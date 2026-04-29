import { Worker } from 'node:worker_threads';

const STORE_METHODS = [
    'getSummary',
    'listSessions',
    'getSessionByIdentity',
    'getSession',
    'listEvents',
    'listTimelineItems',
    'markSessionInterest',
    'saveObservedSession',
    'listColdRepairCandidates',
    'updateContinuityState',
    'upsertIndexedSession',
    'listHotCandidates',
    'listHotSessions',
    'setHotSessionKeys',
    'markSessionForUpstreamSync',
    'appendEvent',
    'deleteSession'
];

export class AcpBusAsyncStore {
    constructor(options = {}) {
        const {
            now: _ignoredNow,
            ...workerOptions
        } = options;
        this.workerOptions = workerOptions;
        this.worker = null;
        this.nextRequestId = 1;
        this.pending = new Map();
        this.initPromise = null;
        this.closed = false;
    }

    async init() {
        if (this.closed) {
            throw new Error('ACP bus async store is closed');
        }
        if (this.initPromise) {
            return await this.initPromise;
        }
        this.#ensureWorker();
        this.initPromise = this.call('init');
        try {
            await this.initPromise;
        } finally {
            this.initPromise = null;
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
            await this.call('close');
        } catch {
            // Termination below is the authoritative cleanup path.
        }
        this.closed = true;
        this.worker = null;
        for (const { reject } of this.pending.values()) {
            reject(new Error('ACP bus async store closed'));
        }
        this.pending.clear();
        await worker.terminate();
    }

    call(method, args = []) {
        if (this.closed) {
            return Promise.reject(new Error('ACP bus async store is closed'));
        }
        this.#ensureWorker();
        const id = this.nextRequestId++;
        const payload = {
            id,
            method,
            args: Array.isArray(args) ? args : []
        };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage(payload);
        });
    }

    #ensureWorker() {
        if (this.worker) {
            return;
        }
        const worker = new Worker(
            new URL('./acp-bus-store-worker.mjs', import.meta.url),
            {
                workerData: {
                    options: this.workerOptions
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
                message?.error?.message || 'ACP bus store worker failed'
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
                    new Error(`ACP bus store worker exited with code ${code}`)
                );
            }
            this.worker = null;
        });
        this.worker = worker;
    }

    #rejectAll(error) {
        for (const { reject } of this.pending.values()) {
            reject(error);
        }
        this.pending.clear();
    }
}

for (const method of STORE_METHODS) {
    AcpBusAsyncStore.prototype[method] = function storeMethod(...args) {
        return this.call(method, args);
    };
}
