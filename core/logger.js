"use strict";

// Простой логгер с уровнями и временными метками. Никаких зависимостей.
// Используется везде в ядре вместо россыпи console.log, чтобы потом можно было
// одним местом перенаправить логи (например, в файл или в окно .exe-приложения).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;

function setLevel(name) {
    if (LEVELS[name] != null) currentLevel = LEVELS[name];
}

function ts() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function emit(level, icon, args) {
    if (LEVELS[level] < currentLevel) return;
    const prefix = `[${ts()}] ${icon}`;
    // warn/error -> stderr, остальное -> stdout
    const stream = level === "warn" || level === "error" ? console.error : console.log;
    stream(prefix, ...args);
}

module.exports = {
    setLevel,
    debug: (...a) => emit("debug", "🔍", a),
    info: (...a) => emit("info", "•", a),
    warn: (...a) => emit("warn", "⚠️", a),
    error: (...a) => emit("error", "❌", a)
};
