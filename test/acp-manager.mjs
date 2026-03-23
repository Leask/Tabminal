import assert from 'node:assert/strict';
import process from 'node:process';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';

import { AcpManager } from '../src/acp-manager.mjs';

class FakeRuntime extends EventEmitter {
    constructor(definition, options = {}) {
        super();
        this.definition = definition;
        this.cwd = options.cwd;
        this.runtimeId = `rt-${definition.id}-${this.cwd}`;
        this.runtimeKey = `${definition.id}::${this.cwd}`;
        this.tabs = new Map();
        this.createdTabs = [];
        this.closedTabs = [];
        this.prompts = [];
        this.cancelled = [];
        this.permissions = [];
        this.disposed = false;
        this.idleScheduled = false;
        this.restoredTabs = [];
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
            availableModes: [],
            messages: [],
            toolCalls: [],
            permissions: []
        };
        this.tabs.set(tab.id, tab);
        this.createdTabs.push(tab.id);
        return { ...tab };
    }

    serializeTab(tab) {
        return { ...tab };
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
            availableModes: [],
            messages: [{
                id: 'restored-message',
                streamKey: 'restored',
                role: 'assistant',
                kind: 'message',
                text: 'restored'
            }],
            toolCalls: [],
            permissions: []
        };
        this.tabs.set(tab.id, tab);
        this.restoredTabs.push(tab.id);
        return { ...tab };
    }

    attachSocket() {
        return true;
    }

    async sendPrompt(tabId, text) {
        this.prompts.push({ tabId, text });
    }

    async cancel(tabId) {
        this.cancelled.push(tabId);
    }

    async resolvePermission(tabId, permissionId, optionId) {
        this.permissions.push({ tabId, permissionId, optionId });
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

describe('AcpManager', () => {
    function createManager() {
        let persistedTabs = [];
        const manager = new AcpManager({
            runtimeFactory: (definition, options) =>
                new FakeRuntime(definition, options),
            loadTabs: async () => persistedTabs,
            saveTabs: async (tabs) => {
                persistedTabs = structuredClone(tabs);
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
            getPersistedTabs: () => persistedTabs
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

        assert.deepEqual(getPersistedTabs(), [{
            id: tab.id,
            agentId: 'codex',
            cwd: '/tmp/project',
            acpSessionId: `acp-${tab.id}`,
            terminalSessionId: 'term-1',
            createdAt: '2026-03-23T00:00:00.000Z'
        }]);

        await manager.closeTab(tab.id);
        assert.deepEqual(getPersistedTabs(), []);
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
        assert.deepEqual(getPersistedTabs(), persisted);
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

        assert.deepEqual(getPersistedTabs(), [{
            id: tab.id,
            agentId: 'codex',
            cwd: '/tmp/project',
            acpSessionId: `acp-${tab.id}`,
            terminalSessionId: 'term-1',
            createdAt: '2026-03-23T00:00:00.000Z'
        }]);
    });
});
