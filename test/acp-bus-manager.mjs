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
        this.promptCalls = [];
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
                : [],
            scope: this.definition.busScope || 'all'
        };
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

    async resumeTab(meta) {
        this.resumeCalls.push(structuredClone(meta));
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
            resume: true,
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
        coldRepairLoadThreshold: options.coldRepairLoadThreshold,
        getCpuLoadRatio: options.getCpuLoadRatio,
        discoveryCwd: '/tmp/discovery',
        loadOpenTabs: options.loadOpenTabs,
        saveOpenTabs: options.saveOpenTabs,
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
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for condition');
}

describe('AcpBusManager', () => {
    it('indexes sessions globally and attaches the most recently updated set', async () => {
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
            const streamedEvents = [];
            manager.on('event', (event) => {
                streamedEvents.push(event);
            });
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
            const attachEvent = streamedEvents.find((event) =>
                event.type === 'session_hot_attached'
            );
            assert.ok(attachEvent);
            assert.equal(
                attachEvent.payload.session.snapshotVersion,
                attachEvent.payload.snapshotVersion
            );
            assert.equal(attachEvent.payload.requiresFullSync, false);
            assert.equal(Array.isArray(attachEvent.payload.changedItems), true);
            assert.equal(attachEvent.payload.changedItems.length > 0, true);
        });
    });

    it('does not promote local interest ahead of ACP updatedAt', async () => {
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

            await new Promise((resolve) => setTimeout(resolve, 25));

            assert.deepEqual(
                manager.listSessions({ hotOnly: true }).map((row) => row.sessionKey),
                ['codex::c-1']
            );
            assert.equal(manager.getState().observedSessionCount, 1);
        });
    });

    it('repairs one stale cold session per low-load sync', async () => {
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 1,
            getCpuLoadRatio: () => 0.1,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: [
                    {
                        sessionId: 'hot',
                        cwd: '/tmp/codex',
                        title: 'Hot',
                        updatedAt: '2026-04-14T10:30:00.000Z'
                    },
                    {
                        sessionId: 'older-cold',
                        cwd: '/tmp/codex',
                        title: 'Older cold',
                        updatedAt: '2026-04-14T10:10:00.000Z'
                    },
                    {
                        sessionId: 'newer-cold',
                        cwd: '/tmp/codex',
                        title: 'Newer cold',
                        updatedAt: '2026-04-14T10:20:00.000Z'
                    }
                ]
            }]
        }, async ({ manager, runtimeInstances, setNow }) => {
            setNow('2026-04-14T10:30:00.000Z');
            await manager.start();

            assert.equal(
                manager.getSession('codex', 'older-cold').messageCount,
                0
            );
            assert.equal(
                manager.getSession('codex', 'newer-cold').messageCount,
                0
            );

            await manager.syncNow('poll');

            assert.equal(
                manager.getSession('codex', 'older-cold').messageCount,
                1
            );
            assert.equal(
                manager.getSession('codex', 'newer-cold').messageCount,
                0
            );
            const observeRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'observe'
            );
            assert.ok(observeRuntime);
            assert.deepEqual(
                observeRuntime.resumeCalls.map((call) => call.acpSessionId),
                ['hot', 'older-cold']
            );
        });
    });

    it('skips cold repair while system load is high', async () => {
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 1,
            getCpuLoadRatio: () => 0.95,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: [
                    {
                        sessionId: 'hot',
                        cwd: '/tmp/codex',
                        title: 'Hot',
                        updatedAt: '2026-04-14T10:30:00.000Z'
                    },
                    {
                        sessionId: 'cold',
                        cwd: '/tmp/codex',
                        title: 'Cold',
                        updatedAt: '2026-04-14T10:10:00.000Z'
                    }
                ]
            }]
        }, async ({ manager, runtimeInstances, setNow }) => {
            setNow('2026-04-14T10:30:00.000Z');
            await manager.start();
            await manager.syncNow('poll');

            assert.equal(manager.getSession('codex', 'cold').messageCount, 0);
            const observeRuntime = runtimeInstances.find((runtime) =>
                runtime.kind === 'observe'
            );
            assert.ok(observeRuntime);
            assert.deepEqual(
                observeRuntime.resumeCalls.map((call) => call.acpSessionId),
                ['hot']
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
            hotSessionLimit: 1,
            definitions: [definition]
        }, async ({ manager }) => {
            await manager.start();
            assert.equal(
                manager.getSession('codex', 'c-2')?.isPresent,
                true
            );

            definition.busScope = 'cwd';
            definition.busSessions = [definition.busSessions[0]];
            await manager.syncNow('cwd-only');

            assert.equal(
                manager.getSession('codex', 'c-2')?.isPresent,
                true
            );

            definition.busScope = 'all';
            await manager.syncNow('all');

            assert.equal(
                manager.getSession('codex', 'c-2')?.isPresent,
                false
            );
        });
    });

    it('keeps pinned sessions observed outside the updated hot set', async () => {
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 1,
            definitions: [{
                id: 'codex',
                label: 'Codex',
                busSessions: [
                    {
                        sessionId: 'c-1',
                        cwd: '/tmp/codex',
                        title: 'Hot',
                        updatedAt: '2026-04-14T10:01:00.000Z'
                    },
                    {
                        sessionId: 'c-2',
                        cwd: '/tmp/codex',
                        title: 'Pinned cold',
                        updatedAt: '2026-04-14T10:00:00.000Z'
                    }
                ]
            }]
        }, async ({ manager }) => {
            await manager.start();
            assert.equal(manager.getState().observedSessionCount, 1);

            const pinned = await manager.pinSession(
                'agent-tab:test',
                {
                    agentId: 'codex',
                    sessionId: 'c-2',
                    cwd: '/tmp/codex',
                    title: 'Pinned cold'
                },
                'test_attach'
            );

            assert.equal(pinned.sessionKey, 'codex::c-2');
            assert.equal(manager.getState().pinnedSessionCount, 1);
            assert.equal(manager.getState().observedSessionCount, 2);
            assert.deepEqual(
                manager.listSessions({ hotOnly: true }).map((row) => row.sessionKey),
                ['codex::c-1', 'codex::c-2']
            );
            assert.equal(
                manager.getSession('codex', 'c-2').continuityState,
                'live'
            );

            await manager.unpinSession('agent-tab:test', 'test_detach');

            await waitFor(() => manager.getState().observedSessionCount === 1);

            assert.equal(manager.getState().pinnedSessionCount, 0);
            assert.equal(manager.getState().observedSessionCount, 1);
            assert.equal(
                manager.getSession('codex', 'c-2').continuityState,
                'resync_required'
            );

        });
    });

    it('restores workspace open tabs as bus-owned session pins', async () => {
        const savedTabs = [];
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 1,
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

            const tab = manager.getOpenTab('open-tab-1');

            assert.equal(tab.id, 'open-tab-1');
            assert.equal(tab.acpSessionId, 's-1');
            assert.equal(tab.terminalSessionId, 'term-1');
            assert.equal(manager.getState().observedSessionCount, 1);
            assert.equal(runtimeInstances.filter((runtime) =>
                runtime.kind === 'observe'
            ).length, 1);
            assert.equal(savedTabs.length, 0);
        });
    });

    it('creates, resumes, and prompts through bus-owned runtime handles', async () => {
        const savedTabs = [];
        await withBusManager('acp-bus-manager-', {
            hotSessionLimit: 1,
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
            assert.equal(manager.listOpenTabs().length, 1);

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
            assert.equal(manager.listOpenTabs().length, 1);
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

            const lightweight = manager.getOpenTab(created.id);
            assert.equal(lightweight.messages.length, 0);
            assert.equal(lightweight.toolCalls.length, 0);
            assert.equal(lightweight.terminals.length, 1);
            assert.equal(lightweight.terminals[0].output, 'alpha\nbeta\n');

            const full = manager.getOpenTab(created.id, {
                includeTranscript: true
            });
            assert.equal(full.messages.length, 1);
            assert.equal(full.terminals.length, 1);
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

            const lightweight = manager.getOpenTab(created.id);
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

            const full = manager.getOpenTab(created.id, {
                includeTranscript: true
            });
            assert.equal(full.messages.length, 1);
            assert.equal(full.toolCalls.length, 2);
            assert.equal(full.permissions.length, 2);
            assert.equal(full.plan.length, 3);
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
