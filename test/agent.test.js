"use strict";

// Самопроверка агентного цикла (Этап 3). Модель смоделирована скриптом, диск — во
// временной папке. Запуск: npm run test:agent

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { createSandbox } = require("../core/safety/sandbox");
const { Workspace } = require("../core/agent/workspace");
const { Agent } = require("../core/agent/agent");
const { restoreBackup } = require("../core/safety/checkpoint");

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (err) { console.error(`  ❌ ${name}\n     ${err.stack || err.message}`); process.exitCode = 1; }
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };

// Готовим временный проект.
function makeProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adhp-agent-"));
    fs.writeFileSync(path.join(dir, "app.js"), "const greeting = 'hello';\nconsole.log(greeting);\n", "utf8");
    return dir;
}

// Хелперы для ответов «модели» в формате OpenAI.
function toolCall(name, args, id) {
    return { message: { role: "assistant", content: null, tool_calls: [{ id: id || name, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
}

// «Модель» как заранее заданная последовательность шагов.
function scriptedGateway(steps) {
    let i = 0;
    return { async complete() { const s = steps[i++]; if (!s) throw new Error("скрипт модели закончился раньше времени"); return s; } };
}

(async () => {
    console.log("\n== Агентный цикл и overlay ==");

    await test("осмотр → чтение → правка → создание → finish, изменения в overlay", async () => {
        const dir = makeProject();
        const ws = new Workspace(createSandbox(dir));
        const gw = scriptedGateway([
            toolCall("list_dir", { path: "." }),
            toolCall("read_file", { path: "app.js" }),
            toolCall("edit_file", { path: "app.js", old_str: "'hello'", new_str: "'привет'" }),
            toolCall("create_file", { path: "src/util.js", content: "module.exports = {};\n" }),
            toolCall("finish", { summary: "Заменил приветствие и добавил util.js" })
        ]);
        const agent = new Agent({ gateway: gw, workspace: ws, capabilities: { editFiles: true, createFiles: true }, logger: silent });
        const res = await agent.run("замени hello на привет и добавь util");

        assert.match(res.summary, /util\.js/);
        // диск НЕ тронут (overlay)
        assert.strictEqual(fs.readFileSync(path.join(dir, "app.js"), "utf8").includes("'hello'"), true, "диск не должен меняться до commit");
        const changes = res.stagedChanges;
        assert.strictEqual(changes.length, 2, "должно быть 2 изменения");
        const edit = changes.find((c) => c.filePath === "app.js");
        assert.ok(edit.newContent.includes("'привет'") && !edit.isNew);
        const created = changes.find((c) => c.filePath === "src/util.js");
        assert.ok(created.isNew);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test("ошибка инструмента возвращается модели, и она исправляется", async () => {
        const dir = makeProject();
        const ws = new Workspace(createSandbox(dir));
        const gw = scriptedGateway([
            // неверный old_str -> вернётся ОШИБКА
            toolCall("edit_file", { path: "app.js", old_str: "НЕТ ТАКОГО", new_str: "x" }),
            // модель исправляется корректной правкой
            toolCall("edit_file", { path: "app.js", old_str: "console.log(greeting);", new_str: "console.info(greeting);" }),
            toolCall("finish", { summary: "Поправил вывод" })
        ]);
        const agent = new Agent({ gateway: gw, workspace: ws, capabilities: { editFiles: true, createFiles: true }, logger: silent });
        const res = await agent.run("замени log на info");
        assert.strictEqual(res.stagedChanges.length, 1);
        assert.ok(res.stagedChanges[0].newContent.includes("console.info"));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test("дубль фрагмента в edit_file отклоняется (нужен уникальный контекст)", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adhp-dup-"));
        fs.writeFileSync(path.join(dir, "a.js"), "x=1;\nx=1;\n", "utf8");
        const ws = new Workspace(createSandbox(dir));
        assert.throws(() => ws.editFile("a.js", "x=1;", "x=2;"), /встречается.*2 раз/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    console.log("\n== Применение: manual / auto / откат ==");

    await test("auto: commit пишет на диск, бэкап позволяет откатить", async () => {
        const dir = makeProject();
        const ws = new Workspace(createSandbox(dir));
        ws.editFile("app.js", "'hello'", "'привет'");
        ws.createFile("new.txt", "новый\n");
        const { applied, backupSession } = ws.commit(".aidevhelper/backups");

        assert.deepStrictEqual(applied.sort(), ["app.js", "new.txt"]);
        assert.ok(fs.readFileSync(path.join(dir, "app.js"), "utf8").includes("'привет'"), "диск должен обновиться");
        assert.ok(fs.existsSync(path.join(dir, "new.txt")));

        // откат
        const r = restoreBackup(backupSession.sessionDir);
        assert.ok(fs.readFileSync(path.join(dir, "app.js"), "utf8").includes("'hello'"), "откат вернул старое содержимое");
        assert.strictEqual(fs.existsSync(path.join(dir, "new.txt")), false, "созданный файл удалён при откате");
        assert.ok(r.restored.includes("app.js") && r.removed.includes("new.txt"));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test("песочница не даёт выйти за пределы проекта через инструмент", async () => {
        const dir = makeProject();
        const ws = new Workspace(createSandbox(dir));
        assert.throws(() => ws.createFile("../escape.txt", "x"), /выходит за пределы|Абсолютные/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    console.log(`\nИтог: ${passed} проверок пройдено${process.exitCode ? ", ЕСТЬ ОШИБКИ" : ", всё чисто ✅"}\n`);
})();
