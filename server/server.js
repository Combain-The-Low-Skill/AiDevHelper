"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { saveApiKey } = require("../core/config");

// Локальный сервер приложения.
// Безопасность: НЕ выставляем CORS-заголовки и требуем кастомный заголовок
// x-adhp-token на каждом /api-вызове. Из-за кастомного заголовка любой
// межсайтовый запрос становится "сложным" -> браузер шлёт preflight, который мы
// отклоняем. Так чужая вкладка не сможет ни прочитать ответ, ни подделать вызов.
// Токен встраивается в страницу при отдаче, поэтому свой же UI его знает.

function createAppServer({ engine, token, uiDir }) {
    const sendJson = (res, code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
    };

    function authOk(req) {
        return req.headers["x-adhp-token"] === token;
    }

    async function readBody(req) {
        return new Promise((resolve, reject) => {
            let b = "";
            req.on("data", (c) => { b += c; });
            req.on("end", () => resolve(b));
            req.on("error", reject);
        });
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        try {
            // --- статика (без токена; ответы безвредны и read-блокируются кросс-оригином) ---
            if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
                let html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
                html = html.replace("__ADHP_TOKEN__", token);
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(html);
                return;
            }
            if (req.method === "GET" && pathname === "/app.js") {
                res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
                res.end(fs.readFileSync(path.join(uiDir, "app.js"), "utf8"));
                return;
            }

            // --- API: требуется токен ---
            if (pathname.startsWith("/api/")) {
                if (!authOk(req)) { sendJson(res, 401, { error: "Нет или неверный токен доступа." }); return; }

                if (req.method === "GET" && pathname === "/api/status") {
                    sendJson(res, 200, {
                        provider: { name: engine.provider.name, label: engine.provider.label, model: engine.provider.model, limits: engine.provider.limits },
                        applyMode: engine.applyMode,
                        apiKeyEnv: engine.provider.apiKeyEnv,
                        hasKey: !!engine.provider.apiKey,
                        usage: engine.scheduler.snapshot(),
                        queue: engine.queue.list().map(slim)
                    });
                    return;
                }

                if (req.method === "POST" && pathname === "/api/save-key") {
                    const { value } = JSON.parse(await readBody(req));
                    if (!value || typeof value !== "string") { sendJson(res, 400, { error: "Пустой ключ." }); return; }
                    saveApiKey(engine.provider.apiKeyEnv, value.trim());
                    engine.provider.apiKey = value.trim();
                    sendJson(res, 200, { ok: true });
                    return;
                }

                if (req.method === "GET" && pathname === "/api/select-folder") {
                    try {
                        const folder = await pickFolderNative();
                        sendJson(res, 200, { path: folder || null });
                    } catch (err) {
                        sendJson(res, 200, { path: null, error: err.message });
                    }
                    return;
                }

                if (req.method === "POST" && pathname === "/api/run") {
                    const { targetDir, task, applyMode } = JSON.parse(await readBody(req));
                    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Transfer-Encoding": "chunked" });
                    const send = (o) => res.write(JSON.stringify(o) + "\n");
                    try {
                        const result = await engine.runAgent({
                            targetDir, task, applyMode,
                            onProgress: (ev) => send({ type: "progress", event: ev })
                        });
                        engine.persistState();
                        send({ type: "result", result });
                    } catch (err) {
                        send({ type: "error", error: err.message });
                    }
                    res.end();
                    return;
                }

                if (req.method === "POST" && pathname === "/api/apply") {
                    const { targetDir, changes } = JSON.parse(await readBody(req));
                    const result = engine.applyAgentChanges(targetDir, changes);
                    sendJson(res, 200, { applied: result.applied, backupDir: result.backupSession && result.backupSession.sessionDir });
                    return;
                }

                if (req.method === "POST" && pathname === "/api/enqueue") {
                    const { targetDir, task, applyMode } = JSON.parse(await readBody(req));
                    const id = engine.queue.enqueue({ type: "agent", payload: { targetDir, task, applyMode } });
                    sendJson(res, 200, { id });
                    return;
                }

                if (req.method === "POST" && pathname === "/api/queue/start") {
                    if (!engine.worker.running) engine.worker.start();
                    sendJson(res, 200, { running: true });
                    return;
                }
                if (req.method === "POST" && pathname === "/api/queue/stop") {
                    engine.worker.stop();
                    sendJson(res, 200, { running: false });
                    return;
                }

                sendJson(res, 404, { error: "Неизвестный эндпоинт." });
                return;
            }

            res.writeHead(404); res.end();
        } catch (err) {
            sendJson(res, 500, { error: err.message });
        }
    });

    return server;
}

function slim(j) {
    return { id: j.id, type: j.type, status: j.status, task: j.payload && j.payload.task, error: j.error };
}

// Нативное окно выбора папки. Сейчас реализовано для Windows через PowerShell.
// В отличие от старой версии, скрипт пишется во временный .ps1 и запускается через
// -File (без подстановки в командную строку). На не-Windows вернёт понятную ошибку,
// чтобы интерфейс предложил ручной ввод пути.
function pickFolderNative() {
    return new Promise((resolve, reject) => {
        if (process.platform !== "win32") {
            return reject(new Error("Нативный выбор папки доступен только в Windows. Введите путь вручную."));
        }
        const script = [
            "Add-Type -AssemblyName System.Windows.Forms",
            "$f = New-Object System.Windows.Forms.Form",
            "$f.TopMost = $true",
            "$f.WindowState = 'Minimized'",
            "$f.ShowInTaskbar = $false",
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
            "$d.Description = 'Select working folder'",
            "$result = $d.ShowDialog($f)",
            "$f.Close()",
            "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
            "else { Write-Output '__CANCELLED__' }"
        ].join("\r\n");
        const tmp = path.join(os.tmpdir(), `adhp-pick-${Date.now()}.ps1`);
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        fs.writeFileSync(tmp, Buffer.concat([bom, Buffer.from(script, "utf8")]));

        const child = execFile(
            "powershell",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", tmp],
            { encoding: "utf8", timeout: 120000 },
            (err, stdout, stderr) => {
                fs.rmSync(tmp, { force: true });
                if (err) {
                    if (err.killed) return reject(new Error("Окно выбора папки не было закрыто за 2 минуты (тайм-аут)."));
                    return reject(new Error(stderr ? stderr.trim() : err.message));
                }
                const out = (stdout || "").trim();
                if (out === "__CANCELLED__" || out === "") return resolve(null);
                resolve(out);
            }
        );
        child.on("error", (e) => reject(new Error(`Не удалось запустить powershell: ${e.message}`)));
    });
}

module.exports = { createAppServer };