// Independently implemented from Lody's bounded startup/turn ownership design.
// See docs/AGENT_ARCHITECTURE.md for provenance and lifecycle contracts.
export class AdmissionGate {
    constructor(limit = 2) {
        if (!Number.isInteger(limit) || limit < 1) {
            throw new Error('Admission limit must be a positive integer');
        }
        this.limit = limit;
        this.active = 0;
        this.queue = [];
    }

    async run(task, signal) {
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
            const waiter = { resolve, reject, signal, abort: null };
            waiter.abort = () => {
                const index = this.queue.indexOf(waiter);
                if (index < 0) return;
                this.queue.splice(index, 1);
                reject(signal.reason);
            };
            signal?.addEventListener('abort', waiter.abort, { once: true });
            this.queue.push(waiter);
            this.drain();
        });
        try {
            signal?.throwIfAborted();
            return await task();
        } finally {
            this.active -= 1;
            this.drain();
        }
    }

    drain() {
        while (this.active < this.limit && this.queue.length) {
            const waiter = this.queue.shift();
            waiter.signal?.removeEventListener('abort', waiter.abort);
            this.active += 1;
            waiter.resolve();
        }
    }
}

export async function withDeadline(task, timeoutMs, label = 'Agent request') {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(task),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`${label} timed out`);
                    error.code = 'runtime_timeout';
                    reject(error);
                }, timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export const runtimeAdmission = new AdmissionGate(2);

export class SessionExecution {
    constructor() {
        this.current = null;
    }

    begin() {
        if (this.current) throw new Error('Agent session is already running');
        const lease = {
            abort: new AbortController(),
            phase: 'preparing'
        };
        this.current = lease;
        return lease;
    }

    dispatch(lease) {
        lease.abort.signal.throwIfAborted();
        if (this.current !== lease) throw new Error('Stale agent execution');
        lease.phase = 'running';
    }

    cancel() {
        const lease = this.current;
        if (!lease) return false;
        lease.abort.abort(new Error('Agent prompt cancelled'));
        return lease.phase === 'running';
    }

    finish(lease) {
        if (this.current !== lease) return false;
        this.current = null;
        return true;
    }
}
