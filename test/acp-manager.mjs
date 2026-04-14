import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import {
    AcpManager,
    buildRestoredToolCall,
    captureRestoreReplayChunk,
    buildTerminalSpawnRequest,
    createRestoreCaptureState,
    finalizeRestoreCaptureMessages,
    getNextSyntheticStreamTurn,
    normalizeAgentTranscriptMessages,
    mergeAgentMessageText
} from '../src/acp-manager.mjs';

class FakeRuntime extends EventEmitter {
    constructor(definition, options = {}) {
        super();
        this.definition = definition;
        this.cwd = options.cwd;
        this.runtimeId = options.runtimeStoreKey
            ? `rt-${options.runtimeStoreKey}`
            : `rt-${definition.id}-${this.cwd}`;
        this.runtimeKey = `${definition.id}::${this.cwd}`;
        this.runtimeStoreKey = options.runtimeStoreKey || this.runtimeKey;
        this.tabs = new Map();
        this.createdTabs = [];
        this.closedTabs = [];
        this.prompts = [];
        this.cancelled = [];
        this.permissions = [];
        this.modeChanges = [];
        this.configChanges = [];
        this.disposed = false;
        this.idleScheduled = false;
        this.restoredTabs = [];
        this.listRequests = [];
        this.resumedTabs = [];
        this.resumeDelayMs = options.resumeDelayMs || 0;
        this.sessionCapabilities = {
            load: true,
            list: true,
            listAll: true,
            resume: false,
            fork: false
        };
        this.supportsAllListing = options.supportsAllListing !== false;
        this.sessionCapabilities.listAll = this.supportsAllListing;
    }

    async createTab(meta) {
        const tab = {
            id: meta.id,
            runtimeId: this.runtimeId,
            runtimeKey: this.runtimeKey,
            acpSessionId: `acp-${meta.id}`,
            agentId: this.definition.id,
            agentLabel: this.definition.label,
            commandLabel: this.definition.commandLabel,
            terminalSessionId: meta.terminalSessionId || '',
            cwd: meta.cwd,
            createdAt: '2026-03-23T00:00:00.000Z',
            status: 'ready',
            busy: false,
            errorMessage: '',
            currentModeId: '',
            availableModes: [
                { id: 'default', name: 'Default' },
                { id: 'review', name: 'Review' }
            ],
            availableCommands: [
                { name: 'review', description: 'Review code' }
            ],
            configOptions: [
                {
                    id: 'model',
                    name: 'Model',
                    category: 'model',
                    type: 'select',
                    currentValue: 'gpt-5.4',
                    options: [
                        { value: 'gpt-5.4', name: 'GPT-5.4' },
                        { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }
                    ]
                },
                {
                    id: 'thought_level',
                    name: 'Thought Level',
                    category: 'thought_level',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' }
                    ]
                }
            ],
            sessionCapabilities: { ...this.sessionCapabilities },
            messages: [],
            toolCalls: [],
            permissions: []
        };
        if (meta.modeId) {
            tab.currentModeId = meta.modeId;
        }
        this.tabs.set(tab.id, tab);
        this.createdTabs.push(tab.id);
        return { ...tab };
    }

    serializeTab(tab) {
        return {
            ...tab,
            sessionCapabilities: { ...this.sessionCapabilities }
        };
    }

    async restoreTab(meta) {
        const tab = {
            id: meta.id,
            runtimeId: this.runtimeId,
            runtimeKey: this.runtimeKey,
            acpSessionId: meta.acpSessionId,
            agentId: this.definition.id,
            agentLabel: this.definition.label,
            commandLabel: this.definition.commandLabel,
            terminalSessionId: meta.terminalSessionId || '',
            cwd: meta.cwd,
            createdAt: meta.createdAt || '2026-03-23T00:00:00.000Z',
            status: 'ready',
            busy: false,
            errorMessage: '',
            currentModeId: '',
            availableModes: [
                { id: 'default', name: 'Default' },
                { id: 'review', name: 'Review' }
            ],
            availableCommands: [
                { name: 'review', description: 'Review code' }
            ],
            configOptions: [
                {
                    id: 'model',
                    name: 'Model',
                    category: 'model',
                    type: 'select',
                    currentValue: 'gpt-5.4',
                    options: [
                        { value: 'gpt-5.4', name: 'GPT-5.4' },
                        { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }
                    ]
                },
                {
                    id: 'thought_level',
                    name: 'Thought Level',
                    category: 'thought_level',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' }
                    ]
                }
            ],
            sessionCapabilities: { ...this.sessionCapabilities },
            messages: [{
                id: 'restored-message',
                streamKey: 'restored',
                role: 'assistant',
                kind: 'message',
                text: 'restored'
            }],
            toolCalls: [],
            permissions: [],
            plan: [],
            usage: null,
            terminals: []
        };
        if (typeof meta.title === 'string') {
            tab.title = meta.title;
        }
        if (typeof meta.currentModeId === 'string' && meta.currentModeId) {
            tab.currentModeId = meta.currentModeId;
        }
        if (Array.isArray(meta.availableModes) && meta.availableModes.length > 0) {
            tab.availableModes = structuredClone(meta.availableModes);
        }
        if (
            Array.isArray(meta.availableCommands)
            && meta.availableCommands.length > 0
        ) {
            tab.availableCommands = structuredClone(meta.availableCommands);
        }
        if (Array.isArray(meta.configOptions) && meta.configOptions.length > 0) {
            tab.configOptions = structuredClone(meta.configOptions);
        }
        if (Array.isArray(meta.messages) && meta.messages.length > 0) {
            tab.messages = structuredClone(meta.messages);
        }
        if (Array.isArray(meta.toolCalls) && meta.toolCalls.length > 0) {
            tab.toolCalls = structuredClone(meta.toolCalls);
        }
        if (Array.isArray(meta.permissions) && meta.permissions.length > 0) {
            tab.permissions = structuredClone(meta.permissions);
        }
        if (Array.isArray(meta.plan) && meta.plan.length > 0) {
            tab.plan = structuredClone(meta.plan);
        }
        if (meta.usage && typeof meta.usage === 'object') {
            tab.usage = structuredClone(meta.usage);
        }
        if (Array.isArray(meta.terminals) && meta.terminals.length > 0) {
            tab.terminals = structuredClone(meta.terminals);
        }
        this.tabs.set(tab.id, tab);
        this.restoredTabs.push(tab.id);
        return { ...tab };
    }

    async listSessions({ cwd, cursor = '', all = false } = {}) {
        if (all && !this.supportsAllListing) {
            this.listRequests.push({ cwd: null, cursor, all: true });
            throw new Error('All-session listing unsupported');
        }
        this.listRequests.push({
            cwd: all ? null : cwd,
            cursor,
            all
        });
        return {
            sessions: [
                {
                    sessionId: 'hist-1',
                    cwd: (all ? '/tmp/other-project' : cwd) || this.cwd,
                    title: 'Previous run',
                    updatedAt: '2026-03-27T00:00:00.000Z'
                },
                {
                    sessionId: 'hist-2',
                    cwd: (all ? '/tmp/project' : cwd) || this.cwd,
                    title: 'Earlier run',
                    updatedAt: '2026-03-26T00:00:00.000Z'
                }
            ],
            nextCursor: ''
        };
    }

    getSessionCapabilities() {
        return { ...this.sessionCapabilities };
    }

    async resumeTab(meta) {
        if (this.resumeDelayMs > 0) {
            await new Promise((resolve) => {
                setTimeout(resolve, this.resumeDelayMs);
            });
        }
        const tab = {
            id: meta.id,
            runtimeId: this.runtimeId,
            runtimeKey: this.runtimeKey,
            acpSessionId: meta.acpSessionId,
            agentId: this.definition.id,
            agentLabel: this.definition.label,
            commandLabel: this.definition.commandLabel,
            terminalSessionId: meta.terminalSessionId || '',
            cwd: meta.cwd,
            createdAt: '2026-03-28T00:00:00.000Z',
            status: 'ready',
            busy: false,
            errorMessage: '',
            currentModeId: '',
            title: meta.title || 'Previous run',
            availableModes: [
                { id: 'default', name: 'Default' },
                { id: 'review', name: 'Review' }
            ],
            availableCommands: [
                { name: 'review', description: 'Review code' }
            ],
            configOptions: [
                {
                    id: 'model',
                    name: 'Model',
                    category: 'model',
                    type: 'select',
                    currentValue: 'gpt-5.4',
                    options: [
                        { value: 'gpt-5.4', name: 'GPT-5.4' },
                        { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }
                    ]
                }
            ],
            sessionCapabilities: { ...this.sessionCapabilities },
            messages: [],
            toolCalls: [],
            permissions: [],
            plan: [],
            usage: null,
            terminals: []
        };
        this.tabs.set(tab.id, tab);
        this.resumedTabs.push(meta.acpSessionId);
        return { ...tab };
    }

    attachSocket() {
        return true;
    }

    async sendPrompt(tabId, text, attachments = []) {
        this.prompts.push({ tabId, text, attachments });
    }

    async cancel(tabId) {
        this.cancelled.push(tabId);
    }

    async resolvePermission(tabId, permissionId, optionId) {
        this.permissions.push({ tabId, permissionId, optionId });
    }

    async setMode(tabId, modeId) {
        this.modeChanges.push({ tabId, modeId });
        const tab = this.tabs.get(tabId);
        if (tab) {
            tab.currentModeId = modeId;
        }
        return {
            currentModeId: modeId,
            availableModes: [
                { id: 'default', name: 'Default' },
                { id: 'review', name: 'Review' }
            ]
        };
    }

    async setConfigOption(tabId, configId, valueId) {
        this.configChanges.push({ tabId, configId, valueId });
        const tab = this.tabs.get(tabId);
        if (tab) {
            tab.configOptions = (tab.configOptions || []).map((option) => (
                option.id === configId
                    ? { ...option, currentValue: valueId }
                    : option
            ));
        }
        return this.serializeTab(this.tabs.get(tabId));
    }

    async closeTab(tabId) {
        this.closedTabs.push(tabId);
        this.tabs.delete(tabId);
    }

    scheduleIdleShutdown(onIdle) {
        this.idleScheduled = true;
        this.onIdle = onIdle;
    }

    async dispose() {
        this.disposed = true;
    }
}

class FailingRuntime extends FakeRuntime {
    async createTab() {
        throw new Error('Authentication required');
    }
}

class SparseCommandsRuntime extends FakeRuntime {
    constructor(definition, options = {}) {
        super(definition, options);
        this.createCount = 0;
    }

    async createTab(meta) {
        this.createCount += 1;
        const tab = await super.createTab(meta);
        if (this.createCount > 1) {
            tab.availableCommands = [];
            tab.availableModes = [];
        }
        this.tabs.set(tab.id, { ...tab });
        return tab;
    }
}

function createSocketRecorder() {
    const events = [];
    return {
        events,
        socket: {
            readyState: 1,
            send(message) {
                events.push(JSON.parse(message));
            },
            on() {}
        }
    };
}

async function waitForValue(fn, timeoutMs = 5000, stepMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    throw new Error('Timed out waiting for condition');
}

describe('AcpManager', () => {
    it('uses the platform-specific Codex ACP package on supported platforms', async () => {
        const manager = new AcpManager();
        try {
            const codex = (await manager.listDefinitions()).find(
                (definition) => definition.id === 'codex'
            );
            assert.ok(codex);
            if (process.platform === 'darwin' && process.arch === 'arm64') {
                assert.match(
                    codex.commandLabel,
                    /@zed-industries\/codex-acp-darwin-arm64@latest/
                );
            }
        } finally {
            await manager.dispose().catch(() => {});
        }
    });

    it('starts a new synthetic restore turn when replay reaches a new user prompt', () => {
        const capture = createRestoreCaptureState([]);
        const ingest = (role, text) => {
            captureRestoreReplayChunk(
                capture,
                {
                    sessionUpdate: `${role}_message_chunk`
                },
                role,
                'message',
                text
            );
        };

        ingest('user', 'prompt one');
        ingest('assistant', 'reply one');
        ingest('user', 'prompt two');
        ingest('assistant', 'reply two');

        assert.deepEqual(
            capture.messages.map((message) => ({
                role: message.role,
                text: message.text,
                streamKey: message.streamKey
            })),
            [
                {
                    role: 'user',
                    text: 'prompt one',
                    streamKey: 'synthetic:0:user_message_chunk:user:message'
                },
                {
                    role: 'assistant',
                    text: 'reply one',
                    streamKey: 'synthetic:0:assistant_message_chunk:assistant:message'
                },
                {
                    role: 'user',
                    text: 'prompt two',
                    streamKey: 'synthetic:1:user_message_chunk:user:message'
                },
                {
                    role: 'assistant',
                    text: 'reply two',
                    streamKey: 'synthetic:1:assistant_message_chunk:assistant:message'
                }
            ]
        );
    });

    it('reuses baseline message metadata for matching restore replay entries', () => {
        const baseline = normalizeAgentTranscriptMessages([
            {
                id: 'user-1',
                streamKey: 'synthetic:42:user_message_chunk:user:message',
                role: 'user',
                kind: 'message',
                text: 'prompt one',
                createdAt: '2026-03-30T00:00:00.000Z'
            },
            {
                id: 'assistant-1',
                streamKey: 'synthetic:42:agent_message_chunk:assistant:message',
                role: 'assistant',
                kind: 'message',
                text: 'reply one',
                createdAt: '2026-03-30T00:00:01.000Z'
            }
        ]);
        const tab = {
            messages: structuredClone(baseline),
            restoreCapture: createRestoreCaptureState(baseline),
            toolCalls: new Map(),
            permissions: new Map(),
            timelineCounter: baseline.length,
            messageCounter: baseline.length
        };

        captureRestoreReplayChunk(
            tab.restoreCapture,
            { sessionUpdate: 'user_message_chunk' },
            'user',
            'message',
            'prompt one'
        );
        captureRestoreReplayChunk(
            tab.restoreCapture,
            { sessionUpdate: 'agent_message_chunk' },
            'assistant',
            'message',
            'reply one'
        );

        assert.equal(finalizeRestoreCaptureMessages(tab), false);
        assert.deepEqual(
            tab.messages.map((message) => ({
                id: message.id,
                streamKey: message.streamKey,
                createdAt: message.createdAt,
                role: message.role,
                text: message.text
            })),
            [
                {
                    id: 'user-1',
                    streamKey: 'synthetic:42:user_message_chunk:user:message',
                    createdAt: '2026-03-30T00:00:00.000Z',
                    role: 'user',
                    text: 'prompt one'
                },
                {
                    id: 'assistant-1',
                    streamKey: 'synthetic:42:agent_message_chunk:assistant:message',
                    createdAt: '2026-03-30T00:00:01.000Z',
                    role: 'assistant',
                    text: 'reply one'
                }
            ]
        );
    });

    it('assigns restore replay message orders from the shared timeline', () => {
        const capture = createRestoreCaptureState([]);
        const orders = [101, 103];
        capture.nextTimelineOrder = () => orders.shift();

        captureRestoreReplayChunk(
            capture,
            { sessionUpdate: 'user_message_chunk' },
            'user',
            'message',
            'prompt one'
        );
        captureRestoreReplayChunk(
            capture,
            { sessionUpdate: 'agent_message_chunk' },
            'assistant',
            'message',
            'reply one'
        );

        assert.deepEqual(
            capture.messages.map((message) => ({
                role: message.role,
                order: message.order
            })),
            [
                { role: 'user', order: 101 },
                { role: 'assistant', order: 103 }
            ]
        );
    });

    it('moves a replayed continued message to the latest shared timeline order', () => {
        const capture = createRestoreCaptureState([]);
        const orders = [101, 102, 103];
        capture.nextTimelineOrder = () => orders.shift();

        captureRestoreReplayChunk(
            capture,
            {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'message-1'
            },
            'assistant',
            'message',
            'Before tool. '
        );

        const tool = buildRestoredToolCall(
            null,
            null,
            {
                toolCallId: 'tool-1',
                status: 'completed'
            },
            () => capture.nextTimelineOrder(),
            {
                allowEmptyCreatedAt: true
            }
        );

        captureRestoreReplayChunk(
            capture,
            {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'message-1'
            },
            'assistant',
            'message',
            'After tool.'
        );

        assert.deepEqual(
            {
                text: capture.messages[0].text,
                order: capture.messages[0].order,
                toolOrder: tool.order
            },
            {
                text: 'Before tool. After tool.',
                order: 103,
                toolOrder: 102
            }
        );
    });

    it('preserves baseline tool timestamps during restore replay', () => {
        const nextTool = buildRestoredToolCall(
            null,
            {
                toolCallId: 'tool-1',
                title: 'Read file',
                status: 'completed',
                createdAt: '2026-03-23T00:01:01.000Z',
                updatedAt: '2026-03-23T00:01:04.000Z',
                content: [{ type: 'terminal', terminalId: 'terminal-1' }]
            },
            {
                toolCallId: 'tool-1',
                status: 'completed'
            },
            () => 77
        );

        assert.deepEqual(
            {
                toolCallId: nextTool.toolCallId,
                createdAt: nextTool.createdAt,
                updatedAt: nextTool.updatedAt,
                order: nextTool.order,
                title: nextTool.title,
                status: nextTool.status
            },
            {
                toolCallId: 'tool-1',
                createdAt: '2026-03-23T00:01:01.000Z',
                updatedAt: '2026-03-23T00:01:04.000Z',
                order: 77,
                title: 'Read file',
                status: 'completed'
            }
        );
    });

    it('does not invent a new tool timestamp on follow-up restore updates', () => {
        const firstTool = buildRestoredToolCall(
            null,
            null,
            {
                toolCallId: 'tool-1',
                status: 'pending'
            },
            () => 77,
            {
                allowEmptyCreatedAt: true
            }
        );

        const updatedTool = buildRestoredToolCall(
            firstTool,
            null,
            {
                toolCallId: 'tool-1',
                status: 'completed'
            },
            () => 78
        );

        assert.deepEqual(
            {
                createdAt: firstTool.createdAt,
                updatedCreatedAt: updatedTool.createdAt,
                order: updatedTool.order,
                status: updatedTool.status
            },
            {
                createdAt: '',
                updatedCreatedAt: '',
                order: 78,
                status: 'completed'
            }
        );
    });

    it('replaces polluted baseline transcript with authoritative restore replay', () => {
        const pollutedBaseline = normalizeAgentTranscriptMessages([
            {
                id: 'u1',
                streamKey: 'synthetic:40:user_message_chunk:user:message',
                role: 'user',
                kind: 'message',
                text: 'prompt one'
            },
            {
                id: 'a1',
                streamKey: 'synthetic:40:agent_message_chunk:assistant:message',
                role: 'assistant',
                kind: 'message',
                text: 'reply one'
            },
            {
                id: 'u2',
                streamKey: 'synthetic:40:user_message_chunk:user:message',
                role: 'user',
                kind: 'message',
                text: 'prompt one'
            },
            {
                id: 'a2',
                streamKey: 'synthetic:40:agent_message_chunk:assistant:message',
                role: 'assistant',
                kind: 'message',
                text: 'reply one'
            }
        ]);
        const ingestReplayIntoTab = (tab) => {
            const ingest = (role, text) => {
                captureRestoreReplayChunk(
                    tab.restoreCapture,
                    {
                        sessionUpdate: `${role}_message_chunk`
                    },
                    role,
                    'message',
                    text
                );
            };
            ingest('user', 'prompt one');
            ingest('assistant', 'reply one');
            ingest('user', 'prompt two');
            ingest('assistant', 'reply two');
        };
        const tab = {
            messages: structuredClone(pollutedBaseline),
            restoreCapture: createRestoreCaptureState(pollutedBaseline),
            toolCalls: new Map(),
            permissions: new Map(),
            timelineCounter: pollutedBaseline.length,
            messageCounter: pollutedBaseline.length
        };

        ingestReplayIntoTab(tab);

        assert.equal(finalizeRestoreCaptureMessages(tab), true);
        assert.deepEqual(
            tab.messages.map((message) => ({
                role: message.role,
                text: message.text
            })),
            [
                { role: 'user', text: 'prompt one' },
                { role: 'assistant', text: 'reply one' },
                { role: 'user', text: 'prompt two' },
                { role: 'assistant', text: 'reply two' }
            ]
        );

        const secondPass = {
            messages: structuredClone(tab.messages),
            restoreCapture: createRestoreCaptureState(tab.messages),
            toolCalls: new Map(),
            permissions: new Map(),
            timelineCounter: tab.messages.length,
            messageCounter: tab.messages.length
        };
        ingestReplayIntoTab(secondPass);

        assert.equal(finalizeRestoreCaptureMessages(secondPass), false);
        assert.deepEqual(
            secondPass.messages.map((message) => ({
                role: message.role,
                text: message.text,
                streamKey: message.streamKey
            })),
            tab.messages.map((message) => ({
                role: message.role,
                text: message.text,
                streamKey: message.streamKey
            }))
        );
    });

    function createManager(options = {}) {
        let persistedTabs = [];
        let persistedConfigs = {};
        const manager = new AcpManager({
            runtimeFactory: (definition, runtimeOptions) =>
                new FakeRuntime(definition, {
                    ...runtimeOptions,
                    ...(options.fakeRuntimeOptions || {})
                }),
            loadTabs: async () => persistedTabs,
            saveTabs: async (tabs) => {
                persistedTabs = structuredClone(tabs);
            },
            loadConfigs: async () => persistedConfigs,
            saveConfigs: async (configs) => {
                persistedConfigs = structuredClone(configs);
            }
        });
        manager.definitions = [{
            id: 'codex',
            label: 'Codex CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];
        return {
            manager,
            getPersistedTabs: () => persistedTabs,
            getPersistedConfigs: () => persistedConfigs
        };
    }

    it('reuses runtimes for the same agent and cwd', async () => {
        const { manager } = createManager();
        const first = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });
        const second = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-2'
        });

        assert.equal(manager.runtimes.size, 1);
        assert.notEqual(first.id, second.id);
        assert.equal(first.runtimeKey, second.runtimeKey);
    });

    it('closes tabs linked to a terminal session', async () => {
        const { manager } = createManager();
        const first = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });
        const second = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-2'
        });

        await manager.closeTabsForTerminalSession('term-1');

        assert.equal(manager.tabs.has(first.id), false);
        assert.equal(manager.tabs.has(second.id), true);
    });

    it('schedules idle shutdown after the last tab closes', async () => {
        const { manager } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });

        const runtimeEntry = manager.runtimes.values().next().value;
        await manager.closeTab(tab.id);

        assert.equal(manager.tabs.size, 0);
        assert.equal(runtimeEntry.runtime.idleScheduled, true);

        await runtimeEntry.runtime.onIdle();
        assert.equal(runtimeEntry.runtime.disposed, true);
        assert.equal(manager.runtimes.size, 0);
    });

    it('persists tab metadata on create and close', async () => {
        const { manager, getPersistedTabs } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });

        assert.equal(getPersistedTabs().length, 1);
        assert.equal(getPersistedTabs()[0].id, tab.id);
        assert.equal(getPersistedTabs()[0].agentId, 'codex');
        assert.equal(getPersistedTabs()[0].cwd, '/tmp/project');
        assert.equal(
            getPersistedTabs()[0].acpSessionId,
            `acp-${tab.id}`
        );
        assert.equal(getPersistedTabs()[0].terminalSessionId, 'term-1');
        assert.equal(
            getPersistedTabs()[0].createdAt,
            '2026-03-23T00:00:00.000Z'
        );
        assert.deepEqual(getPersistedTabs()[0].messages, []);
        assert.deepEqual(getPersistedTabs()[0].toolCalls, []);
        assert.deepEqual(getPersistedTabs()[0].terminals, []);

        await manager.closeTab(tab.id);
        assert.deepEqual(getPersistedTabs(), []);
    });

    it('exposes session history capabilities on serialized tabs', async () => {
        const { manager } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });

        assert.deepEqual(tab.sessionCapabilities, {
            load: true,
            list: true,
            listAll: true,
            resume: false,
            fork: false
        });
    });

    it('lists available historical sessions for a runtime', async () => {
        const { manager } = createManager();

        const result = await manager.listSessions({
            agentId: 'codex',
            cwd: '/tmp/project'
        });

        assert.equal(result.sessions.length, 2);
        assert.equal(result.sessions[0].sessionId, 'hist-1');
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.listRequests, [{
            cwd: '/tmp/project',
            cursor: '',
            all: false
        }]);
        assert.equal(runtimeEntry.runtime.idleScheduled, true);
    });

    it('uses all-session listing when the runtime supports it', async () => {
        const { manager } = createManager();

        const result = await manager.listSessions({
            agentId: 'codex',
            cwd: '/tmp/project',
            all: true
        });

        assert.equal(result.sessions.length, 2);
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.listRequests, [{
            cwd: null,
            cursor: '',
            all: true
        }]);
    });

    it('uses cwd-scoped listing when all-session listing is unsupported', async () => {
        let persistedTabs = [];
        let persistedConfigs = {};
        const manager = new AcpManager({
            runtimeFactory: (definition, options) => new FakeRuntime(
                definition,
                {
                    ...options,
                    supportsAllListing: false
                }
            ),
            loadTabs: async () => persistedTabs,
            saveTabs: async (tabs) => {
                persistedTabs = structuredClone(tabs);
            },
            loadConfigs: async () => persistedConfigs,
            saveConfigs: async (configs) => {
                persistedConfigs = structuredClone(configs);
            }
        });
        manager.definitions = [{
            id: 'codex',
            label: 'Codex CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];

        const result = await manager.listSessions({
            agentId: 'codex',
            cwd: '/tmp/project',
            all: true
        });

        assert.equal(result.sessions.length, 2);
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.listRequests, [
            {
                cwd: '/tmp/project',
                cursor: '',
                all: false
            }
        ]);
    });

    it('merges cwd and all-session listings for resume discovery', async () => {
        const { manager } = createManager();

        const result = await manager.listResumeSessions({
            agentId: 'codex',
            cwd: '/tmp/project'
        });

        assert.equal(result.scope, 'merged');
        assert.equal(result.sessions.length, 2);
        assert.deepEqual(
            result.sessions.map((session) => [session.sessionId, session.cwd]),
            [
                ['hist-1', '/tmp/project'],
                ['hist-2', '/tmp/project']
            ]
        );
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.listRequests, [
            {
                cwd: '/tmp/project',
                cursor: '',
                all: false
            },
            {
                cwd: null,
                cursor: '',
                all: true
            }
        ]);
    });

    it('keeps cwd results when all-session listing fails', async () => {
        let persistedTabs = [];
        let persistedConfigs = {};
        const manager = new AcpManager({
            runtimeFactory: (definition, options) => {
                const runtime = new FakeRuntime(definition, options);
                const original = runtime.listSessions.bind(runtime);
                runtime.listSessions = async ({ all = false, ...rest } = {}) => {
                    if (all) {
                        runtime.listRequests.push({
                            cwd: null,
                            cursor: rest.cursor || '',
                            all: true
                        });
                        throw new Error('All-session listing unsupported');
                    }
                    return await original({ all, ...rest });
                };
                return runtime;
            },
            loadTabs: async () => persistedTabs,
            saveTabs: async (tabs) => {
                persistedTabs = structuredClone(tabs);
            },
            loadConfigs: async () => persistedConfigs,
            saveConfigs: async (configs) => {
                persistedConfigs = structuredClone(configs);
            }
        });
        manager.definitions = [{
            id: 'codex',
            label: 'Codex CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];

        const result = await manager.listResumeSessions({
            agentId: 'codex',
            cwd: '/tmp/project'
        });

        assert.equal(result.scope, 'cwd');
        assert.equal(result.sessions.length, 2);
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.listRequests, [
            {
                cwd: '/tmp/project',
                cursor: '',
                all: false
            },
            {
                cwd: null,
                cursor: '',
                all: true
            }
        ]);
    });

    it('creates a new tab from a historical session', async () => {
        const { manager, getPersistedTabs } = createManager();

        const tab = await manager.resumeTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1',
            sessionId: 'hist-1',
            title: 'Previous run'
        });

        assert.equal(tab.acpSessionId, 'hist-1');
        assert.equal(tab.terminalSessionId, 'term-1');
        assert.equal(tab.title, 'Previous run');
        assert.equal(getPersistedTabs().length, 1);
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.resumedTabs, ['hist-1']);
    });

    it('reuses an existing open tab for the same ACP session', async () => {
        const { manager, getPersistedTabs } = createManager();

        const first = await manager.resumeTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1',
            sessionId: 'hist-1',
            title: 'Previous run'
        });
        const second = await manager.resumeTab({
            agentId: 'codex',
            cwd: '/tmp/other-project',
            terminalSessionId: 'term-2',
            sessionId: 'hist-1',
            title: 'Duplicate open'
        });

        assert.equal(second.id, first.id);
        assert.equal(manager.tabs.size, 1);
        assert.equal(getPersistedTabs().length, 1);
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.resumedTabs, ['hist-1']);
    });

    it('coalesces concurrent resume requests for the same ACP session', async () => {
        const { manager, getPersistedTabs } = createManager({
            fakeRuntimeOptions: {
                resumeDelayMs: 20
            }
        });

        const [first, second] = await Promise.all([
            manager.resumeTab({
                agentId: 'codex',
                cwd: '/tmp/project',
                terminalSessionId: 'term-1',
                sessionId: 'hist-1',
                title: 'Previous run'
            }),
            manager.resumeTab({
                agentId: 'codex',
                cwd: '/tmp/other-project',
                terminalSessionId: 'term-2',
                sessionId: 'hist-1',
                title: 'Duplicate open'
            })
        ]);

        assert.equal(second.id, first.id);
        assert.equal(manager.tabs.size, 1);
        assert.equal(getPersistedTabs().length, 1);
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.resumedTabs, ['hist-1']);
    });

    it('restores persisted tabs when linked terminal sessions exist', async () => {
        const { manager, getPersistedTabs } = createManager();
        const persisted = [{
            id: 'restored-tab',
            agentId: 'codex',
            cwd: '/tmp/project',
            acpSessionId: 'acp-restored',
            terminalSessionId: 'term-1',
            createdAt: '2026-03-23T00:00:00.000Z'
        }];
        await manager.saveTabs(persisted);
        await manager.restoreTabs(new Set(['term-1']));

        assert.equal(manager.tabs.has('restored-tab'), true);
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.restoredTabs, ['restored-tab']);
        assert.equal(getPersistedTabs().length, 1);
        assert.equal(getPersistedTabs()[0].id, 'restored-tab');
        assert.equal(getPersistedTabs()[0].agentId, 'codex');
        assert.equal(getPersistedTabs()[0].cwd, '/tmp/project');
        assert.equal(getPersistedTabs()[0].acpSessionId, 'acp-restored');
        assert.equal(getPersistedTabs()[0].terminalSessionId, 'term-1');
    });

    it('dedupes persisted tabs that share an ACP session id', async () => {
        const { manager, getPersistedTabs } = createManager();
        await manager.saveTabs([
            {
                id: 'debug-restore',
                agentId: 'codex',
                cwd: '/tmp/debug',
                acpSessionId: 'acp-shared',
                terminalSessionId: '',
                createdAt: '2026-03-31T08:34:04.316Z',
                title: 'debug restore',
                messages: [
                    {
                        id: 'message-old',
                        streamKey:
                            'synthetic:10:agent_message_chunk:assistant:message',
                        role: 'assistant',
                        kind: 'message',
                        text: 'latest transcript',
                        order: 2
                    }
                ],
                toolCalls: [
                    {
                        toolCallId: 'tool-latest',
                        createdAt: '2026-03-31T08:40:00.000Z',
                        order: 3,
                        title: 'Latest tool'
                    }
                ]
            },
            {
                id: 'linked-tab',
                agentId: 'codex',
                cwd: '/tmp/project',
                acpSessionId: 'acp-shared',
                terminalSessionId: 'term-1',
                createdAt: '2026-03-31T12:02:07.976Z',
                title: 'Project tab',
                messages: [
                    {
                        id: 'message-older',
                        streamKey:
                            'synthetic:8:agent_message_chunk:assistant:message',
                        role: 'assistant',
                        kind: 'message',
                        text: 'older transcript',
                        order: 2
                    }
                ]
            }
        ]);

        await manager.restoreTabs(new Set(['term-1']));

        assert.equal(manager.tabs.size, 1);
        assert.equal(manager.tabs.has('linked-tab'), true);
        const restored = manager.tabs.get('linked-tab')?.serialize();
        assert.ok(restored);
        assert.equal(restored.terminalSessionId, 'term-1');
        assert.equal(restored.cwd, '/tmp/project');
        assert.equal(restored.title, 'Project tab');
        assert.equal(restored.messages.length, 1);
        assert.equal(
            restored.messages[0].streamKey,
            'synthetic:10:agent_message_chunk:assistant:message'
        );
        assert.equal(getPersistedTabs().length, 1);
        assert.equal(getPersistedTabs()[0].id, 'linked-tab');
        assert.equal(getPersistedTabs()[0].terminalSessionId, 'term-1');
        assert.equal(
            getPersistedTabs()[0].messages[0].streamKey,
            'synthetic:10:agent_message_chunk:assistant:message'
        );
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.restoredTabs, ['linked-tab']);
    });

    it('restores synthetic stream turn above persisted synthetic messages', async () => {
        assert.equal(getNextSyntheticStreamTurn([]), 0);
        assert.equal(getNextSyntheticStreamTurn([
            {
                streamKey: 'synthetic:7:agent_message_chunk:assistant:message'
            }
        ]), 8);
        assert.equal(getNextSyntheticStreamTurn([
            {
                streamKey: 'synthetic:7:agent_message_chunk:assistant:message'
            },
            {
                streamKey: 'plain-message-id'
            },
            {
                streamKey: 'synthetic:12:agent_message_chunk:assistant:message'
            }
        ]), 13);
    });

    it('drops persisted tabs whose terminal session no longer exists', async () => {
        const { manager, getPersistedTabs } = createManager();
        await manager.saveTabs([{
            id: 'orphaned-tab',
            agentId: 'codex',
            cwd: '/tmp/project',
            acpSessionId: 'acp-orphaned',
            terminalSessionId: 'missing-session',
            createdAt: '2026-03-23T00:00:00.000Z'
        }]);

        await manager.restoreTabs(new Set());

        assert.equal(manager.tabs.size, 0);
        assert.deepEqual(getPersistedTabs(), []);
    });

    it('preserves persisted tabs during manager disposal', async () => {
        const { manager, getPersistedTabs } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });

        await manager.dispose();

        assert.equal(getPersistedTabs().length, 1);
        assert.equal(getPersistedTabs()[0].id, tab.id);
        assert.equal(getPersistedTabs()[0].agentId, 'codex');
        assert.equal(getPersistedTabs()[0].cwd, '/tmp/project');
        assert.equal(
            getPersistedTabs()[0].acpSessionId,
            `acp-${tab.id}`
        );
        assert.equal(getPersistedTabs()[0].terminalSessionId, 'term-1');
        assert.equal(
            getPersistedTabs()[0].createdAt,
            '2026-03-23T00:00:00.000Z'
        );
    });

    it('persists ACP transcript snapshots for restore', async () => {
        const { manager, getPersistedTabs } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });
        const runtimeEntry = manager.runtimes.values().next().value;
        const runtimeTab = runtimeEntry.runtime.tabs.get(tab.id);
        runtimeTab.title = 'Workspace check';
        runtimeTab.currentModeId = 'review';
        runtimeTab.messages = [{
            id: 'message-1',
            streamKey: 'message-1',
            role: 'assistant',
            kind: 'message',
            text: 'hello',
            createdAt: '2026-03-23T00:01:00.000Z',
            order: 1
        }];
        runtimeTab.toolCalls = [{
            toolCallId: 'tool-1',
            title: 'Read file',
            createdAt: '2026-03-23T00:01:01.000Z',
            order: 2,
            content: [{
                type: 'terminal',
                terminalId: 'terminal-1'
            }]
        }];
        runtimeTab.permissions = [{
            id: 'permission-1',
            status: 'selected',
            createdAt: '2026-03-23T00:01:02.000Z',
            order: 3
        }];
        runtimeTab.plan = [{
            content: 'Inspect files',
            priority: 'high',
            status: 'completed'
        }];
        runtimeTab.usage = {
            used: 12,
            size: 100,
            updatedAt: '2026-03-23T00:01:03.000Z'
        };
        runtimeTab.terminals = [{
            terminalId: 'terminal-1',
            terminalSessionId: '',
            command: 'pwd',
            cwd: '/tmp/project',
            output: '/tmp/project',
            createdAt: '2026-03-23T00:01:01.000Z',
            updatedAt: '2026-03-23T00:01:04.000Z',
            released: true,
            running: false,
            exitStatus: {
                exitCode: 0,
                signal: null
            }
        }];

        await manager.persistTabs();

        assert.equal(getPersistedTabs()[0].title, 'Workspace check');
        assert.equal(getPersistedTabs()[0].currentModeId, 'review');
        assert.equal(getPersistedTabs()[0].messages.length, 1);
        assert.equal(getPersistedTabs()[0].toolCalls.length, 1);
        assert.equal(getPersistedTabs()[0].permissions.length, 1);
        assert.equal(getPersistedTabs()[0].plan.length, 1);
        assert.equal(getPersistedTabs()[0].terminals.length, 1);
        assert.equal(getPersistedTabs()[0].terminals[0].output, '/tmp/project');
    });

    it('restores persisted terminal history alongside tool history', async () => {
        const { manager } = createManager();
        await manager.saveTabs([{
            id: 'restored-history',
            agentId: 'codex',
            cwd: '/tmp/project',
            acpSessionId: 'acp-restored-history',
            terminalSessionId: '',
            createdAt: '2026-03-23T00:00:00.000Z',
            title: 'History',
            currentModeId: 'review',
            availableModes: [{ id: 'review', name: 'Review' }],
            availableCommands: [{ name: 'review', description: 'Review code' }],
            configOptions: [],
            messages: [{
                id: 'message-1',
                streamKey: 'message-1',
                role: 'assistant',
                kind: 'message',
                text: 'restored',
                createdAt: '2026-03-23T00:01:00.000Z',
                order: 1
            }],
            toolCalls: [{
                toolCallId: 'tool-1',
                title: 'Read file',
                createdAt: '2026-03-23T00:01:01.000Z',
                order: 2,
                content: [{
                    type: 'terminal',
                    terminalId: 'terminal-1'
                }]
            }],
            permissions: [],
            plan: [{
                content: 'Inspect files',
                priority: 'medium',
                status: 'completed'
            }],
            usage: {
                used: 5,
                size: 20,
                updatedAt: '2026-03-23T00:01:02.000Z'
            },
            terminals: [{
                terminalId: 'terminal-1',
                terminalSessionId: '',
                command: 'pwd',
                cwd: '/tmp/project',
                output: '/tmp/project',
                createdAt: '2026-03-23T00:01:01.000Z',
                updatedAt: '2026-03-23T00:01:04.000Z',
                released: true,
                running: false,
                exitStatus: {
                    exitCode: 0,
                    signal: null
                }
            }]
        }]);

        await manager.restoreTabs(new Set());

        const restored = manager.tabs.get('restored-history')?.serialize();
        assert.ok(restored);
        assert.equal(restored.title, 'History');
        assert.equal(restored.messages.length, 1);
        assert.equal(restored.toolCalls.length, 1);
        assert.equal(restored.terminals.length, 1);
        assert.equal(restored.terminals[0].released, true);
        assert.equal(
            restored.terminals[0].output,
            '/tmp/project'
        );
        assert.equal(
            restored.toolCalls[0].content[0].terminalId,
            'terminal-1'
        );
    });

    it('reports restoring state through listState', async () => {
        const { manager } = createManager();
        manager.restoring = true;

        const state = await manager.listState();

        assert.equal(state.restoring, true);
    });

    it('creates tabs with an initial mode when requested', async () => {
        const { manager } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1',
            modeId: 'review'
        });

        assert.equal(tab.currentModeId, 'review');
    });

    it('updates session config options when requested', async () => {
        const { manager } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });

        const updated = await manager.setConfigOption(
            tab.id,
            'thought_level',
            'high'
        );

        const thoughtLevel = updated.configOptions.find(
            (option) => option.id === 'thought_level'
        );
        assert.equal(thoughtLevel?.currentValue, 'high');
    });

    it('reuses cached runtime commands and modes when a later tab omits them', async () => {
        const manager = new AcpManager({
            runtimeFactory: (definition, options) =>
                new SparseCommandsRuntime(definition, options),
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        manager.definitions = [{
            id: 'codex',
            label: 'Codex CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];

        const first = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });
        const second = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-2'
        });

        assert.deepEqual(second.availableCommands, first.availableCommands);
        assert.deepEqual(second.availableModes, first.availableModes);
    });

    it('treats saved Gemini keys as available config', async () => {
        let persistedConfigs = {
            gemini: {
                env: {
                    GEMINI_API_KEY: 'test-key'
                }
            }
        };
        const manager = new AcpManager({
            runtimeFactory: (definition, options) =>
                new FakeRuntime(definition, options),
            loadTabs: async () => [],
            saveTabs: async () => {},
            loadConfigs: async () => persistedConfigs,
            saveConfigs: async (configs) => {
                persistedConfigs = structuredClone(configs);
            }
        });
        manager.definitions = [{
            id: 'gemini',
            label: 'Gemini CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];

        const [definition] = await manager.listDefinitions();

        assert.equal(definition.available, true);
        assert.equal(definition.config.hasGeminiApiKey, true);
    });

    it('reports saved Copilot token config in definitions', async () => {
        let persistedConfigs = {
            copilot: {
                env: {
                    COPILOT_GITHUB_TOKEN: 'test-token'
                }
            }
        };
        const manager = new AcpManager({
            runtimeFactory: (definition, options) =>
                new FakeRuntime(definition, options),
            loadTabs: async () => [],
            saveTabs: async () => {},
            loadConfigs: async () => persistedConfigs,
            saveConfigs: async (configs) => {
                persistedConfigs = structuredClone(configs);
            }
        });
        manager.definitions = [{
            id: 'copilot',
            label: 'GitHub Copilot',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];

        const [definition] = await manager.listDefinitions();

        assert.equal(definition.available, true);
        assert.equal(definition.config.hasCopilotToken, true);
    });

    it('detects a standalone Copilot binary from HOME local bin', async () => {
        const originalHome = process.env.HOME;
        const originalPath = process.env.PATH;
        const tmpHome = await fs.mkdtemp(
            path.join(os.tmpdir(), 'tabminal-copilot-path-')
        );
        const localBin = path.join(tmpHome, '.local', 'bin');
        const copilotPath = path.join(localBin, 'copilot');
        await fs.mkdir(localBin, { recursive: true });
        await fs.writeFile(copilotPath, '#!/bin/sh\nexit 0\n', 'utf8');
        await fs.chmod(copilotPath, 0o755);

        process.env.HOME = tmpHome;
        process.env.PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

        const manager = new AcpManager({
            runtimeFactory: (definition, options) =>
                new FakeRuntime(definition, options),
            loadTabs: async () => [],
            saveTabs: async () => {},
            loadConfigs: async () => ({}),
            saveConfigs: async () => {}
        });

        try {
            const definitions = await manager.listDefinitions();
            const builtIn = manager.definitions.find((item) => item.id === 'copilot');
            const definition = definitions.find((item) => item.id === 'copilot');
            assert.ok(builtIn);
            assert.ok(definition);
            assert.equal(builtIn.command, 'copilot');
            assert.equal(definition.commandLabel, 'copilot --acp --stdio');
            assert.equal(definition.available, true);
        } finally {
            await manager.dispose();
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
            await fs.rm(tmpHome, { recursive: true, force: true });
        }
    });

    it('marks Codex unavailable when auth probe fails', async () => {
        const manager = new AcpManager({
            runtimeFactory: (definition, options) =>
                new FakeRuntime(definition, options),
            loadTabs: async () => [],
            saveTabs: async () => {},
            availabilityProbes: {
                commandExists: () => true,
                hasGhCopilotWrapper: () => true,
                hasGhCopilotCliInstalled: () => true,
                probeCodexAuth: () => ({
                    available: false,
                    reason: 'Run `codex login` on this host'
                }),
                probeGhAuth: () => ({
                    available: true,
                    reason: ''
                })
            }
        });
        manager.definitions = [{
            id: 'codex',
            label: 'Codex CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];

        const [definition] = await manager.listDefinitions();

        assert.equal(definition.available, false);
        assert.equal(definition.reason, 'Run `codex login` on this host');
    });

    it('marks Copilot unavailable when gh auth probe fails', async () => {
        const manager = new AcpManager({
            runtimeFactory: (definition, options) =>
                new FakeRuntime(definition, options),
            loadTabs: async () => [],
            saveTabs: async () => {},
            availabilityProbes: {
                commandExists: () => true,
                hasGhCopilotWrapper: () => true,
                hasGhCopilotCliInstalled: () => true,
                probeCodexAuth: () => ({
                    available: true,
                    reason: ''
                }),
                probeGhAuth: () => ({
                    available: false,
                    reason: 'Run `gh auth login` or set `COPILOT_GITHUB_TOKEN`'
                })
            }
        });
        manager.definitions = [{
            id: 'copilot',
            label: 'GitHub Copilot',
            description: 'test',
            command: 'gh',
            args: ['copilot', '--', '--acp', '--stdio'],
            commandLabel: 'gh copilot -- --acp --stdio',
            setupCommandLabel: 'gh copilot'
        }];

        const [definition] = await manager.listDefinitions();

        assert.equal(definition.available, false);
        assert.equal(
            definition.reason,
            'Run `gh auth login` or set `COPILOT_GITHUB_TOKEN`'
        );
    });

    it('merges and clears saved agent config values', async () => {
        const { manager, getPersistedConfigs } = createManager();
        manager.definitions.push({
            id: 'claude',
            label: 'Claude Agent',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        });

        await manager.updateAgentConfig('claude', {
            env: {
                ANTHROPIC_API_KEY: 'alpha',
                CLAUDE_CODE_USE_VERTEX: '1',
                ANTHROPIC_VERTEX_PROJECT_ID: 'proj-a'
            }
        });

        await manager.updateAgentConfig('claude', {
            env: {
                CLOUD_ML_REGION: 'us-central1'
            },
            clearEnvKeys: ['CLAUDE_CODE_USE_VERTEX']
        });

        assert.deepEqual(getPersistedConfigs().claude.env, {
            ANTHROPIC_API_KEY: 'alpha',
            ANTHROPIC_VERTEX_PROJECT_ID: 'proj-a',
            CLOUD_ML_REGION: 'us-central1'
        });
    });

    it('stores and clears saved Copilot token config values', async () => {
        const { manager, getPersistedConfigs } = createManager();
        manager.definitions.push({
            id: 'copilot',
            label: 'GitHub Copilot',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        });

        await manager.updateAgentConfig('copilot', {
            env: {
                COPILOT_GITHUB_TOKEN: 'alpha'
            }
        });

        await manager.updateAgentConfig('copilot', {
            env: {},
            clearEnvKeys: ['COPILOT_GITHUB_TOKEN']
        });

        assert.deepEqual(getPersistedConfigs().copilot.env, {});
    });

    it('starts a fresh runtime after agent config changes', async () => {
        const { manager } = createManager();
        manager.definitions.push({
            id: 'gemini',
            label: 'Gemini CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        });

        await manager.updateAgentConfig('gemini', {
            env: { GEMINI_API_KEY: 'alpha' }
        });
        const first = await manager.createTab({
            agentId: 'gemini',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });
        await manager.updateAgentConfig('gemini', {
            env: { GEMINI_API_KEY: 'beta' }
        });
        const second = await manager.createTab({
            agentId: 'gemini',
            cwd: '/tmp/project',
            terminalSessionId: 'term-2'
        });

        assert.equal(manager.runtimes.size, 2);
        assert.notEqual(first.runtimeId, second.runtimeId);
    });

    it('wraps shell-like terminal commands when args are omitted', () => {
        const request = buildTerminalSpawnRequest({
            command: 'ls -la /tmp'
        });

        assert.equal(request.shell, true);
        assert.ok(request.args.length > 0);
    });

    it('keeps explicit terminal args as argv execution', () => {
        const request = buildTerminalSpawnRequest({
            command: 'ls',
            args: ['-la', '/tmp']
        });

        assert.equal(request.shell, false);
        assert.equal(request.command, 'ls');
        assert.deepEqual(request.args, ['-la', '/tmp']);
    });

    it('switches modes for an existing agent tab', async () => {
        const { manager } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });

        const updated = await manager.setMode(tab.id, 'review');

        assert.equal(updated.currentModeId, 'review');
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.deepEqual(runtimeEntry.runtime.modeChanges, [{
            tabId: tab.id,
            modeId: 'review'
        }]);
    });

    it('disposes a runtime that fails during initial tab creation', async () => {
        let runtime = null;
        const manager = new AcpManager({
            runtimeFactory: (definition, options) => {
                runtime = new FailingRuntime(definition, options);
                return runtime;
            },
            loadTabs: async () => [],
            saveTabs: async () => {},
            availabilityProbes: {
                commandExists: () => true,
                hasGhCopilotWrapper: () => true,
                hasGhCopilotCliInstalled: () => true,
                probeCodexAuth: () => ({
                    available: true,
                    reason: ''
                }),
                probeGhAuth: () => ({
                    available: true,
                    reason: ''
                })
            }
        });
        manager.definitions = [{
            id: 'codex',
            label: 'Codex CLI',
            description: 'test',
            command: process.execPath,
            args: [],
            commandLabel: process.execPath
        }];

        await assert.rejects(
            manager.createTab({
                agentId: 'codex',
                cwd: '/tmp/project',
                terminalSessionId: 'term-1'
            }),
            /Codex is not authenticated on this host/
        );

        assert.ok(runtime);
        assert.equal(runtime.disposed, true);
        assert.equal(manager.runtimes.size, 0);

        const [definition] = await manager.listDefinitions();
        assert.equal(definition.available, false);
        assert.match(
            definition.reason,
            /Codex is not authenticated on this host/
        );
    });

    it('surfaces spawn errors during runtime startup without crashing', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {},
            availabilityProbes: {
                commandExists: () => true,
                hasGhCopilotWrapper: () => true,
                hasGhCopilotCliInstalled: () => true,
                probeCodexAuth: () => ({
                    available: true,
                    reason: ''
                }),
                probeGhAuth: () => ({
                    available: true,
                    reason: ''
                })
            }
        });
        manager.definitions = [{
            id: 'codex',
            label: 'Codex CLI',
            description: 'test',
            command: '__definitely_not_a_real_command__',
            args: [],
            commandLabel: '__definitely_not_a_real_command__'
        }];

        await assert.rejects(
            manager.createTab({
                agentId: 'codex',
                cwd: '/tmp/project'
            }),
            /not installed|not found|failed/i
        );
        assert.equal(manager.runtimes.size, 0);
    });

    it('streams real ACP test-agent permission turns end-to-end', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, '/permission');

            const permissionEvent = await waitForValue(
                () => events.find((event) => event.type === 'permission_request')
            );
            assert.ok(permissionEvent.permission.id);

            const runningTab = await waitForValue(async () => {
                const state = await manager.listState();
                return state.tabs.find((entry) => entry.id === tab.id)
                    || null;
            });
            assert.equal(runningTab.busy, true);
            assert.match(
                runningTab.messages.at(-1)?.text || '',
                /Prompt: \/permission/
            );
            assert.match(
                runningTab.messages.at(-1)?.createdAt || '',
                /^\d{4}-\d{2}-\d{2}T/
            );
            assert.match(
                runningTab.permissions.at(-1)?.createdAt || '',
                /^\d{4}-\d{2}-\d{2}T/
            );
            assert.equal(runningTab.permissions.length, 1);

            await manager.resolvePermission(
                tab.id,
                permissionEvent.permission.id,
                'allow-once'
            );

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                if (!current) return null;
                const hasTool = current.toolCalls.some((tool) => (
                    tool.toolCallId === 'permission-tool'
                    && tool.status === 'completed'
                ));
                const granted = current.messages.some((message) => (
                    /Permission was granted/.test(message.text || '')
                ));
                const selected = current.permissions.some((permission) => (
                    permission.status === 'selected'
                    && permission.selectedOptionId === 'allow-once'
                ));
                return hasTool && granted && selected && !current.busy
                    ? current
                    : null;
            }, 12000);
            assert.equal(settledTab.status, 'ready');
            assert.ok(
                settledTab.messages.some((message) => (
                    /Permission was granted/.test(message.text || '')
                ))
            );
        } finally {
            await manager.dispose();
        }
    });

    it('advertises and executes real ACP test-agent slash commands', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const createdTab = (await manager.listState()).tabs.find(
                (entry) => entry.id === tab.id
            );
            const commandNames = new Set(
                (createdTab?.availableCommands || []).map((command) => (
                    String(command.name || '')
                ))
            );
            assert.equal(commandNames.has('plan'), true);
            assert.equal(commandNames.has('diff'), true);
            assert.equal(commandNames.has('permission'), true);
            assert.equal(commandNames.has('cancel'), true);

            await manager.sendPrompt(tab.id, '/plan');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                if (!current) return null;
                const hasMessage = current.messages.some((message) => (
                    message.streamKey === 'plan-result'
                    && message.text === 'Plan-only demo complete.'
                ));
                return hasMessage && !current.busy ? current : null;
            }, 12000);

            assert.equal(settledTab.title, 'plan');
            assert.equal(settledTab.plan.length, 3);
            assert.equal(settledTab.plan.every((entry) => (
                entry.status === 'completed'
            )), true);
            assert.ok(
                settledTab.messages.some((message) => (
                    /Plan-only demo complete/.test(message.text || '')
                ))
            );
        } finally {
            await manager.dispose();
        }
    });

    it('cancels real ACP test-agent prompt turns cleanly', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, '/cancel');
            await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current?.busy ? current : null;
            });
            await waitForValue(() => events.find((event) => (
                (
                    event.type === 'message_open'
                    && event.message?.streamKey === 'cancel-smoke'
                )
                || (
                    event.type === 'message_chunk'
                    && event.streamKey === 'cancel-smoke'
                )
            )), 12000);

            await manager.cancel(tab.id);

            const completedEvent = await waitForValue(
                () => events.find((event) => (
                    event.type === 'complete'
                    && event.stopReason === 'cancelled'
                )),
                12000
            );
            assert.equal(completedEvent.status, 'ready');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current && !current.busy ? current : null;
            }, 12000);
            assert.equal(settledTab.status, 'ready');
            assert.equal(settledTab.title, 'cancel');
            assert.equal(settledTab.toolCalls.length, 0);
            assert.ok(
                settledTab.messages.some((message) => (
                    /Tabminal ACP smoke agent online/.test(message.text || '')
                ))
            );
        } finally {
            await manager.dispose();
        }
    });

    it('splits synthetic assistant chunks around tool calls', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });

            await manager.sendPrompt(tab.id, '/order');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                if (!current) return null;
                const hasBefore = current.messages.some((message) => (
                    message.text === 'Before tool.'
                ));
                const hasAfter = current.messages.some((message) => (
                    message.text === 'After tool.'
                ));
                const hasTool = current.toolCalls.some((tool) => (
                    tool.toolCallId === 'synthetic-tool'
                ));
                return hasBefore && hasAfter && hasTool ? current : null;
            }, 12000);

            const beforeMessage = settledTab.messages.find((message) => (
                message.text === 'Before tool.'
            ));
            const afterMessage = settledTab.messages.find((message) => (
                message.text === 'After tool.'
            ));
            const toolCall = settledTab.toolCalls.find((tool) => (
                tool.toolCallId === 'synthetic-tool'
            ));

            assert.ok(beforeMessage);
            assert.ok(afterMessage);
            assert.ok(toolCall);
            assert.ok(beforeMessage.order < toolCall.order);
            assert.ok(toolCall.order < afterMessage.order);
        } finally {
            await manager.dispose();
        }
    });

    it('moves a continued assistant message order after later tool calls', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, '/inline-order');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                if (!current) return null;
                const hasMessage = current.messages.some((message) => (
                    message.streamKey === 'inline-order-message'
                    && message.text === 'Before tool. After tool.'
                ));
                const hasTool = current.toolCalls.some((tool) => (
                    tool.toolCallId === 'inline-order-tool'
                ));
                return hasMessage && hasTool ? current : null;
            }, 12000);

            const assistantMessage = settledTab.messages.find((message) => (
                message.streamKey === 'inline-order-message'
            ));
            const toolCall = settledTab.toolCalls.find((tool) => (
                tool.toolCallId === 'inline-order-tool'
            ));
            const chunkEvent = events.find((event) => (
                event.type === 'message_chunk'
                && event.streamKey === 'inline-order-message'
            ));

            assert.ok(assistantMessage);
            assert.ok(toolCall);
            assert.ok(chunkEvent);
            assert.equal(
                assistantMessage.text,
                'Before tool. After tool.'
            );
            assert.ok(assistantMessage.order > toolCall.order);
            assert.equal(chunkEvent.order, assistantMessage.order);
        } finally {
            await manager.dispose();
        }
    });

    it('reproduces cumulative assistant chunks at the backend bridge layer', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, '/cumulative-debug');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current && !current.busy ? current : null;
            }, 12000);

            const syntheticMessage = settledTab.messages.find((message) => (
                message.streamKey?.startsWith(
                    'synthetic:'
                )
            ));
            assert.ok(syntheticMessage);
            assert.equal(syntheticMessage.text, 'Alpha Beta');

            const openEvent = events.find((event) => (
                event.type === 'message_open'
                && event.message?.streamKey?.startsWith('synthetic:')
            ));
            const chunkEvent = events.find((event) => (
                event.type === 'message_chunk'
                && event.streamKey?.startsWith('synthetic:')
            ));

            assert.ok(openEvent);
            assert.ok(chunkEvent);
            assert.equal(openEvent.message.text, 'Alpha');
            assert.equal(chunkEvent.text, ' Beta');
        } finally {
            await manager.dispose();
        }
    });

    it('deduplicates an identical synthetic restart without message ids', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, '/restart-debug');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current && !current.busy ? current : null;
            }, 12000);

            const syntheticMessages = settledTab.messages.filter((message) => (
                String(message.streamKey || '').startsWith('synthetic:')
            ));
            assert.equal(syntheticMessages.length, 1);
            assert.equal(
                syntheticMessages[0].text,
                'Report A\nline 1\nline 2\n'
            );

            const opens = events.filter((event) => (
                event.type === 'message_open'
                && String(event.message?.streamKey || '').startsWith(
                    'synthetic:'
                )
            ));
            const chunks = events.filter((event) => (
                event.type === 'message_chunk'
                && String(event.streamKey || '').startsWith('synthetic:')
            ));
            assert.equal(opens.length, 1);
            assert.equal(chunks.length, 3);
        } finally {
            await manager.dispose();
        }
    });

    it('conflates restarted assistant text with slight drift into one synthetic message', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, '/restart-drift-debug');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current && !current.busy ? current : null;
            }, 12000);

            const syntheticMessages = settledTab.messages.filter((message) => (
                String(message.streamKey || '').startsWith('synthetic:')
            ));
            assert.equal(syntheticMessages.length, 1);
            assert.equal(
                syntheticMessages[0].text,
                '時間戳：1\nDataset A\nDataset B\n時間戳：2\nDataset A\n'
            );

            const opens = events.filter((event) => (
                event.type === 'message_open'
                && String(event.message?.streamKey || '').startsWith(
                    'synthetic:'
                )
            ));
            assert.equal(opens.length, 1);
        } finally {
            await manager.dispose();
        }
    });

    it('captures plan usage and terminal summaries from real ACP updates', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, '/diff');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current && !current.busy ? current : null;
            }, 12000);

            assert.equal(settledTab.title, 'diff');
            assert.equal(settledTab.plan.length, 3);
            assert.equal(settledTab.plan.every((entry) => (
                entry.status === 'completed'
            )), true);
            assert.equal(settledTab.plan[0].priority, 'high');
            assert.equal(settledTab.usage.used, 48200);
            assert.equal(settledTab.usage.size, 262144);
            assert.equal(settledTab.usage.vendorLabel, 'Tabminal Test Agent');
            assert.equal(settledTab.usage.sessionId, tab.acpSessionId);
            assert.equal(settledTab.usage.summary, 'Synthetic quota view');
            assert.equal(settledTab.usage.windows.length, 2);
            assert.equal(
                settledTab.usage.windows[0].subtitle,
                'short-term window'
            );
            assert.equal(
                settledTab.usage.windows[0].resetDisplay,
                'resets in 11h 33 mins'
            );
            assert.equal(
                settledTab.usage.windows[1].resetDisplay,
                'resets Sep 30'
            );
            assert.equal(settledTab.terminals.length, 1);
            assert.equal(settledTab.terminals[0].released, true);
            assert.equal(settledTab.terminals[0].terminalSessionId, '');
            assert.match(
                settledTab.terminals[0].output || '',
                /alpha[\s\S]*beta/
            );
            assert.ok(events.some((event) => (
                event.type === 'session_update'
                && event.update?.sessionUpdate === 'session_info_update'
                && event.update?.title === 'diff'
            )));
        } finally {
            await manager.dispose();
        }
    });

    it('settles stale running tool calls when a prompt completes', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });
            const { events, socket } = createSocketRecorder();
            manager.attachSocket(tab.id, socket);

            await manager.sendPrompt(tab.id, 'stale-tool');

            const settledTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current && !current.busy ? current : null;
            }, 12000);

            const staleTool = settledTab.toolCalls.find((tool) => (
                tool.toolCallId === 'stale-tool'
            ));
            assert.ok(staleTool);
            assert.equal(staleTool.status, 'completed');
            assert.equal(settledTab.terminals.length, 1);
            assert.equal(settledTab.terminals[0].released, true);
            assert.equal(settledTab.terminals[0].running, false);
            assert.ok(events.some((event) => (
                event.type === 'session_update'
                && event.update?.sessionUpdate === 'tool_call_update'
                && event.update?.toolCallId === 'stale-tool'
                && event.update?.status === 'completed'
            )));
        } finally {
            await manager.dispose();
        }
    });

    it('passes prompt attachments through to the runtime', async () => {
        const { manager } = createManager();
        const tab = await manager.createTab({
            agentId: 'codex',
            cwd: '/tmp/project',
            terminalSessionId: 'term-1'
        });
        const runtimeEntry = manager.runtimes.values().next().value;
        assert.ok(runtimeEntry?.runtime);

        await manager.sendPrompt(tab.id, 'attach this', [{
            id: 'att-1',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 12,
            tempPath: '/tmp/notes.txt'
        }]);

        assert.deepEqual(runtimeEntry.runtime.prompts.at(-1), {
            tabId: tab.id,
            text: 'attach this',
            attachments: [{
                id: 'att-1',
                name: 'notes.txt',
                mimeType: 'text/plain',
                size: 12,
                tempPath: '/tmp/notes.txt'
            }]
        });
    });

    it('marks a tab errored when a real ACP prompt fails', async () => {
        const manager = new AcpManager({
            loadTabs: async () => [],
            saveTabs: async () => {}
        });
        const agentPath = fileURLToPath(
            new URL('../src/acp-test-agent.mjs', import.meta.url)
        );
        manager.definitions = [{
            id: 'test-agent',
            label: 'ACP Test Agent',
            description: 'Local ACP smoke-test agent',
            command: process.execPath,
            args: [agentPath],
            commandLabel: `${process.execPath} ${agentPath}`
        }];

        try {
            const tab = await manager.createTab({
                agentId: 'test-agent',
                cwd: process.cwd(),
                terminalSessionId: 'term-1'
            });

            await manager.sendPrompt(tab.id, 'fail-prompt');
            const erroredTab = await waitForValue(async () => {
                const state = await manager.listState();
                const current = state.tabs.find((entry) => entry.id === tab.id);
                return current && current.status === 'error' && !current.busy
                    ? current
                    : null;
            });

            assert.equal(erroredTab.status, 'error');
            assert.equal(erroredTab.busy, false);
            assert.ok(
                (erroredTab.errorMessage || '').length > 0,
                'expected a surfaced prompt failure message'
            );
        } finally {
            await manager.dispose();
        }
    });

    it('merges sentence chunks into separate paragraphs', () => {
        assert.equal(
            mergeAgentMessageText(
                'Creating the file now.',
                'Created `file.txt` with hello.'
            ),
            'Creating the file now.\n\nCreated `file.txt` with hello.'
        );
    });

    it('does not inject spacing into normal token streams', () => {
        assert.equal(
            mergeAgentMessageText('hel', 'lo'),
            'hello'
        );
        assert.equal(
            mergeAgentMessageText('hello', ' world'),
            'hello world'
        );
    });

    it('preserves markdown fences split across stream chunks', () => {
        assert.equal(
            mergeAgentMessageText('```text\nx\n``', '`\n\nnext'),
            '```text\nx\n```\n\nnext'
        );
        assert.equal(
            mergeAgentMessageText('`', '`'),
            '``'
        );
        assert.equal(
            mergeAgentMessageText('``', '`'),
            '```'
        );
        assert.equal(
            mergeAgentMessageText('`', '``'),
            '```'
        );
    });

    it('deduplicates cumulative assistant chunks', () => {
        assert.equal(
            mergeAgentMessageText('Alpha', 'Alpha Beta'),
            'Alpha Beta'
        );
        assert.equal(
            mergeAgentMessageText('Alpha Beta', 'Beta Gamma'),
            'Alpha Beta Gamma'
        );
    });

    it('collapses repeated synthetic turn replay blocks', () => {
        const messages = normalizeAgentTranscriptMessages([
            {
                id: 'u1',
                role: 'user',
                kind: 'message',
                streamKey: 'synthetic:42:user_message_chunk:user:message',
                text: '重新輸出一次進度表'
            },
            {
                id: 'a1',
                role: 'assistant',
                kind: 'message',
                streamKey: 'synthetic:42:agent_message_chunk:assistant:message',
                text: '# 進度矩陣'
            },
            {
                id: 'u2',
                role: 'user',
                kind: 'message',
                streamKey: 'synthetic:42:user_message_chunk:user:message',
                text: '重新輸出一次進度表'
            },
            {
                id: 'a2',
                role: 'assistant',
                kind: 'message',
                streamKey: 'synthetic:42:agent_message_chunk:assistant:message',
                text: '# 進度矩陣'
            },
            {
                id: 'u3',
                role: 'user',
                kind: 'message',
                streamKey: 'synthetic:43:user_message_chunk:user:message',
                text: '下一條'
            },
            {
                id: 'a3',
                role: 'assistant',
                kind: 'message',
                streamKey: 'synthetic:43:agent_message_chunk:assistant:message',
                text: 'OK'
            }
        ]);

        assert.deepEqual(
            messages.map((message) => ({
                id: message.id,
                streamKey: message.streamKey,
                text: message.text,
                order: message.order
            })),
            [
                {
                    id: 'u1',
                    streamKey: 'synthetic:42:user_message_chunk:user:message',
                    text: '重新輸出一次進度表',
                    order: 1
                },
                {
                    id: 'a2',
                    streamKey: 'synthetic:42:agent_message_chunk:assistant:message',
                    text: '# 進度矩陣',
                    order: 4
                },
                {
                    id: 'u3',
                    streamKey: 'synthetic:43:user_message_chunk:user:message',
                    text: '下一條',
                    order: 5
                },
                {
                    id: 'a3',
                    streamKey: 'synthetic:43:agent_message_chunk:assistant:message',
                    text: 'OK',
                    order: 6
                }
            ]
        );
    });

    it('preserves existing message orders when collapsing replay blocks', () => {
        const messages = normalizeAgentTranscriptMessages([
            {
                id: 'u1',
                role: 'user',
                kind: 'message',
                streamKey: 'synthetic:42:user_message_chunk:user:message',
                text: '重新輸出一次進度表',
                order: 101
            },
            {
                id: 'a1',
                role: 'assistant',
                kind: 'message',
                streamKey: 'synthetic:42:agent_message_chunk:assistant:message',
                text: '# 進度矩陣',
                order: 102
            },
            {
                id: 'u2',
                role: 'user',
                kind: 'message',
                streamKey: 'synthetic:42:user_message_chunk:user:message',
                text: '重新輸出一次進度表',
                order: 103
            },
            {
                id: 'a2',
                role: 'assistant',
                kind: 'message',
                streamKey: 'synthetic:42:agent_message_chunk:assistant:message',
                text: '# 進度矩陣',
                order: 104
            }
        ]);

        assert.deepEqual(
            messages.map((message) => ({
                id: message.id,
                order: message.order
            })),
            [
                { id: 'u1', order: 101 },
                { id: 'a2', order: 104 }
            ]
        );
    });
});
