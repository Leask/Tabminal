import { Worker } from 'node:worker_threads';

export class AsyncDatabaseSync {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.worker = null;
        this.nextRequestId = 1;
        this.pending = new Map();
        this.openPromise = null;
        this.closed = false;
    }

    async open() {
        if (this.closed) {
            throw new Error('Async database is closed');
        }
        if (this.openPromise) {
            return await this.openPromise;
        }
        this.#ensureWorker();
        this.openPromise = this.#call({ method: 'open' });
        try {
            await this.openPromise;
        } finally {
            this.openPromise = null;
        }
    }

    async close() {
        if (this.closed) {
            return;
        }
        const worker = this.worker;
        if (!worker) {
            this.closed = true;
            return;
        }
        try {
            await this.#call({ method: 'close' });
        } finally {
            this.closed = true;
            this.worker = null;
            for (const { reject } of this.pending.values()) {
                reject(new Error('Async database closed'));
            }
            this.pending.clear();
            await worker.terminate();
        }
    }

    async exec(sql) {
        return await this.#call({ method: 'exec', sql });
    }

    async run(sql, params = []) {
        return await this.#call({ method: 'run', sql, params });
    }

    async get(sql, params = []) {
        return await this.#call({ method: 'get', sql, params });
    }

    async all(sql, params = []) {
        return await this.#call({ method: 'all', sql, params });
    }

    async transaction(operations = []) {
        return await this.#call({
            method: 'transaction',
            operations: Array.isArray(operations) ? operations : []
        });
    }

    #ensureWorker() {
        if (this.worker) {
            return;
        }
        const worker = new Worker(
            new URL('./async-database-sync-worker.mjs', import.meta.url),
            {
                workerData: {
                    dbPath: this.dbPath
                }
            }
        );
        worker.on('message', (message) => {
            const id = Number(message?.id || 0);
            const pending = this.pending.get(id);
            if (!pending) {
                return;
            }
            this.pending.delete(id);
            if (message.ok) {
                pending.resolve(message.result);
                return;
            }
            const error = new Error(
                message?.error?.message || 'Async database worker failed'
            );
            if (message?.error?.stack) {
                error.stack = message.error.stack;
            }
            pending.reject(error);
        });
        worker.on('error', (error) => {
            this.#rejectAll(error);
        });
        worker.on('exit', (code) => {
            if (!this.closed && code !== 0) {
                this.#rejectAll(
                    new Error(`Async database worker exited with code ${code}`)
                );
            }
            this.worker = null;
        });
        this.worker = worker;
    }

    #call(payload = {}) {
        if (this.closed) {
            return Promise.reject(new Error('Async database is closed'));
        }
        this.#ensureWorker();
        const id = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...payload, id });
        });
    }

    #rejectAll(error) {
        for (const { reject } of this.pending.values()) {
            reject(error);
        }
        this.pending.clear();
    }
}
