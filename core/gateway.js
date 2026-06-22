"use strict";

const { realNow, realSleep, jitter } = require("./util");

// Шлюз к LLM — единая точка вызова модели, не зависящая от конкретного провайдера.
// Сейчас реализован адаптер для OpenAI-совместимого API (Groq). Адаптер Gemini
// добавим на Этапе 5 — интерфейс complete() от этого не изменится.
//
// Что делает на каждый вызов:
//  1) оценивает токены и берёт слот у планировщика (тот при необходимости ждёт);
//  2) шлёт запрос;
//  3) при 429 — читает Retry-After, ставит планировщику паузу и АВТОМАТИЧЕСКИ повторяет;
//  4) при 5xx/сетевых сбоях — экспоненциальный backoff с джиттером и повтор;
//  5) при успехе — уточняет калибровку оценки токенов реальным usage и возвращает ответ.

class Gateway {
    constructor({ provider, scheduler, estimator, fetchFn, sleep, now, logger, retry }) {
        this.provider = provider;
        this.scheduler = scheduler;
        this.estimator = estimator;
        this.fetchFn = fetchFn || globalThis.fetch;
        this.sleep = sleep || realSleep;
        this.now = now || realNow;
        this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
        this.retry = {
            maxAttempts: (retry && retry.maxAttempts) || 100, // «часами без меня» — терпеливо
            baseDelayMs: (retry && retry.baseDelayMs) || 1000,
            maxDelayMs: (retry && retry.maxDelayMs) || 60 * 1000
        };
    }

    // messages: [{role, content}], maxTokens — бюджет ответа, tools — описания инструментов
    // (function calling). Возвращает текст, сырое сообщение ассистента (с возможными
    // tool_calls), usage и raw-ответ.
    async complete({ messages, maxTokens, temperature = 0.2, tools }) {
        const provider = this.provider;
        const outBudget = Math.min(maxTokens || 4096, provider.limits.maxOutputTokens || 4096);
        const promptText = messages.map((m) => m.content).join("\n");
        const estInput = this.estimator.estimateMessages(messages);
        const estTotal = estInput + outBudget;

        let attempt = 0;
        let lastError = null;

        while (attempt < this.retry.maxAttempts) {
            attempt++;
            const reservation = await this.scheduler.reserve(estTotal);

            try {
                const res = await this.fetchFn(`${provider.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${provider.apiKey}`
                    },
                    body: JSON.stringify({
                        model: provider.model,
                        messages,
                        temperature,
                        max_tokens: outBudget,
                        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {})
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    const usage = data.usage || {};
                    const total = usage.total_tokens || estTotal;
                    this.scheduler.recordUsage(reservation, total);
                    if (usage.prompt_tokens) {
                        this.estimator.calibrate(promptText, usage.prompt_tokens);
                    }
                    const choice = data.choices && data.choices[0];
                    if (choice && choice.finish_reason === "length") {
                        throw new NonRetryableError(
                            "Ответ модели обрезан по лимиту токенов вывода. Уменьшите объём задачи или увеличьте maxOutputTokens у провайдера."
                        );
                    }
                    return {
                        text: choice ? choice.message.content : "",
                        message: choice ? choice.message : null,
                        finishReason: choice ? choice.finish_reason : null,
                        usage,
                        raw: data
                    };
                }

                // --- не-OK ответ ---
                const bodyText = await safeText(res);
                if (res.status === 429) {
                    const waitMs = parseRetryAfter(res, bodyText) || backoffDelay(this.retry, attempt);
                    this.scheduler.setCooldown(waitMs);
                    this.logger.warn(`Лимит API (429). Пауза ${(waitMs / 1000).toFixed(1)} c и повтор (попытка ${attempt}).`);
                    await this.sleep(waitMs);
                    continue;
                }
                if (res.status >= 500) {
                    const waitMs = backoffDelay(this.retry, attempt);
                    this.logger.warn(`Сбой сервера API (${res.status}). Backoff ${(waitMs / 1000).toFixed(1)} c и повтор.`);
                    await this.sleep(waitMs);
                    continue;
                }
                // Groq иногда отдаёт 400 "Failed to call a function" / "failed_generation", когда
                // модель сама сгенерировала кривой вызов инструмента (битый JSON в аргументах).
                // Это не фатальная ошибка конфигурации — это плохой ОТВЕТ модели. Возвращаем её как
                // ToolCallGenerationError: агентный цикл сможет показать модели её же ошибку и дать
                // ей попытаться снова, вместо того чтобы ронять всю задачу.
                if (res.status === 400 && /failed_generation|Failed to call a function/i.test(bodyText)) {
                    throw new ToolCallGenerationError(extractMessage(bodyText));
                }
                // прочие 4xx (неверный ключ, неверная модель и т.п.) — повторять бессмысленно
                throw new NonRetryableError(`Ошибка API ${res.status}: ${extractMessage(bodyText)}`);
            } catch (err) {
                if (err instanceof NonRetryableError) throw err;
                if (err instanceof ToolCallGenerationError) throw err;
                // сетевой сбой — backoff и повтор
                lastError = err;
                const waitMs = backoffDelay(this.retry, attempt);
                this.logger.warn(`Сетевой сбой: ${err.message}. Backoff ${(waitMs / 1000).toFixed(1)} c и повтор.`);
                await this.sleep(waitMs);
            }
        }

        throw new Error(`Исчерпаны попытки (${this.retry.maxAttempts}). Последняя ошибка: ${lastError ? lastError.message : "лимит API"}`);
    }
}

class NonRetryableError extends Error {}
class ToolCallGenerationError extends Error {}

function backoffDelay(retry, attempt) {
    const exp = retry.baseDelayMs * Math.pow(2, attempt - 1);
    return jitter(Math.min(exp, retry.maxDelayMs));
}

// Retry-After может прийти как заголовок (в секундах) или быть зашит в тексте ошибки
// ("try again in 7.5s"). Возвращает миллисекунды или null.
function parseRetryAfter(res, bodyText) {
    const header = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    if (header) {
        const sec = parseFloat(header);
        if (!isNaN(sec)) return Math.ceil(sec * 1000);
    }
    const m = /try again in ([\d.]+)\s*s/i.exec(bodyText || "");
    if (m) return Math.ceil(parseFloat(m[1]) * 1000);
    return null;
}

function extractMessage(bodyText) {
    try {
        const j = JSON.parse(bodyText);
        return (j.error && j.error.message) || bodyText.slice(0, 200);
    } catch {
        return (bodyText || "").slice(0, 200);
    }
}

async function safeText(res) {
    try {
        return await res.text();
    } catch {
        return "";
    }
}

module.exports = { Gateway, NonRetryableError, ToolCallGenerationError };