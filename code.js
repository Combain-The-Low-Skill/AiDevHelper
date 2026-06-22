require('dotenv').config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const { exec } = require("child_process"); // Модуль для запуска системных окон Windows

const apiKey = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Лимит токенов в минуту (TPM) зависит от тарифа аккаунта Groq — на бесплатном/on_demand
// тарифе это часто 12000. Можно переопределить через .env, если у вас другой тариф.
const TPM_LIMIT = parseInt(process.env.GROQ_TPM_LIMIT, 10) || 12000;

// Расширения, которые точно являются бинарными — их содержимое никогда не читаем как текст,
// даже если пользователь явно отметил такой файл галочкой в дереве.
const BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
    ".mp4", ".mp3", ".wav", ".avi", ".mov", ".mkv", ".flac", ".ogg",
    ".zip", ".rar", ".7z", ".tar", ".gz",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".exe", ".dll", ".so", ".bin", ".dat",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".node", ".pyc", ".class", ".jar"
]);

function isLikelyBinary(filePath) {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// Грубая оценка количества токенов по размеру текста в байтах. ВАЖНО: точное число токенов
// зависит от токенизатора конкретной модели (BPE-словарь), и для текста с кириллицей и плотным
// кодом (много скобок, отступов, спецсимволов) расход токенов оказывается заметно выше, чем для
// чистого английского текста. На практике у пользователей с русскими комментариями реальный
// расход у Groq был в 3+ раза больше, чем давала прежняя формула (3.5 байта/токен) — поэтому
// начальный коэффициент снижен до консервативного значения. Это ПРИМЕРНАЯ оценка для
// предупреждения пользователя заранее — точное число токенов известно только самому Groq.
//
// Переменная (не константа): когда Groq реально отказывает по лимиту TPM, он присылает точное
// число запрошенных токенов в тексте ошибки — это используется для автокалибровки коэффициента
// на лету (см. обработку ошибки 413/429 ниже), чтобы оценка становилась точнее по ходу работы.
//
// Начальное значение 0.3 байт/токен выбрано не "с потолка": оно откалибровано по реальному
// случаю, где Groq отказал на тексте с кириллицей и кодом — реальный расход токенов оказался
// примерно в 3.3 раза больше, чем давала прежняя формула (1 байт/токен). Если ваш проект
// преимущественно на английском без кириллицы, оценка может быть избыточно строгой —
// после первого же реального ответа Groq она автоматически скорректируется точнее.
const DEFAULT_BYTES_PER_TOKEN = 0.3;
let calibratedBytesPerToken = DEFAULT_BYTES_PER_TOKEN;

function estimateTokensFromSize(sizeInBytes) {
    return Math.ceil(sizeInBytes / calibratedBytesPerToken);
}

// Та же оценка, но по реальной строке текста (для системного промпта, задачи, итогового контекста) —
// считаем байты в UTF-8, а не количество символов, так как кириллица занимает больше байт на символ.
function estimateTokensFromText(text) {
    return estimateTokensFromSize(Buffer.byteLength(text, "utf8"));
}

// Модели иногда возвращают невалидный JSON: внутри строковых литералов оказываются
// "сырые" управляющие символы (настоящий перевод строки 0x0A, таб 0x09 и т.п.)
// вместо экранированных \n, \t. JSON.parse падает с "Bad control character in string literal".
// Эта функция аккуратно экранирует такие символы ТОЛЬКО внутри строковых литералов,
// не трогая структуру самого JSON (запятые, скобки, кавычки вне строк).
function sanitizeJsonControlChars(text) {
    let result = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const code = text.charCodeAt(i);

        if (inString) {
            if (escaped) {
                result += ch;
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                result += ch;
                escaped = true;
                continue;
            }
            if (ch === '"') {
                result += ch;
                inString = false;
                continue;
            }
            // Управляющие символы (0x00-0x1F) внутри строки невалидны в "сыром" виде — экранируем их
            if (code <= 0x1F) {
                if (ch === "\n") { result += "\\n"; continue; }
                if (ch === "\r") { result += "\\r"; continue; }
                if (ch === "\t") { result += "\\t"; continue; }
                result += "\\u" + code.toString(16).padStart(4, "0");
                continue;
            }
            result += ch;
        } else {
            if (ch === '"') {
                inString = true;
            }
            result += ch;
        }
    }
    return result;
}

// Пытается распарсить ответ модели как JSON, с резервной попыткой через sanitizeJsonControlChars,
// если первая попытка падает именно из-за управляющих символов. Бросает понятную ошибку с фрагментом
// проблемного текста, если не получилось распарсить никак.
function parseModelJson(rawText) {
    try {
        return JSON.parse(rawText);
    } catch (firstError) {
        try {
            return JSON.parse(sanitizeJsonControlChars(rawText));
        } catch (secondError) {
            const snippet = rawText.slice(0, 300).replace(/\s+/g, " ");
            throw new Error(
                `Модель вернула невалидный JSON (${firstError.message}). ` +
                `Начало ответа: "${snippet}${rawText.length > 300 ? "..." : ""}"`
            );
        }
    }
}

// Строит дерево файлов и папок (без чтения содержимого) — используется для отображения
// в интерфейсе, чтобы пользователь сам отметил галочками нужные файлы/папки.
// Показываем абсолютно всё — никаких папок по умолчанию не скрываем, пользователь сам решает.
function buildFileTree(dir, targetDir) {
    const stat = fs.statSync(dir);
    const relativePath = path.relative(targetDir, dir);
    const name = path.basename(dir);

    if (stat.isDirectory()) {
        let children = [];
        try {
            children = fs.readdirSync(dir)
                .sort((a, b) => a.localeCompare(b))
                .map(child => buildFileTree(path.join(dir, child), targetDir))
                .filter(Boolean);
        } catch (err) {
            // Папка может быть недоступна (права доступа и т.п.) — просто пропускаем её содержимое
            children = [];
        }
        return {
            name,
            relativePath: relativePath === "" ? "." : relativePath,
            type: "directory",
            children
        };
    }

    return {
        name,
        relativePath,
        type: "file",
        size: stat.size,
        binary: isLikelyBinary(dir),
        estimatedTokens: isLikelyBinary(dir) ? 0 : estimateTokensFromSize(stat.size)
    };
}

// Читает только те файлы, которые пользователь явно отметил в дереве (selectedFiles —
// список относительных путей). Бинарные файлы пропускаются с предупреждением, а не ломают весь запрос.
function readSelectedFiles(targetDir, selectedFiles) {
    const fileList = [];
    const warnings = [];

    selectedFiles.forEach(relativePath => {
        const absolutePath = path.join(targetDir, relativePath);

        // Защита от выхода за пределы выбранной директории (например, "../../что-то")
        const resolved = path.resolve(absolutePath);
        if (!resolved.startsWith(path.resolve(targetDir))) {
            warnings.push(`Пропущен файл с недопустимым путём: ${relativePath}`);
            return;
        }

        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            warnings.push(`Файл не найден, пропущен: ${relativePath}`);
            return;
        }

        if (isLikelyBinary(resolved)) {
            warnings.push(`Бинарный файл пропущен (не читается как текст): ${relativePath}`);
            return;
        }

        try {
            const content = fs.readFileSync(resolved, "utf8");
            fileList.push({ relativePath, content });
        } catch (err) {
            warnings.push(`Не удалось прочитать файл ${relativePath}: ${err.message}`);
        }
    });

    return { fileList, warnings };
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

    // МАРШРУТ 1.4: Сброс автокалибровки оценки токенов к стартовому значению —
    // на случай если калибровка ушла в неудачную сторону и оценка стала неадекватной.
    if (req.url === "/api/reset-token-calibration" && req.method === "POST") {
        calibratedBytesPerToken = DEFAULT_BYTES_PER_TOKEN;
        console.log(`📐 Калибровка оценки токенов сброшена к стартовому значению: ${DEFAULT_BYTES_PER_TOKEN}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, calibratedBytesPerToken }));
        return;
    }

    // МАРШРУТ 1.5: Построение дерева файлов выбранной папки (для отображения чекбоксов на фронте)
    if (req.url.startsWith("/api/scan-tree") && req.method === "GET") {
        try {
            const reqUrl = new URL(req.url, "http://localhost:3000");
            const targetDir = reqUrl.searchParams.get("dir");

            if (!targetDir || !fs.existsSync(targetDir)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Папка не найдена на диске." }));
                return;
            }

            const selfDir = path.resolve(__dirname);
            if (path.resolve(targetDir) === selfDir) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Нельзя выбирать папку самой программы как рабочую директорию." }));
                return;
            }

            const tree = buildFileTree(targetDir, targetDir);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                success: true,
                tree,
                tpmLimit: TPM_LIMIT,
                calibratedBytesPerToken,
                isDefaultCalibration: calibratedBytesPerToken === DEFAULT_BYTES_PER_TOKEN
            }));
        } catch (error) {
            console.error("❌ Ошибка построения дерева файлов:", error.message);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // МАРШРУТ 2: Передача контекста папки и задачи в ИИ (с потоковым прогрессом, БЕЗ записи на диск)
    if (req.url === "/api/task" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk.toString(); });
        req.on("end", async () => {
            // Стримим ответ построчно (NDJSON), чтобы фронтенд видел прогресс в реальном времени
            res.writeHead(200, { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" });
            const send = (obj) => res.write(JSON.stringify(obj) + "\n");

            try {
                const { task, targetDir, selectedFiles } = JSON.parse(body);

                if (!targetDir || !fs.existsSync(targetDir)) {
                    send({ type: "error", error: "Выбранная папка не найдена на диске компьютере!" });
                    res.end();
                    return;
                }

                // Защита: не даём программе работать со своей же директорией
                const selfDir = path.resolve(__dirname);
                if (path.resolve(targetDir) === selfDir) {
                    send({ type: "error", error: "Нельзя выбирать папку самой программы как рабочую директорию — это может сломать сервер во время работы." });
                    res.end();
                    return;
                }

                if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
                    send({ type: "error", error: "Не выбрано ни одного файла. Отметьте галочками файлы, которые нужно передать ИИ." });
                    res.end();
                    return;
                }

                send({ type: "progress", message: `📂 Читаем выбранные файлы (${selectedFiles.length}) из: ${targetDir}` });
                console.log(`\n📂 Обрабатываем директорию: ${targetDir}`);
                console.log(`🤖 Команда от пользователя: "${task}"`);

                const { fileList: projectFiles, warnings } = readSelectedFiles(targetDir, selectedFiles);

                warnings.forEach(w => send({ type: "progress", message: `⚠️ ${w}` }));

                if (projectFiles.length === 0) {
                    send({ type: "error", error: "Не удалось прочитать ни один из выбранных файлов (возможно, все они бинарные или недоступны)." });
                    res.end();
                    return;
                }

                send({ type: "progress", message: `📑 Прочитано файлов: ${projectFiles.length}. Формируем контекст...` });

                let projectContext = "Project files:\n\n";
                projectFiles.forEach(f => {
                    projectContext += `--- FILE: ${f.relativePath} ---\n${f.content}\n\n`;
                });

                const systemInstruction = `You are an expert developer. You will receive project file context and a task.
Return ONLY a valid JSON array, no markdown, no code fences.
Format: [{"filePath":"relative/path","newContent":"full new file content"}]
All newlines inside "newContent" MUST be escaped as \\n (not raw line breaks). All quotes inside code MUST be escaped as \\". The result must pass JSON.parse without errors.`;

                const userContent = `${projectContext}\n\nTask: ${task}`;
                const estimatedInputTokens = estimateTokensFromText(systemInstruction) + estimateTokensFromText(userContent);

                send({ type: "progress", message: `🧮 Примерная оценка входа: ~${estimatedInputTokens} токенов (лимит ${TPM_LIMIT}/мин).` });

                // Если уже сам вход вплотную подходит к лимиту TPM, дальше пытаться нет смысла —
                // Groq всё равно откажет с "Request too large". Оставляем небольшой запас (10%)
                // на неточность нашей оценки токенов.
                if (estimatedInputTokens > TPM_LIMIT * 0.9) {
                    send({
                        type: "error",
                        error: `Слишком большой объём выбранных файлов: примерно ${estimatedInputTokens} токенов при лимите ${TPM_LIMIT} токенов в минуту на вашем тарифе Groq. Снимите часть галочек в дереве файлов и попробуйте снова, либо разбейте задачу на несколько меньших запросов.`
                    });
                    res.end();
                    return;
                }

                // Остаток лимита после входа отдаём под ответ модели, но не больше 32768 (максимум модели)
                // и не меньше 1024 (иначе модель не успеет вернуть даже короткий валидный JSON).
                const maxOutputTokens = Math.max(1024, Math.min(32768, TPM_LIMIT - estimatedInputTokens));

                send({ type: "progress", message: "🤖 Отправляем запрос модели (Groq)..." });

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
                            { role: "user", content: userContent }
                        ],
                        temperature: 0.2,
                        // Динамический лимит выходных токенов — подбирается так, чтобы вход + выход
                        // не превышали TPM-лимит аккаунта, но при этом не резался сильнее необходимого.
                        max_tokens: maxOutputTokens
                    })
                });

                const groqData = await response.json();

                if (!response.ok) {
                    const rawMessage = groqData.error?.message || `Groq HTTP ошибка ${response.status}`;

                    // Groq в тексте ошибки про лимит TPM присылает ТОЧНОЕ число токенов, которое
                    // он реально посчитал ("Requested 42302"). Это куда надёжнее нашей локальной
                    // оценки по байтам — извлекаем эти числа, чтобы: 1) показать пользователю точную
                    // причину, 2) скорректировать коэффициент оценки на будущие запросы в этой сессии,
                    // чтобы предохранитель срабатывал раньше и точнее.
                    const tpmMatch = rawMessage.match(/Limit (\d+).*?Requested (\d+)/s);
                    if (tpmMatch) {
                        const realLimit = parseInt(tpmMatch[1], 10);
                        const realRequested = parseInt(tpmMatch[2], 10);
                        if (estimatedInputTokens + maxOutputTokens > 0) {
                            const actualRatio = realRequested / (estimatedInputTokens + maxOutputTokens);
                            const observedEstimate = calibratedBytesPerToken / actualRatio;
                            // Сглаживаем калибровку (экспоненциальное скользящее усреднение) вместо полной
                            // перезаписи — единичный нетипичный запрос (мало/много кириллицы) не должен
                            // мгновенно перекраивать оценку для всех остальных файлов. Берём 40% нового
                            // измерения и 60% прежнего значения, и ограничиваем разумным диапазоном
                            // (0.25–1.2 байт/токен), чтобы коэффициент не мог улететь в абсурд от выброса.
                            if (observedEstimate > 0.1 && observedEstimate < 6) {
                                const smoothed = calibratedBytesPerToken * 0.6 + observedEstimate * 0.4;
                                const clamped = Math.min(1.2, Math.max(0.25, smoothed));
                                console.log(`📐 Калибровка оценки токенов: ${calibratedBytesPerToken.toFixed(3)} → ${clamped.toFixed(3)} байт/токен (наблюдение: ${observedEstimate.toFixed(3)}).`);
                                calibratedBytesPerToken = clamped;
                            }
                        }
                        throw new Error(
                            `Groq отказал по лимиту токенов в минуту: реально запрошено ${realRequested}, лимит ${realLimit}. ` +
                            `Наша оценка перед отправкой была занижена — счётчик в интерфейсе пересчитан более строго для следующих попыток. ` +
                            `Снимите часть файлов и попробуйте снова.`
                        );
                    }

                    throw new Error(rawMessage);
                }

                // Если модель не успела закончить ответ (упёрлась в лимит токенов), ответ точно будет
                // обрезан на середине JSON — сообщаем об этом сразу, не пытаясь парсить заведомо неполный текст.
                const finishReason = groqData.choices?.[0]?.finish_reason;
                if (finishReason === "length") {
                    throw new Error(
                        "Ответ модели был обрезан по лимиту токенов — слишком большой объём кода для одного запроса. " +
                        "Попробуйте выбрать меньше файлов за раз или разбить задачу на несколько более мелких шагов."
                    );
                }

                send({ type: "progress", message: "📥 Получен ответ, разбираем изменения..." });

                let cleanText = groqData.choices[0].message.content.trim();
                if (cleanText.startsWith("```json")) cleanText = cleanText.substring(7);
                if (cleanText.startsWith("```")) cleanText = cleanText.substring(3);
                if (cleanText.endsWith("```")) cleanText = cleanText.substring(0, cleanText.length - 3);

                const changes = parseModelJson(cleanText.trim());

                // Собираем preview: для уже существующих файлов сохраняем старое содержимое для diff на фронте
                const filesByPath = {};
                projectFiles.forEach(f => { filesByPath[f.relativePath] = f.content; });

                const preview = changes.map(change => ({
                    filePath: change.filePath,
                    newContent: change.newContent,
                    oldContent: filesByPath[change.filePath] || null,
                    isNew: !(change.filePath in filesByPath)
                }));

                send({ type: "progress", message: `✅ Сформировано предложение по ${preview.length} файлам. Ожидаем подтверждения.` });
                send({ type: "result", targetDir, changes: preview });
                res.end();

            } catch (error) {
                console.error("❌ Ошибка бэкэнда:", error.message);
                send({ type: "error", error: error.message });
                res.end();
            }
        });
        return;
    }

    // МАРШРУТ 3: Применение подтверждённых изменений — реальная запись на диск
    if (req.url === "/api/apply" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk.toString(); });
        req.on("end", () => {
            try {
                const { targetDir, changes } = JSON.parse(body);

                if (!targetDir || !fs.existsSync(targetDir)) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: false, error: "Папка не найдена на диске." }));
                    return;
                }

                const applied = [];
                changes.forEach(change => {
                    const absolutePath = path.join(targetDir, change.filePath);
                    // Создаём промежуточные папки, если модель предложила файл во вложенной директории
                    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
                    fs.writeFileSync(absolutePath, change.newContent, "utf8");
                    applied.push(change.filePath);
                    console.log(`✅ Успешно изменен файл: ${change.filePath}`);
                });

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, files: applied }));
            } catch (error) {
                console.error("❌ Ошибка применения изменений:", error.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(3000, () => {
    console.log("🚀 Бэкэнд-сервер успешно запущен на http://localhost:3000");
    console.log("💡 Откройте файл index.html в браузере и выберите папку для начала работы.");
});