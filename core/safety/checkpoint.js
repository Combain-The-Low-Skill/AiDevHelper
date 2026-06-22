"use strict";

// Резервные копии перед записью на диск + откат.
// Перед тем как агент перезапишет файлы, мы копируем их текущие версии в
// backupDir/<метка_времени>/ и пишем manifest.json. Это даёт безопасный откат
// даже без git. Если папка — git-репозиторий, дополнительно фиксируем текущий
// HEAD в манифесте (чтобы пользователь при желании сравнил/откатил через git).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function detectGitHead(rootDir) {
    try {
        const head = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: rootDir,
            stdio: ["ignore", "pipe", "ignore"]
        }).toString().trim();
        return head || null;
    } catch {
        return null; // не git-репозиторий или git не установлен — это нормально
    }
}

// relativePaths — пути файлов (относительно rootDir), которые СОБИРАЕМСЯ изменить.
// Копируем только те, что реально существуют (новые файлы копировать нечего).
// Возвращает объект сессии бэкапа, который позже можно передать в restoreBackup().
function backupFiles(rootDir, relativePaths, backupBaseDir) {
    const root = path.resolve(rootDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionDir = path.resolve(root, backupBaseDir, stamp);

    const manifest = {
        createdAt: new Date().toISOString(),
        rootDir: root,
        gitHead: detectGitHead(root),
        files: []
    };

    for (const rel of relativePaths) {
        const src = path.resolve(root, rel);
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
            manifest.files.push({ relativePath: rel, existed: false });
            continue;
        }
        const dest = path.join(sessionDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        manifest.files.push({ relativePath: rel, existed: true });
    }

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    return { sessionDir, manifest };
}

// Откат: возвращает файлы из бэкап-сессии на их места.
// Файлы, которых на момент бэкапа не существовало (created files), при откате
// удаляются — так состояние возвращается к моменту перед применением правок.
function restoreBackup(sessionDir) {
    const manifestPath = path.join(sessionDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Манифест бэкапа не найден: ${manifestPath}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const restored = [];
    const removed = [];

    for (const entry of manifest.files) {
        const target = path.resolve(manifest.rootDir, entry.relativePath);
        if (entry.existed) {
            const backup = path.join(sessionDir, entry.relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(backup, target);
            restored.push(entry.relativePath);
        } else if (fs.existsSync(target)) {
            fs.rmSync(target);
            removed.push(entry.relativePath);
        }
    }

    return { restored, removed };
}

module.exports = { backupFiles, restoreBackup, detectGitHead };
