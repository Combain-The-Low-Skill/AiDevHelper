"use strict";

const { loadState, saveState, realSleep } = require("./util");

// Персистентная очередь задач. Хранится в JSON-файле, поэтому переживает перезапуск
// программы — недоделанные задачи продолжатся с того места, где остановились.
//
// Состояния задачи: pending -> running -> done | failed
// (waiting в отдельный статус не выделяем: ожидание лимитов происходит ВНУТРИ
//  обработки через планировщик, задача при этом остаётся running.)
//
// Воркер по очереди берёт pending-задачи и выполняет их через зарегистрированный
// «раннер» по типу задачи. Благодаря планировщику воркер автоматически тормозит под
// лимиты — очередь разгребается «медленно, но верно», часами, без участия человека.

class Queue {
    constructor({ filePath, logger }) {
        this.filePath = filePath;
        this.logger = logger || { info() {} };
        const state = loadState(filePath, { jobs: [], seq: 0 });
        this.jobs = state.jobs || [];
        this.seq = state.seq || 0;
    }

    _persist() {
        saveState(this.filePath, { jobs: this.jobs, seq: this.seq });
    }

    enqueue(job) {
        const id = ++this.seq;
        const record = {
            id,
            type: job.type,
            payload: job.payload || {},
            status: "pending",
            createdAt: new Date().toISOString(),
            attempts: 0,
            result: null,
            error: null
        };
        this.jobs.push(record);
        this._persist();
        this.logger.info(`📥 Задача #${id} (${job.type}) добавлена в очередь.`);
        return id;
    }

    nextPending() {
        return this.jobs.find((j) => j.status === "pending");
    }

    get(id) {
        return this.jobs.find((j) => j.id === id);
    }

    list() {
        return this.jobs.slice();
    }

    update(id, patch) {
        const job = this.get(id);
        if (!job) return;
        Object.assign(job, patch);
        this._persist();
    }
}

class Worker {
    constructor({ queue, runners, logger, sleep, idlePollMs }) {
        this.queue = queue;
        this.runners = runners || {}; // { [type]: async (payload, ctx) => result }
        this.logger = logger || { info() {}, warn() {}, error() {} };
        this.sleep = sleep || realSleep;
        this.idlePollMs = idlePollMs || 1000;
        this.running = false;
    }

    // Обрабатывает одну pending-задачу. Возвращает true, если задача была, иначе false.
    async runOnce() {
        const job = this.queue.nextPending();
        if (!job) return false;

        const runner = this.runners[job.type];
        this.queue.update(job.id, { status: "running", attempts: job.attempts + 1, startedAt: new Date().toISOString() });

        if (!runner) {
            this.queue.update(job.id, { status: "failed", error: `Нет обработчика для типа "${job.type}"` });
            this.logger.error(`Задача #${job.id}: нет обработчика для типа "${job.type}".`);
            return true;
        }

        try {
            this.logger.info(`▶️ Выполняю задачу #${job.id} (${job.type})...`);
            const result = await runner(job.payload, { jobId: job.id });
            this.queue.update(job.id, { status: "done", result, finishedAt: new Date().toISOString() });
            this.logger.info(`✅ Задача #${job.id} завершена.`);
        } catch (err) {
            this.queue.update(job.id, { status: "failed", error: err.message, finishedAt: new Date().toISOString() });
            this.logger.error(`❌ Задача #${job.id} провалена: ${err.message}`);
        }
        return true;
    }

    // Непрерывно разгребает очередь, пока не остановят. Когда задач нет — опрашивает
    // с паузой idlePollMs (на следующих этапах заменим на событийный триггер).
    async start() {
        this.running = true;
        this.logger.info("🟢 Воркер очереди запущен.");
        while (this.running) {
            const had = await this.runOnce();
            if (!had) await this.sleep(this.idlePollMs);
        }
    }

    stop() {
        this.running = false;
        this.logger.info("🔴 Воркер очереди остановлен.");
    }

    // Разовый прогон: выполнить все pending-задачи и выйти (удобно для скриптов/тестов).
    async drain() {
        // eslint-disable-next-line no-await-in-loop
        while (await this.runOnce()) { /* до опустошения */ }
    }
}

module.exports = { Queue, Worker };
