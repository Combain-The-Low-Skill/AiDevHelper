"use strict";

const { systemPrompt } = require("./prompt");
const { buildToolSchemas, executeTool } = require("./tools");
const { ToolCallGenerationError } = require("../gateway");

// Цикл агента. Гоняет модель по кругу «думает → вызывает инструмент → видит результат»,
// пока она не вызовет finish или не упрётся в лимит шагов. Все правки копятся в overlay
// рабочего пространства; на диск ничего не пишется до явного commit() снаружи.

class Agent {
    constructor({ gateway, workspace, capabilities, logger, maxIterations, maxTokensPerCall, onProgress }) {
        this.gateway = gateway;
        this.workspace = workspace;
        this.capabilities = capabilities;
        this.logger = logger || { info() {}, warn() {} };
        this.maxIterations = maxIterations || 25;
        this.maxTokensPerCall = maxTokensPerCall || 2048;
        this.onProgress = onProgress || (() => {});
    }

    async run(task) {
        const tools = buildToolSchemas(this.capabilities);
        const messages = [
            { role: "system", content: systemPrompt() },
            { role: "user", content: `Задача: ${task}\n\nКорень проекта доступен через инструменты (начни с list_dir ".").` }
        ];

        let summary = null;
        let iterations = 0;
        let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let consecutiveGenFailures = 0;
        const maxConsecutiveGenFailures = 3;

        for (iterations = 1; iterations <= this.maxIterations; iterations++) {
            let resp;
            try {
                resp = await this.gateway.complete({ messages, tools, maxTokens: this.maxTokensPerCall });
            } catch (err) {
                if (err instanceof ToolCallGenerationError) {
                    // Модель сгенерировала кривой вызов инструмента (битый JSON и т.п.). Это не
                    // фатально: сообщаем модели об этом простым текстом и даём попробовать снова —
                    // вместо того чтобы ронять всю задачу из-за одного плохого ответа.
                    consecutiveGenFailures++;
                    this.onProgress({ type: "tool_error", name: "(генерация)", error: err.message });
                    if (consecutiveGenFailures > maxConsecutiveGenFailures) {
                        summary = `Модель несколько раз подряд не смогла корректно вызвать инструмент (${err.message}). Задача не завершена — попробуйте переформулировать её проще или меньшими шагами.`;
                        this.logger.warn(summary);
                        break;
                    }
                    messages.push({
                        role: "user",
                        content: `Системная ошибка при вызове инструмента: ${err.message}\nПопробуй ещё раз с более простым и корректным вызовом — за один раз делай меньше действий.`
                    });
                    continue;
                }
                throw err; // прочие ошибки (лимит попыток, неверный ключ и т.п.) — наружу как раньше
            }
            consecutiveGenFailures = 0;
            accumulateUsage(totalUsage, resp.usage);

            const msg = resp.message || { role: "assistant", content: resp.text };
            messages.push(normalizeAssistant(msg));

            const toolCalls = msg.tool_calls || [];
            if (toolCalls.length === 0) {
                // модель ответила текстом без действий — считаем это завершением
                summary = msg.content || "Готово.";
                this.onProgress({ type: "assistant", text: summary });
                break;
            }

            let finished = false;
            for (const call of toolCalls) {
                const name = call.function && call.function.name;
                const args = parseArgs(call.function && call.function.arguments);
                this.onProgress({ type: "tool", name, args: summarizeArgs(name, args) });

                let resultContent;
                try {
                    const result = await executeTool(name, args, this.workspace, this.capabilities);
                    if (result && result.done) {
                        summary = result.summary;
                        finished = true;
                        resultContent = "OK";
                    } else {
                        resultContent = typeof result === "string" ? result : JSON.stringify(result);
                    }
                } catch (err) {
                    // ошибку инструмента не роняем наружу — возвращаем модели, чтобы она исправилась
                    resultContent = `ОШИБКА: ${err.message}`;
                    this.onProgress({ type: "tool_error", name, error: err.message });
                }

                messages.push({
                    role: "tool",
                    tool_call_id: call.id || `${name}_${iterations}`,
                    content: clip(resultContent, 8000)
                });
            }

            if (finished) break;
        }

        if (summary === null) {
            summary = `Достигнут лимit шагов (${this.maxIterations}). Возможно, задача выполнена не полностью.`;
            this.logger.warn(summary);
        }

        return {
            summary,
            iterations,
            usage: totalUsage,
            stagedChanges: this.workspace.getStagedChanges()
        };
    }
}

function parseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return {}; }
}

// Сообщение ассистента должно сохранить tool_calls для контекста следующего шага.
function normalizeAssistant(msg) {
    const out = { role: "assistant", content: msg.content || "" };
    if (msg.tool_calls) out.tool_calls = msg.tool_calls;
    return out;
}

function accumulateUsage(acc, u) {
    if (!u) return;
    acc.prompt_tokens += u.prompt_tokens || 0;
    acc.completion_tokens += u.completion_tokens || 0;
    acc.total_tokens += u.total_tokens || 0;
}

function summarizeArgs(name, args) {
    if (name === "read_file" || name === "list_dir") return args.path;
    if (name === "search") return args.query;
    if (name === "edit_file" || name === "create_file") return args.path;
    if (name === "finish") return args.summary;
    return "";
}

function clip(text, max) {
    if (typeof text !== "string") text = String(text);
    return text.length > max ? text.slice(0, max) + "\n…(обрезано)" : text;
}

module.exports = { Agent };