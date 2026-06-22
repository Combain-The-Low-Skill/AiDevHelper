"use strict";

// Описания инструментов (в формате OpenAI function calling, который понимает Groq)
// и их исполнение поверх Workspace. Какие инструменты доступны — зависит от
// capabilities в config.json (например, runCommands пока выключен).

function buildToolSchemas(capabilities) {
    const tools = [
        {
            type: "function",
            function: {
                name: "list_dir",
                description: "Показать содержимое папки в проекте (файлы и подпапки). Путь относительный.",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string", description: "Относительный путь, '.' для корня" } },
                    required: ["path"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "read_file",
                description: "Прочитать текстовое содержимое файла. Делай это перед правкой, чтобы скопировать точный фрагмент.",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "search",
                description: "Найти строку или регулярное выражение по файлам проекта. Возвращает совпадения с путём и номером строки.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Текст или regex для поиска" },
                        isRegex: { type: "boolean", description: "Трактовать query как регулярное выражение" }
                    },
                    required: ["query"]
                }
            }
        }
    ];

    if (capabilities.editFiles) {
        tools.push({
            type: "function",
            function: {
                name: "edit_file",
                description: "Точечно изменить файл: заменить old_str на new_str. old_str должен встречаться в файле РОВНО один раз (добавь контекст, если нужно). Экономнее, чем переписывать файл целиком.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        old_str: { type: "string", description: "Точный текущий фрагмент (с отступами)" },
                        new_str: { type: "string", description: "Новый фрагмент на замену" }
                    },
                    required: ["path", "old_str", "new_str"]
                }
            }
        });
    }
    if (capabilities.createFiles) {
        tools.push({
            type: "function",
            function: {
                name: "create_file",
                description: "Создать новый файл (или полностью перезаписать существующий) с указанным содержимым.",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" }, content: { type: "string" } },
                    required: ["path", "content"]
                }
            }
        });
    }

    tools.push({
        type: "function",
        function: {
            name: "finish",
            description: "Завершить задачу. Вызови, когда все нужные правки сделаны. Кратко опиши, что было сделано.",
            parameters: {
                type: "object",
                properties: { summary: { type: "string", description: "Краткое резюме выполненной работы" } },
                required: ["summary"]
            }
        }
    });

    return tools;
}

// Поиск по файлам проекта (поверх диска; учитывает overlay для новых файлов через workspace.readFile).
function searchProject(workspace, query, isRegex) {
    const fs = require("fs");
    const path = require("path");
    const root = workspace.sandbox.root;
    const results = [];
    const matcher = isRegex ? new RegExp(query, "i") : null;

    function walk(absDir) {
        let entries;
        try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const abs = path.join(absDir, e.name);
            const rel = path.relative(root, abs).replace(/\\/g, "/");
            if (e.isDirectory()) {
                if (e.name === "node_modules" || e.name === ".git" || rel.startsWith(".aidevhelper")) continue;
                walk(abs);
            } else {
                if (results.length >= 100) return;
                let content;
                try { content = workspace.readFile(rel); } catch { continue; }
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    const hit = matcher ? matcher.test(lines[i]) : lines[i].includes(query);
                    if (hit) {
                        results.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
                        if (results.length >= 100) return;
                    }
                }
            }
        }
    }
    walk(root);
    return results;
}

// Выполнить один tool_call. Возвращает строку-результат для отправки модели обратно.
// Для finish возвращает специальный объект { done:true, summary }.
async function executeTool(name, args, workspace, capabilities) {
    switch (name) {
        case "list_dir":
            return JSON.stringify(workspace.listDir(args.path || "."));
        case "read_file":
            return workspace.readFile(args.path);
        case "search":
            return JSON.stringify(searchProject(workspace, args.query, !!args.isRegex));
        case "edit_file":
            if (!capabilities.editFiles) throw new Error("Правка файлов отключена в настройках.");
            return JSON.stringify(workspace.editFile(args.path, args.old_str, args.new_str));
        case "create_file":
            if (!capabilities.createFiles) throw new Error("Создание файлов отключено в настройках.");
            return JSON.stringify(workspace.createFile(args.path, args.content));
        case "finish":
            return { done: true, summary: args.summary || "Готово." };
        default:
            throw new Error(`Неизвестный инструмент: ${name}`);
    }
}

module.exports = { buildToolSchemas, executeTool, searchProject };
