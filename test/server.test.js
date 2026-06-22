"use strict";

// Самопроверка сервера (Этап 4). Движок подменён заглушкой, чтобы проверять именно
// HTTP-слой: авторизацию по токену, статус, потоковый /api/run и /api/apply.
// Запуск: npm run test:server

const http = require("http");
const path = require("path");
const assert = require("assert");
const { createAppServer } = require("../server/server");

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (err) { console.error(`  ❌ ${name}\n     ${err.stack || err.message}`); process.exitCode = 1; }
}

const TOKEN = "test-token-123";

// Заглушка движка с минимально нужным интерфейсом.
const mockEngine = {
    provider: { name: "test", label: "Test", model: "m", limits: { rpm: 10, tpm: 1000, rpd: 100 } },
    applyMode: "manual",
    scheduler: { snapshot: () => ({ rpm: "1/10", tpm: "30/1000", rpd: "1/100", cooldownMs: 0 }) },
    queue: { list: () => [{ id: 1, type: "agent", status: "pending", payload: { task: "сделай X" } }], enqueue: () => 2 },
    worker: { running: false, start() { this.running = true; }, stop() { this.running = false; } },
    persistState() {},
    async runAgent({ task, onProgress }) {
        onProgress({ type: "tool", name: "read_file", args: "a.js" });
        onProgress({ type: "tool", name: "edit_file", args: "a.js" });
        return { mode: "manual", summary: `сделано: ${task}`, changes: [{ filePath: "a.js", oldContent: "x", newContent: "y", isNew: false }] };
    },
    applyAgentChanges() { return { applied: ["a.js"], backupSession: { sessionDir: "/tmp/backup/x" } }; }
};

function request(port, method, pathname, { token, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: {
            ...(token ? { "x-adhp-token": token } : {}),
            ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {})
        } }, (res) => {
            let buf = "";
            res.on("data", (c) => { buf += c; });
            res.on("end", () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const server = createAppServer({ engine: mockEngine, token: TOKEN, uiDir: path.join(__dirname, "..", "ui") });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    console.log("\n== Сервер: безопасность ==");
    await test("API без токена -> 401", async () => {
        const r = await request(port, "GET", "/api/status");
        assert.strictEqual(r.status, 401);
    });
    await test("API с неверным токеном -> 401", async () => {
        const r = await request(port, "GET", "/api/status", { token: "wrong" });
        assert.strictEqual(r.status, 401);
    });

    console.log("\n== Сервер: эндпоинты ==");
    await test("страница отдаётся и токен подставлен", async () => {
        const r = await request(port, "GET", "/");
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.includes(TOKEN), "токен должен быть встроен в HTML");
        assert.ok(!r.body.includes("__ADHP_TOKEN__"), "плейсхолдер должен быть заменён");
    });
    await test("статус возвращает лимиты, режим и очередь", async () => {
        const r = await request(port, "GET", "/api/status", { token: TOKEN });
        const s = JSON.parse(r.body);
        assert.strictEqual(s.applyMode, "manual");
        assert.strictEqual(s.usage.rpm, "1/10");
        assert.strictEqual(s.queue.length, 1);
    });
    await test("/api/run отдаёт поток прогресса и итоговый результат", async () => {
        const r = await request(port, "POST", "/api/run", { token: TOKEN, body: { targetDir: "/x", task: "почини" } });
        const lines = r.body.trim().split("\n").map((l) => JSON.parse(l));
        const progress = lines.filter((l) => l.type === "progress");
        const result = lines.find((l) => l.type === "result");
        assert.ok(progress.length >= 2, "должно прийти несколько событий прогресса");
        assert.ok(result, "должен прийти итоговый результат");
        assert.strictEqual(result.result.changes.length, 1);
    });
    await test("/api/apply применяет изменения", async () => {
        const r = await request(port, "POST", "/api/apply", { token: TOKEN, body: { targetDir: "/x", changes: [{ filePath: "a.js", newContent: "y" }] } });
        const s = JSON.parse(r.body);
        assert.deepStrictEqual(s.applied, ["a.js"]);
    });
    await test("/api/enqueue ставит задачу и запуск/стоп очереди работают", async () => {
        const r = await request(port, "POST", "/api/enqueue", { token: TOKEN, body: { targetDir: "/x", task: "t" } });
        assert.strictEqual(JSON.parse(r.body).id, 2);
        await request(port, "POST", "/api/queue/start", { token: TOKEN });
        assert.strictEqual(mockEngine.worker.running, true);
        await request(port, "POST", "/api/queue/stop", { token: TOKEN });
        assert.strictEqual(mockEngine.worker.running, false);
    });

    server.close();
    console.log(`\nИтог: ${passed} проверок пройдено${process.exitCode ? ", ЕСТЬ ОШИБКИ" : ", всё чисто ✅"}\n`);
})();
