"use strict";

const fs = require("fs");
const path = require("path");
const { createSandbox } = require("./safety/sandbox");
const { backupFiles } = require("./safety/checkpoint");

// Применение набора изменений на диск с предварительным бэкапом.
// Используется в режиме manual: агент предложил changes, пользователь подтвердил —
// записываем. В отличие от старого /api/apply, каждый путь проходит через песочницу,
// поэтому выйти за пределы рабочей папки невозможно.
//
// changes: [{ filePath, newContent }]
function applyChanges(targetDir, changes, backupBaseDir) {
    const sandbox = createSandbox(targetDir);
    const rels = changes.map((c) => c.filePath);

    // на всякий случай проверим все пути ДО записи — чтобы не применить часть и упасть
    rels.forEach((rel) => sandbox.safeResolve(rel));

    const backupSession = backupFiles(targetDir, rels, backupBaseDir);

    const applied = [];
    for (const change of changes) {
        const abs = sandbox.safeResolve(change.filePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, change.newContent, "utf8");
        applied.push(change.filePath);
    }
    return { applied, backupSession };
}

module.exports = { applyChanges };
