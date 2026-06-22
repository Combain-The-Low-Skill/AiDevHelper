"use strict";

// Самопроверка фундамента (Этап 1). Без сторонних библиотек.
// Запуск: npm run test:foundation  (или: node test/foundation.test.js)

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { config, getActiveProvider } = require("../core/config");
const { createSandbox, assertNotSelf } = require("../core/safety/sandbox");
const { backupFiles, restoreBackup } = require("../core/safety/checkpoint");

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (err) {
        console.error(`  ❌ ${name}\n     ${err.message}`);
        process.exitCode = 1;
    }
}

// --- временная рабочая папка для тестов ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adhp-test-"));
fs.mkdirSync(path.join(tmp, "src"));
fs.writeFileSync(path.join(tmp, "src", "app.js"), "console.log('v1');\n", "utf8");

console.log("\n== Конфигурация ==");
test("config.json загружается и валиден", () => {
    assert.ok(config.activeProvider, "не задан activeProvider");
    assert.ok(config.providers[config.activeProvider], "активный провайдер не описан");
});
test("getActiveProvider не падает без ключа (ленивая проверка)", () => {
    const p = getActiveProvider(false);
    assert.ok(p.baseUrl && p.model && p.limits, "провайдер недоописан");
});
test("getActiveProvider(true) даёт понятную ошибку без ключа", () => {
    const had = process.env[getActiveProvider(false).apiKeyEnv];
    delete process.env[getActiveProvider(false).apiKeyEnv];
    assert.throws(() => getActiveProvider(true), /Не задан ключ API/);
    if (had !== undefined) process.env[getActiveProvider(false).apiKeyEnv] = had;
});

console.log("\n== Песочница путей ==");
const sb = createSandbox(tmp);
test("разрешает путь внутри проекта", () => {
    const r = sb.safeResolve("src/app.js");
    assert.ok(r.startsWith(sb.root));
});
test("разрешает новый файл во вложенной папке", () => {
    const r = sb.safeResolve("src/components/new.js");
    assert.ok(r.startsWith(sb.root));
});
test("блокирует выход вверх через ..", () => {
    assert.throws(() => sb.safeResolve("../../secret.txt"), /выходит за пределы/);
});
test("блокирует абсолютный путь", () => {
    assert.throws(() => sb.safeResolve("/etc/passwd"), /Абсолютные пути запрещены/);
});
test("isInside возвращает корректные булевы значения", () => {
    assert.strictEqual(sb.isInside("src/app.js"), true);
    assert.strictEqual(sb.isInside("../escape"), false);
});
test("assertNotSelf запрещает папку самой программы", () => {
    assert.throws(() => assertNotSelf(tmp, tmp), /самой программы/);
    assert.doesNotThrow(() => assertNotSelf(tmp, path.join(tmp, "other")));
});

console.log("\n== Бэкапы и откат ==");
test("бэкап + правка + откат возвращают исходное содержимое", () => {
    const session = backupFiles(tmp, ["src/app.js", "src/created.js"], ".aidevhelper/backups");

    // имитируем работу агента: меняем существующий файл и создаём новый
    fs.writeFileSync(path.join(tmp, "src", "app.js"), "console.log('v2-СЛОМАНО');\n", "utf8");
    fs.writeFileSync(path.join(tmp, "src", "created.js"), "new\n", "utf8");

    const result = restoreBackup(session.sessionDir);

    const restoredApp = fs.readFileSync(path.join(tmp, "src", "app.js"), "utf8");
    assert.strictEqual(restoredApp, "console.log('v1');\n", "старый файл не восстановлен");
    assert.ok(result.restored.includes("src/app.js"));

    // созданного файла на момент бэкапа не было -> откат должен его удалить
    assert.strictEqual(fs.existsSync(path.join(tmp, "src", "created.js")), false, "созданный файл не удалён при откате");
    assert.ok(result.removed.includes("src/created.js"));
});

// уборка
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nИтог: ${passed} проверок пройдено${process.exitCode ? ", ЕСТЬ ОШИБКИ" : ", всё чисто ✅"}\n`);
