"use strict";

const path = require("path");
const crypto = require("crypto");
const { createEngine } = require("../core/engine");
const { createAppServer } = require("./server");
const logger = require("../core/logger");

// Запуск веб-версии. Поднимает движок из конфига, генерирует одноразовый токен
// доступа и стартует локальный сервер. Ссылку с токеном печатает в консоль —
// открой её в браузере.

const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;

function main() {
    let engine;
    try {
        engine = createEngine({ requireKey: false }); // ключ можно ввести в интерфейсе
    } catch (err) {
        logger.error(err.message);
        logger.error("Проверьте .env (ключ API) и config.json.");
        process.exit(1);
    }

    const token = crypto.randomBytes(16).toString("hex");
    const server = createAppServer({ engine, token, uiDir: path.join(__dirname, "..", "ui") });

    server.listen(PORT, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${PORT}/?t=${token}`;
        logger.info(`🚀 AiDevHelper запущен. Провайдер: ${engine.provider.label} (${engine.provider.model}).`);
        logger.info(`Откройте в браузере: ${url}`);
    });

    const shutdown = () => { engine.worker.stop(); server.close(() => process.exit(0)); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main();
