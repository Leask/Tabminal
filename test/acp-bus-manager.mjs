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
        this.createCalls = [];
        this.resumeCalls = [];
        this.listCalls = [];
        this.promptCalls = [];
        this.detachCalls = [];
        this.disposed = false;
        this.kind = String(options.runtimeStoreKey || '').includes(':observe:')
            ? 'observe'
            : 'discovery';
    }

    async listSessions(options = {}) {
        this.listCalls.push(structuredClone(options));
        const sourceSessions = options.all === true
            && Array.isArray(this.definition.busAllSessions)
            ? this.definition.busAllSessions
            : this.definition.busSessions;
        const sessions = Array.isArray(sourceSessions)
            ? structuredClone(sourceSessions)
            : [];
        const shouldFilterByCwd = this.definition.filterBusSessionsByCwd
            && (
                options.all !== true
                || this.definition.busScope === 'cwd'
            );
        const filteredSessions = shouldFilterByCwd
            ? sessions.filter((session) =>
                path.resolve(session.cwd || '/') === path.resolve(options.cwd || '/')
            )
            : sessions;
        return {
            sessions: filteredSessions,
            scope: this.definition.busScope || 'all'
        };
    }

    async waitForSessionReady(tabId) {
        return structuredClone(this.tabs.get(tabId));
    }

    async reloadTab(tabId) {
        const tab = this.tabs.get(tabId);
        this.tabs.delete(tabId);
        return await this.resumeTab({
            id: tab.id, acpSessionId: tab.acpSessionId, cwd: tab.cwd
        }, { replayHistory: true });
    }

    async createTab(meta) {
        this.createCalls.push(structuredClone(meta));
        const sessionId = `new-${this.createCalls.length}`;
        const tab = {
            id: meta.id,
            runtimeId: `runtime-${this.definition.id}`,
            runtimeKey: this.options.runtimeStoreKey || '',
            agentId: this.definition.id,
            agentLabel: this.definition.label,
            commandLabel: this.definition.commandLabel || '',
            acpSessionId: sessionId,
            cwd: meta.cwd,
            terminalSessionId: meta.terminalSessionId || '',
            title: `${this.definition.label} ${sessionId}`,
            status: 'ready',
            busy: false,
            errorMessage: '',
            currentModeId: meta.modeId || '',
            availableModes: [],
            availableCommands: [],
            sessionCapabilities: this.getSessionCapabilities(),
            configOptions: [],
            messages: [],
            toolCalls: [],
            permissions: [],
            plan: [],
            terminals: []
        };
        this.tabs.set(meta.id, tab);
        return this.serializeTab(tab);
    }

    async resumeTab(meta, options = {}) {
        this.resumeCalls.push({
            ...structuredClone(meta),
            replayHistory: options.replayHistory
        });
        if (this.definition.missingSessions?.includes(meta.acpSessionId)) {
            throw new Error('Session not found');
        }
        const tab = {
            id: meta.id,
            runtimeId: `runtime-${this.definition.id}`,
            runtimeKey: this.options.runtimeStoreKey || '',
            agentId: this.definition.id,
            agentLabel: this.definition.label,
            commandLabel: this.definition.commandLabel || '',
            acpSessionId: meta.acpSessionId,
            cwd: meta.cwd,
            terminalSessionId: meta.terminalSessionId || '',
            title: meta.title || `${this.definition.label} ${meta.acpSessionId}`,
            status: 'ready',
            busy: false,
            errorMessage: '',
            currentModeId: '',
            availableModes: [],
            availableCommands: [],
            sessionCapabilities: this.getSessionCapabilities(),
            configOptions: [],
            messages: [{
                id: `msg-${meta.acpSessionId}`,
                kind: 'message',
                role: 'assistant',
                text: `loaded ${meta.acpSessionId}`
            }],
            toolCalls: [],
            permissions: [],
            plan: [],
            terminals: []
        };
        this.tabs.set(meta.id, tab);
        return this.serializeTab(tab);
    }

    getSessionCapabilities() {
        return {
            list: true,
            listAll: true,
            resume: !this.definition.capabilitiesAfterResume
                || this.resumeCalls.length > 0,
            load: true
        };
    }

    serializeTab(tab) {
        return structuredClone(tab);
    }

    async sendPrompt(tabId, text, attachments = []) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        this.promptCalls.push({
            tabId,
            text,
            attachments: structuredClone(attachments)
        });
        tab.messages.push({
            id: `prompt-${this.promptCalls.length}`,
            kind: 'message',
            role: 'user',
            text
        });
        this.emit('tab_dirty', { tabId });
    }

    async cancel() {}

    async resolvePermission() {}

    async setMode(tabId, modeId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        tab.currentModeId = modeId;
        this.emit('tab_dirty', { tabId });
        return this.serializeTab(tab);
    }

    async setConfigOption(tabId, configId, valueId) {
        const tab = this.tabs.get(tabId);
        if (!tab) {
            throw new Error('Agent tab not found');
        }
        tab.configOptions = [{ id: configId, selectedValueId: valueId }];
        this.emit('tab_dirty', { tabId });
        return this.serializeTab(tab);
    }

    detachTab(tabId) {
        this.detachCalls.push(tabId);
        return this.tabs.delete(tabId);
    }

    async dispose() {
        this.disposed = true;
    }

    async closeTab(tabId) {
        this.detachTab(tabId);
    }

    async supportsHistoryRead() {
        return this.definition.historySupported === true;
    }

    async readSessionHistory(sessionId, receive) {
        this.historyCalls ||= [];
        this.historyCalls.push(sessionId);
        if (this.definition.readHistory) {
            return await this.definition.readHistory(sessionId, receive);
        }
        await receive({ sessionUpdate: 'agent_message_chunk',
            messageId: `msg-${sessionId}`,
            content: { type: 'text', text: `loaded ${sessionId}` } });
    }
}

class FakeAcpManager {
    constructor(definitions) {
        this.definitions = definitions;
        this.configVersions = new Map();
        this.configs = new Map();
    }

    async ensureConfigsLoaded() {}

    async listDefinitions() {
        return structuredClone(this.definitions);
    }

    async listDefinitionsFast() {
        return structuredClone(this.definitions);
    }

    async listAgentConfigs() {
        return Object.fromEntries(this.configs.entries());
    }

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
        cacheSessionLimit: options.cacheSessionLimit || 10,
        snapshotFlushDelayMs: options.snapshotFlushDelayMs || 25,
        coldRepairLoadThreshold: options.coldRepairLoadThreshold,
        getCpuLoadRatio: options.getCpuLoadRatio,
        discoveryCwd: '/tmp/discovery',
        loadOpenTabs: options.loadOpenTabs,
        saveOpenTabs: options.saveOpenTabs,
        listWorkspaceCwds: options.listWorkspaceCwds,
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

async function waitFor(condition, timeoutMs = 500, intervalMs = 10) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (await condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for condition');
}

describe('AcpBusManager', () => {
    it('never auto-attaches recent, interested, or unsupported sessions', async () => {
        await withBusManager('bus-demand-only-', {
            getCpuLoadRatio: () => 0,
            definitions: [{ id: 'codex', label: 'Codex', busSessions:
                Array.from({ length: 300 }, (_, i) => ({
                    sessionId: `s-${i}`, cwd: '/tmp/test',
                    updatedAt: '2026-04-14T10:00:00.000Z'
                })) }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            await manager.markSessionInterest({ agentId: 'codex',
                sessionId: 's-1', cwd: '/tmp/test' });
            await manager.syncNow();
            assert.equal((await manager.listSessions({ limit: 300 })).length, 300);
            assert.equal(manager.observedSessions.size, 0);
            assert.equal(runtimeInstances.length, 1);
            assert.equal(runtimeInstances[0].resumeCalls.length, 0);
        });
    });

    it('syncs read-only history with no controller and skips unchanged history', async () => {
        await withBusManager('bus-history-', {
            getCpuLoadRatio: () => 0,
            definitions: [{ id: 'codex', label: 'Codex', historySupported: true,
                busSessions: [{ sessionId: 's', cwd: '/tmp/test',
                    updatedAt: '2026-04-14T09:00:00.000Z' }] }]
        }, async ({ manager, runtimeInstances, setNow }) => {
            await manager.start();
            await manager.syncNow();
            assert.equal((await manager.getSession('codex', 's')).messageCount, 1);
            assert.equal(manager.observedSessions.size, 0);
            assert.equal(runtimeInstances[0].resumeCalls.length, 0);
            setNow('2026-04-14T11:00:00.000Z');
            await manager.syncNow();
            assert.equal(runtimeInstances[0].historyCalls.length, 1);
            const page = await manager.listTimelineItems('codex::s', { limit: 10 });
            assert.equal(page.items[0].value.text, 'loaded s');
        });
    });

    it('retains prior history on partial read failure and retries later', async () => {
        let fail = true;
        await withBusManager('bus-history-failure-', {
            getCpuLoadRatio: () => 0,
            definitions: [{ id: 'codex', label: 'Codex', historySupported: true,
                busSessions: [{ sessionId: 's', cwd: '/tmp/test' }],
                readHistory: async (_, receive) => {
                    await receive({ sessionUpdate: 'agent_message_chunk',
                        messageId: 'one', content: { type: 'text', text: 'partial' } });
                    if (fail) throw new Error('stream failed');
                } }]
        }, async ({ manager, setNow }) => {
            await manager.start();
            await manager.syncNow();
            assert.equal((await manager.getSession('codex', 's')).messageCount, 0);
            fail = false;
            setNow('2026-04-14T11:00:00.000Z');
            await manager.syncNow();
            assert.equal((await manager.getSession('codex', 's')).messageCount, 1);
        });
    });

    it('shares a controller across browsers and releases only after work settles', async () => {
        await withBusManager('bus-clients-', {
            definitions: [{ id: 'codex', label: 'Codex', busSessions: [] }]
        }, async ({ manager }) => {
            await manager.start();
            const first = manager.registerWorkspaceClient();
            const second = manager.registerWorkspaceClient();
            const tab = await manager.createTabForUi({
                agentId: 'codex', cwd: '/tmp/test', clientId: first
            });
            await manager.attachOpenTab(tab.id, 'second_browser', second);
            assert.equal(manager.observedSessions.size, 1);
            await manager.releaseWorkspaceClient(first);
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.equal(manager.observedSessions.size, 1);
            const handle = [...manager.observedSessions.values()][0];
            const runtimeTab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
            runtimeTab.busy = true;
            await manager.releaseWorkspaceClient(second);
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.equal(manager.observedSessions.size, 1);
            runtimeTab.busy = false;
            runtimeTab.permissions = [{ id: 'p', status: 'pending' }];
            handle.runtimeEntry.runtime.emit('tab_dirty', { tabId: handle.tabId });
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.equal(manager.observedSessions.size, 1);
            runtimeTab.permissions = [];
            handle.runtimeEntry.runtime.emit('tab_dirty', { tabId: handle.tabId });
            await waitFor(() => manager.observedSessions.size === 0);
            await assert.rejects(manager.attachOpenTab(tab.id, 'stale', first),
                /no longer available/);
            assert.equal((await manager.listOpenTabs()).length, 1);
        });
    });

    it('does not read histories while CPU load is high', async () => {
        await withBusManager('bus-history-load-', {
            getCpuLoadRatio: () => 1,
            definitions: [{ id: 'codex', label: 'Codex', historySupported: true,
                busSessions: [{ sessionId: 's', cwd: '/tmp/test' }] }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            await manager.syncNow();
            assert.equal(runtimeInstances[0].historyCalls, undefined);
            assert.equal(manager.observedSessions.size, 0);
        });
    });

    it('single-flights simultaneous browser attachments to the same session', async () => {
        await withBusManager('bus-attach-race-', {
            definitions: [{ id: 'codex', label: 'Codex', busSessions: [] }]
        }, async ({ manager }) => {
            await manager.start();
            const one = manager.registerWorkspaceClient();
            const two = manager.registerWorkspaceClient();
            const [first, second] = await Promise.all([one, two].map((clientId) =>
                manager.resumeTabForUi({ agentId: 'codex', sessionId: 'shared',
                    cwd: '/tmp/test', clientId })));
            assert.equal(first.serialized.acpSessionId, second.serialized.acpSessionId);
            assert.equal(manager.observedSessions.size, 1);
            const handle = manager.observedSessions.get('codex::shared');
            assert.equal(handle.runtimeEntry.runtime.resumeCalls.length, 1);
            assert.equal(manager.pinnedSessions.size, 2);
            await manager.closeTabForUi(first.serialized.id);
            await manager.syncNow();
            assert.equal(manager.observedSessions.size, 1);
            await manager.closeTabForUi(second.serialized.id);
            await manager.syncNow();
            assert.equal(manager.observedSessions.size, 0);
        });
    });

    it('finishes and persists work even after its workspace tab closes', async () => {
        await withBusManager('bus-work-after-close-', {
            definitions: [{ id: 'codex', label: 'Codex', busSessions: [] }]
        }, async ({ manager }) => {
            await manager.start();
            const clientId = manager.registerWorkspaceClient();
            const tab = await manager.createTabForUi({
                agentId: 'codex', cwd: '/tmp/test', clientId
            });
            const handle = manager.observedSessions.get(`codex::${tab.acpSessionId}`);
            const runtime = handle.runtimeEntry.runtime;
            const live = runtime.tabs.get(handle.tabId);
            live.busy = true;
            await manager.closeTabForUi(tab.id);
            await manager.syncNow();
            assert.equal(manager.observedSessions.size, 1);
            live.messages.push({ id: 'final', role: 'assistant', text: 'finished' });
            live.busy = false;
            runtime.emit('tab_dirty', { tabId: handle.tabId });
            await manager.syncNow();
            assert.equal(manager.observedSessions.size, 0);
            assert.equal(runtime.disposed, true);
            const page = await manager.listTimelineItems(handle.sessionKey);
            assert.equal(page.items.at(-1).value.text, 'finished');
        });
    });

    it('routes commands through stable workspace identity after reconnect', async () => {
        await withBusManager('bus-workspace-reconnect-', {
            definitions: [{ id: 'codex', label: 'Codex', busSessions: [] }]
        }, async ({ manager }) => {
            await manager.start();
            const clientId = manager.registerWorkspaceClient();
            const tab = await manager.createTabForUi({
                agentId: 'codex', cwd: '/tmp/test', clientId
            });
            await manager.releaseWorkspaceClient(clientId);
            await manager.syncNow();
            assert.equal(manager.observedSessions.size, 0);
            const nextClient = manager.registerWorkspaceClient();
            await manager.attachOpenTab(tab.id, 'reconnect', nextClient);
            const handle = manager.observedSessions.get(`codex::${tab.acpSessionId}`);
            assert.notEqual(handle.tabId, tab.id);
            await manager.setConfigOptionForTab(tab.id, 'model', 'test');
            await manager.sendPromptForTab(tab.id, 'continue');
            assert.equal(handle.runtimeEntry.runtime.promptCalls.length, 1);
            assert.equal(handle.runtimeEntry.runtime.promptCalls[0].tabId, handle.tabId);
            await manager.releaseWorkspaceClient(nextClient);
            await manager.syncNow();
            assert.equal(manager.observedSessions.size, 0);
        });
    });

    it('discards background history superseded by an explicit attach', async () => {
        let startRead;
        let finishRead;
        const started = new Promise((resolve) => { startRead = resolve; });
        const finish = new Promise((resolve) => { finishRead = resolve; });
        await withBusManager('bus-history-attach-race-', {
            getCpuLoadRatio: () => 0,
            definitions: [{ id: 'codex', label: 'Codex', historySupported: true,
                busSessions: [{ sessionId: 's', cwd: '/tmp/test' }],
                readHistory: async (_, receive) => {
                    await receive({ sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: 'obsolete' } });
                    startRead();
                    await finish;
                } }]
        }, async ({ manager }) => {
            await manager.start();
            const syncing = manager.syncNow();
            try {
                await started;
                const clientId = manager.registerWorkspaceClient();
                await manager.resumeTabForUi({ agentId: 'codex', sessionId: 's',
                    cwd: '/tmp/test', clientId });
                assert.equal(manager.observedSessions.size, 1);
            } finally {
                finishRead();
                await syncing;
            }
            const page = await manager.listTimelineItems('codex::s');
            assert.equal(page.items.length, 1);
            assert.equal(page.items[0].value.text, 'loaded s');
        });
    });

    it('persists runtime exit after an in-flight snapshot write', async () => {
        await withBusManager('acp-exit-write-fence-', {
            definitions: [{ id: 'codex', label: 'Codex', busSessions: [
                { sessionId: 'hot', cwd: '/tmp/test',
                    updatedAt: '2026-04-14T10:30:00.000Z' }
            ] }]
        }, async ({ manager, store }) => {
            await manager.start();
            await manager.pinSession('test:hot', {
                agentId: 'codex', sessionId: 'hot', cwd: '/tmp/test'
            });
            const handle = manager.observedSessions.get('codex::hot');
            const runtime = handle.runtimeEntry.runtime;
            const save = store.saveObservedSession.bind(store);
            let entered = false;
            let release;
            const gate = new Promise((resolve) => { release = resolve; });
            store.saveObservedSession = async (...args) => {
                entered = true;
                await gate;
                return await save(...args);
            };
            runtime.tabs.get(handle.tabId).messages[0].text += ' final delta';
            runtime.emit('tab_dirty', { tabId: handle.tabId });
            try {
                await waitFor(() => entered);
                runtime.emit('runtime_exit', { code: 1 });
            } finally {
                release();
            }
            await waitFor(async () => (
                await manager.getSession('codex', 'hot')
            ).status === 'disconnected');
            assert.equal((await manager.getSession('codex', 'hot')).continuityState,
                'resync_required');
        });
    });



    it('flushes continuously arriving updates without waiting for stream silence', async () => {
        await withBusManager('acp-live-throttle-', {
            definitions: [{ id: 'codex', label: 'Codex', busSessions: [
                { sessionId: 'hot', cwd: '/tmp/test',
                    updatedAt: '2026-04-14T10:30:00.000Z' }
            ] }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            await manager.pinSession('test:hot', {
                agentId: 'codex', sessionId: 'hot', cwd: '/tmp/test'
            });
            const runtime = runtimeInstances.find((item) => item.kind === 'observe');
            const tab = [...runtime.tabs.values()][0];
            let writes = 0;
            manager.on('session_snapshot_updated', () => writes++);
            const timer = setInterval(() => {
                tab.messages[0].text += ' delta';
                runtime.emit('tab_dirty', { tabId: tab.id });
            }, 10);
            try {
                await waitFor(() => writes >= 2, 2000);
            } finally {
                clearInterval(timer);
            }
            assert.ok(writes >= 2);
        });
    });









    it('serves resume picker from bus cache without blocking on upstream', async () => {
        await withBusManager('acp-bus-manager-', {

            getCpuLoadRatio: () => 0.1,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                filterBusSessionsByCwd: true,
                busSessions: [
                    {
                        sessionId: 'current',
                        cwd: '/tmp/current',
                        title: 'Current cwd',
                        updatedAt: '2026-04-14T10:01:00.000Z'
                    },
                    {
                        sessionId: 'other',
                        cwd: '/tmp/other',
                        title: 'Other cwd',
                        updatedAt: '2026-04-14T10:02:00.000Z'
                    }
                ]
            }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            const discoveryRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'discovery'
            );
            const before = discoveryRuntime.listCalls.length;

            const result = await manager.listResumeSessions({
                agentId: 'codex',
                cwd: '/tmp/current'
            });
            const newCalls = discoveryRuntime.listCalls.slice(before);

            assert.equal(newCalls.length, 0);
            assert.equal(result.scope, 'bus');
            assert.deepEqual(
                result.sessions.map((session) => session.sessionId),
                ['other', 'current']
            );
        });
    });

    it('returns an empty resume picker from bus when cache is empty', async () => {
        await withBusManager('acp-bus-manager-', {

            getCpuLoadRatio: () => 0.1,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                filterBusSessionsByCwd: true,
                busSessions: []
            }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            manager.acpManager.definitions[0].busSessions = [{
                sessionId: 'current',
                cwd: '/tmp/current',
                title: 'Current cwd',
                updatedAt: '2026-04-14T10:01:00.000Z'
            }];
            const discoveryRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'discovery'
            );
            const before = discoveryRuntime.listCalls.length;

            const result = await manager.listResumeSessions({
                agentId: 'codex',
                cwd: '/tmp/current'
            });
            const newCalls = discoveryRuntime.listCalls.slice(before);

            assert.equal(newCalls.length, 0);
            assert.equal(result.scope, 'bus');
            assert.deepEqual(result.sessions, []);
        });
    });

    it('syncs current workspace cwd sessions into the bus index', async () => {
        await withBusManager('acp-bus-manager-', {

            getCpuLoadRatio: () => 0.1,
            listWorkspaceCwds: () => [
                '/tmp/current',
                '/tmp/current',
                '/tmp/other'
            ],
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busScope: 'cwd',
                filterBusSessionsByCwd: true,
                busSessions: [
                    {
                        sessionId: 'current',
                        cwd: '/tmp/current',
                        title: 'Current cwd',
                        updatedAt: '2026-04-14T10:01:00.000Z'
                    },
                    {
                        sessionId: 'other',
                        cwd: '/tmp/other',
                        title: 'Other cwd',
                        updatedAt: '2026-04-14T10:02:00.000Z'
                    }
                ]
            }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            const discoveryRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'discovery'
            );
            assert.deepEqual(
                discoveryRuntime.listCalls.map((call) => ({
                    all: call.all,
                    cwd: call.cwd
                })),
                [
                    { all: true, cwd: '/tmp/discovery' },
                    { all: false, cwd: '/tmp/current' },
                    { all: false, cwd: '/tmp/other' }
                ]
            );
            const result = await manager.listResumeSessions({
                agentId: 'codex',
                cwd: '/tmp/current'
            });
            assert.equal(result.scope, 'bus');
            assert.deepEqual(
                result.sessions.map((session) => session.sessionId),
                ['other', 'current']
            );
        });
    });

    it('supplements all-session sync with current workspace cwd scans', async () => {
        await withBusManager('acp-bus-manager-', {

            getCpuLoadRatio: () => 0.1,
            listWorkspaceCwds: () => ['/tmp/current', '/tmp/other'],
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busScope: 'all',
                filterBusSessionsByCwd: true,
                busAllSessions: [
                    {
                        sessionId: 'global',
                        cwd: '/tmp/global',
                        title: 'Global',
                        updatedAt: '2026-04-14T10:00:00.000Z'
                    }
                ],
                busSessions: [
                    {
                        sessionId: 'global',
                        cwd: '/tmp/global',
                        title: 'Global',
                        updatedAt: '2026-04-14T10:00:00.000Z'
                    },
                    {
                        sessionId: 'current',
                        cwd: '/tmp/current',
                        title: 'Current cwd',
                        updatedAt: '2026-04-14T10:01:00.000Z'
                    },
                    {
                        sessionId: 'other',
                        cwd: '/tmp/other',
                        title: 'Other cwd',
                        updatedAt: '2026-04-14T10:02:00.000Z'
                    }
                ]
            }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            const discoveryRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'discovery'
            );
            assert.deepEqual(
                discoveryRuntime.listCalls.map((call) => ({
                    all: call.all,
                    cwd: call.cwd
                })),
                [
                    { all: true, cwd: '/tmp/discovery' },
                    { all: false, cwd: '/tmp/current' },
                    { all: false, cwd: '/tmp/other' }
                ]
            );
            const result = await manager.listResumeSessions({
                agentId: 'codex',
                cwd: '/tmp/current'
            });
            assert.equal(result.scope, 'bus');
            assert.deepEqual(
                result.sessions.map((session) => session.sessionId),
                ['other', 'current', 'global']
            );
        });
    });



    it('does not remove sessions when discovery is cwd-scoped', async () => {
        const definition = {
            id: 'codex',
            label: 'Codex',
            busScope: 'all',
            busSessions: [
                {
                    sessionId: 'c-1',
                    cwd: '/tmp/codex',
                    title: 'Visible',
                    updatedAt: '2026-04-14T10:01:00.000Z'
                },
                {
                    sessionId: 'c-2',
                    cwd: '/tmp/other',
                    title: 'Other cwd',
                    updatedAt: '2026-04-14T10:00:00.000Z'
                }
            ]
        };
        await withBusManager('acp-bus-manager-', {

            definitions: [definition]
        }, async ({ manager }) => {
            await manager.start();
            assert.equal(
                (await manager.getSession('codex', 'c-2'))?.isPresent,
                true
            );

            definition.busScope = 'cwd';
            definition.busSessions = [definition.busSessions[0]];
            await manager.syncNow('cwd-only');

            assert.equal(
                (await manager.getSession('codex', 'c-2'))?.isPresent,
                true
            );

            definition.busScope = 'all';
            await manager.syncNow('all');

            assert.equal(
                (await manager.getSession('codex', 'c-2'))?.isPresent,
                true
            );
        });
    });

    it('deletes metadata only after upstream reports a missing session on attach', async () => {
        await withBusManager('acp-bus-manager-', {

            definitions: [{
                id: 'codex',
                label: 'Codex',
                missingSessions: ['missing'],
                busSessions: [{
                    sessionId: 'missing',
                    cwd: '/tmp/codex',
                    title: 'Missing upstream',
                    updatedAt: '2026-04-14T10:01:00.000Z'
                }]
            }]
        }, async ({ manager }) => {
            const events = [];
            manager.on('event', (event) => {
                events.push(event);
            });
            await manager.start();

            assert.ok(await manager.getSession('codex', 'missing'));
            await assert.rejects(manager.pinSession('test:missing', {
                agentId: 'codex', sessionId: 'missing', cwd: '/tmp/codex'
            }), /Session not found/);
            assert.equal(await manager.getSession('codex', 'missing'), null);
            await waitFor(() => events.some((event) =>
                event.type === 'session_index_removed'
            ));
        });
    });



    it('restores workspace identities without attaching any session', async () => {
        const savedTabs = [];
        await withBusManager('acp-bus-manager-', {

            loadOpenTabs: async () => [{
                id: 'open-tab-1',
                agentId: 'test-agent',
                acpSessionId: 's-1',
                cwd: '/tmp/test-agent',
                terminalSessionId: 'term-1',
                title: 'Persisted session'
            }],
            saveOpenTabs: async (tabs) => {
                savedTabs.push(structuredClone(tabs));
            },
            definitions: [{
                id: 'test-agent',
                label: 'Test Agent',
                busSessions: [{
                    sessionId: 's-1',
                    cwd: '/tmp/test-agent',
                    title: 'Persisted session',
                    updatedAt: '2026-04-14T10:01:00.000Z'
                }]
            }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start({
                validTerminalSessionIds: new Set(['term-1'])
            });

            const tab = await manager.getOpenTab('open-tab-1');

            assert.equal(tab.id, 'open-tab-1');
            assert.equal(tab.acpSessionId, 's-1');
            assert.equal(tab.terminalSessionId, 'term-1');
            assert.equal((await manager.getState()).observedSessionCount, 0);
            assert.equal(runtimeInstances.filter((runtime) =>
                runtime.kind === 'observe'
            ).length, 0);
            assert.equal(savedTabs.length, 0);
        });
    });

    it('creates, resumes, and prompts through bus-owned runtime handles', async () => {
        const savedTabs = [];
        await withBusManager('acp-bus-manager-', {

            loadOpenTabs: async () => [],
            saveOpenTabs: async (tabs) => {
                savedTabs.push(structuredClone(tabs));
            },
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: [{
                    sessionId: 'c-1',
                    cwd: '/tmp/codex',
                    title: 'Existing',
                    updatedAt: '2026-04-14T10:01:00.000Z'
                }]
            }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();

            const created = await manager.createTabForUi({
                agentId: 'codex',
                cwd: '/tmp/codex',
                terminalSessionId: 'term-1'
            });
            assert.equal(created.agentId, 'codex');
            assert.equal(created.terminalSessionId, 'term-1');
            assert.equal((await manager.listOpenTabs()).length, 1);
            const state = await manager.listState();
            assert.equal(state.bus.openTabCount, 1);
            assert.equal(state.definitions.length, 1);
            assert.equal(state.tabs.length, 1);

            await manager.sendPromptForTab(created.id, 'hello bus');
            const observeRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'observe'
                && runtime.promptCalls.length > 0
            );
            assert.ok(observeRuntime);
            assert.equal(observeRuntime.promptCalls[0].text, 'hello bus');

            const resumed = await manager.resumeTabForUi({
                agentId: 'codex',
                cwd: '/tmp/codex',
                sessionId: 'c-1',
                targetTabId: created.id,
                terminalSessionId: 'term-1',
                title: 'Existing'
            });
            assert.equal(resumed.serialized.id, created.id);
            assert.equal(resumed.serialized.acpSessionId, 'c-1');
            assert.equal((await manager.listOpenTabs()).length, 1);
            assert.ok(savedTabs.length >= 2);
        });
    });

    it('deduplicates prompt commands by requestId', async () => {
        await withBusManager('acp-bus-manager-', {
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: []
            }]
        }, async ({ manager, runtimeInstances }) => {
            await manager.start();
            const created = await manager.createTabForUi({
                agentId: 'codex',
                cwd: '/tmp/codex'
            });

            const first = await manager.sendPromptForTab(
                created.id,
                'hello bus',
                [],
                { requestId: 'req-1' }
            );
            const second = await manager.sendPromptForTab(
                created.id,
                'hello bus',
                [],
                { requestId: 'req-1' }
            );

            const observeRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'observe'
            );
            assert.ok(observeRuntime);
            assert.equal(observeRuntime.promptCalls.length, 1);
            assert.equal(first.deduped, false);
            assert.equal(second.deduped, true);
            assert.equal(second.requestId, 'req-1');
        });
    });

    it('rejects reused prompt requestId with a different payload', async () => {
        await withBusManager('acp-bus-manager-', {
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: []
            }]
        }, async ({ manager }) => {
            await manager.start();
            const created = await manager.createTabForUi({
                agentId: 'codex',
                cwd: '/tmp/codex'
            });

            await manager.sendPromptForTab(
                created.id,
                'hello bus',
                [],
                { requestId: 'req-1' }
            );

            await assert.rejects(
                () => manager.sendPromptForTab(
                    created.id,
                    'different payload',
                    [],
                    { requestId: 'req-1' }
                ),
                (error) => error?.code === 'idempotency_conflict'
            );
        });
    });

    it('keeps terminal summaries in lightweight open tab metadata', async () => {
        await withBusManager('acp-bus-manager-', {
            snapshotFlushDelayMs: 20,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: []
            }]
        }, async ({ manager, runtimeInstances }) => {
            const streamedEvents = [];
            manager.on('event', (event) => {
                streamedEvents.push(event);
            });
            await manager.start();
            const created = await manager.createTabForUi({
                agentId: 'codex',
                cwd: '/tmp/codex'
            });
            const observeRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'observe'
            );
            const runtimeTab = observeRuntime.tabs.get(created.id);
            runtimeTab.messages.push({
                id: 'terminal-context',
                kind: 'message',
                role: 'assistant',
                text: 'terminal context'
            });
            runtimeTab.terminals.push({
                terminalId: 'terminal-1',
                command: 'printf alpha beta',
                output: 'alpha\nbeta\n',
                running: false,
                released: true
            });
            observeRuntime.emit('tab_dirty', { tabId: created.id });

            await new Promise((resolve) => setTimeout(resolve, 100));

            const lightweight = await manager.getOpenTab(created.id);
            assert.equal(lightweight.messages.length, 0);
            assert.equal(lightweight.toolCalls.length, 0);
            assert.equal(lightweight.terminals.length, 1);
            assert.equal(lightweight.terminals[0].output, 'alpha\nbeta\n');

            const event = streamedEvents.findLast?.((entry) => (
                entry.type === 'session_snapshot_updated'
                && Array.isArray(entry.payload?.resources?.terminals)
                && entry.payload.resources.terminals.length > 0
            )) || streamedEvents.reverse().find((entry) => (
                entry.type === 'session_snapshot_updated'
                && Array.isArray(entry.payload?.resources?.terminals)
                && entry.payload.resources.terminals.length > 0
            ));
            assert.ok(event);
            assert.equal(event.payload.resources.terminals[0].output, 'alpha\nbeta\n');

            const page = await manager.listTimelineItems(
                `codex::${created.acpSessionId}`,
                { limit: 10 }
            );
            assert.deepEqual(
                page.items.map((item) => item.itemKey),
                ['message:terminal-context']
            );
        });
    });

    it('keeps active live state in lightweight open tab metadata', async () => {
        await withBusManager('acp-bus-manager-', {
            snapshotFlushDelayMs: 20,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: []
            }]
        }, async ({ manager, runtimeInstances }) => {
            const streamedEvents = [];
            manager.on('event', (event) => {
                streamedEvents.push(event);
            });
            await manager.start();
            const created = await manager.createTabForUi({
                agentId: 'codex',
                cwd: '/tmp/codex'
            });
            const observeRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'observe'
            );
            const runtimeTab = observeRuntime.tabs.get(created.id);
            runtimeTab.busy = true;
            runtimeTab.messages.push({
                id: 'live-context',
                kind: 'message',
                role: 'assistant',
                text: 'live context'
            });
            runtimeTab.toolCalls.push({
                toolCallId: 'tool-active',
                title: 'Active tool',
                status: 'running'
            }, {
                toolCallId: 'tool-done',
                title: 'Completed tool',
                status: 'completed'
            });
            runtimeTab.permissions.push({
                id: 'permission-active',
                status: 'pending',
                toolCall: {
                    toolCallId: 'tool-active',
                    title: 'Active tool'
                },
                options: [{ optionId: 'allow', name: 'Allow' }]
            }, {
                id: 'permission-done',
                status: 'selected',
                selectedOptionId: 'allow'
            });
            runtimeTab.plan.push({
                content: 'Completed step',
                status: 'completed'
            }, {
                content: 'Active step',
                status: 'in_progress'
            }, {
                content: 'Pending step',
                status: 'pending'
            });
            observeRuntime.emit('tab_dirty', { tabId: created.id });

            await new Promise((resolve) => setTimeout(resolve, 100));

            const lightweight = await manager.getOpenTab(created.id);
            assert.equal(lightweight.messages.length, 0);
            assert.deepEqual(
                lightweight.toolCalls.map((entry) => entry.toolCallId),
                ['tool-active']
            );
            assert.deepEqual(
                lightweight.permissions.map((entry) => entry.id),
                ['permission-active']
            );
            assert.deepEqual(
                lightweight.plan.map((entry) => entry.content),
                ['Active step', 'Pending step']
            );

            const event = streamedEvents.findLast?.((entry) => (
                entry.type === 'session_snapshot_updated'
                && Array.isArray(entry.payload?.resources?.toolCalls)
                && entry.payload.resources.toolCalls.length > 0
            )) || streamedEvents.reverse().find((entry) => (
                entry.type === 'session_snapshot_updated'
                && Array.isArray(entry.payload?.resources?.toolCalls)
                && entry.payload.resources.toolCalls.length > 0
            ));
            assert.ok(event);
            assert.deepEqual(
                event.payload.resources.toolCalls.map((entry) => entry.toolCallId),
                ['tool-active']
            );
            assert.deepEqual(
                event.payload.resources.permissions.map((entry) => entry.id),
                ['permission-active']
            );
            assert.deepEqual(
                event.payload.resources.plan.map((entry) => entry.content),
                ['Active step', 'Pending step']
            );

            const page = await manager.listTimelineItems(
                `codex::${created.acpSessionId}`,
                { limit: 10 }
            );
            assert.deepEqual(
                page.items.map((item) => item.type),
                ['message', 'tool', 'tool', 'permission', 'permission', 'plan']
            );
        });
    });

    it('coalesces runtime snapshot flushes and marks runtime exits', async () => {
        await withBusManager('acp-bus-manager-', {

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
            await manager.pinSession('test:c-1', {
                agentId: 'codex', sessionId: 'c-1', cwd: '/tmp/test'
            });
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

            const updated = await manager.getSession('codex', 'c-1', {
                includeSnapshot: true
            });
            assert.equal(updated.messageCount, 2);
            assert.equal(updated.snapshot.messages.length, 0);
            const page = await manager.listTimelineItems('codex::c-1', {
                limit: 10
            });
            assert.equal(page.items.length, 2);

            const snapshotEvents = (await manager.listEvents(10)).filter((event) =>
                event.type === 'session_snapshot_updated'
            );
            assert.equal(snapshotEvents.length, 1);

            handle.runtimeEntry.runtime.emit('runtime_exit', { code: 1 });
            await waitFor(async () => (
                await manager.getSession('codex', 'c-1')
            ).continuityState === 'resync_required');

            const resync = await manager.getSession('codex', 'c-1');
            assert.equal(resync.continuityState, 'resync_required');
            assert.equal(resync.status, 'disconnected');
        });
    });
});
