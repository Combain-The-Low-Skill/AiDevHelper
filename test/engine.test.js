"use strict";

// Самопроверка движка экономии (Этап 2). Сеть и реальное время НЕ используются:
// API подменяется фейковым fetch, время — управляемыми «часами».
// Запуск: npm run test:engine

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { TokenEstimator } = require("../core/tokenEstimator");
const { RateScheduler } = require("../core/scheduler");
const { Gateway } = require("../core/gateway");
const { Queue, Worker } = require("../core/queue");

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (err) {
        console.error(`  ❌ ${name}\n     ${err.stack || err.message}`);
        process.exitCode = 1;
    }
}

// Управляемые часы: sleep мгновенно «проматывает» время вперёд.
function makeClock(start = 0) {
    let t = start;
    return { now: () => t, sleep: async (ms) => { t += Math.max(0, ms); } };
}

// Фейковый Response в стиле fetch.
function fakeResponse({ status = 200, body = {}, headers = {} }) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body))
    };
}

function usageBody(text, promptTokens, completionTokens) {
    return {
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
        }
    };
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const provider = { name: "test", baseUrl: "http://x", apiKey: "k", model: "m", limits: { rpm: 2, tpm: 1000, rpd: 100, maxOutputTokens: 256 } };

(async () => {
    console.log("\n== Оценка токенов ==");
    await test("калибровка двигает коэффициент к наблюдаемому", () => {
        const est = new TokenEstimator(3.5);
        const before = est.charsPerToken;
        // текст из 400 символов, реально 200 токенов -> наблюдаемое 2.0 (меньше 3.5)
        est.calibrate("x".repeat(400), 200);
        assert.ok(est.charsPerToken < before, "коэффициент должен уменьшиться к 2.0");
        assert.ok(est.charsPerToken >= 1.5, "не должен уйти ниже минимума");
    });

    console.log("\n== Планировщик лимитов ==");
    await test("ждёт окно при упоре в RPM", async () => {
        const clock = makeClock(0);
        const sch = new RateScheduler({ rpm: 2, tpm: 1e9, rpd: 1e9 }, { ...clock, logger: silent });
        await sch.reserve(10); // t=0
        await sch.reserve(10); // t=0, RPM=2 (полный)
        await sch.reserve(10); // должен прождать ~60с
        assert.ok(clock.now() >= 60000, `ожидалось ожидание ~60с, прошло ${clock.now()}мс`);
    });

    await test("ждёт при превышении TPM и учитывает реальный usage", async () => {
        const clock = makeClock(0);
        const sch = new RateScheduler({ rpm: 1e9, tpm: 1000, rpd: 1e9 }, { ...clock, logger: silent });
        const r1 = await sch.reserve(800);
        sch.recordUsage(r1, 800);
        await sch.reserve(800); // 800+800 > 1000 -> ждёт выпадения первого из окна (~60с)
        assert.ok(clock.now() >= 60000, `ожидалось ожидание окна TPM, прошло ${clock.now()}мс`);
    });

    await test("запрос больше лимита TPM отклоняется сразу", async () => {
        const sch = new RateScheduler({ rpm: 1e9, tpm: 1000, rpd: 1e9 }, { ...makeClock(), logger: silent });
        await assert.rejects(() => sch.reserve(5000), /больше лимита TPM/);
    });

    console.log("\n== Шлюз к API ==");
    await test("успешный ответ: возвращает текст и калибрует оценку", async () => {
        const clock = makeClock(0);
        const est = new TokenEstimator(3.5);
        const sch = new RateScheduler(provider.limits, { ...clock, logger: silent });
        const gw = new Gateway({
            provider, scheduler: sch, estimator: est, ...clock, logger: silent,
            fetchFn: async () => fakeResponse({ body: usageBody("привет", 50, 5) })
        });
        const out = await gw.complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
        assert.strictEqual(out.text, "привет");
        assert.strictEqual(out.usage.total_tokens, 55);
    });

    await test("429 с Retry-After: ставит паузу и автоматически повторяет", async () => {
        const clock = makeClock(0);
        const est = new TokenEstimator(3.5);
        const sch = new RateScheduler(provider.limits, { ...clock, logger: silent });
        let calls = 0;
        const gw = new Gateway({
            provider, scheduler: sch, estimator: est, ...clock, logger: silent,
            fetchFn: async () => {
                calls++;
                if (calls === 1) return fakeResponse({ status: 429, headers: { "retry-after": "5" }, body: { error: { message: "rate limited" } } });
                return fakeResponse({ body: usageBody("готово", 40, 3) });
            }
        });
        const out = await gw.complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
        assert.strictEqual(calls, 2, "должно быть 2 обращения (1 отказ + 1 успех)");
        assert.ok(clock.now() >= 5000, "должна была произойти пауза ~5с по Retry-After");
        assert.strictEqual(out.text, "готово");
    });

    await test("5xx: backoff и повтор до успеха", async () => {
        const clock = makeClock(0);
        const sch = new RateScheduler(provider.limits, { ...clock, logger: silent });
        let calls = 0;
        const gw = new Gateway({
            provider, scheduler: sch, estimator: new TokenEstimator(3.5), ...clock, logger: silent,
            fetchFn: async () => (++calls < 3 ? fakeResponse({ status: 503, body: "upstream" }) : fakeResponse({ body: usageBody("ок", 30, 2) }))
        });
        const out = await gw.complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
        assert.strictEqual(calls, 3);
        assert.strictEqual(out.text, "ок");
    });

    await test("4xx (кроме 429): без повторов, понятная ошибка", async () => {
        const clock = makeClock(0);
        const sch = new RateScheduler(provider.limits, { ...clock, logger: silent });
        let calls = 0;
        const gw = new Gateway({
            provider, scheduler: sch, estimator: new TokenEstimator(3.5), ...clock, logger: silent,
            fetchFn: async () => { calls++; return fakeResponse({ status: 400, body: { error: { message: "bad request" } } }); }
        });
        await assert.rejects(() => gw.complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 }), /400.*bad request/);
        assert.strictEqual(calls, 1, "4xx не должен повторяться");
    });

    console.log("\n== Очередь и воркер ==");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adhp-q-"));
    const queuePath = path.join(tmp, "queue.json");

    await test("воркер выполняет задачи и сохраняет результат", async () => {
        const q = new Queue({ filePath: queuePath, logger: silent });
        q.enqueue({ type: "echo", payload: { msg: "раз" } });
        q.enqueue({ type: "echo", payload: { msg: "два" } });
        const worker = new Worker({
            queue: q, logger: silent, sleep: async () => {},
            runners: { echo: async (p) => ({ echoed: p.msg.toUpperCase() }) }
        });
        await worker.drain();
        const jobs = q.list();
        assert.ok(jobs.every((j) => j.status === "done"), "все задачи должны быть done");
        assert.strictEqual(jobs[0].result.echoed, "РАЗ");
    });

    await test("очередь переживает перезапуск (читается с диска)", async () => {
        const q2 = new Queue({ filePath: queuePath, logger: silent });
        const jobs = q2.list();
        assert.strictEqual(jobs.length, 2, "обе задачи должны прочитаться с диска");
        assert.strictEqual(jobs[1].result.echoed, "ДВА");
    });

    await test("проваленная задача помечается failed с текстом ошибки", async () => {
        const q = new Queue({ filePath: path.join(tmp, "q2.json"), logger: silent });
        q.enqueue({ type: "boom", payload: {} });
        const worker = new Worker({
            queue: q, logger: silent, sleep: async () => {},
            runners: { boom: async () => { throw new Error("взрыв"); } }
        });
        await worker.drain();
        assert.strictEqual(q.list()[0].status, "failed");
        assert.match(q.list()[0].error, /взрыв/);
    });

    fs.rmSync(tmp, { recursive: true, force: true });

    console.log(`\nИтог: ${passed} проверок пройдено${process.exitCode ? ", ЕСТЬ ОШИБКИ" : ", всё чисто ✅"}\n`);
})();
