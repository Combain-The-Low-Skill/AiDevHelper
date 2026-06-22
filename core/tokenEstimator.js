"use strict";

// Оценка количества токенов в тексте ДО отправки запроса.
//
// Чем это лучше старой версии:
//  - Старый код использовал безумный коэффициент 0.3 байт/токен (завышал оценку
//    в разы) и калибровался ТОЛЬКО при ошибке 429 по хрупкому regex.
//  - Здесь оценка идёт по символам (символьная длина ближе к токенам, чем байты)
//    и калибруется на КАЖДОМ успешном ответе — провайдер всегда присылает реальный
//    usage.prompt_tokens, это самый точный источник.
//
// Оценка всё равно приблизительная (точный токенайзер у каждой модели свой), но
// нужна она лишь для предварительного резервирования в планировщике — после ответа
// счётчики уточняются реальными числами.

const DEFAULT_CHARS_PER_TOKEN = 3.5; // разумный старт для кода; кириллица обычно ниже
const MIN_RATIO = 1.5;
const MAX_RATIO = 8;

class TokenEstimator {
    constructor(charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
        this.charsPerToken = clamp(charsPerToken, MIN_RATIO, MAX_RATIO);
    }

    estimate(text) {
        if (!text) return 0;
        return Math.ceil(text.length / this.charsPerToken);
    }

    estimateMessages(messages) {
        // ~4 токена служебной разметки на сообщение (роль, разделители) — грубая надбавка.
        return messages.reduce((sum, m) => sum + this.estimate(m.content) + 4, 0);
    }

    // Уточнение коэффициента по реальному usage. promptText — то, что отправили,
    // realPromptTokens — сколько токенов насчитал провайдер. Сглаживаем (EMA),
    // чтобы один нетипичный запрос не перекашивал оценку.
    calibrate(promptText, realPromptTokens) {
        if (!promptText || !realPromptTokens || realPromptTokens <= 0) return;
        const observed = promptText.length / realPromptTokens;
        if (observed < 0.5 || observed > 20) return; // явный выброс — игнорируем
        const smoothed = this.charsPerToken * 0.7 + observed * 0.3;
        this.charsPerToken = clamp(smoothed, MIN_RATIO, MAX_RATIO);
    }

    toJSON() {
        return { charsPerToken: this.charsPerToken };
    }

    static fromJSON(obj) {
        return new TokenEstimator(obj && obj.charsPerToken ? obj.charsPerToken : DEFAULT_CHARS_PER_TOKEN);
    }
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

module.exports = { TokenEstimator, DEFAULT_CHARS_PER_TOKEN };
