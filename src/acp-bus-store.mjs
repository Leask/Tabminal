import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BASE_DIR = path.join(os.homedir(), '.tabminal');
const DEFAULT_DB_PATH = path.join(BASE_DIR, 'acp-bus.sqlite');
const DEFAULT_EVENT_LIMIT = 2000;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const MAX_EVENT_DELTA_ITEMS = 50;

function parseJsonText(text, fallback) {
    if (typeof text !== 'string' || text.trim() === '') {
        return fallback;
    }
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

function maxIso(...values) {
    return values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .sort()
        .at(-1) || '';
}

function normalizeSessionKey(agentId, sessionId) {
    return `${String(agentId || '').trim()}::${String(sessionId || '').trim()}`;
}

function nowIso() {
    return new Date().toISOString();
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

function encodeTimelineCursor(row) {
    if (!row) {
        return '';
    }
    const index = Number(row.item_index || row.itemIndex || row.index || 0);
    const payload = JSON.stringify({
        index,
        key: String(row.item_key || row.itemKey || '')
    });
    return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeTimelineCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.trim() === '') {
        return null;
    }
    try {
        const parsed = JSON.parse(
            Buffer.from(cursor.trim(), 'base64url').toString('utf8')
        );
        const index = Number(parsed?.index);
        const key = String(parsed?.key || '');
        if (!Number.isFinite(index) || !key) {
            return null;
        }
        return { index, key };
    } catch {
        return null;
    }
}

function normalizeTimelineOrder(entry, fallbackOrder) {
    if (Number.isFinite(entry?.order)) {
        return Number(entry.order);
    }
    return Number.isFinite(fallbackOrder) ? fallbackOrder : 0;
}

function getTimelineItemIdentity(type, value, fallbackIndex) {
    const index = Number.isFinite(fallbackIndex) ? fallbackIndex : 0;
    if (type === 'message') {
        return String(
            value?.id
            || value?.messageId
            || value?.streamKey
            || `message-${index}`
        );
    }
    if (type === 'tool') {
        return String(
            value?.toolCallId
            || value?.id
            || `tool-${index}`
        );
    }
    if (type === 'permission') {
        return String(value?.id || `permission-${index}`);
    }
    if (type === 'plan') {
        return String(value?.id || `plan-${index}`);
    }
    return `${type}-${index}`;
}

function hashSerializable(value) {
    return crypto
        .createHash('sha1')
        .update(JSON.stringify(value ?? null))
        .digest('hex')
        .slice(0, 16);
}

function compareTimelinePayload(left, right) {
    const leftOrder = Number(left?.order);
    const rightOrder = Number(right?.order);
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) {
        if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
        }
    } else if (Number.isFinite(leftOrder)) {
        return -1;
    } else if (Number.isFinite(rightOrder)) {
        return 1;
    }
    return String(left?.id || left?.toolCallId || '').localeCompare(
        String(right?.id || right?.toolCallId || '')
    );
}

function compareTimelineRows(left, right) {
    const leftIndex = Number(left?.itemIndex);
    const rightIndex = Number(right?.itemIndex);
    if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex)) {
        if (leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }
    } else if (Number.isFinite(leftIndex)) {
        return -1;
    } else if (Number.isFinite(rightIndex)) {
        return 1;
    }
    return String(left?.itemKey || '').localeCompare(String(right?.itemKey || ''));
}

function normalizeTimelineRows(rows = []) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return [];
    }
    return [...rows]
        .sort(compareTimelineRows)
        .map((row, index) => {
            const itemIndex = index + 1;
            const value = parseJsonText(row.payloadJson, {});
            const payload = value && typeof value === 'object'
                ? { ...value, index: itemIndex }
                : value;
            if (payload && typeof payload === 'object') {
                delete payload.order;
            }
            return {
                ...row,
                itemIndex,
                payloadJson: JSON.stringify(payload)
            };
        });
}

function timelineRowValue(row) {
    const index = Number(row?.item_index || row?.itemIndex || row?.index || 0);
    const value = parseJsonText(row?.payload_json ?? row?.payloadJson, {});
    const payload = value && typeof value === 'object'
        ? { ...value, index }
        : value;
    if (payload && typeof payload === 'object') {
        delete payload.order;
    }
    return payload;
}

function timelineRowToItem(row) {
    const index = Number(row?.item_index || row?.itemIndex || row?.index || 0);
    return {
        itemKey: String(row?.item_key || row?.itemKey || ''),
        cursor: encodeTimelineCursor(row),
        type: String(row?.item_type || row?.itemType || ''),
        index,
        updatedAt: String(row?.updated_at || row?.updatedAt || ''),
        value: timelineRowValue(row)
    };
}

function timelineRowSignature(row) {
    return JSON.stringify({
        itemType: String(row?.item_type || row?.itemType || ''),
        itemId: String(row?.item_id || row?.itemId || ''),
        itemIndex: Number(row?.item_index || row?.itemIndex || 0),
        role: String(row?.role || ''),
        kind: String(row?.kind || ''),
        status: String(row?.status || ''),
        payloadJson: String(row?.payload_json ?? row?.payloadJson ?? '{}')
    });
}

function buildTimelineDelta(previousRows, nextRows, options = {}) {
    const previous = Array.isArray(previousRows) ? previousRows : [];
    const next = Array.isArray(nextRows) ? nextRows : [];
    const previousByKey = new Map(
        previous.map((row) => [String(row.item_key || row.itemKey || ''), row])
    );
    const nextKeys = new Set(
        next.map((row) => String(row.item_key || row.itemKey || ''))
    );
    const removedItemKeys = previous
        .map((row) => String(row.item_key || row.itemKey || ''))
        .filter((key) => key && !nextKeys.has(key));
    const changedRows = next.filter((row) => {
        const key = String(row.item_key || row.itemKey || '');
        const previousRow = previousByKey.get(key);
        return !previousRow
            || timelineRowSignature(previousRow) !== timelineRowSignature(row);
    });
    const tooLarge = changedRows.length > MAX_EVENT_DELTA_ITEMS;
    const requiresFullSync = options.authoritativeSnapshot === true
        || removedItemKeys.length > 0
        || tooLarge;
    const total = next.length;
    const timelineIndex = {
        total,
        minIndex: total > 0 ? 1 : 0,
        maxIndex: total
    };
    return {
        changed: requiresFullSync || changedRows.length > 0,
        requiresFullSync,
        changedItems: requiresFullSync
            ? []
            : changedRows.map((row) => timelineRowToItem(row)),
        removedItemKeys,
        timelineIndex
    };
}

function mergeSnapshotArray(previousItems, nextItems, type) {
    const previous = Array.isArray(previousItems) ? previousItems : [];
    const next = Array.isArray(nextItems) ? nextItems : [];
    if (next.length === 0) {
        return cloneSerializable(previous, []);
    }
    const merged = new Map();
    for (const [index, item] of previous.entries()) {
        if (!item || typeof item !== 'object') continue;
        const key = getTimelineItemIdentity(type, item, index);
        merged.set(key, cloneSerializable(item, {}) || {});
    }
    for (const [index, item] of next.entries()) {
        if (!item || typeof item !== 'object') continue;
        const key = getTimelineItemIdentity(type, item, index);
        merged.set(key, cloneSerializable(item, {}) || {});
    }
    return Array.from(merged.values()).sort(compareTimelinePayload);
}

function normalizePlanEntries(entries) {
    return Array.isArray(entries)
        ? entries
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => ({
                content: typeof entry.content === 'string' ? entry.content : '',
                priority: typeof entry.priority === 'string'
                    ? entry.priority
                    : 'medium',
                status: typeof entry.status === 'string'
                    ? entry.status
                    : 'pending',
                order: Number.isFinite(entry.order) ? Number(entry.order) : undefined
            }))
        : [];
}

function isPlanComplete(entries = []) {
    return Array.isArray(entries)
        && entries.length > 0
        && entries.every((entry) =>
            String(entry?.status || '').toLowerCase() === 'completed'
        );
}

function getPlanOrder(entries, fallbackOrder) {
    const planSortIndexes = normalizePlanEntries(entries)
        .map((entry) => Number(entry.order))
        .filter(Number.isFinite);
    if (planSortIndexes.length === 0) {
        return Number.isFinite(fallbackOrder) ? fallbackOrder : 0;
    }
    return Math.max(...planSortIndexes) + 0.5;
}

function buildPlanHistoryEntry(entries, observedAt, fallbackOrder) {
    const normalizedEntries = normalizePlanEntries(entries);
    const fingerprint = hashSerializable(normalizedEntries);
    return {
        id: `plan-${fingerprint}`,
        active: false,
        status: 'completed',
        createdAt: observedAt,
        order: getPlanOrder(normalizedEntries, fallbackOrder),
        summary: '',
        entries: normalizedEntries
    };
}

function mergePlanState(previousSnapshot, nextSnapshot, observedAt) {
    const previousHistory = Array.isArray(previousSnapshot?.planHistory)
        ? cloneSerializable(previousSnapshot.planHistory, [])
        : [];
    const nextHistory = Array.isArray(nextSnapshot?.planHistory)
        ? cloneSerializable(nextSnapshot.planHistory, [])
        : [];
    const history = new Map();
    for (const item of [...previousHistory, ...nextHistory]) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || `plan-${hashSerializable(item.entries || [])}`);
        history.set(id, {
            ...item,
            id,
            active: false,
            status: item.status || 'completed',
            entries: normalizePlanEntries(item.entries)
        });
    }
    const plan = normalizePlanEntries(nextSnapshot?.plan);
    if (isPlanComplete(plan)) {
        const entry = buildPlanHistoryEntry(
            plan,
            observedAt,
            (history.size + 1) * 1000
        );
        history.set(entry.id, entry);
    }
    return {
        ...nextSnapshot,
        plan,
        planHistory: Array.from(history.values()).sort(compareTimelinePayload)
    };
}

function buildTimelineRowsFromSnapshot(sessionKey, snapshot, observedAt) {
    const rows = [];
    const pushItems = (type, items) => {
        if (!Array.isArray(items)) {
            return;
        }
        for (const [index, item] of items.entries()) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const value = cloneSerializable(item, {}) || {};
            const identity = getTimelineItemIdentity(type, value, index);
            const itemKey = `${type}:${identity}`;
            rows.push({
                sessionKey,
                itemKey,
                itemType: type,
                itemId: identity,
                itemIndex: normalizeTimelineOrder(value, rows.length + 1),
                role: String(value.role || ''),
                kind: String(value.kind || ''),
                status: String(value.status || ''),
                updatedAt: observedAt,
                payloadJson: JSON.stringify(value)
            });
        }
    };
    pushItems('message', snapshot?.messages);
    pushItems('tool', snapshot?.toolCalls);
    pushItems('permission', snapshot?.permissions);
    pushItems('plan', snapshot?.planHistory);
    const activePlan = normalizePlanEntries(snapshot?.plan);
    if (activePlan.length > 0 && !isPlanComplete(activePlan)) {
        pushItems('plan', [{
            id: 'active-plan',
            active: true,
            status: 'active',
            order: getPlanOrder(activePlan, rows.length + 1),
            summary: '',
            entries: activePlan
        }]);
    }
    return normalizeTimelineRows(rows);
}

function rowToSession(row, includeSnapshot = false) {
    if (!row) return null;
    const snapshot = includeSnapshot
        ? parseJsonText(row.snapshot_json, null)
        : undefined;
    return {
        sessionKey: String(row.session_key || ''),
        agentId: String(row.agent_id || ''),
        sessionId: String(row.session_id || ''),
        cwd: String(row.cwd || ''),
        title: String(row.title || ''),
        upstreamUpdatedAt: String(row.upstream_updated_at || ''),
        lastActivityAt: String(row.last_activity_at || ''),
        lastSeenAt: String(row.last_seen_at || ''),
        lastAttachedAt: String(row.last_attached_at || ''),
        lastLoadedAt: String(row.last_loaded_at || ''),
        lastLiveAt: String(row.last_live_at || ''),
        lastReceivedAt: String(row.last_received_at || ''),
        lastDetachedAt: String(row.last_detached_at || ''),
        continuityState: String(row.continuity_state || 'cold'),
        hotRank: Number.isInteger(row.hot_rank) ? row.hot_rank : null,
        status: String(row.status || ''),
        busy: !!row.busy,
        errorMessage: String(row.error_message || ''),
        messageCount: Number.isFinite(row.message_count)
            ? row.message_count
            : 0,
        toolCallCount: Number.isFinite(row.tool_call_count)
            ? row.tool_call_count
            : 0,
        isPresent: !!row.is_present,
        snapshotVersion: Number.isFinite(row.snapshot_version)
            ? row.snapshot_version
            : 0,
        snapshot
    };
}

function mergeObservedSnapshot(previousSnapshot, nextSnapshot, options = {}) {
    if (!options.preserveSnapshotContent || !previousSnapshot) {
        return nextSnapshot;
    }
    const merged = {
        ...previousSnapshot,
        ...nextSnapshot
    };
    const preferArray = (key) => {
        if (Array.isArray(nextSnapshot?.[key]) && nextSnapshot[key].length > 0) {
            merged[key] = nextSnapshot[key];
            return;
        }
        if (Array.isArray(previousSnapshot?.[key])) {
            merged[key] = previousSnapshot[key];
            return;
        }
        merged[key] = Array.isArray(nextSnapshot?.[key]) ? nextSnapshot[key] : [];
    };
    merged.messages = mergeSnapshotArray(
        previousSnapshot?.messages,
        nextSnapshot?.messages,
        'message'
    );
    merged.toolCalls = mergeSnapshotArray(
        previousSnapshot?.toolCalls,
        nextSnapshot?.toolCalls,
        'tool'
    );
    merged.permissions = mergeSnapshotArray(
        previousSnapshot?.permissions,
        nextSnapshot?.permissions,
        'permission'
    );
    preferArray('plan');
    preferArray('terminals');
    merged.planHistory = mergeSnapshotArray(
        previousSnapshot?.planHistory,
        nextSnapshot?.planHistory,
        'plan'
    );
    merged.availableModes = Array.isArray(nextSnapshot?.availableModes)
        && nextSnapshot.availableModes.length > 0
        ? nextSnapshot.availableModes
        : (previousSnapshot?.availableModes || []);
    merged.availableCommands = Array.isArray(nextSnapshot?.availableCommands)
        && nextSnapshot.availableCommands.length > 0
        ? nextSnapshot.availableCommands
        : (previousSnapshot?.availableCommands || []);
    merged.configOptions = Array.isArray(nextSnapshot?.configOptions)
        && nextSnapshot.configOptions.length > 0
        ? nextSnapshot.configOptions
        : (previousSnapshot?.configOptions || []);
    merged.usage = nextSnapshot?.usage || previousSnapshot?.usage || null;
    return merged;
}

function sessionChanged(previous, next) {
    if (!previous) return true;
    return [
        'cwd',
        'title',
        'upstreamUpdatedAt',
        'lastActivityAt',
        'lastSeenAt',
        'lastAttachedAt',
        'lastLoadedAt',
        'lastLiveAt',
        'lastReceivedAt',
        'lastDetachedAt',
        'continuityState',
        'hotRank',
        'status',
        'busy',
        'errorMessage',
        'messageCount',
        'toolCallCount',
        'isPresent',
        'snapshotVersion'
    ].some((field) => previous[field] !== next[field]);
}

export function buildAcpBusSessionKey(agentId, sessionId) {
    return normalizeSessionKey(agentId, sessionId);
}

export class AcpBusStore {
    constructor(options = {}) {
        this.dbPath = options.dbPath || DEFAULT_DB_PATH;
        this.eventLimit = Number.isFinite(options.eventLimit)
            ? Math.max(100, Math.floor(options.eventLimit))
            : DEFAULT_EVENT_LIMIT;
        this.busyTimeoutMs = Number.isFinite(options.busyTimeoutMs)
            ? Math.max(0, Math.floor(options.busyTimeoutMs))
            : DEFAULT_BUSY_TIMEOUT_MS;
        this.now = typeof options.now === 'function' ? options.now : nowIso;
        this.db = null;
    }

    async init() {
        if (this.db) {
            return;
        }
        await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`
            PRAGMA busy_timeout = ${this.busyTimeoutMs};
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA temp_store = MEMORY;
            CREATE TABLE IF NOT EXISTS acp_bus_sessions (
                session_key TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                cwd TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                upstream_updated_at TEXT NOT NULL DEFAULT '',
                last_activity_at TEXT NOT NULL DEFAULT '',
                last_seen_at TEXT NOT NULL DEFAULT '',
                last_attached_at TEXT NOT NULL DEFAULT '',
                last_loaded_at TEXT NOT NULL DEFAULT '',
                last_live_at TEXT NOT NULL DEFAULT '',
                last_received_at TEXT NOT NULL DEFAULT '',
                last_detached_at TEXT NOT NULL DEFAULT '',
                continuity_state TEXT NOT NULL DEFAULT 'cold',
                hot_rank INTEGER,
                status TEXT NOT NULL DEFAULT '',
                busy INTEGER NOT NULL DEFAULT 0,
                error_message TEXT NOT NULL DEFAULT '',
                message_count INTEGER NOT NULL DEFAULT 0,
                tool_call_count INTEGER NOT NULL DEFAULT 0,
                is_present INTEGER NOT NULL DEFAULT 1,
                snapshot_version INTEGER NOT NULL DEFAULT 0,
                snapshot_json TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_acp_bus_sessions_agent
                ON acp_bus_sessions(agent_id);
            CREATE INDEX IF NOT EXISTS idx_acp_bus_sessions_activity
                ON acp_bus_sessions(last_activity_at DESC);
            CREATE INDEX IF NOT EXISTS idx_acp_bus_sessions_hot
                ON acp_bus_sessions(hot_rank ASC);
            CREATE TABLE IF NOT EXISTS acp_bus_timeline_items (
                session_key TEXT NOT NULL,
                item_key TEXT NOT NULL,
                item_type TEXT NOT NULL,
                item_id TEXT NOT NULL DEFAULT '',
                item_index INTEGER NOT NULL DEFAULT 0,
                role TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY(session_key, item_key)
            );
            CREATE TABLE IF NOT EXISTS acp_bus_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                type TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_acp_bus_events_created_at
                ON acp_bus_events(created_at DESC);
        `);
        this.#ensureColumn(
            'acp_bus_sessions',
            'last_received_at',
            "TEXT NOT NULL DEFAULT ''"
        );
        this.#ensureColumn(
            'acp_bus_sessions',
            'last_detached_at',
            "TEXT NOT NULL DEFAULT ''"
        );
        this.#ensureColumn(
            'acp_bus_sessions',
            'snapshot_version',
            'INTEGER NOT NULL DEFAULT 0'
        );
        this.#ensureTimelineIndexColumn();
    }

    close() {
        if (!this.db) {
            return;
        }
        this.db.close();
        this.db = null;
    }

    #requireDb() {
        if (!this.db) {
            throw new Error('ACP bus store not initialized');
        }
        return this.db;
    }

    #ensureColumn(tableName, columnName, definition) {
        const db = this.#requireDb();
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        if (columns.some((column) => column.name === columnName)) {
            return;
        }
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }

    #ensureTimelineIndexColumn() {
        const db = this.#requireDb();
        const columns = db.prepare(`
            PRAGMA table_info(acp_bus_timeline_items)
        `).all();
        const hasItemIndex = columns.some((column) => (
            column.name === 'item_index'
        ));
        const hasItemOrder = columns.some((column) => (
            column.name === 'item_order'
        ));
        const itemIndexColumn = columns.find((column) => (
            column.name === 'item_index'
        ));
        const hasIntegerIndex = /^INTEGER$/i.test(
            String(itemIndexColumn?.type || '')
        );
        db.exec('DROP INDEX IF EXISTS idx_acp_bus_timeline_order');
        if (hasItemIndex && hasIntegerIndex && !hasItemOrder) {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_acp_bus_timeline_index
                    ON acp_bus_timeline_items(session_key, item_index, item_key)
            `);
            return;
        }
        const sourceIndexColumn = hasItemIndex ? 'item_index' : 'item_order';
        db.exec('BEGIN');
        try {
            db.exec(`
                ALTER TABLE acp_bus_timeline_items
                RENAME TO acp_bus_timeline_items_legacy
            `);
            db.exec(`
                CREATE TABLE acp_bus_timeline_items (
                    session_key TEXT NOT NULL,
                    item_key TEXT NOT NULL,
                    item_type TEXT NOT NULL,
                    item_id TEXT NOT NULL DEFAULT '',
                    item_index INTEGER NOT NULL DEFAULT 0,
                    role TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    PRIMARY KEY(session_key, item_key)
                )
            `);
            db.exec(`
                INSERT INTO acp_bus_timeline_items (
                    session_key,
                    item_key,
                    item_type,
                    item_id,
                    item_index,
                    role,
                    kind,
                    status,
                    updated_at,
                    payload_json
                )
                SELECT
                    session_key,
                    item_key,
                    item_type,
                    item_id,
                    CAST(${sourceIndexColumn} AS INTEGER),
                    role,
                    kind,
                    status,
                    updated_at,
                    payload_json
                FROM acp_bus_timeline_items_legacy
            `);
            db.exec('DROP TABLE acp_bus_timeline_items_legacy');
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_acp_bus_timeline_index
                ON acp_bus_timeline_items(session_key, item_index, item_key)
        `);
    }

    #getSessionRow(sessionKey) {
        const db = this.#requireDb();
        return db.prepare(`
            SELECT *
            FROM acp_bus_sessions
            WHERE session_key = ?
        `).get(sessionKey) || null;
    }

    getSession(sessionKey, options = {}) {
        const row = this.#getSessionRow(sessionKey);
        return rowToSession(row, options.includeSnapshot === true);
    }

    getSessionByIdentity(agentId, sessionId, options = {}) {
        return this.getSession(
            buildAcpBusSessionKey(agentId, sessionId),
            options
        );
    }

    #writeSession(record) {
        const db = this.#requireDb();
        db.prepare(`
            INSERT INTO acp_bus_sessions (
                session_key,
                agent_id,
                session_id,
                cwd,
                title,
                upstream_updated_at,
                last_activity_at,
                last_seen_at,
                last_attached_at,
                last_loaded_at,
                last_live_at,
                last_received_at,
                last_detached_at,
                continuity_state,
                hot_rank,
                status,
                busy,
                error_message,
                message_count,
                tool_call_count,
                is_present,
                snapshot_version,
                snapshot_json
            ) VALUES (
                @sessionKey,
                @agentId,
                @sessionId,
                @cwd,
                @title,
                @upstreamUpdatedAt,
                @lastActivityAt,
                @lastSeenAt,
                @lastAttachedAt,
                @lastLoadedAt,
                @lastLiveAt,
                @lastReceivedAt,
                @lastDetachedAt,
                @continuityState,
                @hotRank,
                @status,
                @busy,
                @errorMessage,
                @messageCount,
                @toolCallCount,
                @isPresent,
                @snapshotVersion,
                @snapshotJson
            )
            ON CONFLICT(session_key) DO UPDATE SET
                agent_id = excluded.agent_id,
                session_id = excluded.session_id,
                cwd = excluded.cwd,
                title = excluded.title,
                upstream_updated_at = excluded.upstream_updated_at,
                last_activity_at = excluded.last_activity_at,
                last_seen_at = excluded.last_seen_at,
                last_attached_at = excluded.last_attached_at,
                last_loaded_at = excluded.last_loaded_at,
                last_live_at = excluded.last_live_at,
                last_received_at = excluded.last_received_at,
                last_detached_at = excluded.last_detached_at,
                continuity_state = excluded.continuity_state,
                hot_rank = excluded.hot_rank,
                status = excluded.status,
                busy = excluded.busy,
                error_message = excluded.error_message,
                message_count = excluded.message_count,
                tool_call_count = excluded.tool_call_count,
                is_present = excluded.is_present,
                snapshot_version = excluded.snapshot_version,
                snapshot_json = excluded.snapshot_json
        `).run({
            sessionKey: record.sessionKey,
            agentId: record.agentId,
            sessionId: record.sessionId,
            cwd: record.cwd,
            title: record.title,
            upstreamUpdatedAt: record.upstreamUpdatedAt,
            lastActivityAt: record.lastActivityAt,
            lastSeenAt: record.lastSeenAt,
            lastAttachedAt: record.lastAttachedAt,
            lastLoadedAt: record.lastLoadedAt,
            lastLiveAt: record.lastLiveAt,
            lastReceivedAt: record.lastReceivedAt,
            lastDetachedAt: record.lastDetachedAt,
            continuityState: record.continuityState,
            hotRank: Number.isInteger(record.hotRank) ? record.hotRank : null,
            status: record.status,
            busy: record.busy ? 1 : 0,
            errorMessage: record.errorMessage,
            messageCount: record.messageCount,
            toolCallCount: record.toolCallCount,
            isPresent: record.isPresent ? 1 : 0,
            snapshotVersion: Number.isFinite(record.snapshotVersion)
                ? record.snapshotVersion
                : 0,
            snapshotJson: record.snapshotJson
        });
    }

    #upsertTimelineRows(rows = []) {
        if (!Array.isArray(rows) || rows.length === 0) {
            return;
        }
        const db = this.#requireDb();
        const insert = db.prepare(`
            INSERT INTO acp_bus_timeline_items (
                session_key,
                item_key,
                item_type,
                item_id,
                item_index,
                role,
                kind,
                status,
                updated_at,
                payload_json
            ) VALUES (
                @sessionKey,
                @itemKey,
                @itemType,
                @itemId,
                @itemIndex,
                @role,
                @kind,
                @status,
                @updatedAt,
                @payloadJson
            )
            ON CONFLICT(session_key, item_key) DO UPDATE SET
                item_type = excluded.item_type,
                item_id = excluded.item_id,
                item_index = excluded.item_index,
                role = excluded.role,
                kind = excluded.kind,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
        `);
        db.exec('BEGIN');
        try {
            for (const row of rows) {
                insert.run(row);
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    #replaceTimelineRows(sessionKey, rows = []) {
        const db = this.#requireDb();
        db.exec('BEGIN');
        try {
            db.prepare(`
                DELETE FROM acp_bus_timeline_items
                WHERE session_key = ?
            `).run(sessionKey);
            if (Array.isArray(rows) && rows.length > 0) {
                const insert = db.prepare(`
                    INSERT INTO acp_bus_timeline_items (
                        session_key,
                        item_key,
                        item_type,
                        item_id,
                        item_index,
                        role,
                        kind,
                        status,
                        updated_at,
                        payload_json
                    ) VALUES (
                        @sessionKey,
                        @itemKey,
                        @itemType,
                        @itemId,
                        @itemIndex,
                        @role,
                        @kind,
                        @status,
                        @updatedAt,
                        @payloadJson
                    )
                `);
                for (const row of rows) {
                    insert.run(row);
                }
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    #deleteTimelineItems(sessionKey, itemKeys = []) {
        const keys = itemKeys
            .map((key) => String(key || '').trim())
            .filter(Boolean);
        if (keys.length === 0) {
            return;
        }
        const db = this.#requireDb();
        const remove = db.prepare(`
            DELETE FROM acp_bus_timeline_items
            WHERE session_key = ?
                AND item_key = ?
        `);
        for (const key of keys) {
            remove.run(sessionKey, key);
        }
    }

    #getTimelineRows(sessionKey) {
        const db = this.#requireDb();
        return db.prepare(`
            SELECT *
            FROM acp_bus_timeline_items
            WHERE session_key = ?
            ORDER BY item_index ASC, item_key ASC
        `).all(String(sessionKey || '').trim());
    }

    #ensureTimelineIndexes(sessionKey) {
        const db = this.#requireDb();
        const bounds = db.prepare(`
            SELECT
                COUNT(*) AS count,
                COUNT(DISTINCT item_index) AS distinct_count,
                MIN(item_index) AS min_index,
                MAX(item_index) AS max_index,
                SUM(item_index) AS sum_index
            FROM acp_bus_timeline_items
            WHERE session_key = ?
        `).get(sessionKey) || {};
        const count = Number(bounds.count || 0);
        if (count === 0) {
            return;
        }
        const distinctCount = Number(bounds.distinct_count || 0);
        const minIndex = Number(bounds.min_index || 0);
        const maxIndex = Number(bounds.max_index || 0);
        const sumIndex = Number(bounds.sum_index || 0);
        const expectedSum = (count * (count + 1)) / 2;
        if (
            minIndex === 1
            && maxIndex === count
            && distinctCount === count
            && sumIndex === expectedSum
        ) {
            return;
        }
        const rows = db.prepare(`
            SELECT item_key, item_index, payload_json
            FROM acp_bus_timeline_items
            WHERE session_key = ?
            ORDER BY item_index ASC, item_key ASC
        `).all(sessionKey);
        const update = db.prepare(`
            UPDATE acp_bus_timeline_items
            SET item_index = ?, payload_json = ?
            WHERE session_key = ? AND item_key = ?
        `);
        db.exec('BEGIN');
        try {
            for (const [index, row] of rows.entries()) {
                const itemIndex = index + 1;
                const value = parseJsonText(row.payload_json, {});
                const payload = value && typeof value === 'object'
                    ? { ...value, index: itemIndex }
                    : value;
                if (payload && typeof payload === 'object') {
                    delete payload.order;
                }
                update.run(
                    itemIndex,
                    JSON.stringify(payload),
                    sessionKey,
                    row.item_key
                );
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    upsertIndexedSession(entry = {}) {
        const agentId = String(entry.agentId || '').trim();
        const sessionId = String(entry.sessionId || '').trim();
        if (!agentId || !sessionId) {
            throw new Error('agentId and sessionId are required');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previous = this.getSession(sessionKey, { includeSnapshot: true });
        const seenAt = typeof entry.seenAt === 'string' && entry.seenAt.trim()
            ? entry.seenAt.trim()
            : this.now();
        const initialActivityAt = !previous && !String(entry.updatedAt || '').trim()
            ? seenAt
            : '';
        const upstreamUpdatedAt = maxIso(
            previous?.upstreamUpdatedAt,
            entry.updatedAt
        );
        const lastActivityAt = maxIso(
            previous?.lastActivityAt,
            upstreamUpdatedAt,
            initialActivityAt
        );
        const next = {
            sessionKey,
            agentId,
            sessionId,
            cwd: String(entry.cwd || previous?.cwd || '').trim(),
            title: typeof entry.title === 'string'
                ? entry.title
                : (previous?.title || ''),
            upstreamUpdatedAt,
            lastActivityAt,
            lastSeenAt: seenAt,
            lastAttachedAt: previous?.lastAttachedAt || '',
            lastLoadedAt: previous?.lastLoadedAt || '',
            lastLiveAt: previous?.lastLiveAt || '',
            lastReceivedAt: previous?.lastReceivedAt || '',
            lastDetachedAt: previous?.lastDetachedAt || '',
            continuityState: previous?.continuityState || 'cold',
            hotRank: previous?.hotRank ?? null,
            status: previous?.status || '',
            busy: previous?.busy || false,
            errorMessage: previous?.errorMessage || '',
            messageCount: previous?.messageCount || 0,
            toolCallCount: previous?.toolCallCount || 0,
            isPresent: true,
            snapshotVersion: previous?.snapshotVersion || 0,
            snapshotJson: previous?.snapshot
                ? JSON.stringify(previous.snapshot)
                : ''
        };
        this.#writeSession(next);
        const record = this.getSession(sessionKey, { includeSnapshot: true });
        return {
            created: !previous,
            previous,
            changed: sessionChanged(previous, record),
            record
        };
    }

    saveObservedSession(snapshot, options = {}) {
        const rawSnapshot = cloneSerializable(snapshot, null);
        const agentId = String(rawSnapshot?.agentId || '').trim();
        const sessionId = String(rawSnapshot?.acpSessionId || '').trim();
        if (!agentId || !sessionId || !rawSnapshot) {
            throw new Error('Observed snapshot must include agentId and sessionId');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previousRow = this.#getSessionRow(sessionKey);
        const previous = rowToSession(previousRow, true);
        const mergedSnapshot = mergeObservedSnapshot(
            previous?.snapshot || null,
            rawSnapshot,
            options
        );
        const observedAt = typeof options.observedAt === 'string'
            && options.observedAt.trim()
            ? options.observedAt.trim()
            : this.now();
        const loadedAt = typeof options.loadedAt === 'string'
            ? options.loadedAt.trim()
            : '';
        const attachedAt = typeof options.attachedAt === 'string'
            ? options.attachedAt.trim()
            : '';
        const liveAt = typeof options.liveAt === 'string'
            ? options.liveAt.trim()
            : observedAt;
        const safeSnapshot = mergePlanState(
            previous?.snapshot || null,
            mergedSnapshot,
            observedAt
        );
        const timelineRows = buildTimelineRowsFromSnapshot(
            sessionKey,
            safeSnapshot,
            observedAt
        );
        if (previous) {
            this.#ensureTimelineIndexes(sessionKey);
        }
        const previousTimelineRows = previous ? this.#getTimelineRows(sessionKey) : [];
        const timelineDelta = buildTimelineDelta(
            previousTimelineRows,
            timelineRows,
            {
                authoritativeSnapshot: options.authoritativeSnapshot === true
            }
        );
        const receivedAt = typeof options.receivedAt === 'string'
            && options.receivedAt.trim()
            ? options.receivedAt.trim()
            : (timelineRows.length > 0 ? observedAt : '');
        const snapshotJson = JSON.stringify(safeSnapshot);
        const previousSnapshotJson = String(previousRow?.snapshot_json || '');
        const snapshotChanged = !previous || previousSnapshotJson !== snapshotJson;
        const snapshotVersion = Number(previous?.snapshotVersion || 0)
            + (snapshotChanged || timelineDelta.changed ? 1 : 0);
        const next = {
            sessionKey,
            agentId,
            sessionId,
            cwd: String(safeSnapshot.cwd || previous?.cwd || '').trim(),
            title: typeof safeSnapshot.title === 'string'
                ? safeSnapshot.title
                : (previous?.title || ''),
            upstreamUpdatedAt: maxIso(
                previous?.upstreamUpdatedAt,
                options.upstreamUpdatedAt
            ),
            lastActivityAt: maxIso(
                previous?.lastActivityAt,
                observedAt,
                liveAt,
                loadedAt,
                attachedAt
            ),
            lastSeenAt: maxIso(previous?.lastSeenAt, observedAt),
            lastAttachedAt: maxIso(previous?.lastAttachedAt, attachedAt),
            lastLoadedAt: maxIso(previous?.lastLoadedAt, loadedAt),
            lastLiveAt: maxIso(previous?.lastLiveAt, liveAt),
            lastReceivedAt: maxIso(previous?.lastReceivedAt, receivedAt),
            lastDetachedAt: previous?.lastDetachedAt || '',
            continuityState: String(
                options.continuityState
                || previous?.continuityState
                || 'cached'
            ),
            hotRank: previous?.hotRank ?? null,
            status: String(safeSnapshot.status || previous?.status || ''),
            busy: !!safeSnapshot.busy,
            errorMessage: String(
                safeSnapshot.errorMessage || previous?.errorMessage || ''
            ),
            messageCount: Array.isArray(safeSnapshot.messages)
                ? safeSnapshot.messages.length
                : 0,
            toolCallCount: Array.isArray(safeSnapshot.toolCalls)
                ? safeSnapshot.toolCalls.length
                : 0,
            isPresent: options.isPresent === false
                ? false
                : (previous?.isPresent ?? true),
            snapshotVersion,
            snapshotJson
        };
        this.#writeSession(next);
        if (options.authoritativeSnapshot === true) {
            this.#replaceTimelineRows(sessionKey, timelineRows);
        } else {
            if (!timelineRows.some((row) => row.itemKey === 'plan:active-plan')) {
                this.#deleteTimelineItems(sessionKey, ['plan:active-plan']);
            }
            this.#upsertTimelineRows(timelineRows);
        }
        const record = this.getSession(sessionKey, { includeSnapshot: true });
        return {
            created: !previous,
            previous,
            changed: sessionChanged(previous, record),
            record,
            timelineDelta: {
                ...timelineDelta,
                snapshotVersion: record.snapshotVersion
            }
        };
    }

    markSessionInterest(entry = {}) {
        const agentId = String(entry.agentId || '').trim();
        const sessionId = String(entry.sessionId || '').trim();
        if (!agentId || !sessionId) {
            throw new Error('agentId and sessionId are required');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previous = this.getSession(sessionKey, { includeSnapshot: true });
        const next = {
            sessionKey,
            agentId,
            sessionId,
            cwd: String(entry.cwd || previous?.cwd || '').trim(),
            title: typeof entry.title === 'string'
                ? entry.title
                : (previous?.title || ''),
            upstreamUpdatedAt: previous?.upstreamUpdatedAt || '',
            lastActivityAt: previous?.lastActivityAt || '',
            lastSeenAt: previous?.lastSeenAt || '',
            lastAttachedAt: previous?.lastAttachedAt || '',
            lastLoadedAt: previous?.lastLoadedAt || '',
            lastLiveAt: previous?.lastLiveAt || '',
            lastReceivedAt: previous?.lastReceivedAt || '',
            lastDetachedAt: previous?.lastDetachedAt || '',
            continuityState: previous?.continuityState || 'cold',
            hotRank: previous?.hotRank ?? null,
            status: previous?.status || '',
            busy: previous?.busy || false,
            errorMessage: previous?.errorMessage || '',
            messageCount: previous?.messageCount || 0,
            toolCallCount: previous?.toolCallCount || 0,
            isPresent: previous?.isPresent ?? true,
            snapshotVersion: previous?.snapshotVersion || 0,
            snapshotJson: previous?.snapshot
                ? JSON.stringify(previous.snapshot)
                : ''
        };
        this.#writeSession(next);
        const record = this.getSession(sessionKey, { includeSnapshot: true });
        return {
            created: !previous,
            previous,
            changed: sessionChanged(previous, record),
            record
        };
    }

    updateContinuityState(sessionKey, continuityState, options = {}) {
        const previous = this.getSession(sessionKey, { includeSnapshot: true });
        if (!previous) {
            return null;
        }
        const next = {
            ...previous,
            continuityState: String(continuityState || previous.continuityState),
            lastAttachedAt: maxIso(previous.lastAttachedAt, options.attachedAt),
            lastLoadedAt: maxIso(previous.lastLoadedAt, options.loadedAt),
            lastLiveAt: maxIso(previous.lastLiveAt, options.liveAt),
            lastReceivedAt: maxIso(
                previous.lastReceivedAt,
                options.receivedAt
            ),
            lastDetachedAt: maxIso(
                previous.lastDetachedAt,
                options.detachedAt
            ),
            lastActivityAt: maxIso(previous.lastActivityAt, options.activityAt),
            status: typeof options.status === 'string'
                ? options.status
                : previous.status,
            busy: typeof options.busy === 'boolean'
                ? options.busy
                : previous.busy,
            errorMessage: typeof options.errorMessage === 'string'
                ? options.errorMessage
                : previous.errorMessage,
            snapshotJson: previous.snapshot
                ? JSON.stringify(previous.snapshot)
                : ''
        };
        this.#writeSession(next);
        return this.getSession(sessionKey, { includeSnapshot: true });
    }

    reconcileAgentPresence(agentId, seenSessionKeys = [], reconciledAt = this.now()) {
        const rows = this.listSessions({ agentId, includeSnapshot: true });
        const seen = new Set(seenSessionKeys);
        const missing = [];
        for (const row of rows) {
            if (!row.isPresent || seen.has(row.sessionKey)) {
                continue;
            }
            const next = {
                ...row,
                isPresent: false,
                lastSeenAt: reconciledAt,
                lastReceivedAt: row.lastReceivedAt || '',
                lastDetachedAt: row.lastDetachedAt || '',
                snapshotJson: row.snapshot ? JSON.stringify(row.snapshot) : ''
            };
            this.#writeSession(next);
            missing.push(
                this.getSession(row.sessionKey, { includeSnapshot: true })
            );
        }
        return missing;
    }

    setHotSessionKeys(sessionKeys = []) {
        const db = this.#requireDb();
        const normalized = sessionKeys
            .map((key) => String(key || '').trim())
            .filter(Boolean);
        db.exec('BEGIN');
        try {
            db.prepare(`
                UPDATE acp_bus_sessions
                SET hot_rank = NULL
            `).run();
            const update = db.prepare(`
                UPDATE acp_bus_sessions
                SET hot_rank = ?
                WHERE session_key = ?
            `);
            normalized.forEach((sessionKey, index) => {
                update.run(index, sessionKey);
            });
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    listSessions(options = {}) {
        const db = this.#requireDb();
        const clauses = [];
        const params = [];
        if (options.agentId) {
            clauses.push('agent_id = ?');
            params.push(String(options.agentId).trim());
        }
        if (options.presentOnly) {
            clauses.push('is_present = 1');
        }
        if (options.hotOnly) {
            clauses.push('hot_rank IS NOT NULL');
        }
        const whereClause = clauses.length > 0
            ? `WHERE ${clauses.join(' AND ')}`
            : '';
        const limitClause = Number.isFinite(options.limit) && options.limit > 0
            ? `LIMIT ${Math.floor(options.limit)}`
            : '';
        const rows = db.prepare(`
            SELECT *
            FROM acp_bus_sessions
            ${whereClause}
            ORDER BY
                CASE WHEN hot_rank IS NULL THEN 1 ELSE 0 END ASC,
                hot_rank ASC,
                upstream_updated_at DESC,
                last_activity_at DESC,
                last_seen_at DESC,
                title COLLATE NOCASE ASC
            ${limitClause}
        `).all(...params);
        return rows.map((row) =>
            rowToSession(row, options.includeSnapshot === true)
        );
    }

    listMostActiveSessions(limit, options = {}) {
        const db = this.#requireDb();
        const safeLimit = Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 10;
        const clauses = [];
        const params = [];
        if (options.presentOnly !== false) {
            clauses.push('is_present = 1');
        }
        const whereClause = clauses.length > 0
            ? `WHERE ${clauses.join(' AND ')}`
            : '';
        const rows = db.prepare(`
            SELECT *
            FROM acp_bus_sessions
            ${whereClause}
            ORDER BY
                upstream_updated_at DESC,
                last_activity_at DESC,
                last_seen_at DESC,
                title COLLATE NOCASE ASC
            LIMIT ${safeLimit}
        `).all(...params);
        return rows.map((row) => rowToSession(row, options.includeSnapshot === true));
    }

    listHotCandidates(limit, options = {}) {
        const db = this.#requireDb();
        const safeLimit = Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 10;
        const clauses = [];
        if (options.presentOnly !== false) {
            clauses.push('is_present = 1');
        }
        const whereClause = clauses.length > 0
            ? `WHERE ${clauses.join(' AND ')}`
            : '';
        const rows = db.prepare(`
            SELECT *
            FROM acp_bus_sessions
            ${whereClause}
            ORDER BY
                upstream_updated_at DESC,
                last_activity_at DESC,
                last_seen_at DESC,
                title COLLATE NOCASE ASC
            LIMIT ${safeLimit}
        `).all();
        return rows.map((row) =>
            rowToSession(row, options.includeSnapshot === true)
        );
    }

    listHotSessions(limit, options = {}) {
        const db = this.#requireDb();
        const limitClause = Number.isFinite(limit) && limit > 0
            ? `LIMIT ${Math.floor(limit)}`
            : '';
        const rows = db.prepare(`
            SELECT *
            FROM acp_bus_sessions
            WHERE hot_rank IS NOT NULL
            ORDER BY hot_rank ASC
            ${limitClause}
        `).all();
        return rows.map((row) => rowToSession(row, options.includeSnapshot === true));
    }

    pruneSessions(limit, preserveKeys = []) {
        const db = this.#requireDb();
        const safeLimit = Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 1000;
        const preserved = new Set(
            preserveKeys.map((key) => String(key || '').trim()).filter(Boolean)
        );
        const rows = this.listMostActiveSessions(safeLimit, {
            presentOnly: false,
            includeSnapshot: false
        });
        const keep = new Set();
        for (const row of rows) {
            keep.add(row.sessionKey);
        }
        for (const key of preserved) {
            keep.add(key);
        }
        const deleted = [];
        const allRows = this.listSessions({ includeSnapshot: false });
        const remove = db.prepare(`
            DELETE FROM acp_bus_sessions
            WHERE session_key = ?
        `);
        const removeTimeline = db.prepare(`
            DELETE FROM acp_bus_timeline_items
            WHERE session_key = ?
        `);
        for (const row of allRows) {
            if (row.hotRank !== null || keep.has(row.sessionKey)) {
                continue;
            }
            remove.run(row.sessionKey);
            removeTimeline.run(row.sessionKey);
            deleted.push(row);
        }
        return deleted;
    }

    listTimelineItems(sessionKey, options = {}) {
        const db = this.#requireDb();
        const normalizedSessionKey = String(sessionKey || '').trim();
        if (!normalizedSessionKey) {
            return {
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
        this.#ensureTimelineIndexes(normalizedSessionKey);
        const safeLimit = Number.isFinite(options.limit)
            ? Math.min(200, Math.max(1, Math.floor(options.limit)))
            : 30;
        const before = decodeTimelineCursor(options.before);
        const after = decodeTimelineCursor(options.after);
        let rows = [];
        if (before) {
            rows = db.prepare(`
                SELECT *
                FROM acp_bus_timeline_items
                WHERE session_key = ?
                    AND (
                        item_index < ?
                        OR (item_index = ? AND item_key < ?)
                    )
                ORDER BY item_index DESC, item_key DESC
                LIMIT ?
            `).all(
                normalizedSessionKey,
                before.index,
                before.index,
                before.key,
                safeLimit
            ).reverse();
        } else if (after) {
            rows = db.prepare(`
                SELECT *
                FROM acp_bus_timeline_items
                WHERE session_key = ?
                    AND (
                        item_index > ?
                        OR (item_index = ? AND item_key > ?)
                    )
                ORDER BY item_index ASC, item_key ASC
                LIMIT ?
            `).all(
                normalizedSessionKey,
                after.index,
                after.index,
                after.key,
                safeLimit
            );
        } else {
            rows = db.prepare(`
                SELECT *
                FROM acp_bus_timeline_items
                WHERE session_key = ?
                ORDER BY item_index DESC, item_key DESC
                LIMIT ?
            `).all(normalizedSessionKey, safeLimit).reverse();
        }
        const total = Number(db.prepare(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
            WHERE session_key = ?
        `).get(normalizedSessionKey)?.count || 0);
        const bounds = db.prepare(`
            SELECT
                MIN(item_index) AS min_index,
                MAX(item_index) AS max_index
            FROM acp_bus_timeline_items
            WHERE session_key = ?
        `).get(normalizedSessionKey) || {};
        const minIndex = Number(bounds.min_index || 0);
        const maxIndex = Number(bounds.max_index || 0);
        const first = rows[0] || null;
        const last = rows.at(-1) || null;
        const hasOlder = first ? Number(db.prepare(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
            WHERE session_key = ?
                AND (
                    item_index < ?
                    OR (item_index = ? AND item_key < ?)
                )
        `).get(
            normalizedSessionKey,
            first.item_index,
            first.item_index,
            first.item_key
        )?.count || 0) > 0 : false;
        const hasNewer = last ? Number(db.prepare(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
            WHERE session_key = ?
                AND (
                    item_index > ?
                    OR (item_index = ? AND item_key > ?)
                )
        `).get(
            normalizedSessionKey,
            last.item_index,
            last.item_index,
            last.item_key
        )?.count || 0) > 0 : false;
        return {
            items: rows.map((row) => timelineRowToItem(row)),
            total,
            hasOlder,
            hasNewer,
            minIndex,
            maxIndex,
            firstIndex: Number(first?.item_index || 0),
            lastIndex: Number(last?.item_index || 0),
            prevCursor: encodeTimelineCursor(first),
            nextCursor: encodeTimelineCursor(last)
        };
    }

    appendEvent(event = {}) {
        const db = this.#requireDb();
        const createdAt = typeof event.createdAt === 'string'
            && event.createdAt.trim()
            ? event.createdAt.trim()
            : this.now();
        const payload = cloneSerializable(event.payload, {});
        const eventRecord = {
            createdAt,
            type: String(event.type || '').trim(),
            agentId: String(event.agentId || '').trim(),
            sessionId: String(event.sessionId || '').trim(),
            payload
        };
        db.prepare(`
            INSERT INTO acp_bus_events (
                created_at,
                type,
                agent_id,
                session_id,
                payload_json
            ) VALUES (?, ?, ?, ?, ?)
        `).run(
            eventRecord.createdAt,
            eventRecord.type,
            eventRecord.agentId,
            eventRecord.sessionId,
            JSON.stringify(eventRecord.payload)
        );
        const row = db.prepare(`
            SELECT last_insert_rowid() AS id
        `).get();
        db.prepare(`
            DELETE FROM acp_bus_events
            WHERE id NOT IN (
                SELECT id
                FROM acp_bus_events
                ORDER BY id DESC
                LIMIT ?
            )
        `).run(this.eventLimit);
        return {
            id: Number(row?.id || 0),
            ...eventRecord
        };
    }

    listEvents(limit = 100) {
        const db = this.#requireDb();
        const safeLimit = Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 100;
        const rows = db.prepare(`
            SELECT *
            FROM acp_bus_events
            ORDER BY id DESC
            LIMIT ?
        `).all(safeLimit);
        return rows.map((row) => ({
            id: Number(row.id),
            createdAt: String(row.created_at || ''),
            type: String(row.type || ''),
            agentId: String(row.agent_id || ''),
            sessionId: String(row.session_id || ''),
            payload: parseJsonText(row.payload_json, {})
        }));
    }

    getSummary() {
        const db = this.#requireDb();
        const sessionCount = db.prepare(`
            SELECT COUNT(*) AS count
            FROM acp_bus_sessions
        `).get().count;
        const hotCount = db.prepare(`
            SELECT COUNT(*) AS count
            FROM acp_bus_sessions
            WHERE hot_rank IS NOT NULL
        `).get().count;
        const eventCount = db.prepare(`
            SELECT COUNT(*) AS count
            FROM acp_bus_events
        `).get().count;
        const timelineItemCount = db.prepare(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
        `).get().count;
        return {
            dbPath: this.dbPath,
            sessionCount,
            hotCount,
            timelineItemCount,
            eventCount
        };
    }
}
