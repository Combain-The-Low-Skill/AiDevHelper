// 1. Первой строчкой подключаем защиту. Она прочитает файл .env и загрузит ключ в память
require('dotenv').config(); 

const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ПРОВЕРКА БЕЗОПАСНОСТИ:
// Теперь ключ берется из скрытой переменной процесса process.env
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey || apiKey.startsWith("СЮДА")) {
    console.error("❌ ОШИБКА БЕЗОПАСНОСТИ: Вы не создали файл .env или забыли указать там GEMINI_API_KEY!");
    process.exit(1);
}

const TARGET_DIR = "D:\\AiHelper\\MyProject";

if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
}

// Передаем защищенный ключ в ИИ
const ai = new GoogleGenAI({ apiKey: apiKey });

function scanDirectory(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (file === "node_modules" || file === ".git") return;

        if (stat.isDirectory()) {
            scanDirectory(filePath, fileList);
        } else {
            if (file.endsWith(".js") || file.endsWith(".html") || file.endsWith(".css") || file.endsWith(".json")) {
                const content = fs.readFileSync(filePath, "utf8");
                fileList.push({ relativePath: path.relative(TARGET_DIR, filePath), content });
            }
        }
    });
    return fileList;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function startConversation() {
    console.log(`\n📂 Сканирую рабочую директорию: ${TARGET_DIR}`);
    let projectFiles = scanDirectory(TARGET_DIR);
    
    if (projectFiles.length === 0) {
        const defaultFile = path.join(TARGET_DIR, "index.html");
        fs.writeFileSync(defaultFile, "<!DOCTYPE html>\n<html>\n<head><title>Мой проект</title></head>\n<body>\n\n</body>\n</html>", "utf8");
        projectFiles = scanDirectory(TARGET_DIR);
    }

    let projectContext = "Вот структура и код файлов в моем проекте:\n\n";
    projectFiles.forEach(f => {
        projectContext += `--- ФАЙЛ: ${f.relativePath} ---\n${f.content}\n\n`;
    });

    rl.question("\n💻 Что ИИ должен сделать в проекте? ", async (task) => {
        if (task.trim() === "exit") { rl.close(); return; }

        console.log("🤖 ИИ анализирует файлы и вносит изменения...");

        const systemInstruction = `Ты — эксперт-разработчик. Тебе передан контекст проекта. 
        Выполни задачу пользователя. Ты должен вернуть ответ СТРОГО в формате JSON-массива объектов. 
        Не пиши никаких объяснений словами, не используй разметку markdown. Только чистый JSON.
        Формат ответа:
        [
          {
            "filePath": "относительный_путь_к_файлу",
            "newContent": "полный новый код файла с твоими изменениями"
          }
        ]`;

        try {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: `${projectContext}\n\nЗадача от пользователя: ${task}`,
                config: { systemInstruction }
            });

            let cleanText = response.text.trim();
            if (cleanText.startsWith("```json")) cleanText = cleanText.substring(7);
            if (cleanText.startsWith("```")) cleanText = cleanText.substring(3);
            if (cleanText.endsWith("```")) cleanText = cleanText.substring(0, cleanText.length - 3);

            const changes = JSON.parse(cleanText.trim());

            changes.forEach(change => {
                const absolutePath = path.join(TARGET_DIR, change.filePath);
                fs.writeFileSync(absolutePath, change.newContent, "utf8");
                console.log(`✅ Обновлен файл: ${change.filePath}`);
            });

            console.log("\n🎉 Изменения успешно внесены!");
        } catch (error) {
            console.error("❌ Ошибка выполнения:", error.message);
        }

        startConversation();
    });
}

startConversation();
