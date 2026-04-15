import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AcpBusManager } from '../src/acp-bus-manager.mjs';
import { AcpBusStore } from '../src/acp-bus-store.mjs';

async function createTempDbPath(prefix) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return {
        dir,
        dbPath: path.join(dir, 'acp-bus.sqlite')
    };
}

class FakeBusRuntime extends EventEmitter {
    constructor(definition, options = {}) {
        super();
        this.definition = definition;
        this.options = options;
        this.tabs = new Map();
        this.resumeCalls = [];
        this.detachCalls = [];
        this.disposed = false;
        this.kind = String(options.runtimeStoreKey || '').includes(':observe:')
            ? 'observe'
            : 'discovery';
    }

    async listSessions() {
        return {
            sessions: Array.isArray(this.definition.busSessions)
                ? structuredClone(this.definition.busSessions)
                : []
        };
    }

    async resumeTab(meta) {
        this.resumeCalls.push(structuredClone(meta));
        const tab = {
            id: meta.id,
            agentId: this.definition.id,
            acpSessionId: meta.acpSessionId,
            cwd: meta.cwd,
            title: meta.title || `${this.definition.label} ${meta.acpSessionId}`,
            status: 'ready',
            busy: false,
            errorMessage: '',
            messages: [{
                id: `msg-${meta.acpSessionId}`,
                kind: 'message',
                role: 'assistant',
                text: `loaded ${meta.acpSessionId}`
            }],
            toolCalls: []
        };
        this.tabs.set(meta.id, tab);
        return this.serializeTab(tab);
    }

    serializeTab(tab) {
        return structuredClone(tab);
    }

    detachTab(tabId) {
        this.detachCalls.push(tabId);
        return this.tabs.delete(tabId);
    }

    async dispose() {
        this.disposed = true;
    }
}

class FakeAcpManager {
    constructor(definitions) {
        this.definitions = definitions;
        this.configVersions = new Map();
        this.configs = new Map();
    }

    async ensureConfigsLoaded() {}

    getDefinitionAvailability() {
        return { available: true };
    }

    getAgentConfigVersion(agentId) {
        return this.configVersions.get(agentId) || 0;
    }

    getAgentConfig(agentId) {
        return this.configs.get(agentId) || {};
    }
}

async function withBusManager(prefix, options, callback) {
    const { dir, dbPath } = await createTempDbPath(prefix);
    const runtimeInstances = [];
    let currentNow = '2026-04-14T10:00:00.000Z';
    const store = new AcpBusStore({
        dbPath,
        eventLimit: 100,
        now: () => currentNow
    });
    const acpManager = new FakeAcpManager(options.definitions);
    const manager = new AcpBusManager({
        acpManager,
        store,
        now: () => currentNow,
        pollIntervalMs: options.pollIntervalMs || 60_000,
        hotSessionLimit: options.hotSessionLimit || 1,
        cacheSessionLimit: options.cacheSessionLimit || 10,
        snapshotFlushDelayMs: options.snapshotFlushDelayMs || 25,
        discoveryCwd: '/tmp/discovery',
        runtimeFactory: (definition, runtimeOptions) => {
            const runtime = new FakeBusRuntime(definition, runtimeOptions);
            runtimeInstances.push(runtime);
            return runtime;
        }
    });

    try {
        await callback({
            manager,
            store,
            runtimeInstances,
            setNow(value) {
                currentNow = value;
            }
        });
    } finally {
        await manager.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }
}

describe('AcpBusManager', () => {
    it('indexes sessions globally and attaches only the hottest set', async () => {
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 2,
            definitions: [
                {
                    id: 'codex',
                    label: 'Codex',
                    busSessions: [
                        {
                            sessionId: 'c-1',
                            cwd: '/tmp/codex',
                            title: 'Codex recent',
                            updatedAt: '2026-04-14T10:03:00.000Z'
                        },
                        {
                            sessionId: 'c-2',
                            cwd: '/tmp/codex',
                            title: 'Codex older',
                            updatedAt: '2026-04-14T10:01:00.000Z'
                        }
                    ]
                },
                {
                    id: 'gemini',
                    label: 'Gemini',
                    busSessions: [{
                        sessionId: 'g-1',
                        cwd: '/tmp/gemini',
                        title: 'Gemini recent',
                        updatedAt: '2026-04-14T10:02:00.000Z'
                    }]
                }
            ]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();

            const hotSessions = manager.listSessions({ hotOnly: true });
            assert.equal(hotSessions.length, 2);
            assert.deepEqual(
                hotSessions.map((row) => row.sessionKey),
                ['codex::c-1', 'gemini::g-1']
            );
            assert.equal(manager.getState().observedSessionCount, 2);

            const observeRuntimes = runtimeInstances.filter((runtime) =>
                runtime.kind === 'observe'
            );
            assert.equal(observeRuntimes.length, 2);
            assert.deepEqual(
                observeRuntimes.flatMap((runtime) =>
                    runtime.resumeCalls.map((call) => call.acpSessionId)
                ).sort(),
                ['c-1', 'g-1']
            );
        });
    });

    it('promotes interested sessions into the hot set', async () => {
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 1,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: [
                    {
                        sessionId: 'c-1',
                        cwd: '/tmp/codex',
                        title: 'First',
                        updatedAt: '2026-04-14T10:01:00.000Z'
                    },
                    {
                        sessionId: 'c-2',
                        cwd: '/tmp/codex',
                        title: 'Second',
                        updatedAt: '2026-04-14T10:00:00.000Z'
                    }
                ]
            }]
        }, async ({ manager, setNow }) => {
            await manager.start();
            assert.deepEqual(
                manager.listSessions({ hotOnly: true }).map((row) => row.sessionKey),
                ['codex::c-1']
            );

            setNow('2026-04-14T10:05:00.000Z');
            await manager.markSessionInterest({
                agentId: 'codex',
                sessionId: 'c-2',
                cwd: '/tmp/codex',
                title: 'Second'
            });

            assert.deepEqual(
                manager.listSessions({ hotOnly: true }).map((row) => row.sessionKey),
                ['codex::c-2']
            );
            const cold = manager.getSession('codex', 'c-1');
            assert.equal(cold.continuityState, 'resync_required');
        });
    });

    it('debounces runtime snapshot flushes and marks runtime exits', async () => {
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 1,
            snapshotFlushDelayMs: 20,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: [{
                    sessionId: 'c-1',
                    cwd: '/tmp/codex',
                    title: 'First',
                    updatedAt: '2026-04-14T10:01:00.000Z'
                }]
            }]
        }, async ({ manager, setNow }) => {
            await manager.start();
            const handle = manager.observedSessions.get('codex::c-1');
            assert.ok(handle);

            const tab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
            tab.messages.push({
                id: 'msg-2',
                kind: 'message',
                role: 'assistant',
                text: 'updated'
            });
            setNow('2026-04-14T10:02:00.000Z');
            handle.runtimeEntry.runtime.emit('tab_dirty', { tabId: handle.tabId });
            setNow('2026-04-14T10:02:01.000Z');
            handle.runtimeEntry.runtime.emit('tab_dirty', { tabId: handle.tabId });

            await new Promise((resolve) => setTimeout(resolve, 100));

            const updated = manager.getSession('codex', 'c-1', {
                includeSnapshot: true
            });
            assert.equal(updated.messageCount, 2);
            assert.equal(updated.snapshot.messages.length, 2);

            const snapshotEvents = manager.listEvents(10).filter((event) =>
                event.type === 'session_snapshot_updated'
            );
            assert.equal(snapshotEvents.length, 1);

            handle.runtimeEntry.runtime.emit('runtime_exit', { code: 1 });
            await new Promise((resolve) => setTimeout(resolve, 0));

            const resync = manager.getSession('codex', 'c-1');
            assert.equal(resync.continuityState, 'resync_required');
            assert.equal(resync.status, 'disconnected');
        });
    });
});
