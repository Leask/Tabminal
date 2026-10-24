import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { EventEmitter } from 'node:events';

import { HistoryImporter } from './agents/history.mjs';
import {
    AcpRuntime,
    mergeDefinitionEnv
} from './acp-manager.mjs';
import {
    AcpBusStore,
    buildAcpBusSessionKey
} from './acp-bus-store.mjs';

const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_CACHE_SESSION_LIMIT = 1000;
const DEFAULT_EVENT_LIMIT = 2000;
const DEFAULT_SNAPSHOT_FLUSH_DELAY_MS = 250;
const DEFAULT_REPLAY_GAP_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND_REQUEST_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND_REQUEST_LIMIT = 500;
const DEFAULT_COLD_REPAIR_LOAD_THRESHOLD = 0.7;
const DEFAULT_RESUME_LIST_LIMIT = 300;

function nowIso() {
    return new Date().toISOString();
}

function buildObserveRuntimeKey(agentId, cwd) {
    return `${String(agentId || '').trim()}::${path.resolve(cwd || '/')}`;
}

function createRuntimeStoreKey(kind, agentId, cwd) {
    return `bus:${kind}:${String(agentId || '').trim()}:${path.resolve(cwd || '/')}`;
}

function getDefaultCpuLoadRatio() {
    const load = os.loadavg()[0];
    const cores = typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;
    const safeCores = Number.isFinite(cores) && cores > 0 ? cores : 1;
    return load / safeCores;
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

function normalizeCommandRequestId(value) {
    return String(value || '').trim();
}

function buildPromptRequestSignature(text, attachments = []) {
    return JSON.stringify({
        text: String(text || ''),
        attachments: Array.isArray(attachments)
            ? attachments.map((attachment) => ({
                name: String(attachment?.name || '').trim(),
                mimeType: String(attachment?.mimeType || '').trim(),
                size: Number.isFinite(attachment?.size)
                    ? attachment.size
                    : 0
            }))
            : []
    });
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
        this.listWorkspaceCwds = typeof options.listWorkspaceCwds === 'function'
            ? options.listWorkspaceCwds
            : () => [];
        this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
            ? Math.max(500, Math.floor(options.pollIntervalMs))
            : DEFAULT_POLL_INTERVAL_MS;
        this.cacheSessionLimit = Number.isFinite(options.cacheSessionLimit)
            ? Math.max(1, Math.floor(options.cacheSessionLimit))
            : DEFAULT_CACHE_SESSION_LIMIT;
        this.replayGapMs = Number.isFinite(options.replayGapMs)
            ? Math.max(0, Math.floor(options.replayGapMs))
            : DEFAULT_REPLAY_GAP_MS;
        this.snapshotFlushDelayMs = Number.isFinite(options.snapshotFlushDelayMs)
            ? Math.max(50, Math.floor(options.snapshotFlushDelayMs))
            : DEFAULT_SNAPSHOT_FLUSH_DELAY_MS;
        this.commandRequestTtlMs = Number.isFinite(options.commandRequestTtlMs)
            ? Math.max(1000, Math.floor(options.commandRequestTtlMs))
            : DEFAULT_COMMAND_REQUEST_TTL_MS;
        this.commandRequestLimit = Number.isFinite(options.commandRequestLimit)
            ? Math.max(1, Math.floor(options.commandRequestLimit))
            : DEFAULT_COMMAND_REQUEST_LIMIT;
        this.coldRepairLoadThreshold = Number.isFinite(
            options.coldRepairLoadThreshold
        )
            ? Math.max(0, options.coldRepairLoadThreshold)
            : DEFAULT_COLD_REPAIR_LOAD_THRESHOLD;
        this.getCpuLoadRatio = typeof options.getCpuLoadRatio === 'function'
            ? options.getCpuLoadRatio
            : getDefaultCpuLoadRatio;
        this.discoveryCwd = path.resolve(
            options.discoveryCwd || process.cwd()
        );
        this.discoveryEnabled = options.discoveryEnabled !== false;
        this.now = typeof options.now === 'function' ? options.now : nowIso;
        this.started = false;
        this.restoring = false;
        this.storeReady = false;
        this.storeReadyPromise = null;
        this.startPromise = null;
        this.syncPromise = null;
        this.pollTimer = null;
        this.discoveryRuntimes = new Map();
        this.observeRuntimes = new Map();
        this.observedSessions = new Map();
        this.pinnedSessions = new Map();
        this.workspaceClients = new Set();
        this.pendingAttaches = new Map();
        this.pendingDetaches = new Map();
        this.tabToSessionKey = new Map();
        this.openTabs = new Map();
        this.openTabsPersistenceChain = Promise.resolve();
        this.pendingResumeTabs = new Map();
        this.commandRequests = new Map();
        this.coldRepairPromise = null;
        this.historyRetryAfter = new Map();
        this.snapshotFlushTimers = new Map();
        this.snapshotWrites = new Map();
        this.controllerReconcilePromise = null;
        this.controllerReconcileReason = '';
        this.eventWritePromises = new Set();
        this.stopping = false;
        this.disposePromise = null;
    }

    async start(options = {}) {
        if (this.stopping) throw new Error('ACP bus is shutting down');
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
            await this.#ensureStoreReady();
            await this.#restoreOpenTabs(options);
            await this.syncNow('startup');
            this.started = true;
            await this.store.setHotSessionKeys([]);
            this.#scheduleNextPoll();
        } finally {
            this.restoring = false;
        }
    }

    async dispose() {
        if (this.disposePromise) return this.disposePromise;
        this.stopping = true;
        this.disposePromise = this.#disposeInternal();
        return this.disposePromise;
    }

    async #disposeInternal() {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
        // Stop transports first so pending RPCs cannot outlive storage.
        await Promise.allSettled([
            ...this.discoveryRuntimes.values(), ...this.observeRuntimes.values()
        ].map((entry) => entry.runtime.dispose()));
        await Promise.allSettled([
            this.startPromise, this.syncPromise, this.controllerReconcilePromise,
            this.coldRepairPromise, ...this.pendingResumeTabs.values()
        ]);
        for (const timer of this.snapshotFlushTimers.values()) {
            clearTimeout(timer);
        }
        this.snapshotFlushTimers.clear();

        const observedKeys = Array.from(this.observedSessions.keys());
        for (const sessionKey of observedKeys) {
            await this.#detachController(sessionKey, 'shutdown');
        }
        this.observedSessions.clear();
        this.pinnedSessions.clear();
        this.tabToSessionKey.clear();
        this.openTabs.clear();
        this.commandRequests.clear();
        this.coldRepairPromise = null;

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
        await Promise.allSettled([...this.snapshotWrites.values()]);
        await this.#drainEventWrites();
        this.storeReady = false;
        await this.store.close();
    }

    async getState() {
        await this.#ensureStoreReady();
        return {
            started: this.started,
            restoring: this.restoring,
            pollIntervalMs: this.pollIntervalMs,
            attachmentPolicy: 'workspace-demand',
            cacheSessionLimit: this.cacheSessionLimit,
            observedSessionCount: this.observedSessions.size,
            pinnedSessionCount: this.pinnedSessions.size,
            openTabCount: this.openTabs.size,
            discoveryRuntimeCount: this.discoveryRuntimes.size,
            observeRuntimeCount: this.observeRuntimes.size,
            store: await this.store.getSummary()
        };
    }

    async listSessions(options = {}) {
        await this.#ensureStoreReady();
        return await this.store.listSessions(options);
    }

    async getSession(agentId, sessionId, options = {}) {
        await this.#ensureStoreReady();
        return await this.store.getSessionByIdentity(agentId, sessionId, options);
    }

    async listResumeSessions(options = {}) {
        await this.#ensureStoreReady();
        const definition = this.#getDefinition(options.agentId);
        const cwd = path.resolve(options.cwd || process.cwd());
        const limit = Number.isFinite(options.limit)
            ? Math.min(DEFAULT_RESUME_LIST_LIMIT, Math.max(1, Math.floor(options.limit)))
            : DEFAULT_RESUME_LIST_LIMIT;
        const busSessions = (await this.store.listSessions({
            agentId: definition.id,
            presentOnly: true,
            limit,
            includeSnapshot: false
        })).map((row) => this.#resumeSessionFromBusRow(row));

        if (busSessions.length > 0) {
            return {
                sessions: this.#mergeResumeSessions(busSessions, cwd, limit),
                nextCursor: '',
                scope: 'bus'
            };
        }
        return {
            sessions: [],
            nextCursor: '',
            scope: 'bus'
        };
    }

    async listEvents(limit = 100) {
        await this.#ensureStoreReady();
        return await this.store.listEvents(limit);
    }

    async listTimelineItems(sessionKey, options = {}) {
        await this.#ensureStoreReady();
        return await this.store.listTimelineItems(sessionKey, options);
    }

    async listState() {
        await this.acpManager.ensureConfigsLoaded();
        await this.#ensureStoreReady();
        return {
            bus: await this.getState(),
            restoring: this.restoring,
            definitions: await this.acpManager.listDefinitionsFast(),
            configs: await this.acpManager.listAgentConfigs(),
            tabs: await this.listOpenTabs()
        };
    }

    async listInventory() {
        return {
            restoring: this.restoring,
            tabs: (await this.listOpenTabs()).map((tab) => ({
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

    async listOpenTabs(options = {}) {
        const includeTranscript = options.includeTranscript === true;
        const tabs = await Promise.all(Array.from(this.openTabs.keys())
            .map((tabId) => this.getOpenTab(tabId, { includeTranscript })));
        return tabs.filter(Boolean);
    }

    async getOpenTab(tabId, options = {}) {
        await this.#ensureStoreReady();
        const meta = this.openTabs.get(String(tabId || '').trim());
        if (!meta) {
            return null;
        }
        const session = await this.store.getSession(
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

    registerWorkspaceClient() {
        const id = crypto.randomUUID();
        this.workspaceClients.add(id);
        return id;
    }

    assertWorkspaceClient(clientId = '') {
        if (clientId && !this.workspaceClients.has(clientId)) {
            throw Object.assign(
                new Error('Workspace connection is no longer available'),
                { code: 'runtime_unavailable',
                    details: { reason: 'workspace_disconnected' } }
            );
        }
    }

    tabPinId(tabId, clientId = '') {
        return clientId
            ? `client:${clientId}:agent-tab:${tabId}`
            : `agent-tab:${tabId}`;
    }

    async releaseWorkspaceClient(clientId) {
        this.workspaceClients.delete(clientId);
        for (const pinId of this.pinnedSessions.keys()) {
            if (pinId.startsWith(`client:${clientId}:`)) {
                this.pinnedSessions.delete(pinId);
            }
        }
        this.#scheduleControllerReconcile('workspace_disconnected');
    }

    async attachOpenTab(tabId, reason = 'agent_tab_attach', clientId = '') {
        this.assertWorkspaceClient(clientId);
        const meta = this.openTabs.get(String(tabId || '').trim());
        if (!meta) {
            return null;
        }
        const session = await this.pinSession(
            this.tabPinId(meta.id, clientId),
            {
                agentId: meta.agentId,
                sessionId: meta.acpSessionId,
                cwd: meta.cwd,
                title: meta.title
            },
            reason
        );
        return {
            tab: await this.getOpenTab(meta.id),
            session
        };
    }

    async getTimelinePageForTab(tabId, query = {}) {
        await this.#ensureStoreReady();
        const meta = this.openTabs.get(String(tabId || '').trim());
        if (!meta) {
            return null;
        }
        const session = await this.store.getSession(
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
            ...(await this.store.listTimelineItems(session.sessionKey, {
                limit: Number.parseInt(query.limit, 10),
                before: typeof query.before === 'string' ? query.before : '',
                after: typeof query.after === 'string' ? query.after : ''
            }))
        };
    }

    async markSessionInterest(entry = {}) {
        const result = await this.store.markSessionInterest(entry);
        this.#emitEvent('session_index_updated', result.record, {
            reason: 'interest'
        });
        this.#scheduleControllerReconcile('interest');
        return result.record;
    }

    async pinSession(pinId, entry = {}, reason = 'ui_attach') {
        const normalizedPinId = String(pinId || '').trim();
        if (!normalizedPinId) {
            throw new Error('pinId is required');
        }
        const result = await this.store.markSessionInterest(entry);
        const clientId = normalizedPinId.match(/^client:([^:]+):/)?.[1];
        this.assertWorkspaceClient(clientId);
        const previousSessionKey = this.pinnedSessions.get(normalizedPinId) || '';
        this.pinnedSessions.set(normalizedPinId, result.record.sessionKey);
        try {
            await this.#ensureObservedSession(result.record, reason);
        } catch (error) {
            this.pinnedSessions.delete(normalizedPinId);
            await this.#handleSessionAttachFailure(result.record, error, { reason });
            throw error;
        }
        this.#scheduleControllerReconcile(reason);
        if (previousSessionKey !== result.record.sessionKey) {
            this.#emitEvent('session_ui_attached', result.record, {
                reason,
                pinId: normalizedPinId
            });
        }
        return await this.store.getSession(result.record.sessionKey, {
            includeSnapshot: true
        });
    }

    async createTabForUi(options = {}) {
        this.assertWorkspaceClient(options.clientId);
        await this.#ensureInteractiveReady();
        const definition = this.#getDefinition(options.agentId);
        const cwd = path.resolve(options.cwd || process.cwd());
        const runtimeEntry = this.#getObserveRuntime(definition, cwd);
        return await this.#withRuntimeOperation(runtimeEntry, () =>
            this.#createTabForUiInternal(runtimeEntry, cwd, options));
    }

    async #createTabForUiInternal(runtimeEntry, cwd, options) {
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
        const persisted = await this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt: this.now(),
            attachedAt: this.now(),
            liveAt: this.now(),
            preserveSnapshotContent: false
        });
        runtimeEntry.sessionKeys.add(handle.sessionKey);
        await this.#rememberOpenTab(serialized, 'agent_tab_create', options.clientId);
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
        return await this.getOpenTab(serialized.id);
    }

    async resumeTabForUi(options = {}) {
        this.assertWorkspaceClient(options.clientId);
        await this.#ensureInteractiveReady();
        const previous = await this.getSession(
            options.agentId,
            options.sessionId
        );
        const resumeKey = [
            String(options.agentId || '').trim(),
            String(options.sessionId || '').trim(),
            String(options.targetTabId || '').trim(),
            String(options.clientId || '')
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
        const definition = this.#getDefinition(options.agentId);
        const cwd = path.resolve(options.cwd || process.cwd());
        const targetTabId = String(options.targetTabId || '').trim();
        const tabId = targetTabId || crypto.randomUUID();
        const sessionKey = buildAcpBusSessionKey(definition.id, options.sessionId);
        const pinId = this.tabPinId(tabId, options.clientId);
        await this.pinSession(pinId, {
            agentId: definition.id, sessionId: options.sessionId,
            cwd, title: options.title || previous?.title || ''
        }, 'agent_tab_resume');
        const handle = this.observedSessions.get(sessionKey);
        const runtime = handle.runtimeEntry.runtime;
        const serialized = this.#decorateSerializedTab(
            runtime.serializeTab(runtime.tabs.get(handle.tabId)), runtime
        );

        const uiSerialized = {
            ...serialized,
            id: tabId,
            terminalSessionId: options.terminalSessionId
                || serialized.terminalSessionId
                || '',
            cwd: serialized.cwd || cwd,
            title: serialized.title || options.title || ''
        };
        await this.#rememberOpenTab(
            uiSerialized, 'agent_tab_attach', options.clientId
        );
        const busSession = await this.store.getSession(sessionKey);
        const attachSource = previous?.continuityState === 'live'
            ? 'hot'
            : previous
                ? 'cache'
                : 'cold';
        return {
            serialized: (await this.getOpenTab(tabId)) || uiSerialized,
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
        this.#scheduleControllerReconcile(reason);
        const record = await this.store.getSession(sessionKey, {
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
        for (const pinId of this.pinnedSessions.keys()) {
            if (pinId === `agent-tab:${normalizedTabId}`
                || pinId.endsWith(`:agent-tab:${normalizedTabId}`)) {
                await this.unpinSession(pinId, 'agent_tab_close');
            }
        }
        // The runtime may still own a prompt after its workspace tab closes.
        if (![...this.observedSessions.values()].some(
            (handle) => handle.tabId === normalizedTabId
        )) this.tabToSessionKey.delete(normalizedTabId);
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
            const result = await this.store.markSessionInterest({
                agentId: tab.agentId,
                sessionId: tab.acpSessionId,
                cwd: tab.cwd,
                title: tab.title
            });
            this.tabToSessionKey.set(tab.id, result.record.sessionKey);
        }
        if (changed) {
            await this.#persistOpenTabs(restoredTabs);
        }
    }

    async #rememberOpenTab(serialized, reason = 'agent_tab_update', clientId = '') {
        const tab = normalizeOpenAgentTab(serialized);
        if (!tab) {
            throw new Error('Open agent tab requires a session identity');
        }
        this.openTabs.set(tab.id, tab);
        const result = await this.store.markSessionInterest({
            agentId: tab.agentId,
            sessionId: tab.acpSessionId,
            cwd: tab.cwd,
            title: tab.title
        });
        if (!clientId || this.workspaceClients.has(clientId)) {
            this.pinnedSessions.set(
                this.tabPinId(tab.id, clientId), result.record.sessionKey
            );
        }
        this.tabToSessionKey.set(tab.id, result.record.sessionKey);
        await this.#persistOpenTabs();
        this.#scheduleControllerReconcile(reason);
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

    #getSessionKeyForTab(tabId) {
        const normalizedTabId = String(tabId || '').trim();
        if (!normalizedTabId) {
            return '';
        }
        const tab = this.openTabs.get(normalizedTabId);
        return tab
            ? buildAcpBusSessionKey(tab.agentId, tab.acpSessionId)
            : (this.tabToSessionKey.get(normalizedTabId) || '');
    }

    #getControlTarget(tabId) {
        const normalizedTabId = String(tabId || '').trim();
        if (!normalizedTabId) {
            throw new Error('Agent tab not found');
        }
        const sessionKey = this.#getSessionKeyForTab(normalizedTabId);
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

    async #persistBusHandleSnapshot(handle, reason) {
        await this.snapshotWrites.get(handle.sessionKey);
        return await this.#flushSessionSnapshot(handle.sessionKey, reason);
    }

    async sendPromptForTab(tabId, text, attachments = [], options = {}) {
        const requestId = normalizeCommandRequestId(options.requestId);
        if (requestId) {
            return await this.#runCommandRequest(
                `tab_prompt:${String(tabId || '').trim()}:${requestId}`,
                buildPromptRequestSignature(text, attachments),
                async () => {
                    await this.#sendPromptForTabInternal(
                        tabId,
                        text,
                        attachments
                    );
                    return {
                        accepted: true,
                        requestId,
                        deduped: false
                    };
                }
            );
        }
        await this.#sendPromptForTabInternal(tabId, text, attachments);
        return {
            accepted: true,
            requestId: '',
            deduped: false
        };
    }

    async #sendPromptForTabInternal(tabId, text, attachments = []) {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            await target.handle.runtimeEntry.runtime.sendPrompt(
                target.tabId,
                text,
                attachments
            );
            await this.#persistBusHandleSnapshot(target.handle, 'send_prompt');
            return;
        }
    }

    #pruneCommandRequests() {
        if (this.commandRequests.size === 0) {
            return;
        }
        const nowMs = Date.now();
        for (const [key, entry] of this.commandRequests.entries()) {
            if ((nowMs - entry.updatedAtMs) > this.commandRequestTtlMs) {
                this.commandRequests.delete(key);
            }
        }
        while (this.commandRequests.size > this.commandRequestLimit) {
            const oldestKey = this.commandRequests.keys().next().value;
            if (!oldestKey) {
                break;
            }
            this.commandRequests.delete(oldestKey);
        }
    }

    async #runCommandRequest(key, signature, execute) {
        this.#pruneCommandRequests();
        const existing = this.commandRequests.get(key);
        if (existing) {
            if (existing.signature !== signature) {
                const error = new Error(
                    'requestId was already used for a different command payload'
                );
                error.code = 'idempotency_conflict';
                throw error;
            }
            if (existing.promise) {
                const result = await existing.promise;
                return {
                    ...result,
                    deduped: true
                };
            }
            if (existing.result) {
                return {
                    ...existing.result,
                    deduped: true
                };
            }
        }
        const entry = {
            signature,
            updatedAtMs: Date.now(),
            promise: null,
            result: null
        };
        const promise = (async () => await execute())();
        entry.promise = promise;
        this.commandRequests.set(key, entry);
        try {
            const result = await promise;
            entry.promise = null;
            entry.result = result;
            entry.updatedAtMs = Date.now();
            return result;
        } catch (error) {
            this.commandRequests.delete(key);
            throw error;
        }
    }

    async cancelForTab(tabId) {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            await target.handle.runtimeEntry.runtime.cancel(target.tabId);
            await this.#persistBusHandleSnapshot(target.handle, 'cancel');
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
            await this.#persistBusHandleSnapshot(
                target.handle,
                'resolve_permission'
            );
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
            await this.#persistBusHandleSnapshot(target.handle, 'set_mode');
            return (await this.getOpenTab(tabId)) || serialized;
        }
        throw new Error('Agent tab not found');
    }

    async setConfigOptionForTab(tabId, configId, valueId) {
        const target = this.#getControlTarget(tabId);
        if (target.source === 'bus') {
            const serialized = await target.handle.runtimeEntry.runtime
                .setConfigOption(target.tabId, configId, valueId);
            await this.#persistBusHandleSnapshot(
                target.handle,
                'set_config_option'
            );
            return (await this.getOpenTab(tabId)) || serialized;
        }
        throw new Error('Agent tab not found');
    }

    #scheduleControllerReconcile(reason = 'manual') {
        if (this.stopping || !this.started) {
            return;
        }
        if (!this.controllerReconcileReason) {
            this.controllerReconcileReason = String(reason || 'manual');
        }
        if (this.controllerReconcilePromise) {
            return;
        }
        this.controllerReconcilePromise = (async () => {
            while (this.started && this.controllerReconcileReason) {
                const currentReason = this.controllerReconcileReason;
                this.controllerReconcileReason = '';
                await this.#reconcileControllers(currentReason);
            }
        })()
            .catch((error) => {
                console.warn(
                    '[ACP Bus] Failed to reconcile controllers:',
                    error?.message || error
                );
            })
            .finally(() => {
                this.controllerReconcilePromise = null;
                if (this.controllerReconcileReason) {
                    this.#scheduleControllerReconcile(this.controllerReconcileReason);
                }
            });
    }

    async syncNow(reason = 'manual') {
        if (this.stopping) return;
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

    async #ensureStoreReady() {
        if (this.storeReady) {
            return;
        }
        if (!this.storeReadyPromise) {
            this.storeReadyPromise = (async () => {
                await this.store.init();
                this.storeReady = true;
            })()
                .finally(() => {
                    this.storeReadyPromise = null;
                });
        }
        await this.storeReadyPromise;
    }

    async #ensureInteractiveReady() {
        if (this.stopping) throw new Error('ACP bus is shutting down');
        await this.acpManager.ensureConfigsLoaded();
        await this.#ensureStoreReady();
        if (!this.started && !this.startPromise) {
            void this.start().catch((error) => {
                console.warn(
                    '[ACP Bus] Failed to complete background startup:',
                    error?.message || error
                );
            });
        }
    }

    async #syncNowInternal(reason) {
        if (!this.discoveryEnabled) {
            return { complete: true, state: await this.getState() };
        }
        const availableDefinitions = await this.#listAvailableDefinitions();
        if (availableDefinitions.length === 0) {
            return {
                complete: false,
                state: await this.getState()
            };
        }
        let complete = true;

        for (const definition of availableDefinitions) {
            const runtimeEntry = this.#getDiscoveryRuntime(definition);
            try {
                await this.#listAndRecordIndexedSessions(
                    runtimeEntry.runtime,
                    {
                        definition,
                        cwd: this.discoveryCwd,
                        all: true,
                        limit: DEFAULT_RESUME_LIST_LIMIT,
                        reason
                    }
                );

                for (const workspaceCwd of this.#listWorkspaceDiscoveryCwds()) {
                    await this.#listAndRecordIndexedSessions(
                        runtimeEntry.runtime,
                        {
                            definition,
                            cwd: workspaceCwd,
                            all: false,
                            limit: DEFAULT_RESUME_LIST_LIMIT,
                            reason: `${reason}:workspace_cwd`
                        }
                    );
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

        await this.#reconcileControllers(reason);
        if (reason !== 'startup') {
            await this.#maybeSyncOneUpstreamSession(reason);
        }

        return {
            complete,
            state: await this.getState()
        };
    }

    async #listAvailableDefinitions() {
        await this.acpManager.ensureConfigsLoaded();
        return this.acpManager.definitions;
    }

    #listWorkspaceDiscoveryCwds() {
        let rawCwds = [];
        try {
            rawCwds = this.listWorkspaceCwds();
        } catch (error) {
            this.#emitEvent('session_runtime_exit', {
                agentId: '',
                sessionId: '',
                sessionKey: '',
                title: '',
                cwd: this.discoveryCwd,
                continuityState: 'cold',
                hotRank: null,
                busy: false,
                status: 'disconnected',
                errorMessage: error?.message || 'Failed to list workspace cwd',
                isPresent: true
            }, {
                reason: 'workspace_cwd_discovery'
            });
            return [];
        }
        const seen = new Set();
        const cwds = [];
        for (const rawCwd of Array.isArray(rawCwds) ? rawCwds : []) {
            const value = String(rawCwd || '').trim();
            if (!value) continue;
            const cwd = path.resolve(value);
            if (seen.has(cwd)) continue;
            seen.add(cwd);
            cwds.push(cwd);
        }
        return cwds;
    }

    #getDefinition(agentId) {
        const normalizedAgentId = String(agentId || '').trim();
        const definition = this.acpManager.definitions.find(
            (entry) => entry.id === normalizedAgentId
        );
        if (!definition) {
            throw new Error('Unknown agent');
        }
        return definition;
    }

    #isSystemBusyForColdRepair() {
        let ratio = 0;
        try {
            ratio = this.getCpuLoadRatio();
        } catch {
            return true;
        }
        if (!Number.isFinite(ratio)) {
            return true;
        }
        return ratio >= this.coldRepairLoadThreshold;
    }

    async #maybeSyncOneUpstreamSession(reason) {
        if (this.coldRepairPromise) return await this.coldRepairPromise;
        if (this.#isSystemBusyForColdRepair()) return null;
        const agentIds = [];
        for (const [id, entry] of this.discoveryRuntimes) {
            if (entry.runtime.disposed) continue;
            try {
                if (await entry.runtime.supportsHistoryRead?.()) agentIds.push(id);
            } catch { /* A failed provider must not block other readers. */ }
        }
        if (!agentIds.length) return null;
        const candidates = await this.store.listColdRepairCandidates(100, {
            minAgeMs: this.replayGapMs, now: this.now(),
            includeSnapshot: false, agentIds
        });
        const nowMs = Date.parse(this.now());
        for (const [key, retryAt] of this.historyRetryAfter) {
            if (retryAt <= nowMs) this.historyRetryAfter.delete(key);
        }
        const candidate = candidates.find((row) =>
            !this.observedSessions.has(row.sessionKey)
            && !this.pendingAttaches.has(row.sessionKey)
            && !this.historyRetryAfter.has(row.sessionKey));
        if (!candidate) return null;
        this.coldRepairPromise = this.#repairColdSession(candidate, reason)
            .catch((error) => {
                this.historyRetryAfter.set(
                    candidate.sessionKey, nowMs + this.replayGapMs
                );
                this.#emitEvent('session_history_sync_failed', candidate, {
                    reason, error: error.message
                });
                return null;
            }).finally(() => { this.coldRepairPromise = null; });
        return await this.coldRepairPromise;
    }

    async #listRuntimeSessionPage(runtime, options = {}) {
        return await runtime.listSessions({
            cwd: options.cwd,
            all: options.all,
            cursor: options.cursor || ''
        });
    }

    async #listAndRecordIndexedSessions(runtime, options = {}) {
        const sessions = [];
        const records = [];
        let scope = 'cwd';
        let nextCursor = '';
        const seenCursors = new Set();
        for (;;) {
            const result = await this.#listRuntimeSessionPage(runtime, {
                cwd: options.cwd,
                all: options.all,
                cursor: nextCursor
            });
            const batch = Array.isArray(result?.sessions)
                ? result.sessions
                : [];
            if (result?.scope === 'all') {
                scope = 'all';
            }
            sessions.push(...batch);
            for (const session of batch) {
                const change = await this.#recordIndexedSession(
                    options.definition,
                    session,
                    options.reason || 'session_list'
                );
                records.push(change.record);
            }
            if (sessions.length >= options.limit) {
                return {
                    sessions: sessions.slice(0, options.limit),
                    records: records.slice(0, options.limit),
                    scope
                };
            }
            const previousCursor = nextCursor;
            nextCursor = typeof result?.nextCursor === 'string'
                ? result.nextCursor
                : '';
            if (!nextCursor || nextCursor === previousCursor) {
                break;
            }
            if (seenCursors.has(nextCursor)) {
                break;
            }
            seenCursors.add(nextCursor);
        }
        return { sessions, records, scope };
    }

    async #recordIndexedSession(definition, session, reason) {
        const change = await this.store.upsertIndexedSession({
            agentId: definition.id,
            sessionId: session.sessionId,
            cwd: session.cwd,
            title: session.title || '',
            updatedAt: session.updatedAt || session.lastReceivedAt || '',
            seenAt: this.now()
        });
        const eventType = shouldRecordIndexChange(
            change.previous,
            change.record
        );
        if (eventType) {
            this.#emitEvent(eventType, change.record, { reason });
        }
        return change;
    }

    #resumeSessionFromBusRow(row = {}) {
        return {
            sessionId: String(row.sessionId || '').trim(),
            cwd: String(row.cwd || '').trim(),
            title: typeof row.title === 'string' ? row.title : '',
            updatedAt: row.upstreamUpdatedAt
                || row.lastReceivedAt
                || row.lastSeenAt
                || '',
            relativeUpdatedAt: ''
        };
    }

    #mergeResumeSessions(sessions, cwd, limit) {
        const currentCwd = path.resolve(cwd || process.cwd());
        const merged = new Map();
        for (const session of sessions) {
            const sessionId = String(session?.sessionId || '').trim();
            const sessionCwd = String(session?.cwd || '').trim();
            if (!sessionId || !sessionCwd) continue;
            const previous = merged.get(sessionId);
            const currentTime = Date.parse(session.updatedAt || '') || 0;
            const previousTime = Date.parse(previous?.updatedAt || '') || 0;
            if (!previous || currentTime >= previousTime) {
                merged.set(sessionId, {
                    sessionId,
                    cwd: sessionCwd,
                    title: typeof session.title === 'string' ? session.title : '',
                    updatedAt: typeof session.updatedAt === 'string'
                        ? session.updatedAt
                        : '',
                    relativeUpdatedAt: typeof session.relativeUpdatedAt === 'string'
                        ? session.relativeUpdatedAt
                        : ''
                });
            }
        }
        return Array.from(merged.values())
            .sort((left, right) => {
                const leftTime = Date.parse(left.updatedAt || '') || 0;
                const rightTime = Date.parse(right.updatedAt || '') || 0;
                if (leftTime !== rightTime) {
                    return rightTime - leftTime;
                }
                const leftCwd = path.resolve(left.cwd || process.cwd());
                const rightCwd = path.resolve(right.cwd || process.cwd());
                const leftCurrent = leftCwd === currentCwd ? 0 : 1;
                const rightCurrent = rightCwd === currentCwd ? 0 : 1;
                if (leftCurrent !== rightCurrent) {
                    return leftCurrent - rightCurrent;
                }
                return String(left.title || left.sessionId).localeCompare(
                    String(right.title || right.sessionId)
                );
            })
            .slice(0, limit);
    }

    async #repairColdSession(row, reason) {
        const runtime = this.discoveryRuntimes.get(row.agentId)?.runtime;
        if (!runtime) return null;
        const stage = await this.store.beginHistoryImport(row.sessionKey);
        const importer = new HistoryImporter(this.store, stage);
        const isRequested = () => this.stopping
            || this.observedSessions.has(row.sessionKey)
            || this.pendingAttaches.has(row.sessionKey);
        try {
            await runtime.readSessionHistory(row.sessionId, async (update) => {
                if (isRequested()) throw new Error('History read superseded by workspace');
                await importer.receive(update);
            });
            if (isRequested()) return null;
            const record = await this.store.commitHistoryImport(stage);
            if (record) this.#emitEvent('session_snapshot_updated', record, {
                reason: 'history_sync', source: reason,
                requiresFullSync: true, changedItems: []
            });
            return record;
        } finally {
            if (!stage.closed) await this.store.abortHistoryImport(stage);
        }
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
        const getSnapshotArray = (key) => {
            if (Array.isArray(liveSnapshot?.[key])) return liveSnapshot[key];
            if (Array.isArray(snapshot?.[key])) return snapshot[key];
            if (Array.isArray(source?.[key])) return source[key];
            return [];
        };
        const isActiveStatus = (value = '') => {
            const status = String(value || '').toLowerCase();
            return status === 'pending'
                || status === 'running'
                || status === 'in_progress'
                || status === 'active';
        };
        const activeToolCalls = getSnapshotArray('toolCalls').filter(
            (entry) => isActiveStatus(entry?.status)
        );
        const pendingPermissions = getSnapshotArray('permissions').filter(
            (entry) => String(entry?.status || 'pending').toLowerCase()
                === 'pending'
        );
        const activePlan = getSnapshotArray('plan').filter(
            (entry) => isActiveStatus(entry?.status)
        );
        const terminalSummaries = (
            Array.isArray(source.terminals)
            && source.terminals.length > 0
        )
            ? source.terminals
            : (Array.isArray(snapshot?.terminals) ? snapshot.terminals : []);
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
                terminals: terminalSummaries
            }
            : {
                messages: [],
                toolCalls: activeToolCalls,
                permissions: pendingPermissions,
                plan: activePlan,
                terminals: terminalSummaries
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
        if (this.stopping) throw new Error('ACP bus is shutting down');
        const key = String(definition.id || '').trim();
        const currentVersion = this.acpManager.getAgentConfigVersion(
            definition.id
        );
        const existing = this.discoveryRuntimes.get(key);
        if (existing && !existing.runtime.disposed
            && existing.configVersion === currentVersion) {
            return existing;
        }
        if (existing) {
            this.discoveryRuntimes.delete(key);
            void existing.runtime.dispose().catch(() => {});
        }
        const runtime = this.runtimeFactory(definition, {
            cwd: this.discoveryCwd,
            readOnly: true,
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
        if (this.stopping) throw new Error('ACP bus is shutting down');
        const runtimeKey = buildObserveRuntimeKey(definition.id, cwd);
        const currentVersion = this.acpManager.getAgentConfigVersion(
            definition.id
        );
        const existing = this.observeRuntimes.get(runtimeKey);
        if (existing && !existing.runtime.disposed
            && existing.configVersion === currentVersion) {
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
            pendingOperations: 0,
            sessionKeys: new Set()
        };
        runtime.on('tab_dirty', ({ tabId }) => {
            const sessionKey = this.tabToSessionKey.get(tabId);
            if (!sessionKey) {
                return;
            }
            this.#scheduleSnapshotFlush(sessionKey);
            this.#scheduleControllerReconcile('runtime_update');
        });
        runtime.on('runtime_exit', (detail) => {
            const pending = this.#handleObserveRuntimeExit(entry, detail)
                .catch((error) => console.warn(
                    '[ACP Bus] Runtime exit persistence failed:', error.message
                ));
            this.eventWritePromises.add(pending);
            void pending.finally(() => this.eventWritePromises.delete(pending));
        });
        this.observeRuntimes.set(runtimeKey, entry);
        return entry;
    }

    async #withRuntimeOperation(runtimeEntry, task) {
        runtimeEntry.pendingOperations++;
        try {
            return await task();
        } finally {
            runtimeEntry.pendingOperations--;
            this.#scheduleControllerReconcile('control_operation_settled');
            await this.#disposeObserveRuntimeIfIdle(runtimeEntry);
        }
    }

    async #disposeObserveRuntimeIfIdle(runtimeEntry) {
        if (!runtimeEntry) {
            return;
        }
        if (runtimeEntry.pendingOperations > 0
            || runtimeEntry.sessionKeys.size > 0 || runtimeEntry.runtime.tabs.size > 0) {
            return;
        }
        if (this.observeRuntimes.get(runtimeEntry.runtimeKey) === runtimeEntry) {
            this.observeRuntimes.delete(runtimeEntry.runtimeKey);
        }
        await runtimeEntry.runtime.dispose().catch(() => {});
    }

    #hasUnfinishedWork(handle) {
        const runtime = handle.runtimeEntry.runtime;
        const tab = runtime.tabs.get(handle.tabId);
        const values = (items) => items instanceof Map
            ? [...items.values()] : (Array.isArray(items) ? items : []);
        return !!(handle.runtimeEntry.pendingOperations > 0
            || tab?.busy || tab?.execution?.current
            || tab?.status === 'restoring'
            || runtime.sessionLoadPromises?.has(handle.tabId)
            || values(tab?.permissions).some((item) => item.status === 'pending')
            || values(tab?.toolCalls).some((item) =>
                ['pending', 'running', 'in_progress'].includes(item.status))
            || values(tab?.terminals).some((item) => item.running === true));
    }

    async #reconcileControllers(reason) {
        if (this.stopping) return;
        // Reconciliation only releases controllers. It never starts one.
        const requested = new Set(this.pinnedSessions.values());
        for (const [key, handle] of this.observedSessions) {
            if (requested.has(key) || this.#hasUnfinishedWork(handle)) continue;
            await this.#detachController(key, reason);
        }
        await this.store.setHotSessionKeys([...this.observedSessions.keys()]);
    }

    async #handleSessionAttachFailure(row, error, options = {}) {
        if (this.#isUpstreamSessionMissingError(error)) {
            const deleted = await this.store.deleteSession(row.sessionKey);
            if (deleted) {
                this.#emitEvent('session_index_removed', deleted, {
                    reason: options.reason || 'session_missing',
                    error: error?.message || 'Session missing upstream'
                });
            }
            return;
        }
        const updated = await this.store.updateContinuityState(
            row.sessionKey,
            'resync_required',
            {
                status: options.status || 'disconnected',
                busy: false,
                errorMessage: error?.message
                    || options.message
                    || 'Attach failed'
            }
        );
        if (updated) {
            this.#emitEvent('session_resync_required', updated, {
                reason: options.reason || 'attach_failed',
                error: error?.message || options.message || 'Attach failed'
            });
        }
    }

    #isUpstreamSessionMissingError(error) {
        const message = String(error?.message || error || '').toLowerCase();
        return /session/.test(message)
            && /(not found|missing|does not exist|unknown)/.test(message);
    }

    async #ensureObservedSession(row, reason) {
        await this.pendingDetaches.get(row.sessionKey);
        if (this.observedSessions.has(row.sessionKey)) {
            return this.observedSessions.get(row.sessionKey);
        }
        if (this.pendingAttaches.has(row.sessionKey)) {
            return await this.pendingAttaches.get(row.sessionKey);
        }
        const pending = this.#attachController(row, reason);
        this.pendingAttaches.set(row.sessionKey, pending);
        try {
            return await pending;
        } finally {
            this.pendingAttaches.delete(row.sessionKey);
            this.#scheduleControllerReconcile('attach_settled');
        }
    }

    #hasReplayGap(row) {
        const upstreamUpdatedAt = Date.parse(row?.upstreamUpdatedAt || '');
        const lastReceivedAt = Date.parse(
            row?.lastReceivedAt
            || row?.lastLiveAt
            || row?.lastLoadedAt
            || ''
        );
        if (!Number.isFinite(upstreamUpdatedAt) || !Number.isFinite(lastReceivedAt)) {
            return false;
        }
        return (upstreamUpdatedAt - lastReceivedAt) > this.replayGapMs;
    }

    #shouldReplayOnAttach(row) {
        return (
            Number(row?.messageCount || 0) === 0
            && Number(row?.toolCallCount || 0) === 0
        );
    }

    async #attachController(row, reason) {
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
        return await this.#withRuntimeOperation(runtimeEntry, () =>
            this.#resumeController(runtimeEntry, row, reason));
    }

    async #resumeController(runtimeEntry, row, reason) {
        const tabId = crypto.randomUUID();
        const attachedAt = this.now();
        const hasReplayGap = this.#hasReplayGap(row);
        const replayHistory = this.#shouldReplayOnAttach(row);
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
        const persisted = await this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt: attachedAt,
            attachedAt,
            loadedAt: attachedAt,
            liveAt: attachedAt,
            preserveSnapshotContent: true
        });
        let eventRecord = persisted.record;
        if (hasReplayGap) {
            eventRecord = await this.store.markSessionForUpstreamSync(
                persisted.record.sessionKey,
                {
                    status: persisted.record.status,
                    busy: persisted.record.busy,
                    errorMessage: persisted.record.errorMessage
                }
            ) || persisted.record;
        }
        this.#emitEvent(
            'session_hot_attached',
            eventRecord,
            this.#buildSnapshotEventExtra(persisted, {
                reason,
                replayHistory,
                requiresUpstreamSync: hasReplayGap
            })
        );
        return handle;
    }

    async #detachController(sessionKey, reason) {
        if (this.pendingDetaches.has(sessionKey)) {
            return await this.pendingDetaches.get(sessionKey);
        }
        const pending = this.#releaseController(sessionKey, reason);
        this.pendingDetaches.set(sessionKey, pending);
        try {
            return await pending;
        } finally {
            this.pendingDetaches.delete(sessionKey);
        }
    }

    async #releaseController(sessionKey, reason) {
        const handle = this.observedSessions.get(sessionKey);
        if (!handle) {
            return false;
        }
        const timer = this.snapshotFlushTimers.get(sessionKey);
        if (timer) {
            clearTimeout(timer);
            this.snapshotFlushTimers.delete(sessionKey);
        }

        await this.snapshotWrites.get(sessionKey);
        if (!this.stopping && (this.#hasUnfinishedWork(handle)
            || [...this.pinnedSessions.values()].includes(sessionKey))) return false;

        // Persist the settled tail before releasing the controller.
        const tab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
        if (!this.stopping && tab && tab.status !== 'restoring') {
            await this.store.saveObservedSession(
                this.#decorateSerializedTab(
                    handle.runtimeEntry.runtime.serializeTab(tab),
                    handle.runtimeEntry.runtime
                ), { preserveSnapshotContent: true, observedAt: this.now() }
            );
        }

        if (!this.stopping && (this.#hasUnfinishedWork(handle)
            || [...this.pinnedSessions.values()].includes(sessionKey))) return false;
        await handle.runtimeEntry.runtime.closeTab(handle.tabId);
        this.observedSessions.delete(sessionKey);
        this.tabToSessionKey.delete(handle.tabId);
        handle.runtimeEntry.sessionKeys.delete(sessionKey);

        const updated = await this.store.updateContinuityState(
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

        await this.#disposeObserveRuntimeIfIdle(handle.runtimeEntry);
        return true;
    }

    #scheduleSnapshotFlush(sessionKey) {
        if (this.stopping) return;
        const existing = this.snapshotFlushTimers.get(sessionKey);
        if (existing) return;
        const timer = setTimeout(() => {
            this.snapshotFlushTimers.delete(sessionKey);
            void this.#flushSessionSnapshot(sessionKey);
        }, this.snapshotFlushDelayMs);
        this.snapshotFlushTimers.set(sessionKey, timer);
    }

    async #flushSessionSnapshot(sessionKey, reason = 'runtime_update') {
        const existing = this.snapshotWrites.get(sessionKey);
        if (existing) {
            this.#scheduleSnapshotFlush(sessionKey);
            return await existing;
        }
        const pending = this.#writeSessionSnapshot(sessionKey, reason);
        this.snapshotWrites.set(sessionKey, pending);
        try {
            return await pending;
        } catch (error) {
            console.warn('[ACP Bus] Snapshot write failed:', error.message);
        } finally {
            this.snapshotWrites.delete(sessionKey);
        }
    }

    async #writeSessionSnapshot(sessionKey, reason) {
        const handle = this.observedSessions.get(sessionKey);
        if (!handle) {
            return;
        }
        const tab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
        if (!tab || tab.status === 'restoring') {
            return;
        }
        const observedAt = this.now();
        const serialized = handle.runtimeEntry.runtime.serializeTab(tab);
        const authoritativeSnapshot = tab.authoritativeSnapshot === true
            || serialized.authoritativeSnapshot === true;
        const persisted = await this.store.saveObservedSession(serialized, {
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
                    reason
                })
            );
        }
    }

    async #handleObserveRuntimeExit(runtimeEntry, detail) {
        if (this.stopping) return;
        const affectedKeys = Array.from(runtimeEntry.sessionKeys);
        if (this.observeRuntimes.get(runtimeEntry.runtimeKey) === runtimeEntry) {
            this.observeRuntimes.delete(runtimeEntry.runtimeKey);
        }
        for (const sessionKey of affectedKeys) {
            const handle = this.observedSessions.get(sessionKey);
            if (!handle || handle.runtimeEntry !== runtimeEntry) {
                continue;
            }
            this.observedSessions.delete(sessionKey);
            this.tabToSessionKey.delete(handle.tabId);
            clearTimeout(this.snapshotFlushTimers.get(sessionKey));
            this.snapshotFlushTimers.delete(sessionKey);
            await this.snapshotWrites.get(sessionKey);
            if (this.observedSessions.has(sessionKey)) continue;
            const updated = await this.store.updateContinuityState(
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
            resources: this.#buildSnapshotResources(persisted?.record?.snapshot),
            changedItems: Array.isArray(delta.changedItems)
                ? delta.changedItems
                : [],
            removedItemKeys: Array.isArray(delta.removedItemKeys)
                ? delta.removedItemKeys
                : [],
            requiresFullSync: !!delta.requiresFullSync
        };
    }

    #buildSnapshotResources(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            return {
                toolCalls: [],
                permissions: [],
                plan: [],
                terminals: []
            };
        }
        const isActiveStatus = (value = '') => {
            const status = String(value || '').toLowerCase();
            return status === 'pending'
                || status === 'running'
                || status === 'in_progress'
                || status === 'active';
        };
        const arrayValue = (key) => Array.isArray(snapshot[key])
            ? cloneSerializable(snapshot[key], [])
            : [];
        return {
            toolCalls: arrayValue('toolCalls').filter((entry) =>
                isActiveStatus(entry?.status)
            ),
            permissions: arrayValue('permissions').filter((entry) =>
                String(entry?.status || 'pending').toLowerCase() === 'pending'
            ),
            plan: arrayValue('plan').filter((entry) =>
                isActiveStatus(entry?.status)
            ),
            terminals: arrayValue('terminals'),
            usage: snapshot.usage || null,
            availableModes: arrayValue('availableModes'),
            availableCommands: arrayValue('availableCommands'),
            configOptions: arrayValue('configOptions')
        };
    }

    #emitEvent(type, row, extra = {}) {
        if (!this.storeReady) {
            return;
        }
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
        const promise = this.#persistAndEmitEvent({
            createdAt: this.now(),
            type,
            agentId: row?.agentId || '',
            sessionId: row?.sessionId || '',
            payload
        }, type, payload);
        this.eventWritePromises.add(promise);
        void promise.finally(() => {
            this.eventWritePromises.delete(promise);
        });
    }

    async #persistAndEmitEvent(eventPayload, type, payload) {
        try {
            const event = await this.store.appendEvent(eventPayload);
            this.emit('event', event);
            this.emit(type, payload);
        } catch (error) {
            console.warn(
                '[ACP Bus] Failed to persist event:',
                error?.message || error
            );
        }
    }

    async #drainEventWrites() {
        while (this.eventWritePromises.size > 0) {
            await Promise.allSettled(Array.from(this.eventWritePromises));
        }
    }

    #scheduleNextPoll() {
        if (this.stopping) return;
        clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => {
            void this.syncNow('poll');
        }, this.pollIntervalMs);
    }
}
