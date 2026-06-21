require('dotenv').config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const { exec } = require("child_process"); // Модуль для запуска системных окон Windows

const apiKey = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Функция рекурсивного обхода и чтения файлов в папке
function scanDirectory(dir, targetDir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        if (file === "node_modules" || file === ".git") return;
        if (fs.statSync(filePath).isDirectory()) {
            scanDirectory(filePath, targetDir, fileList);
        } else {
            // Читаем только файлы веб-кода
            if (file.endsWith(".js") || file.endsWith(".html") || file.endsWith(".css") || file.endsWith(".json")) {
                const content = fs.readFileSync(filePath, "utf8");
                fileList.push({ relativePath: path.relative(targetDir, filePath), content });
            }
        }
    });
    return fileList;
}

// Новая функция: открывает стандартное окно проводника в правильном графическом режиме Windows
const openFolderDialogWindows = () => {
    return new Promise((resolve, reject) => {
        // Скрипт использует Shell.Application — это более легкий и надежный способ вызова проводника в Windows без зависаний потоков
        const psScript = `
        $app = New-Object -ComObject Shell.Application;
        $folder = $app.BrowseForFolder(0, 'Выберите рабочую папку вашего проекта', 0, 17);
        if ($folder) {
            Write-Output $folder.Self.Path;
        }
        `;
        
        // Добавлен флаг -NonInteractive, чтобы PowerShell не зависал в фоне, ожидая консольного ввода
        exec(`powershell -ExecutionPolicy Bypass -NonInteractive -Command "${psScript.replace(/\n/g, ' ')}"`, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        });
    });
};

// Создаем HTTP веб-сервер
const server = http.createServer((req, res) => {
    // Настройки CORS, чтобы ваш браузер мог свободно общаться с сервером
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    // МАРШРУТ 1: Открытие системного Проводника Windows
    if (req.url === "/api/select-folder" && req.method === "GET") {
        openFolderDialogWindows()
            .then(folderPath => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, path: folderPath || null }));
            })
            .catch(err => {
                console.error("Ошибка открытия проводника:", err.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
        return;
    }

    // МАРШРУТ 2: Передача контекста папки и задачи в ИИ Gemini
    if (req.url === "/api/task" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk.toString(); });
        req.on("end", async () => {
            try {
                const { task, targetDir } = JSON.parse(body);

                if (!targetDir || !fs.existsSync(targetDir)) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: false, error: "Выбранная папка не найдена на диске компьютере!" }));
                    return;
                }

                console.log(`\n📂 Обрабатываем директорию: ${targetDir}`);
                console.log(`🤖 Команда от пользователя: "${task}"`);

                let projectFiles = scanDirectory(targetDir, targetDir);
                
                // Если пользователь выбрал пустую папку, создаем стартовую заглушку
                if (projectFiles.length === 0) {
                    const defaultFile = path.join(targetDir, "index.html");
                    fs.writeFileSync(defaultFile, "<!DOCTYPE html>\n<html>\n<head><title>Новый проект</title></head>\n<body>\n\n</body>\n</html>", "utf8");
                    projectFiles = scanDirectory(targetDir, targetDir);
                }

                let projectContext = "Вот текущая структура и код файлов в моем проекте:\n\n";
                projectFiles.forEach(f => {
                    projectContext += `--- ФАЙЛ: ${f.relativePath} ---\n${f.content}\n\n`;
                });

                const systemInstruction = `Ты — эксперт-разработчик. Тебе передан контекст проекта. 
                Выполни задачу пользователя. Ты должен вернуть ответ СТРОГО в формате JSON-массива объектов, без markdown разметки.
                Формат ответа: [{"filePath": "относительный_путь", "newContent": "абсолютно полный новый код файла"}]`;

                const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: GROQ_MODEL,
                        messages: [
                            { role: "system", content: systemInstruction },
                            { role: "user", content: `${projectContext}\n\nЗадача от пользователя: ${task}` }
                        ],
                        temperature: 0.2
                    })
                });

                const groqData = await response.json();

                if (!response.ok) {
                    throw new Error(groqData.error?.message || `Groq HTTP ошибка ${response.status}`);
                }

                let cleanText = groqData.choices[0].message.content.trim();
                if (cleanText.startsWith("```json")) cleanText = cleanText.substring(7);
                if (cleanText.startsWith("```")) cleanText = cleanText.substring(3);
                if (cleanText.endsWith("```")) cleanText = cleanText.substring(0, cleanText.length - 3);

                const changes = JSON.parse(cleanText.trim());
                changes.forEach(change => {
                    const absolutePath = path.join(targetDir, change.filePath);
                    // Перезаписываем или создаем файлы на жестком диске
                    fs.writeFileSync(absolutePath, change.newContent, "utf8");
                    console.log(`✅ Успешно изменен файл: ${change.filePath}`);
                });

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, files: changes.map(c => c.filePath) }));

            } catch (error) {
                console.error("❌ Ошибка бэкэнда:", error.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(3000, () => {
    console.log("🚀 Бэкэнд-сервер успешно запущен на http://localhost:3000");
    console.log("💡 Откройте файл index.html в браузере и выберите папку для начала работы.");
});