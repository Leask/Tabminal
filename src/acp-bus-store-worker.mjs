import { parentPort, workerData } from 'node:worker_threads';

import { AcpBusStore } from './acp-bus-store.mjs';

const store = new AcpBusStore(workerData?.options || {});

async function handleCall(message = {}) {
    const id = message.id;
    const method = String(message.method || '').trim();
    const args = Array.isArray(message.args) ? message.args : [];
    try {
        if (method === 'init') {
            await store.init();
            parentPort.postMessage({ id, ok: true, result: null });
            return;
        }
        if (method === 'close') {
            store.close();
            parentPort.postMessage({ id, ok: true, result: null });
            return;
        }
        if (typeof store[method] !== 'function') {
            throw new Error(`Unknown ACP bus store method: ${method}`);
        }
        const result = store[method](...args);
        parentPort.postMessage({ id, ok: true, result });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            error: {
                message: error?.message || String(error),
                stack: error?.stack || ''
            }
        });
    }
}

parentPort.on('message', (message) => {
    void handleCall(message);
});
