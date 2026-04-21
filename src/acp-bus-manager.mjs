import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';

import {
    AcpRuntime,
    mergeDefinitionEnv
} from './acp-manager.mjs';
import {
    AcpBusStore,
    buildAcpBusSessionKey
} from './acp-bus-store.mjs';

const DEFAULT_POLL_INTERVAL_MS = 10000;
const DEFAULT_HOT_SESSION_LIMIT = 10;
const DEFAULT_CACHE_SESSION_LIMIT = 1000;
const DEFAULT_EVENT_LIMIT = 2000;
const DEFAULT_SNAPSHOT_FLUSH_DELAY_MS = 250;
const DEFAULT_REPLAY_GAP_MS = 10 * 60 * 1000;

function nowIso() {
    return new Date().toISOString();
}

function buildObserveRuntimeKey(agentId, cwd) {
    return `${String(agentId || '').trim()}::${path.resolve(cwd || '/')}`;
}

function createRuntimeStoreKey(kind, agentId, cwd) {
    return `bus:${kind}:${String(agentId || '').trim()}:${path.resolve(cwd || '/')}`;
}

function cloneSerializable(value, fallback) {
    if (value === undefined) {
        return fallback;
    }
    try {
        return structuredClone(value);
    } catch {
        return fallback;
    }
}

function normalizeOpenAgentTab(entry = {}) {
    const id = String(entry.id || '').trim();
    const agentId = String(entry.agentId || '').trim();
    const acpSessionId = String(
        entry.acpSessionId
        || entry.sessionId
        || ''
    ).trim();
    const cwd = String(entry.cwd || '').trim();
    if (!id || !agentId || !acpSessionId || !cwd) {
        return null;
    }
    return {
        id,
        agentId,
        acpSessionId,
        cwd,
        terminalSessionId: String(entry.terminalSessionId || '').trim(),
        createdAt: String(entry.createdAt || '').trim() || nowIso(),
        title: typeof entry.title === 'string' ? entry.title : '',
        currentModeId: typeof entry.currentModeId === 'string'
            ? entry.currentModeId
            : ''
    };
}

function shouldRecordIndexChange(previous, next) {
    if (!previous) {
        return 'session_index_created';
    }
    if (
        previous.title !== next.title
        || previous.cwd !== next.cwd
        || previous.upstreamUpdatedAt !== next.upstreamUpdatedAt
        || previous.isPresent !== next.isPresent
    ) {
        return next.isPresent
            ? 'session_index_updated'
            : 'session_index_removed';
    }
    return '';
}

export class AcpBusManager extends EventEmitter {
    constructor(options = {}) {
        super();
        if (!options.acpManager) {
            throw new Error('acpManager is required');
        }
        this.acpManager = options.acpManager;
        this.store = options.store || new AcpBusStore({
            eventLimit: options.eventLimit || DEFAULT_EVENT_LIMIT
        });
        this.runtimeFactory = options.runtimeFactory || (
            (definition, runtimeOptions) => new AcpRuntime(definition, runtimeOptions)
        );
        this.loadOpenTabs = typeof options.loadOpenTabs === 'function'
            ? options.loadOpenTabs
            : async () => [];
        this.saveOpenTabs = typeof options.saveOpenTabs === 'function'
            ? options.saveOpenTabs
            : async () => {};
        this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
            ? Math.max(500, Math.floor(options.pollIntervalMs))
            : DEFAULT_POLL_INTERVAL_MS;
        this.hotSessionLimit = Number.isFinite(options.hotSessionLimit)
            ? Math.max(1, Math.floor(options.hotSessionLimit))
            : DEFAULT_HOT_SESSION_LIMIT;
        this.cacheSessionLimit = Number.isFinite(options.cacheSessionLimit)
            ? Math.max(this.hotSessionLimit, Math.floor(options.cacheSessionLimit))
            : DEFAULT_CACHE_SESSION_LIMIT;
        this.replayGapMs = Number.isFinite(options.replayGapMs)
            ? Math.max(0, Math.floor(options.replayGapMs))
            : DEFAULT_REPLAY_GAP_MS;
        this.snapshotFlushDelayMs = Number.isFinite(options.snapshotFlushDelayMs)
            ? Math.max(50, Math.floor(options.snapshotFlushDelayMs))
            : DEFAULT_SNAPSHOT_FLUSH_DELAY_MS;
        this.discoveryCwd = path.resolve(
            options.discoveryCwd || process.cwd()
        );
        this.now = typeof options.now === 'function' ? options.now : nowIso;
        this.started = false;
        this.restoring = false;
        this.startPromise = null;
        this.syncPromise = null;
        this.pollTimer = null;
        this.discoveryRuntimes = new Map();
        this.observeRuntimes = new Map();
        this.observedSessions = new Map();
        this.pinnedSessions = new Map();
        this.tabToSessionKey = new Map();
        this.openTabs = new Map();
        this.openTabsPersistenceChain = Promise.resolve();
        this.pendingResumeTabs = new Map();
        this.snapshotFlushTimers = new Map();
        this.rebalancePromise = null;
        this.rebalancePendingReason = '';
    }

    async start(options = {}) {
        if (this.started) {
            return;
        }
        if (this.startPromise) {
            return await this.startPromise;
        }
        this.startPromise = this.#startInternal(options);
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async #startInternal(options = {}) {
        this.restoring = true;
        try {
            await this.acpManager.ensureConfigsLoaded();
            await this.store.init();
            await this.#restoreOpenTabs(options);
            await this.syncNow('startup');
            this.started = true;
            await this.#restoreHotSessions();
            this.#scheduleNextPoll();
        } finally {
            this.restoring = false;
        }
    }

    async dispose() {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
        for (const timer of this.snapshotFlushTimers.values()) {
            clearTimeout(timer);
        }
        this.snapshotFlushTimers.clear();

        const observedKeys = Array.from(this.observedSessions.keys());
        for (const sessionKey of observedKeys) {
            await this.#detachHotSession(sessionKey, 'shutdown');
        }
        this.observedSessions.clear();
        this.pinnedSessions.clear();
        this.tabToSessionKey.clear();
        this.openTabs.clear();

        const discoveryEntries = Array.from(this.discoveryRuntimes.values());
        this.discoveryRuntimes.clear();
        await Promise.allSettled(discoveryEntries.map((entry) =>
            entry.runtime.dispose()
        ));

        const observeEntries = Array.from(this.observeRuntimes.values());
        this.observeRuntimes.clear();
        await Promise.allSettled(observeEntries.map((entry) =>
            entry.runtime.dispose()
        ));

        this.started = false;
        this.store.close();
    }

    getState() {
        return {
            started: this.started,
            restoring: this.restoring,
            pollIntervalMs: this.pollIntervalMs,
            hotSessionLimit: this.hotSessionLimit,
            cacheSessionLimit: this.cacheSessionLimit,
            observedSessionCount: this.observedSessions.size,
            pinnedSessionCount: this.pinnedSessions.size,
            openTabCount: this.openTabs.size,
            discoveryRuntimeCount: this.discoveryRuntimes.size,
            observeRuntimeCount: this.observeRuntimes.size,
            store: this.store.getSummary()
        };
    }

    listSessions(options = {}) {
        return this.store.listSessions(options);
    }

    getSession(agentId, sessionId, options = {}) {
        return this.store.getSessionByIdentity(agentId, sessionId, options);
    }

    listEvents(limit = 100) {
        return this.store.listEvents(limit);
    }

    listTimelineItems(sessionKey, options = {}) {
        return this.store.listTimelineItems(sessionKey, options);
    }

    async listState() {
        await this.acpManager.ensureConfigsLoaded();
        return {
            restoring: this.restoring,
            definitions: await this.acpManager.listDefinitions(),
            configs: await this.acpManager.listAgentConfigs(),
            tabs: this.listOpenTabs()
        };
    }

    async listInventory() {
        return {
            restoring: this.restoring,
            tabs: this.listOpenTabs().map((tab) => ({
                id: tab.id,
                runtimeId: tab.runtimeId,
                runtimeKey: tab.runtimeKey,
                acpSessionId: tab.acpSessionId,
                agentId: tab.agentId,
                agentLabel: tab.agentLabel,
                commandLabel: tab.commandLabel,
                title: tab.title,
                terminalSessionId: tab.terminalSessionId,
                cwd: tab.cwd,
                createdAt: tab.createdAt,
                status: tab.status,
                busy: tab.busy,
                errorMessage: tab.errorMessage,
                currentModeId: tab.currentModeId,
                sessionCapabilities: tab.sessionCapabilities,
                busConnectionKind: tab.busConnectionKind,
                busContinuityState: tab.busContinuityState,
                busHotRank: tab.busHotRank
            }))
        };
    }

    listOpenTabs(options = {}) {
        const includeTranscript = options.includeTranscript === true;
        return Array.from(this.openTabs.keys())
            .map((tabId) => this.getOpenTab(tabId, { includeTranscript }))
            .filter(Boolean);
    }

    getOpenTab(tabId, options = {}) {
        const meta = this.openTabs.get(String(tabId || '').trim());
        if (!meta) {
            return null;
        }
        const session = this.store.getSession(
            buildAcpBusSessionKey(meta.agentId, meta.acpSessionId),
            { includeSnapshot: true }
        );
        const handle = session
            ? this.observedSessions.get(session.sessionKey)
            : null;
        const runtime = handle?.runtimeEntry?.runtime || null;
        const runtimeTab = runtime?.tabs instanceof Map
            ? runtime.tabs.get(handle.tabId)
            : null;
        const liveSnapshot = runtimeTab
            ? runtime.serializeTab(runtimeTab)
            : null;
        return this.#mergeOpenTabSnapshot(meta, session, liveSnapshot, {
            includeTranscript: options.includeTranscript === true,
            runtime
        });
    }

    async attachOpenTab(tabId, reason = 'agent_tab_attach') {
        const meta = this.openTabs.get(String(tabId || '').trim());
        if (!meta) {
            return null;
        }
        const session = await this.pinSession(
            `agent-tab:${meta.id}`,
            {
                agentId: meta.agentId,
                sessionId: meta.acpSessionId,
                cwd: meta.cwd,
                title: meta.title
            },
            reason
        );
        return {
            tab: this.getOpenTab(meta.id),
            session
        };
    }

    getTimelinePageForTab(tabId, query = {}) {
        const meta = this.openTabs.get(String(tabId || '').trim());
        if (!meta) {
            return null;
        }
        const session = this.store.getSession(
            buildAcpBusSessionKey(meta.agentId, meta.acpSessionId)
        );
        if (!session) {
            return {
                sessionKey: '',
                items: [],
                total: 0,
                hasOlder: false,
                hasNewer: false,
                minIndex: 0,
                maxIndex: 0,
                firstIndex: 0,
                lastIndex: 0,
                prevCursor: '',
                nextCursor: ''
            };
        }
        return {
            sessionKey: session.sessionKey,
            ...this.store.listTimelineItems(session.sessionKey, {
                limit: Number.parseInt(query.limit, 10),
                before: typeof query.before === 'string' ? query.before : '',
                after: typeof query.after === 'string' ? query.after : ''
            })
        };
    }

    async markSessionInterest(entry = {}) {
        const result = this.store.markSessionInterest(entry);
        this.#emitEvent('session_index_updated', result.record, {
            reason: 'interest'
        });
        this.#scheduleRebalance('interest');
        return result.record;
    }

    async pinSession(pinId, entry = {}, reason = 'ui_attach') {
        const normalizedPinId = String(pinId || '').trim();
        if (!normalizedPinId) {
            throw new Error('pinId is required');
        }
        const result = this.store.markSessionInterest(entry);
        const previousSessionKey = this.pinnedSessions.get(normalizedPinId) || '';
        this.pinnedSessions.set(normalizedPinId, result.record.sessionKey);
        await this.#ensureObservedSession(result.record, reason);
        this.#scheduleRebalance(reason);
        if (previousSessionKey !== result.record.sessionKey) {
            this.#emitEvent('session_ui_attached', result.record, {
                reason,
                pinId: normalizedPinId
            });
        }
        return this.store.getSession(result.record.sessionKey, {
            includeSnapshot: true
        });
    }

    async createTabForUi(options = {}) {
        await this.start();
        const definition = this.#getAvailableDefinition(options.agentId);
        const cwd = path.resolve(options.cwd || process.cwd());
        const runtimeEntry = this.#getObserveRuntime(definition, cwd);
        const tabId = crypto.randomUUID();
        let rawSerialized = null;
        try {
            rawSerialized = await runtimeEntry.runtime.createTab({
                id: tabId,
                cwd,
                terminalSessionId: options.terminalSessionId || '',
                modeId: options.modeId || ''
            });
        } catch (error) {
            await this.#disposeObserveRuntimeIfIdle(runtimeEntry);
            throw error;
        }
        const serialized = this.#decorateSerializedTab(
            rawSerialized,
            runtimeEntry.runtime
        );
        const handle = this.#registerRuntimeHandle(
            runtimeEntry,
            tabId,
            serialized
        );
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt: this.now(),
            attachedAt: this.now(),
            liveAt: this.now(),
            preserveSnapshotContent: false
        });
        runtimeEntry.sessionKeys.add(handle.sessionKey);
        await this.#rememberOpenTab(serialized, 'agent_tab_create');
        if (persisted.changed) {
            this.#emitEvent(
                'session_snapshot_updated',
                persisted.record,
                this.#buildSnapshotEventExtra(persisted, {
                    reason: 'agent_tab_create'
                })
            );
        }
        this.#emitEvent('session_ui_attached', persisted.record, {
            reason: 'agent_tab_create',
            pinId: `agent-tab:${serialized.id}`
        });
        return this.getOpenTab(serialized.id);
    }

    async resumeTabForUi(options = {}) {
        await this.start();
        const previous = this.getSession(
            options.agentId,
            options.sessionId
        );
        const resumeKey = [
            String(options.agentId || '').trim(),
            String(options.sessionId || '').trim(),
            String(options.targetTabId || '').trim()
        ].join('\0');
        const pending = this.pendingResumeTabs.get(resumeKey);
        if (pending) {
            return await pending;
        }

        const resumePromise = this.#resumeTabForUiInternal(options, previous);
        this.pendingResumeTabs.set(resumeKey, resumePromise);
        try {
            return await resumePromise;
        } finally {
            this.pendingResumeTabs.delete(resumeKey);
        }
    }

    async #resumeTabForUiInternal(options = {}, previous = null) {
        const definition = this.#getAvailableDefinition(options.agentId);
        const cwd = path.resolve(options.cwd || process.cwd());
        const targetTabId = String(options.targetTabId || '').trim();
        const tabId = targetTabId || crypto.randomUUID();
        const sessionKey = buildAcpBusSessionKey(definition.id, options.sessionId);
        let handle = this.observedSessions.get(sessionKey) || null;
        let serialized = null;

        if (handle?.runtimeEntry?.runtime) {
            const runtimeTab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
            if (runtimeTab) {
                serialized = this.#decorateSerializedTab(
                    handle.runtimeEntry.runtime.serializeTab(runtimeTab),
                    handle.runtimeEntry.runtime
                );
            }
        }

        if (!serialized) {
            const runtimeEntry = this.#getObserveRuntime(definition, cwd);
            const replayHistory = !runtimeEntry.runtime
                .getSessionCapabilities?.().resume;
            try {
                serialized = this.#decorateSerializedTab(
                    await runtimeEntry.runtime.resumeTab({
                        id: tabId,
                        acpSessionId: options.sessionId,
                        cwd,
                        terminalSessionId: options.terminalSessionId || '',
                        title: options.title || ''
                    }, {
                        replayHistory
                    }),
                    runtimeEntry.runtime
                );
            } catch (error) {
                await this.#disposeObserveRuntimeIfIdle(runtimeEntry);
                throw error;
            }
            handle = this.#registerRuntimeHandle(runtimeEntry, tabId, serialized);
            runtimeEntry.sessionKeys.add(handle.sessionKey);
            const persisted = this.store.saveObservedSession(serialized, {
                continuityState: 'live',
                observedAt: this.now(),
                attachedAt: this.now(),
                liveAt: this.now(),
                preserveSnapshotContent: true
            });
            if (persisted.changed) {
                this.#emitEvent(
                    'session_snapshot_updated',
                    persisted.record,
                    this.#buildSnapshotEventExtra(persisted, {
                        reason: 'resume_tab'
                    })
                );
            }
        }

        const uiSerialized = {
            ...serialized,
            id: tabId,
            terminalSessionId: options.terminalSessionId
                || serialized.terminalSessionId
                || '',
            cwd: serialized.cwd || cwd,
            title: serialized.title || options.title || ''
        };
        await this.#rememberOpenTab(uiSerialized, 'agent_tab_attach');
        const busSession = await this.pinSession(
            `agent-tab:${tabId}`,
            {
                agentId: definition.id,
                sessionId: uiSerialized.acpSessionId,
                cwd: uiSerialized.cwd,
                title: uiSerialized.title
            },
            'agent_tab_attach'
        );
        const attachSource = previous?.continuityState === 'live'
            ? 'hot'
            : previous
                ? 'cache'
                : 'cold';
        return {
            serialized: this.getOpenTab(tabId) || uiSerialized,
            busSession,
            attachSource
        };
    }

    async unpinSession(pinId, reason = 'ui_detach') {
        const normalizedPinId = String(pinId || '').trim();
        if (!normalizedPinId) {
            return false;
        }
        const sessionKey = this.pinnedSessions.get(normalizedPinId) || '';
        if (!sessionKey) {
            return false;
        }
        this.pinnedSessions.delete(normalizedPinId);
        this.#scheduleRebalance(reason);
        const record = this.store.getSession(sessionKey, {
            includeSnapshot: true
        });
        if (record) {
            this.#emitEvent('session_ui_detached', record, {
                reason,
                pinId: normalizedPinId
            });
        }
        return true;
    }

    async closeTabForUi(tabId) {
        const normalizedTabId = String(tabId || '').trim();
        if (!normalizedTabId) {
            return false;
        }
        const existed = this.openTabs.delete(normalizedTabId);
        await this.unpinSession(`agent-tab:${normalizedTabId}`, 'agent_tab_close');
        this.tabToSessionKey.delete(normalizedTabId);
        if (existed) {
            await this.#persistOpenTabs();
        }
        return existed;
    }

    async closeTabsForTerminalSession(terminalSessionId) {
        const targetSessionId = String(terminalSessionId || '').trim();
        if (!targetSessionId) {
            return;
        }
        const tabIds = Array.from(this.openTabs.values())
            .filter((tab) => tab.terminalSessionId === targetSessionId)
            .map((tab) => tab.id);
        for (const tabId of tabIds) {
            await this.closeTabForUi(tabId);
        }
    }

    async releaseManagedTerminalSession(terminalSessionId, options = {}) {
        const targetSessionId = String(terminalSessionId || '').trim();
        if (!targetSessionId) {
            return false;
        }
        for (const entry of this.observeRuntimes.values()) {
            if (
                typeof entry.runtime.releaseManagedTerminalSession
                !== 'function'
            ) {
                continue;
            }
            const released = await entry.runtime.releaseManagedTerminalSession(
                targetSessionId,
                options
            );
            if (released) {
                return true;
            }
        }
        return false;
    }

    async #restoreOpenTabs(options = {}) {
        const validTerminalSessionIds = options.validTerminalSessionIds instanceof Set
            ? options.validTerminalSessionIds
            : null;
        const rawTabs = await this.loadOpenTabs();
        const seenTabIds = new Set();
        const restoredTabs = [];
        let changed = false;
        for (const rawTab of rawTabs) {
            const tab = normalizeOpenAgentTab(rawTab);
            if (!tab) {
                changed = true;
                continue;
            }
            if (seenTabIds.has(tab.id)) {
                changed = true;
                continue;
            }
            if (
                tab.terminalSessionId
                && validTerminalSessionIds
                && !validTerminalSessionIds.has(tab.terminalSessionId)
            ) {
                changed = true;
                continue;
            }
            seenTabIds.add(tab.id);
            restoredTabs.push(tab);
            this.openTabs.set(tab.id, tab);
            const result = this.store.markSessionInterest({
                agentId: tab.agentId,
                sessionId: tab.acpSessionId,
                cwd: tab.cwd,
                title: tab.title
            });
            this.pinnedSessions.set(`agent-tab:${tab.id}`, result.record.sessionKey);
            this.tabToSessionKey.set(tab.id, result.record.sessionKey);
        }
        if (changed) {
            await this.#persistOpenTabs(restoredTabs);
        }
    }

    async #rememberOpenTab(serialized, reason = 'agent_tab_update') {
        const tab = normalizeOpenAgentTab(serialized);
        if (!tab) {
            throw new Error('Open agent tab requires a session identity');
        }
        this.openTabs.set(tab.id, tab);
        const result = this.store.markSessionInterest({
            agentId: tab.agentId,
            sessionId: tab.acpSessionId,
            cwd: tab.cwd,
            title: tab.title
        });
        this.pinnedSessions.set(`agent-tab:${tab.id}`, result.record.sessionKey);
        this.tabToSessionKey.set(tab.id, result.record.sessionKey);
        await this.#persistOpenTabs();
        this.#scheduleRebalance(reason);
        return tab;
    }

    async #persistOpenTabs(tabs = null) {
        const payload = (Array.isArray(tabs)
            ? tabs
            : Array.from(this.openTabs.values())
        ).map((tab) => ({
            id: tab.id,
            agentId: tab.agentId,
            cwd: tab.cwd,
            acpSessionId: tab.acpSessionId,
            terminalSessionId: tab.terminalSessionId,
            createdAt: tab.createdAt,
            title: tab.title,
            currentModeId: tab.currentModeId
        }));
        this.openTabsPersistenceChain = this.openTabsPersistenceChain
            .catch(() => {})
            .then(() => this.saveOpenTabs(payload));
        await this.openTabsPersistenceChain;
    }

    #getPinnedSessionKeyForTab(tabId) {
        const normalizedTabId = String(tabId || '').trim();
        if (!normalizedTabId) {
            return '';
        }
        return this.pinnedSessions.get(`agent-tab:${normalizedTabId}`)
            || this.tabToSessionKey.get(normalizedTabId)
            || '';
    }

    #getControlTarget(tabId) {
        const normalizedTabId = String(tabId || '').trim();
        if (!normalizedTabId) {
            throw new Error('Agent tab not found');
        }
        const sessionKey = this.#getPinnedSessionKeyForTab(normalizedTabId);
        const handle = sessionKey
            ? this.observedSessions.get(sessionKey)
            : null;
        if (handle?.runtimeEntry?.runtime && handle.tabId) {
            return {
                source: 'bus',
                tabId: handle.tabId,
                handle
            };
        }
        throw new Error('Agent tab not found');
    }

    #persistBusHandleSnapshot(handle, reason) {
        if (!handle?.runtimeEntry?.runtime || !handle.tabId) {
            return null;
        }
        const tab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
        if (!tab) {
            return null;
        }
        const observedAt = this.now();
        const serialized = handle.runtimeEntry.runtime.serializeTab(tab);
        const authoritativeSnapshot = tab.authoritativeSnapshot === true
            || serialized.authoritativeSnapshot === true;
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt,
            liveAt: observedAt,
            preserveSnapshotContent: !authoritativeSnapshot,
            authoritativeSnapshot
        });
        tab.authoritativeSnapshot = false;
        if (persisted.changed) {
            this.#emitEvent(
                'session_snapshot_updated',
                persisted.record,
                this.#buildSnapshotEventExtra(persisted, { reason })
            );
        }
        return serialized;
    }

    async sendPromptForTab(tabId, text, attachments = []) {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            await target.handle.runtimeEntry.runtime.sendPrompt(
                target.tabId,
                text,
                attachments
            );
            this.#persistBusHandleSnapshot(target.handle, 'send_prompt');
            return;
        }
    }

    async cancelForTab(tabId) {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            await target.handle.runtimeEntry.runtime.cancel(target.tabId);
            this.#persistBusHandleSnapshot(target.handle, 'cancel');
            return;
        }
    }

    async resolvePermissionForTab(tabId, permissionId, optionId = '') {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            await target.handle.runtimeEntry.runtime.resolvePermission(
                target.tabId,
                permissionId,
                optionId
            );
            this.#persistBusHandleSnapshot(target.handle, 'resolve_permission');
            return;
        }
    }

    async setModeForTab(tabId, modeId) {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            const serialized = await target.handle.runtimeEntry.runtime.setMode(
                target.tabId,
                modeId
            );
            this.#persistBusHandleSnapshot(target.handle, 'set_mode');
            return this.getOpenTab(tabId) || serialized;
        }
        throw new Error('Agent tab not found');
    }

    async setConfigOptionForTab(tabId, configId, valueId) {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            const serialized = await target.handle.runtimeEntry.runtime
                .setConfigOption(target.tabId, configId, valueId);
            this.#persistBusHandleSnapshot(target.handle, 'set_config_option');
            return this.getOpenTab(tabId) || serialized;
        }
        throw new Error('Agent tab not found');
    }

    #scheduleRebalance(reason = 'manual') {
        if (!this.started || this.syncPromise) {
            return;
        }
        if (!this.rebalancePendingReason) {
            this.rebalancePendingReason = String(reason || 'manual');
        }
        if (this.rebalancePromise) {
            return;
        }
        this.rebalancePromise = (async () => {
            while (this.started && !this.syncPromise && this.rebalancePendingReason) {
                const currentReason = this.rebalancePendingReason;
                this.rebalancePendingReason = '';
                await this.#rebalanceHotSessions(currentReason);
            }
        })()
            .catch((error) => {
                console.warn(
                    '[ACP Bus] Failed to rebalance hot sessions:',
                    error?.message || error
                );
            })
            .finally(() => {
                this.rebalancePromise = null;
                if (this.rebalancePendingReason) {
                    this.#scheduleRebalance(this.rebalancePendingReason);
                }
            });
    }

    async syncNow(reason = 'manual') {
        if (this.syncPromise) {
            return await this.syncPromise;
        }
        this.syncPromise = this.#syncNowInternal(reason);
        try {
            return await this.syncPromise;
        } finally {
            this.syncPromise = null;
            if (this.started) {
                this.#scheduleNextPoll();
            }
        }
    }

    async #syncNowInternal(reason) {
        const availableDefinitions = await this.#listAvailableDefinitions();
        if (availableDefinitions.length === 0) {
            return {
                complete: false,
                state: this.getState()
            };
        }
        let complete = true;

        for (const definition of availableDefinitions) {
            const runtimeEntry = this.#getDiscoveryRuntime(definition);
            const seenKeys = [];
            try {
                const result = await runtimeEntry.runtime.listSessions({
                    cwd: this.discoveryCwd,
                    all: true
                });
                const sessions = Array.isArray(result?.sessions)
                    ? result.sessions
                    : [];
                const scope = result?.scope === 'all' ? 'all' : 'cwd';
                for (const session of sessions) {
                    const change = this.store.upsertIndexedSession({
                        agentId: definition.id,
                        sessionId: session.sessionId,
                        cwd: session.cwd,
                        title: session.title || '',
                        updatedAt: session.updatedAt || '',
                        seenAt: this.now()
                    });
                    seenKeys.push(change.record.sessionKey);
                    const eventType = shouldRecordIndexChange(
                        change.previous,
                        change.record
                    );
                    if (eventType) {
                        this.#emitEvent(eventType, change.record, {
                            reason
                        });
                    }
                }
                if (scope === 'all') {
                    const removed = this.store.reconcileAgentPresence(
                        definition.id,
                        seenKeys,
                        this.now()
                    );
                    for (const row of removed) {
                        this.#emitEvent('session_index_removed', row, {
                            reason,
                            providerId: definition.id
                        });
                    }
                }
            } catch (error) {
                complete = false;
                this.#emitEvent('session_runtime_exit', {
                    agentId: definition.id,
                    sessionId: '',
                    sessionKey: '',
                    title: '',
                    cwd: this.discoveryCwd,
                    continuityState: 'cold',
                    hotRank: null,
                    busy: false,
                    status: 'disconnected',
                    errorMessage: error?.message || 'Session discovery failed',
                    isPresent: true
                }, {
                    reason,
                    runtimeKind: 'discovery'
                });
            }
        }

        if (complete) {
            await this.#rebalanceHotSessions(reason);
        }

        return {
            complete,
            state: this.getState()
        };
    }

    async #listAvailableDefinitions() {
        await this.acpManager.ensureConfigsLoaded();
        return this.acpManager.definitions.filter((definition) => {
            const availability = this.acpManager.getDefinitionAvailability(
                definition
            );
            return availability.available;
        });
    }

    #getAvailableDefinition(agentId) {
        const normalizedAgentId = String(agentId || '').trim();
        const definition = this.acpManager.definitions.find(
            (entry) => entry.id === normalizedAgentId
        );
        if (!definition) {
            throw new Error('Unknown agent');
        }
        const availability = this.acpManager.getDefinitionAvailability(definition);
        if (!availability.available) {
            throw new Error(availability.reason || 'Agent unavailable');
        }
        return definition;
    }

    #getSessionCapabilities(runtime) {
        if (typeof runtime?.getSessionCapabilities === 'function') {
            return runtime.getSessionCapabilities();
        }
        return {};
    }

    #decorateSerializedTab(serialized, runtime = null) {
        if (!serialized || typeof serialized !== 'object') {
            return serialized;
        }
        const definition = this.acpManager.definitions.find(
            (entry) => entry.id === serialized.agentId
        );
        return {
            ...serialized,
            agentLabel: serialized.agentLabel || definition?.label || 'Agent',
            commandLabel: serialized.commandLabel
                || definition?.commandLabel
                || '',
            sessionCapabilities: serialized.sessionCapabilities
                || this.#getSessionCapabilities(runtime)
        };
    }

    #registerRuntimeHandle(runtimeEntry, tabId, serialized) {
        const sessionKey = buildAcpBusSessionKey(
            serialized.agentId,
            serialized.acpSessionId
        );
        const existing = this.observedSessions.get(sessionKey);
        if (existing?.runtimeEntry?.runtime && existing.tabId !== tabId) {
            existing.runtimeEntry.runtime.detachTab(existing.tabId);
            existing.runtimeEntry.sessionKeys.delete(sessionKey);
            if (
                existing.runtimeEntry !== runtimeEntry
                && existing.runtimeEntry.sessionKeys.size === 0
            ) {
                this.observeRuntimes.delete(existing.runtimeEntry.runtimeKey);
                void existing.runtimeEntry.runtime.dispose().catch(() => {});
            }
        }
        const handle = {
            sessionKey,
            agentId: serialized.agentId,
            sessionId: serialized.acpSessionId,
            tabId,
            runtimeEntry
        };
        this.observedSessions.set(sessionKey, handle);
        this.tabToSessionKey.set(tabId, sessionKey);
        return handle;
    }

    #mergeOpenTabSnapshot(meta, session, liveSnapshot, options = {}) {
        const includeTranscript = options.includeTranscript === true;
        const snapshot = session?.snapshot && typeof session.snapshot === 'object'
            ? session.snapshot
            : null;
        const source = liveSnapshot || snapshot || {};
        const runtime = options.runtime || null;
        const definition = this.acpManager.definitions.find(
            (entry) => entry.id === meta.agentId
        );
        const transcriptArrays = includeTranscript
            ? {
                messages: Array.isArray(snapshot?.messages)
                    ? snapshot.messages
                    : (source.messages || []),
                toolCalls: Array.isArray(snapshot?.toolCalls)
                    ? snapshot.toolCalls
                    : (source.toolCalls || []),
                permissions: Array.isArray(snapshot?.permissions)
                    ? snapshot.permissions
                    : (source.permissions || []),
                plan: Array.isArray(snapshot?.plan)
                    ? snapshot.plan
                    : (source.plan || []),
                terminals: Array.isArray(snapshot?.terminals)
                    ? snapshot.terminals
                    : (source.terminals || [])
            }
            : {
                messages: [],
                toolCalls: [],
                permissions: [],
                plan: [],
                terminals: []
            };
        return {
            ...cloneSerializable(source, {}),
            id: meta.id,
            runtimeId: source.runtimeId || '',
            runtimeKey: source.runtimeKey || '',
            acpSessionId: meta.acpSessionId,
            agentId: meta.agentId,
            agentLabel: source.agentLabel || definition?.label || 'Agent',
            commandLabel: source.commandLabel || definition?.commandLabel || '',
            title: source.title || meta.title || '',
            terminalSessionId: meta.terminalSessionId || '',
            cwd: meta.cwd || source.cwd || '',
            createdAt: meta.createdAt || source.createdAt || '',
            status: source.status || session?.status || 'ready',
            busy: typeof source.busy === 'boolean'
                ? source.busy
                : !!session?.busy,
            errorMessage: source.errorMessage || session?.errorMessage || '',
            currentModeId: source.currentModeId || meta.currentModeId || '',
            availableModes: Array.isArray(source.availableModes)
                ? source.availableModes
                : [],
            availableCommands: Array.isArray(source.availableCommands)
                ? source.availableCommands
                : [],
            sessionCapabilities: source.sessionCapabilities
                || this.#getSessionCapabilities(runtime),
            configOptions: Array.isArray(source.configOptions)
                ? source.configOptions
                : [],
            usage: snapshot?.usage || source.usage || null,
            ...transcriptArrays,
            busConnectionKind: 'shared',
            busContinuityState: session?.continuityState || 'cold',
            busHotRank: session?.hotRank ?? null
        };
    }

    #getDiscoveryRuntime(definition) {
        const key = String(definition.id || '').trim();
        const currentVersion = this.acpManager.getAgentConfigVersion(
            definition.id
        );
        const existing = this.discoveryRuntimes.get(key);
        if (existing && existing.configVersion === currentVersion) {
            return existing;
        }
        if (existing) {
            this.discoveryRuntimes.delete(key);
            void existing.runtime.dispose().catch(() => {});
        }
        const runtime = this.runtimeFactory(definition, {
            cwd: this.discoveryCwd,
            idleTimeoutMs: 0,
            runtimeStoreKey: createRuntimeStoreKey(
                'discovery',
                definition.id,
                this.discoveryCwd
            ),
            env: mergeDefinitionEnv(
                definition,
                this.acpManager.getAgentConfig(definition.id)
            )
        });
        const entry = {
            runtime,
            definition,
            configVersion: currentVersion
        };
        this.discoveryRuntimes.set(key, entry);
        return entry;
    }

    #getObserveRuntime(definition, cwd) {
        const runtimeKey = buildObserveRuntimeKey(definition.id, cwd);
        const currentVersion = this.acpManager.getAgentConfigVersion(
            definition.id
        );
        const existing = this.observeRuntimes.get(runtimeKey);
        if (existing && existing.configVersion === currentVersion) {
            return existing;
        }
        if (existing) {
            this.observeRuntimes.delete(runtimeKey);
            void existing.runtime.dispose().catch(() => {});
        }
        const resolvedCwd = path.resolve(cwd || '/');
        const runtime = this.runtimeFactory(definition, {
            cwd: resolvedCwd,
            idleTimeoutMs: 0,
            runtimeStoreKey: createRuntimeStoreKey(
                'observe',
                definition.id,
                resolvedCwd
            ),
            terminalManager: this.acpManager.terminalManager || null,
            env: mergeDefinitionEnv(
                definition,
                this.acpManager.getAgentConfig(definition.id)
            )
        });
        const entry = {
            runtime,
            definition,
            cwd: resolvedCwd,
            runtimeKey,
            configVersion: currentVersion,
            sessionKeys: new Set()
        };
        runtime.on('tab_dirty', ({ tabId }) => {
            const sessionKey = this.tabToSessionKey.get(tabId);
            if (!sessionKey) {
                return;
            }
            this.#scheduleSnapshotFlush(sessionKey);
        });
        runtime.on('runtime_exit', (detail) => {
            void this.#handleObserveRuntimeExit(entry, detail);
        });
        this.observeRuntimes.set(runtimeKey, entry);
        return entry;
    }

    async #disposeObserveRuntimeIfIdle(runtimeEntry) {
        if (!runtimeEntry) {
            return;
        }
        if (runtimeEntry.sessionKeys.size > 0 || runtimeEntry.runtime.tabs.size > 0) {
            return;
        }
        this.observeRuntimes.delete(runtimeEntry.runtimeKey);
        await runtimeEntry.runtime.dispose().catch(() => {});
    }

    async #restoreHotSessions() {
        const hotRows = this.store.listHotCandidates(this.hotSessionLimit, {
            includeSnapshot: true
        });
        const desiredKeys = new Set([
            ...hotRows.map((row) => row.sessionKey),
            ...this.pinnedSessions.values()
        ]);
        this.store.setHotSessionKeys(Array.from(desiredKeys));
        for (const sessionKey of desiredKeys) {
            const row = hotRows.find((entry) => entry.sessionKey === sessionKey)
                || this.store.getSession(sessionKey, { includeSnapshot: true });
            if (!row) {
                continue;
            }
            try {
                await this.#attachHotSession(row, 'restore');
            } catch (error) {
                this.store.updateContinuityState(
                    row.sessionKey,
                    'resync_required',
                    {
                        status: 'disconnected',
                        busy: false,
                        errorMessage: error?.message || 'Restore failed'
                    }
                );
                this.#emitEvent('session_resync_required', row, {
                    reason: 'restore',
                    error: error?.message || 'Restore failed'
                });
            }
        }
    }

    async #rebalanceHotSessions(reason) {
        const hotRows = this.store.listHotCandidates(
            this.hotSessionLimit,
            {
                presentOnly: true,
                includeSnapshot: true
            }
        );
        const hotKeys = hotRows.map((row) => row.sessionKey);
        const desiredKeys = new Set([
            ...hotKeys,
            ...this.pinnedSessions.values()
        ]);
        this.store.setHotSessionKeys(Array.from(desiredKeys));

        for (const sessionKey of desiredKeys) {
            let row = hotRows.find((entry) => entry.sessionKey === sessionKey);
            if (!row) {
                row = this.store.getSession(sessionKey, {
                    includeSnapshot: true
                });
            }
            if (!row) continue;
            try {
                await this.#ensureObservedSession(row, reason);
            } catch (error) {
                this.store.updateContinuityState(
                    row.sessionKey,
                    'resync_required',
                    {
                        status: 'disconnected',
                        busy: false,
                        errorMessage: error?.message || 'Hot attach failed'
                    }
                );
                this.#emitEvent('session_resync_required', row, {
                    reason,
                    error: error?.message || 'Hot attach failed'
                });
            }
        }

        for (const sessionKey of Array.from(this.observedSessions.keys())) {
            if (desiredKeys.has(sessionKey)) {
                continue;
            }
            await this.#detachHotSession(sessionKey, 'rebalance');
        }

        const deleted = this.store.pruneSessions(
            this.cacheSessionLimit,
            Array.from(desiredKeys)
        );
        for (const row of deleted) {
            this.#emitEvent('session_index_removed', row, {
                reason: 'eviction'
            });
        }
    }

    async #ensureObservedSession(row, reason) {
        if (this.observedSessions.has(row.sessionKey)) {
            return this.observedSessions.get(row.sessionKey);
        }
        return this.#attachHotSession(row, reason);
    }

    #shouldReplayOnAttach(row) {
        const upstreamUpdatedAt = Date.parse(row?.upstreamUpdatedAt || '');
        const lastReceivedAt = Date.parse(
            row?.lastReceivedAt
            || row?.lastLiveAt
            || row?.lastLoadedAt
            || ''
        );
        const hasCachedTimeline = (
            Number(row?.messageCount || 0) > 0
            || Number(row?.toolCallCount || 0) > 0
        );
        if (!hasCachedTimeline) {
            return true;
        }
        if (!Number.isFinite(upstreamUpdatedAt) || !Number.isFinite(lastReceivedAt)) {
            return false;
        }
        return (upstreamUpdatedAt - lastReceivedAt) > this.replayGapMs;
    }

    async #attachHotSession(row, reason) {
        if (this.observedSessions.has(row.sessionKey)) {
            return this.observedSessions.get(row.sessionKey);
        }
        const definition = this.acpManager.definitions.find(
            (entry) => entry.id === row.agentId
        );
        if (!definition) {
            throw new Error(`Unknown ACP provider: ${row.agentId}`);
        }
        const runtimeEntry = this.#getObserveRuntime(definition, row.cwd);
        const tabId = crypto.randomUUID();
        const attachedAt = this.now();
        const replayHistory = this.#shouldReplayOnAttach(row)
            || !runtimeEntry.runtime.getSessionCapabilities?.().resume;
        const serialized = this.#decorateSerializedTab(
            await runtimeEntry.runtime.resumeTab({
                id: tabId,
                acpSessionId: row.sessionId,
                cwd: row.cwd,
                terminalSessionId: '',
                title: row.title || ''
            }, {
                replayHistory
            }),
            runtimeEntry.runtime
        );
        const handle = this.#registerRuntimeHandle(runtimeEntry, tabId, serialized);
        runtimeEntry.sessionKeys.add(handle.sessionKey);
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt: attachedAt,
            attachedAt,
            loadedAt: attachedAt,
            liveAt: attachedAt,
            preserveSnapshotContent: true
        });
        this.#emitEvent(
            'session_hot_attached',
            persisted.record,
            this.#buildSnapshotEventExtra(persisted, {
                reason,
                replayHistory
            })
        );
        return handle;
    }

    async #detachHotSession(sessionKey, reason) {
        const handle = this.observedSessions.get(sessionKey);
        if (!handle) {
            return false;
        }
        this.observedSessions.delete(sessionKey);
        this.tabToSessionKey.delete(handle.tabId);
        const timer = this.snapshotFlushTimers.get(sessionKey);
        if (timer) {
            clearTimeout(timer);
            this.snapshotFlushTimers.delete(sessionKey);
        }

        handle.runtimeEntry.runtime.detachTab(handle.tabId);
        handle.runtimeEntry.sessionKeys.delete(sessionKey);

        const updated = this.store.updateContinuityState(
            sessionKey,
            'resync_required',
            {
                activityAt: this.now(),
                detachedAt: this.now(),
                status: 'ready',
                busy: false,
                errorMessage: ''
            }
        );
        if (updated) {
            this.#emitEvent('session_hot_detached', updated, { reason });
        }

        if (handle.runtimeEntry.sessionKeys.size === 0) {
            this.observeRuntimes.delete(handle.runtimeEntry.runtimeKey);
            await handle.runtimeEntry.runtime.dispose().catch(() => {});
        }
        return true;
    }

    #scheduleSnapshotFlush(sessionKey) {
        const existing = this.snapshotFlushTimers.get(sessionKey);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.snapshotFlushTimers.delete(sessionKey);
            void this.#flushSessionSnapshot(sessionKey);
        }, this.snapshotFlushDelayMs);
        this.snapshotFlushTimers.set(sessionKey, timer);
    }

    async #flushSessionSnapshot(sessionKey) {
        const handle = this.observedSessions.get(sessionKey);
        if (!handle) {
            return;
        }
        const tab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
        if (!tab) {
            return;
        }
        const observedAt = this.now();
        const serialized = handle.runtimeEntry.runtime.serializeTab(tab);
        const authoritativeSnapshot = tab.authoritativeSnapshot === true
            || serialized.authoritativeSnapshot === true;
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt,
            liveAt: observedAt,
            preserveSnapshotContent: !authoritativeSnapshot,
            authoritativeSnapshot
        });
        tab.authoritativeSnapshot = false;
        if (persisted.changed) {
            this.#emitEvent(
                'session_snapshot_updated',
                persisted.record,
                this.#buildSnapshotEventExtra(persisted, {
                    reason: 'runtime_update'
                })
            );
        }
    }

    async #handleObserveRuntimeExit(runtimeEntry, detail) {
        const affectedKeys = Array.from(runtimeEntry.sessionKeys);
        this.observeRuntimes.delete(runtimeEntry.runtimeKey);
        for (const sessionKey of affectedKeys) {
            const handle = this.observedSessions.get(sessionKey);
            if (!handle) {
                continue;
            }
            this.observedSessions.delete(sessionKey);
            this.tabToSessionKey.delete(handle.tabId);
            const updated = this.store.updateContinuityState(
                sessionKey,
                'resync_required',
                {
                    activityAt: this.now(),
                    detachedAt: this.now(),
                    status: 'disconnected',
                    busy: false,
                    errorMessage: detail?.signal
                        ? `Agent runtime exited (${detail.signal}).`
                        : detail?.code !== null
                            && detail?.code !== undefined
                            ? `Agent runtime exited (${detail.code}).`
                            : 'Agent runtime exited.'
                }
            );
            if (updated) {
                this.#emitEvent('session_runtime_exit', updated, {
                    reason: 'runtime_exit',
                    detail: {
                        code: detail?.code ?? null,
                        signal: detail?.signal || null
                    }
                });
                this.#emitEvent('session_resync_required', updated, {
                    reason: 'runtime_exit'
                });
            }
        }
    }

    #buildSnapshotEventExtra(persisted, extra = {}) {
        const delta = persisted?.timelineDelta || {};
        return {
            ...extra,
            snapshotVersion: Number.isFinite(delta.snapshotVersion)
                ? delta.snapshotVersion
                : (persisted?.record?.snapshotVersion || 0),
            timelineIndex: delta.timelineIndex || null,
            changedItems: Array.isArray(delta.changedItems)
                ? delta.changedItems
                : [],
            removedItemKeys: Array.isArray(delta.removedItemKeys)
                ? delta.removedItemKeys
                : [],
            requiresFullSync: !!delta.requiresFullSync
        };
    }

    #emitEvent(type, row, extra = {}) {
        const payload = {
            ...extra,
            session: row
                ? {
                    sessionKey: row.sessionKey,
                    agentId: row.agentId,
                    sessionId: row.sessionId,
                    cwd: row.cwd,
                    title: row.title,
                    upstreamUpdatedAt: row.upstreamUpdatedAt,
                    lastActivityAt: row.lastActivityAt,
                    lastReceivedAt: row.lastReceivedAt,
                    lastDetachedAt: row.lastDetachedAt,
                    continuityState: row.continuityState,
                    hotRank: row.hotRank,
                    status: row.status,
                    busy: row.busy,
                    errorMessage: row.errorMessage,
                    messageCount: row.messageCount,
                    toolCallCount: row.toolCallCount,
                    isPresent: row.isPresent,
                    snapshotVersion: row.snapshotVersion
                }
                : null
        };
        const event = this.store.appendEvent({
            createdAt: this.now(),
            type,
            agentId: row?.agentId || '',
            sessionId: row?.sessionId || '',
            payload
        });
        this.emit('event', event);
        this.emit(type, payload);
    }

    #scheduleNextPoll() {
        clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => {
            void this.syncNow('poll');
        }, this.pollIntervalMs);
    }
}
