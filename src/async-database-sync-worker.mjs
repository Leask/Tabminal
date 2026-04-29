import { parentPort, workerData } from 'node:worker_threads';

import { DatabaseSync } from 'node:sqlite';

let db = null;

function normalizeParams(params) {
    if (params === undefined || params === null) {
        return [];
    }
    if (Array.isArray(params)) {
        return params;
    }
    if (typeof params === 'object') {
        return params;
    }
    return [params];
}

function callStatement(statement, method, params) {
    const normalized = normalizeParams(params);
    if (Array.isArray(normalized)) {
        return statement[method](...normalized);
    }
    return statement[method](normalized);
}

function requireDb() {
    if (!db) {
        throw new Error('Async database is not open');
    }
    return db;
}

function runOperation(operation = {}) {
    const database = requireDb();
    const type = String(operation.type || '').trim();
    const sql = String(operation.sql || '');
    if (type === 'exec') {
        database.exec(sql);
        return null;
    }
    if (type === 'run') {
        const statement = database.prepare(sql);
        const result = callStatement(statement, type, operation.params);
        return {
            changes: Number(result?.changes || 0),
            lastInsertRowid: Number(result?.lastInsertRowid || 0)
        };
    }
    if (type === 'get' || type === 'all') {
        const statement = database.prepare(sql);
        return callStatement(statement, type, operation.params);
    }
    throw new Error(`Unknown async database operation: ${type}`);
}

async function handleCall(message = {}) {
    const id = message.id;
    try {
        const method = String(message.method || '').trim();
        if (method === 'open') {
            if (!db) {
                db = new DatabaseSync(workerData?.dbPath);
            }
            parentPort.postMessage({ id, ok: true, result: null });
            return;
        }
        if (method === 'close') {
            if (db) {
                db.close();
                db = null;
            }
            parentPort.postMessage({ id, ok: true, result: null });
            return;
        }
        if (method === 'transaction') {
            const database = requireDb();
            const operations = Array.isArray(message.operations)
                ? message.operations
                : [];
            database.exec('BEGIN');
            try {
                const results = operations.map((operation) =>
                    runOperation(operation)
                );
                database.exec('COMMIT');
                parentPort.postMessage({ id, ok: true, result: results });
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
            return;
        }
        const result = runOperation({
            type: method,
            sql: message.sql,
            params: message.params
        });
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
