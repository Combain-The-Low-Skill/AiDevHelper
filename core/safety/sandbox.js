"use strict";

// Песочница путей. Гарантирует, что любая файловая операция остаётся ВНУТРИ
// выбранной рабочей папки. Это защита и от прямого "../../etc/...", и от того,
// что модель в ответе предложит путь, вылезающий за пределы проекта.
//
// Главная проблема старой версии: запись (/api/apply) делала path.join без
// проверки выхода за пределы. Здесь любая операция идёт только через safeResolve.

const fs = require("fs");
const path = require("path");

function createSandbox(rootDir) {
    const root = path.resolve(rootDir);

    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Рабочая папка не существует или не является директорией: ${root}`);
    }

    // Реальный путь корня (раскрывает симлинки самого корня), чтобы сравнение префиксов
    // было честным даже если рабочая папка сама по себе — симлинк.
    const realRoot = fs.realpathSync(root);

    // Превращает относительный путь (от модели/пользователя) в безопасный абсолютный.
    // Бросает ошибку, если путь пытается выйти за пределы корня.
    function safeResolve(relativePath) {
        if (typeof relativePath !== "string" || relativePath.length === 0) {
            throw new Error("Пустой или некорректный путь.");
        }
        if (path.isAbsolute(relativePath)) {
            throw new Error(`Абсолютные пути запрещены, ожидается путь относительно проекта: ${relativePath}`);
        }

        const target = path.resolve(root, relativePath);
        const rel = path.relative(root, target);

        // rel начинается с ".." => target выше корня; isAbsolute(rel) на Windows
        // ловит переход на другой диск (C: -> D:).
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`Путь выходит за пределы рабочей папки: ${relativePath}`);
        }

        // Дополнительная защита от симлинк-побега: проверяем реальный путь той части,
        // что уже существует на диске (целевого файла может ещё не быть — это нормально).
        const existing = nearestExistingAncestor(target);
        if (existing) {
            const realExisting = fs.realpathSync(existing);
            if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
                throw new Error(`Путь ведёт через симлинк за пределы рабочей папки: ${relativePath}`);
            }
        }

        return target;
    }

    function isInside(relativePath) {
        try {
            safeResolve(relativePath);
            return true;
        } catch {
            return false;
        }
    }

    return { root, realRoot, safeResolve, isInside };
}

function nearestExistingAncestor(absPath) {
    let current = absPath;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
    return current;
}

// Запрет выбирать собственную папку программы как рабочую (иначе агент может
// переписать сам себя во время работы). Сохраняем полезную проверку из старой версии.
function assertNotSelf(rootDir, selfDir) {
    if (path.resolve(rootDir) === path.resolve(selfDir)) {
        throw new Error("Нельзя выбирать папку самой программы как рабочую директорию.");
    }
}

module.exports = { createSandbox, assertNotSelf };
