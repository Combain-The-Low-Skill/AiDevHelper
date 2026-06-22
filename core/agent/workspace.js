"use strict";

const fs = require("fs");
const path = require("path");
const { backupFiles } = require("../safety/checkpoint");

// Рабочее пространство агента поверх песочницы.
// Все правки во время цикла копятся в overlay (в памяти): чтение идёт «сквозь» overlay,
// поэтому агент видит собственные незаписанные изменения и рассуждает связно.
// Диск изменяется ОДИН раз — в commit(): сначала бэкап оригиналов, потом запись.

const MAX_READ_BYTES = 200 * 1024; // не отдаём модели гигантские файлы (защита токенов)
const BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".mp4", ".mp3", ".wav", ".avi", ".mov", ".mkv", ".flac", ".ogg",
    ".zip", ".rar", ".7z", ".tar", ".gz",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".exe", ".dll", ".so", ".bin", ".dat",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".node", ".pyc", ".class", ".jar"
]);

function isBinary(rel) {
    return BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

class Workspace {
    constructor(sandbox) {
        this.sandbox = sandbox;
        this.overlay = new Map();    // rel -> новое содержимое
        this.originals = new Map();  // rel -> исходное содержимое (или null, если файла не было)
    }

    _rememberOriginal(rel) {
        if (this.originals.has(rel)) return;
        const abs = this.sandbox.safeResolve(rel);
        this.originals.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null);
    }

    exists(rel) {
        if (this.overlay.has(rel)) return true;
        const abs = this.sandbox.safeResolve(rel);
        return fs.existsSync(abs) && fs.statSync(abs).isFile();
    }

    readFile(rel) {
        if (isBinary(rel)) throw new Error(`Файл бинарный, не читается как текст: ${rel}`);
        if (this.overlay.has(rel)) return this.overlay.get(rel);
        const abs = this.sandbox.safeResolve(rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`Файл не найден: ${rel}`);
        const size = fs.statSync(abs).size;
        if (size > MAX_READ_BYTES) {
            throw new Error(`Файл слишком большой (${Math.round(size / 1024)} КБ) — прочитайте его частями или работайте точечно.`);
        }
        return fs.readFileSync(abs, "utf8");
    }

    listDir(rel = ".") {
        const abs = this.sandbox.safeResolve(rel === "" ? "." : rel);
        let entries = [];
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            entries = fs.readdirSync(abs).map((name) => {
                const childAbs = path.join(abs, name);
                const isDir = fs.statSync(childAbs).isDirectory();
                return { name, type: isDir ? "dir" : "file" };
            });
        }
        // добавим новые файлы из overlay, которых ещё нет на диске в этой папке
        const prefix = rel === "." || rel === "" ? "" : rel.replace(/\\/g, "/") + "/";
        for (const created of this.overlay.keys()) {
            const norm = created.replace(/\\/g, "/");
            if (norm.startsWith(prefix)) {
                const remainder = norm.slice(prefix.length);
                if (remainder && !remainder.includes("/") && !entries.find((e) => e.name === remainder)) {
                    entries.push({ name: remainder, type: "file", staged: true });
                }
            }
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    createFile(rel, content) {
        if (isBinary(rel)) throw new Error(`Нельзя создавать бинарный файл как текст: ${rel}`);
        this.sandbox.safeResolve(rel); // проверка пути
        this._rememberOriginal(rel);
        this.overlay.set(rel, content);
        return { created: rel, isNew: this.originals.get(rel) === null };
    }

    // Точечная правка «найти-заменить». oldStr должен встречаться РОВНО один раз —
    // иначе непонятно, какое место менять, и правка отклоняется (это надёжнее дифов).
    editFile(rel, oldStr, newStr) {
        const current = this.readFile(rel);
        if (typeof oldStr !== "string" || oldStr.length === 0) {
            throw new Error(`Пустой old_str для ${rel}.`);
        }
        const parts = current.split(oldStr);
        const count = parts.length - 1;
        if (count === 0) {
            throw new Error(`В файле ${rel} не найден фрагмент для замены. Сначала прочитайте файл и скопируйте точный текст.`);
        }
        if (count > 1) {
            throw new Error(`Фрагмент встречается в ${rel} ${count} раз(а) — уточните old_str бо́льшим контекстом, чтобы совпадение было единственным.`);
        }
        this._rememberOriginal(rel);
        this.overlay.set(rel, parts.join(newStr));
        return { edited: rel };
    }

    // Список накопленных изменений для превью diff.
    getStagedChanges() {
        const changes = [];
        for (const [rel, newContent] of this.overlay.entries()) {
            const oldContent = this.originals.get(rel);
            changes.push({ filePath: rel, oldContent, newContent, isNew: oldContent === null });
        }
        return changes;
    }

    hasChanges() {
        return this.overlay.size > 0;
    }

    // Транзакционная запись на диск: бэкап изменяемых файлов -> запись overlay.
    commit(backupBaseDir) {
        if (!this.hasChanges()) return { applied: [], backupSession: null };
        const rels = [...this.overlay.keys()];
        const backupSession = backupFiles(this.sandbox.root, rels, backupBaseDir);

        const applied = [];
        for (const [rel, content] of this.overlay.entries()) {
            const abs = this.sandbox.safeResolve(rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, "utf8");
            applied.push(rel);
        }
        // overlay переносится «на диск» — оставляем его как новое исходное состояние
        for (const [rel, content] of this.overlay.entries()) this.originals.set(rel, content);
        this.overlay.clear();
        return { applied, backupSession };
    }

    discard() {
        this.overlay.clear();
    }
}

module.exports = { Workspace, isBinary, MAX_READ_BYTES };
