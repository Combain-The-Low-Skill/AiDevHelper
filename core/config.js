"use strict";

// Загрузка и валидация конфигурации.
// - читает config.json (провайдеры, лимиты, полномочия, безопасность)
// - подхватывает .env через dotenv (ключи API)
// - даёт удобный доступ к активному провайдеру и проверяет наличие его ключа
//
// Важно: наличие ключа API проверяется ЛЕНИВО (только когда провайдер реально
// нужен для запроса), чтобы фундамент и тесты можно было гонять без ключей.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ quiet: true });

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");

function readConfigFile() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Не найден config.json по пути ${CONFIG_PATH}`);
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
        throw new Error(`config.json содержит невалидный JSON: ${err.message}`);
    }
    validateConfig(raw);
    return raw;
}

function validateConfig(cfg) {
    if (!cfg.providers || typeof cfg.providers !== "object") {
        throw new Error("В config.json отсутствует секция providers.");
    }
    if (!cfg.activeProvider || !cfg.providers[cfg.activeProvider]) {
        throw new Error(
            `activeProvider="${cfg.activeProvider}" не описан в секции providers. ` +
            `Доступные: ${Object.keys(cfg.providers).join(", ")}`
        );
    }
    for (const [name, p] of Object.entries(cfg.providers)) {
        if (name.startsWith("_")) continue;
        if (!p.baseUrl || !p.apiKeyEnv || !p.model) {
            throw new Error(`Провайдер "${name}" должен содержать baseUrl, apiKeyEnv и model.`);
        }
        if (!p.limits || typeof p.limits !== "object") {
            throw new Error(`У провайдера "${name}" отсутствует секция limits (rpm/tpm/rpd).`);
        }
    }
}

const config = readConfigFile();

const ENV_PATH = path.join(PROJECT_ROOT, ".env");

// Запись/обновление ключа в секретный .env (создаёт файл, если его нет) и в process.env,
// чтобы ключ заработал без перезапуска. Значение ключа нигде не логируется.
function saveApiKey(envVar, value) {
    let lines = [];
    if (fs.existsSync(ENV_PATH)) lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
    const entry = `${envVar}=${value}`;
    const idx = lines.findIndex((l) => l.startsWith(envVar + "="));
    if (idx >= 0) lines[idx] = entry; else lines.push(entry);
    fs.writeFileSync(ENV_PATH, lines.filter((l) => l !== "").join("\n") + "\n", { mode: 0o600 });
    process.env[envVar] = value;
}

// Возвращает описание активного провайдера + его ключ из .env.
// requireKey=true бросит понятную ошибку, если ключ не задан.
function getActiveProvider(requireKey = true) {
    const name = config.activeProvider;
    const provider = { name, ...config.providers[name] };
    const apiKey = process.env[provider.apiKeyEnv];

    if (requireKey && !apiKey) {
        throw new Error(
            `Не задан ключ API для провайдера "${name}". ` +
            `Добавь ${provider.apiKeyEnv}=... в файл .env (шаблон — в .env.example).`
        );
    }
    provider.apiKey = apiKey || null;
    return provider;
}

module.exports = {
    PROJECT_ROOT,
    ENV_PATH,
    config,
    capabilities: config.capabilities || {},
    safety: config.safety || {},
    getActiveProvider,
    saveApiKey
};
