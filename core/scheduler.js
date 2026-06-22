"use strict";

const { realNow, realSleep } = require("./util");

// Планировщик лимитов — главный инструмент экономии и режима «медленно, но верно».
//
// Держит три скользящих окна на провайдера:
//   RPM — запросов в минуту   (окно 60 сек)
//   TPM — токенов в минуту     (окно 60 сек, суммируем токены)
//   RPD — запросов в сутки     (окно 24 часа)
// Плюс cooldownUntil — пауза, выставляемая по заголовку Retry-After от провайдера.
//
// reserve(estTokens) НЕ отклоняет запрос при нехватке лимита — он ВЫЧИСЛЯЕТ, сколько
// ждать до освобождения окна, и спит до этого момента (порциями), затем выдаёт «слот».
// Так очередь сама размазывает работу во времени и доводит её до конца без участия
// пользователя.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

class RateScheduler {
    constructor(limits, opts = {}) {
        this.limits = {
            rpm: limits.rpm || Infinity,
            tpm: limits.tpm || Infinity,
            rpd: limits.rpd || Infinity
        };
        this.now = opts.now || realNow;
        this.sleep = opts.sleep || realSleep;
        this.logger = opts.logger || { info() {}, debug() {} };
        this.maxSleepChunk = opts.maxSleepChunk || 30 * 1000; // спим порциями, чтобы быть отзывчивыми

        this.rpmHits = [];      // [ts, ...]
        this.rpdHits = [];      // [ts, ...]
        this.tpmHits = [];      // [{ts, tokens}, ...]
        this.cooldownUntil = 0;
    }

    _prune(now) {
        this.rpmHits = this.rpmHits.filter((t) => now - t < MINUTE);
        this.rpdHits = this.rpdHits.filter((t) => now - t < DAY);
        this.tpmHits = this.tpmHits.filter((e) => now - e.ts < MINUTE);
    }

    _tpmUsed() {
        return this.tpmHits.reduce((s, e) => s + e.tokens, 0);
    }

    // Сколько миллисекунд ждать до появления свободного слота под estTokens. 0 — можно сейчас.
    _waitMs(now, estTokens) {
        let wait = 0;

        if (this.cooldownUntil > now) {
            wait = Math.max(wait, this.cooldownUntil - now);
        }
        if (this.rpmHits.length >= this.limits.rpm) {
            wait = Math.max(wait, this.rpmHits[0] + MINUTE - now);
        }
        if (this.rpdHits.length >= this.limits.rpd) {
            wait = Math.max(wait, this.rpdHits[0] + DAY - now);
        }
        // TPM: если добавление estTokens превысит лимит — ждём, пока из окна не выпадут
        // самые старые токены, чтобы освободить достаточно места.
        if (this._tpmUsed() + estTokens > this.limits.tpm) {
            let freed = 0;
            const need = this._tpmUsed() + estTokens - this.limits.tpm;
            for (const e of this.tpmHits) {
                freed += e.tokens;
                if (freed >= need) {
                    wait = Math.max(wait, e.ts + MINUTE - now);
                    break;
                }
            }
            // Если даже полное окно не вмещает запрос — ждём опустошения окна целиком.
            if (freed < need && this.tpmHits.length) {
                wait = Math.max(wait, this.tpmHits[this.tpmHits.length - 1].ts + MINUTE - now);
            }
        }
        return Math.max(0, Math.ceil(wait));
    }

    // Ждёт (если нужно) и резервирует слот. Возвращает «резервацию» — после ответа
    // её токены уточняются реальным usage через recordUsage().
    async reserve(estTokens) {
        // защита от запроса, который физически не влезает даже в пустое окно TPM
        if (estTokens > this.limits.tpm) {
            throw new Error(
                `Запрос (~${estTokens} токенов) больше лимита TPM (${this.limits.tpm}) — ` +
                `его нельзя выполнить целиком. Разбейте задачу на меньшие части.`
            );
        }

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const now = this.now();
            this._prune(now);
            const wait = this._waitMs(now, estTokens);
            if (wait <= 0) break;
            this.logger.info(`⏳ Лимит API: ждём ${(wait / 1000).toFixed(1)} c до освобождения окна...`);
            await this.sleep(Math.min(wait, this.maxSleepChunk));
        }

        const now = this.now();
        this.rpmHits.push(now);
        this.rpdHits.push(now);
        const entry = { ts: now, tokens: estTokens };
        this.tpmHits.push(entry);
        return { entry };
    }

    // Заменяет предварительную оценку токенов реальным числом из ответа провайдера.
    recordUsage(reservation, realTokens) {
        if (reservation && reservation.entry && realTokens > 0) {
            reservation.entry.tokens = realTokens;
        }
    }

    // Пауза по требованию провайдера (заголовок Retry-After при 429).
    setCooldown(ms) {
        if (ms > 0) this.cooldownUntil = this.now() + ms;
    }

    snapshot() {
        const now = this.now();
        this._prune(now);
        return {
            rpm: `${this.rpmHits.length}/${fmt(this.limits.rpm)}`,
            tpm: `${this._tpmUsed()}/${fmt(this.limits.tpm)}`,
            rpd: `${this.rpdHits.length}/${fmt(this.limits.rpd)}`,
            cooldownMs: Math.max(0, this.cooldownUntil - now)
        };
    }

    toJSON() {
        return {
            rpmHits: this.rpmHits,
            rpdHits: this.rpdHits,
            tpmHits: this.tpmHits,
            cooldownUntil: this.cooldownUntil
        };
    }

    loadJSON(obj) {
        if (!obj) return;
        this.rpmHits = obj.rpmHits || [];
        this.rpdHits = obj.rpdHits || [];
        this.tpmHits = obj.tpmHits || [];
        this.cooldownUntil = obj.cooldownUntil || 0;
        this._prune(this.now());
    }
}

function fmt(n) {
    return n === Infinity ? "∞" : n;
}

module.exports = { RateScheduler };
