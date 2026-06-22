"use strict";

const fs = require("fs");
const path = require("path");

// Реальные now()/sleep() по умолчанию. В тестах их подменяют на «фейковые часы»,
// чтобы проверять логику ожидания мгновенно, без настоящих задержек.
const realNow = () => Date.now();
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// Небольшой случайный разброс для backoff, чтобы при сбое все ретраи не били
// в API одновременно ("thundering herd").
function jitter(ms, ratio = 0.2) {
    const delta = ms * ratio;
    return Math.round(ms - delta + Math.random() * 2 * delta);
}

// Простое JSON-хранилище состояния на диске (для планировщика и очереди).
function loadState(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return { ...fallback };
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return { ...fallback };
    }
}

function saveState(filePath, obj) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Атомарная запись: сначала во временный файл, потом переименование.
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
}

module.exports = { realNow, realSleep, jitter, loadState, saveState };
