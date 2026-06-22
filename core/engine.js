"use strict";

const path = require("path");
const { loadState, saveState } = require("./util");
const logger = require("./logger");
const { config, getActiveProvider, PROJECT_ROOT } = require("./config");
const { TokenEstimator } = require("./tokenEstimator");
const { RateScheduler } = require("./scheduler");
const { Gateway } = require("./gateway");
const { Queue, Worker } = require("./queue");
const { createSandbox, assertNotSelf } = require("./safety/sandbox");
const { Workspace } = require("./agent/workspace");
const { Agent } = require("./agent/agent");
const { applyChanges } = require("./applyChanges");

// Сборка движка из конфига. Состояние планировщика и калибровки оценки токенов
// сохраняется на диск и восстанавливается при старте — чтобы учёт RPD (суточного
// лимита) и накопленная калибровка переживали перезапуск программы.
//
// Параметры (для тестов можно подменить fetchFn / sleep / now / requireKey):
function createEngine(opts = {}) {
    const provider = getActiveProvider(opts.requireKey !== false);

    const stateDir = path.join(PROJECT_ROOT, ".aidevhelper", "state");
    const schedStatePath = opts.schedStatePath || path.join(stateDir, `scheduler.${provider.name}.json`);
    const queuePath = opts.queuePath || path.join(stateDir, "queue.json");

    // восстановление калибровки оценки токенов
    const saved = loadState(schedStatePath, {});
    const estimator = TokenEstimator.fromJSON(saved.estimator);

    const scheduler = new RateScheduler(provider.limits, {
        logger,
        now: opts.now,
        sleep: opts.sleep
    });
    scheduler.loadJSON(saved.scheduler);

    const persistState = () => {
        saveState(schedStatePath, { scheduler: scheduler.toJSON(), estimator: estimator.toJSON() });
    };

    const gateway = new Gateway({
        provider,
        scheduler,
        estimator,
        fetchFn: opts.fetchFn,
        sleep: opts.sleep,
        now: opts.now,
        logger,
        retry: config.retry
    });

    const queue = new Queue({ filePath: queuePath, logger });

    // Раннер для базового типа задачи "llm": один вызов модели. На Этапе 3 поверх
    // появился раннер "agent" (ниже), который внутри делает много таких вызовов с инструментами.
    const runners = {
        async llm(payload) {
            const result = await gateway.complete({
                messages: payload.messages,
                maxTokens: payload.maxTokens,
                temperature: payload.temperature
            });
            persistState();
            return { text: result.text, usage: result.usage };
        },
        async agent(payload) {
            const res = await runAgent(payload);
            persistState();
            return res;
        }
    };

    const agentCfg = config.agent || {};
    const capabilities = config.capabilities || {};
    const backupBaseDir = (config.safety && config.safety.backupDir) || ".aidevhelper/backups";

    // Запуск агента над задачей в выбранной папке.
    // applyMode 'auto' -> сразу пишем на диск (с бэкапом); 'manual' -> возвращаем
    // предложенные изменения для подтверждения, на диск не пишем.
    async function runAgent({ task, targetDir, applyMode, onProgress }) {
        if (!targetDir) throw new Error("Не указана рабочая папка (targetDir).");
        if (!provider.apiKey) throw new Error("Ключ API не задан. Введите его в интерфейсе справа.");
        assertNotSelf(targetDir, PROJECT_ROOT);
        const sandbox = createSandbox(targetDir);
        const workspace = new Workspace(sandbox);
        const mode = applyMode || agentCfg.applyMode || "manual";

        const agent = new Agent({
            gateway,
            workspace,
            capabilities,
            logger,
            maxIterations: agentCfg.maxIterations,
            maxTokensPerCall: agentCfg.maxTokensPerCall,
            onProgress
        });

        const result = await agent.run(task);

        if (mode === "auto" && workspace.hasChanges()) {
            const { applied, backupSession } = workspace.commit(backupBaseDir);
            return { mode, summary: result.summary, applied, backupDir: backupSession && backupSession.sessionDir, usage: result.usage };
        }
        // manual: ничего не пишем, отдаём предложение
        return { mode, summary: result.summary, changes: result.stagedChanges, usage: result.usage };
    }

    // Подтверждённое применение изменений (для manual-режима).
    function applyAgentChanges(targetDir, changes) {
        assertNotSelf(targetDir, PROJECT_ROOT);
        return applyChanges(targetDir, changes, backupBaseDir);
    }

    const worker = new Worker({ queue, runners, logger, sleep: opts.sleep });

    return { provider, estimator, scheduler, gateway, queue, worker, persistState, runAgent, applyAgentChanges, applyMode: agentCfg.applyMode || "manual" };
}

module.exports = { createEngine };
