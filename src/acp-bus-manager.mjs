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
const DEFAULT_CACHE_SESSION_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 2000;
const DEFAULT_SNAPSHOT_FLUSH_DELAY_MS = 250;

function nowIso() {
    return new Date().toISOString();
}

function buildObserveRuntimeKey(agentId, cwd) {
    return `${String(agentId || '').trim()}::${path.resolve(cwd || '/')}`;
}

function createRuntimeStoreKey(kind, agentId, cwd) {
    return `bus:${kind}:${String(agentId || '').trim()}:${path.resolve(cwd || '/')}`;
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
        this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
            ? Math.max(500, Math.floor(options.pollIntervalMs))
            : DEFAULT_POLL_INTERVAL_MS;
        this.hotSessionLimit = Number.isFinite(options.hotSessionLimit)
            ? Math.max(1, Math.floor(options.hotSessionLimit))
            : DEFAULT_HOT_SESSION_LIMIT;
        this.cacheSessionLimit = Number.isFinite(options.cacheSessionLimit)
            ? Math.max(this.hotSessionLimit, Math.floor(options.cacheSessionLimit))
            : DEFAULT_CACHE_SESSION_LIMIT;
        this.snapshotFlushDelayMs = Number.isFinite(options.snapshotFlushDelayMs)
            ? Math.max(50, Math.floor(options.snapshotFlushDelayMs))
            : DEFAULT_SNAPSHOT_FLUSH_DELAY_MS;
        this.discoveryCwd = path.resolve(
            options.discoveryCwd || process.cwd()
        );
        this.controllerSnapshotProvider =
            typeof options.controllerSnapshotProvider === 'function'
                ? options.controllerSnapshotProvider
                : null;
        this.now = typeof options.now === 'function' ? options.now : nowIso;
        this.started = false;
        this.startPromise = null;
        this.syncPromise = null;
        this.pollTimer = null;
        this.discoveryRuntimes = new Map();
        this.observeRuntimes = new Map();
        this.observedSessions = new Map();
        this.pinnedSessions = new Map();
        this.tabToSessionKey = new Map();
        this.snapshotFlushTimers = new Map();
    }

    async start() {
        if (this.started) {
            return;
        }
        if (this.startPromise) {
            return await this.startPromise;
        }
        this.startPromise = this.#startInternal();
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async #startInternal() {
        await this.acpManager.ensureConfigsLoaded();
        await this.store.init();
        await this.#restoreHotSessions();
        await this.syncNow('startup');
        this.started = true;
        this.#scheduleNextPoll();
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
            pollIntervalMs: this.pollIntervalMs,
            hotSessionLimit: this.hotSessionLimit,
            cacheSessionLimit: this.cacheSessionLimit,
            observedSessionCount: this.observedSessions.size,
            pinnedSessionCount: this.pinnedSessions.size,
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

    async markSessionInterest(entry = {}) {
        const result = this.store.markSessionInterest({
            ...entry,
            interestedAt: entry.interestedAt || this.now()
        });
        this.#emitEvent('session_index_updated', result.record, {
            reason: 'interest'
        });
        if (this.started && !this.syncPromise) {
            await this.#rebalanceHotSessions('interest');
        }
        return result.record;
    }

    async pinSession(pinId, entry = {}, reason = 'ui_attach') {
        const normalizedPinId = String(pinId || '').trim();
        if (!normalizedPinId) {
            throw new Error('pinId is required');
        }
        const result = this.store.markSessionInterest({
            ...entry,
            interestedAt: entry.interestedAt || this.now()
        });
        const previousSessionKey = this.pinnedSessions.get(normalizedPinId) || '';
        this.pinnedSessions.set(normalizedPinId, result.record.sessionKey);
        await this.#ensureObservedSession(result.record, reason);
        if (this.started && !this.syncPromise) {
            await this.#rebalanceHotSessions(reason);
        }
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
        if (this.started && !this.syncPromise) {
            await this.#rebalanceHotSessions(reason);
        }
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

    ingestControllerTab(serialized, reason = 'controller_update') {
        const agentId = String(serialized?.agentId || '').trim();
        const sessionId = String(serialized?.acpSessionId || '').trim();
        if (!agentId || !sessionId) {
            return null;
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const observedAt = this.now();
        const handle = this.observedSessions.get(sessionKey) || null;
        if (!handle && this.#shouldTreatControllerAsObserved(sessionKey)) {
            this.#attachControllerSession(serialized, reason, {
                attachedAt: observedAt,
                emit: false
            });
        } else if (handle?.kind === 'controller') {
            handle.tabId = String(serialized.id || handle.tabId);
            if (handle.tabId) {
                this.tabToSessionKey.set(handle.tabId, sessionKey);
            }
        }
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt,
            liveAt: observedAt
        });
        if (persisted.changed) {
            this.#emitEvent('session_snapshot_updated', persisted.record, {
                reason
            });
        }
        return persisted.record;
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

    async #restoreHotSessions() {
        const hotRows = this.store.listHotSessions(this.hotSessionLimit, {
            includeSnapshot: true
        });
        for (const row of hotRows) {
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
        const hotRows = this.store.listMostActiveSessions(
            this.hotSessionLimit,
            {
                presentOnly: true,
                includeSnapshot: true
            }
        );
        const hotKeys = hotRows.map((row) => row.sessionKey);
        this.store.setHotSessionKeys(hotKeys);
        const desiredKeys = new Set([
            ...hotKeys,
            ...this.pinnedSessions.values()
        ]);

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
        const controllerSnapshot = this.controllerSnapshotProvider
            ? this.controllerSnapshotProvider(row.agentId, row.sessionId)
            : null;
        if (controllerSnapshot) {
            return this.#attachControllerSession(controllerSnapshot, reason);
        }
        return this.#attachHotSession(row, reason);
    }

    #shouldTreatControllerAsObserved(sessionKey) {
        if (!sessionKey) {
            return false;
        }
        if (Array.from(this.pinnedSessions.values()).includes(sessionKey)) {
            return true;
        }
        const row = this.store.getSession(sessionKey);
        return Number.isInteger(row?.hotRank);
    }

    #attachControllerSession(serialized, reason, options = {}) {
        const sessionKey = buildAcpBusSessionKey(
            serialized.agentId,
            serialized.acpSessionId
        );
        if (this.observedSessions.has(sessionKey)) {
            return this.observedSessions.get(sessionKey);
        }
        const attachedAt = typeof options.attachedAt === 'string'
            ? options.attachedAt
            : this.now();
        const handle = {
            kind: 'controller',
            sessionKey,
            agentId: serialized.agentId,
            sessionId: serialized.acpSessionId,
            tabId: String(serialized.id || ''),
            runtimeEntry: null
        };
        this.observedSessions.set(sessionKey, handle);
        if (handle.tabId) {
            this.tabToSessionKey.set(handle.tabId, sessionKey);
        }
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt: attachedAt,
            attachedAt,
            loadedAt: attachedAt,
            liveAt: attachedAt
        });
        if (options.emit !== false) {
            this.#emitEvent('session_hot_attached', persisted.record, {
                reason,
                source: 'controller'
            });
        }
        return handle;
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
        const serialized = await runtimeEntry.runtime.resumeTab({
            id: tabId,
            acpSessionId: row.sessionId,
            cwd: row.cwd,
            terminalSessionId: '',
            title: row.title || ''
        });
        const sessionKey = buildAcpBusSessionKey(
            serialized.agentId,
            serialized.acpSessionId
        );
        const handle = {
            sessionKey,
            agentId: serialized.agentId,
            sessionId: serialized.acpSessionId,
            tabId,
            runtimeEntry
        };
        this.observedSessions.set(sessionKey, handle);
        this.tabToSessionKey.set(tabId, sessionKey);
        runtimeEntry.sessionKeys.add(sessionKey);
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt: attachedAt,
            attachedAt,
            loadedAt: attachedAt,
            liveAt: attachedAt
        });
        this.#emitEvent('session_hot_attached', persisted.record, {
            reason
        });
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

        if (handle.kind !== 'controller') {
            handle.runtimeEntry.runtime.detachTab(handle.tabId);
            handle.runtimeEntry.sessionKeys.delete(sessionKey);
        }

        const updated = this.store.updateContinuityState(
            sessionKey,
            'resync_required',
            {
                activityAt: this.now(),
                status: 'ready',
                busy: false,
                errorMessage: ''
            }
        );
        if (updated) {
            this.#emitEvent('session_hot_detached', updated, { reason });
        }

        if (
            handle.kind !== 'controller'
            && handle.runtimeEntry.sessionKeys.size === 0
        ) {
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
        if (!handle || handle.kind === 'controller') {
            return;
        }
        const tab = handle.runtimeEntry.runtime.tabs.get(handle.tabId);
        if (!tab) {
            return;
        }
        const observedAt = this.now();
        const serialized = handle.runtimeEntry.runtime.serializeTab(tab);
        const persisted = this.store.saveObservedSession(serialized, {
            continuityState: 'live',
            observedAt,
            liveAt: observedAt
        });
        if (persisted.changed) {
            this.#emitEvent('session_snapshot_updated', persisted.record, {
                reason: 'runtime_update'
            });
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
                    continuityState: row.continuityState,
                    hotRank: row.hotRank,
                    status: row.status,
                    busy: row.busy,
                    errorMessage: row.errorMessage,
                    messageCount: row.messageCount,
                    toolCallCount: row.toolCallCount,
                    isPresent: row.isPresent
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
