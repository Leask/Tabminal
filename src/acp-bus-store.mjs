import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { AsyncDatabaseSync } from './sqlite.mjs';

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

function getTimelineItemIdentity(type, value, fallbackIndex) {
    const index = Number.isFinite(fallbackIndex) ? fallbackIndex : 0;
    const order = Number(value?.order);
    const orderIdentity = Number.isFinite(order) ? `order:${order}` : '';
    if (type === 'message') {
        return String(
            value?.id
            || value?.messageId
            || value?.streamKey
            || orderIdentity
            || `message-${index}`
        );
    }
    if (type === 'tool') {
        return String(
            value?.toolCallId
            || value?.id
            || orderIdentity
            || `tool-${index}`
        );
    }
    if (type === 'permission') {
        return String(value?.id || orderIdentity || `permission-${index}`);
    }
    if (type === 'plan') {
        return String(value?.id || orderIdentity || `plan-${index}`);
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
        const nextItem = cloneSerializable(item, {}) || {};
        const previousItem = merged.get(key);
        if (
            previousItem
            && Number.isFinite(previousItem.index)
            && !Number.isFinite(nextItem.index)
        ) {
            nextItem.index = previousItem.index;
        }
        merged.set(key, nextItem);
    }
    return Array.from(merged.values());
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
                    : 'pending'
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

function buildPlanHistoryEntry(entries, observedAt, options = {}) {
    const normalizedEntries = normalizePlanEntries(entries);
    const completed = isPlanComplete(normalizedEntries);
    return {
        id: String(options.id || `plan-${hashSerializable({
            entries: normalizedEntries,
            observedAt
        })}`),
        active: !completed,
        status: completed ? 'completed' : 'active',
        createdAt: String(options.createdAt || observedAt || ''),
        summary: options.summary || '',
        entries: normalizedEntries
    };
}

function mergePlanState(previousSnapshot, nextSnapshot, observedAt, options = {}) {
    const authoritative = options.authoritativeSnapshot === true;
    const previousHistory = !authoritative && Array.isArray(previousSnapshot?.planHistory)
        ? cloneSerializable(previousSnapshot.planHistory, [])
        : [];
    const nextHistory = Array.isArray(nextSnapshot?.planHistory)
        ? cloneSerializable(nextSnapshot.planHistory, [])
        : [];
    const history = new Map();
    for (const item of [...previousHistory, ...nextHistory]) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || `plan-${hashSerializable(item.entries || [])}`);
        const index = Number.isFinite(item.index) ? Number(item.index) : undefined;
        history.set(id, {
            ...item,
            id,
            active: false,
            status: item.status || 'completed',
            entries: normalizePlanEntries(item.entries)
        });
        if (Number.isFinite(index)) {
            history.get(id).index = index;
        }
        delete history.get(id).order;
    }
    const plan = normalizePlanEntries(nextSnapshot?.plan);
    if (plan.length > 0) {
        const activeHistory = Array.from(history.values()).find((item) => {
            const status = String(item?.status || '').toLowerCase();
            return item?.active === true
                || status === 'active'
                || status === 'pending'
                || status === 'running'
                || status === 'in_progress';
        });
        const entry = buildPlanHistoryEntry(
            plan,
            observedAt,
            {
                id: activeHistory?.id,
                createdAt: activeHistory?.createdAt,
                summary: activeHistory?.summary
            }
        );
        history.set(entry.id, entry);
    }
    return {
        ...nextSnapshot,
        plan,
        planHistory: Array.from(history.values())
    };
}

function buildPreviousTimelineIndex(rows = []) {
    const map = new Map();
    let maxIndex = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const itemKey = String(row?.item_key || row?.itemKey || '').trim();
        const itemIndex = Number(row?.item_index || row?.itemIndex || 0);
        if (!itemKey || !Number.isFinite(itemIndex) || itemIndex <= 0) {
            continue;
        }
        map.set(itemKey, itemIndex);
        maxIndex = Math.max(maxIndex, itemIndex);
    }
    return { map, maxIndex };
}

function finalizeTimelineRows(rows, options = {}) {
    const authoritative = options.authoritativeSnapshot === true;
    const previousIndex = buildPreviousTimelineIndex(options.previousRows);
    const hasPrevious = previousIndex.map.size > 0;
    let nextIndex = previousIndex.maxIndex + 1;
    const sorted = [...rows].sort((left, right) => {
        if (authoritative) {
            return left.sequence - right.sequence;
        }
        const leftExisting = !authoritative
            ? previousIndex.map.get(left.itemKey)
            : undefined;
        const rightExisting = !authoritative
            ? previousIndex.map.get(right.itemKey)
            : undefined;
        if (leftExisting && rightExisting && leftExisting !== rightExisting) {
            return leftExisting - rightExisting;
        }
        if (leftExisting || rightExisting) {
            return leftExisting ? -1 : 1;
        }
        return left.sequence - right.sequence;
    });
    const finalized = sorted.map((row, index) => {
        const previousItemIndex = !authoritative
            ? previousIndex.map.get(row.itemKey)
            : undefined;
        const itemIndex = previousItemIndex || (
            authoritative || !hasPrevious
                ? index + 1
                : nextIndex++
        );
        const value = parseJsonText(row.payloadJson, {});
        const payload = value && typeof value === 'object'
            ? { ...value, index: itemIndex }
            : value;
        if (payload && typeof payload === 'object') {
            delete payload.order;
        }
        const cleanedRow = { ...row };
        delete cleanedRow.sequence;
        return {
            ...cleanedRow,
            itemIndex,
            payloadJson: JSON.stringify(payload)
        };
    });
    return finalized.sort(compareTimelineRows);
}

function applyTimelineIndexesToSnapshot(snapshot, rows = []) {
    const next = cloneSerializable(snapshot, snapshot || {});
    if (!next || typeof next !== 'object') {
        return next;
    }
    const indexByKey = new Map(
        rows.map((row) => [String(row.itemKey || ''), Number(row.itemIndex || 0)])
    );
    for (const [key, type] of [
        ['messages', 'message'],
        ['toolCalls', 'tool'],
        ['permissions', 'permission'],
        ['planHistory', 'plan']
    ]) {
        if (!Array.isArray(next[key])) {
            continue;
        }
        next[key] = next[key].map((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                return entry;
            }
            const identity = getTimelineItemIdentity(type, entry, index);
            const itemIndex = indexByKey.get(`${type}:${identity}`);
            const cleaned = { ...entry };
            if (Number.isFinite(itemIndex) && itemIndex > 0) {
                cleaned.index = itemIndex;
            }
            delete cleaned.order;
            return cleaned;
        });
    }
    if (Array.isArray(next.plan)) {
        next.plan = normalizePlanEntries(next.plan);
    }
    delete next.timelineItems;
    return next;
}

function normalizeTimelineCandidate(raw, fallbackIndex) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const type = String(raw.type || raw.itemType || '').trim();
    const value = raw.value && typeof raw.value === 'object'
        ? raw.value
        : raw.payload && typeof raw.payload === 'object'
            ? raw.payload
            : raw.item && typeof raw.item === 'object'
                ? raw.item
                : null;
    if (!type || !value) {
        return null;
    }
    return {
        type,
        value: cloneSerializable(value, {}) || {},
        fallbackIndex
    };
}

function buildTimelineCandidates(snapshot) {
    const candidates = [];
    const pushItem = (type, item, fallbackIndex) => {
        if (!item || typeof item !== 'object') {
            return;
        }
        candidates.push({
            type,
            value: cloneSerializable(item, {}) || {},
            fallbackIndex
        });
    };
    const timelineItems = Array.isArray(snapshot?.timelineItems)
        ? snapshot.timelineItems
        : [];
    if (timelineItems.length > 0) {
        for (const [index, item] of timelineItems.entries()) {
            const candidate = normalizeTimelineCandidate(item, index);
            if (candidate) {
                candidates.push(candidate);
            }
        }
        for (const [index, item] of (snapshot?.planHistory || []).entries()) {
            pushItem('plan', item, index);
        }
        return candidates;
    }
    for (const [index, item] of (snapshot?.messages || []).entries()) {
        pushItem('message', item, index);
    }
    for (const [index, item] of (snapshot?.toolCalls || []).entries()) {
        pushItem('tool', item, index);
    }
    for (const [index, item] of (snapshot?.permissions || []).entries()) {
        pushItem('permission', item, index);
    }
    for (const [index, item] of (snapshot?.planHistory || []).entries()) {
        pushItem('plan', item, index);
    }
    return candidates;
}

function buildTimelineRowsFromSnapshot(
    sessionKey,
    snapshot,
    observedAt,
    options = {}
) {
    const rows = [];
    for (const candidate of buildTimelineCandidates(snapshot)) {
        const value = cloneSerializable(candidate.value, {}) || {};
        const identity = getTimelineItemIdentity(
            candidate.type,
            value,
            candidate.fallbackIndex
        );
        const itemKey = `${candidate.type}:${identity}`;
        const sequence = rows.length + 1;
        rows.push({
            sessionKey,
            itemKey,
            itemType: candidate.type,
            itemId: identity,
            itemIndex: sequence,
            role: String(value.role || ''),
            kind: String(value.kind || ''),
            status: String(value.status || ''),
            updatedAt: observedAt,
            payloadJson: JSON.stringify(value),
            sequence
        });
    }
    return finalizeTimelineRows(rows, options);
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
        this.db = new AsyncDatabaseSync(this.dbPath);
        await this.db.open();
        await this.db.exec(`
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
        await this.#ensureColumn(
            'acp_bus_sessions',
            'last_received_at',
            "TEXT NOT NULL DEFAULT ''"
        );
        await this.#ensureColumn(
            'acp_bus_sessions',
            'last_detached_at',
            "TEXT NOT NULL DEFAULT ''"
        );
        await this.#ensureColumn(
            'acp_bus_sessions',
            'snapshot_version',
            'INTEGER NOT NULL DEFAULT 0'
        );
        await this.#ensureTimelineIndexColumn();
    }

    async close() {
        if (!this.db) {
            return;
        }
        await this.db.close();
        this.db = null;
    }

    #requireDb() {
        if (!this.db) {
            throw new Error('ACP bus store not initialized');
        }
        return this.db;
    }

    async #ensureColumn(tableName, columnName, definition) {
        const db = this.#requireDb();
        const columns = await db.all(`PRAGMA table_info(${tableName})`);
        if (columns.some((column) => column.name === columnName)) {
            return;
        }
        await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }

    async #ensureTimelineIndexColumn() {
        const db = this.#requireDb();
        const columns = await db.all(`
            PRAGMA table_info(acp_bus_timeline_items)
        `);
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
        await db.exec('DROP INDEX IF EXISTS idx_acp_bus_timeline_order');
        if (hasItemIndex && hasIntegerIndex && !hasItemOrder) {
            await db.exec(`
                CREATE INDEX IF NOT EXISTS idx_acp_bus_timeline_index
                    ON acp_bus_timeline_items(session_key, item_index, item_key)
            `);
            return;
        }
        const sourceIndexColumn = hasItemIndex ? 'item_index' : 'item_order';
        await db.transaction([
            {
                type: 'exec',
                sql: `
                    ALTER TABLE acp_bus_timeline_items
                    RENAME TO acp_bus_timeline_items_legacy
                `
            },
            {
                type: 'exec',
                sql: `
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
                `
            },
            {
                type: 'exec',
                sql: `
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
                `
            },
            {
                type: 'exec',
                sql: 'DROP TABLE acp_bus_timeline_items_legacy'
            }
        ]);
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_acp_bus_timeline_index
                ON acp_bus_timeline_items(session_key, item_index, item_key)
        `);
    }

    async #getSessionRow(sessionKey) {
        const db = this.#requireDb();
        return await db.get(`
            SELECT *
            FROM acp_bus_sessions
            WHERE session_key = ?
        `, [sessionKey]) || null;
    }

    async getSession(sessionKey, options = {}) {
        const row = await this.#getSessionRow(sessionKey);
        return rowToSession(row, options.includeSnapshot === true);
    }

    async getSessionByIdentity(agentId, sessionId, options = {}) {
        return await this.getSession(
            buildAcpBusSessionKey(agentId, sessionId),
            options
        );
    }

    async #writeSession(record) {
        const db = this.#requireDb();
        await db.run(`
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
        `, {
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

    async #upsertTimelineRows(rows = []) {
        if (!Array.isArray(rows) || rows.length === 0) {
            return;
        }
        const db = this.#requireDb();
        const sql = `
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
        `;
        await db.transaction(rows.map((row) => ({
            type: 'run',
            sql,
            params: row
        })));
    }

    async #replaceTimelineRows(sessionKey, rows = []) {
        const db = this.#requireDb();
        const insertSql = `
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
        `;
        const operations = [{
            type: 'run',
            sql: `
                DELETE FROM acp_bus_timeline_items
                WHERE session_key = ?
            `,
            params: [sessionKey]
        }];
        for (const row of Array.isArray(rows) ? rows : []) {
            operations.push({
                type: 'run',
                sql: insertSql,
                params: row
            });
        }
        await db.transaction(operations);
    }

    async #getTimelineRows(sessionKey) {
        const db = this.#requireDb();
        return await db.all(`
            SELECT *
            FROM acp_bus_timeline_items
            WHERE session_key = ?
            ORDER BY item_index ASC, item_key ASC
        `, [String(sessionKey || '').trim()]);
    }

    async #ensureTimelineIndexes(sessionKey) {
        const db = this.#requireDb();
        const bounds = await db.get(`
            SELECT
                COUNT(*) AS count,
                COUNT(DISTINCT item_index) AS distinct_count,
                MIN(item_index) AS min_index,
                MAX(item_index) AS max_index,
                SUM(item_index) AS sum_index
            FROM acp_bus_timeline_items
            WHERE session_key = ?
        `, [sessionKey]) || {};
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
        const rows = await db.all(`
            SELECT item_key, item_index, payload_json
            FROM acp_bus_timeline_items
            WHERE session_key = ?
            ORDER BY item_index ASC, item_key ASC
        `, [sessionKey]);
        const updateSql = `
            UPDATE acp_bus_timeline_items
            SET item_index = ?, payload_json = ?
            WHERE session_key = ? AND item_key = ?
        `;
        const operations = rows.map((row, index) => {
            const itemIndex = index + 1;
            const value = parseJsonText(row.payload_json, {});
            const payload = value && typeof value === 'object'
                ? { ...value, index: itemIndex }
                : value;
            if (payload && typeof payload === 'object') {
                delete payload.order;
            }
            return {
                type: 'run',
                sql: updateSql,
                params: [
                    itemIndex,
                    JSON.stringify(payload),
                    sessionKey,
                    row.item_key
                ]
            };
        });
        await db.transaction(operations);
    }

    async upsertIndexedSession(entry = {}) {
        const agentId = String(entry.agentId || '').trim();
        const sessionId = String(entry.sessionId || '').trim();
        if (!agentId || !sessionId) {
            throw new Error('agentId and sessionId are required');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previous = await this.getSession(sessionKey, {
            includeSnapshot: true
        });
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
        await this.#writeSession(next);
        const record = await this.getSession(sessionKey, {
            includeSnapshot: true
        });
        return {
            created: !previous,
            previous,
            changed: sessionChanged(previous, record),
            record
        };
    }

    async saveObservedSession(snapshot, options = {}) {
        const rawSnapshot = cloneSerializable(snapshot, null);
        const agentId = String(rawSnapshot?.agentId || '').trim();
        const sessionId = String(rawSnapshot?.acpSessionId || '').trim();
        if (!agentId || !sessionId || !rawSnapshot) {
            throw new Error('Observed snapshot must include agentId and sessionId');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previousRow = await this.#getSessionRow(sessionKey);
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
        if (previous) {
            await this.#ensureTimelineIndexes(sessionKey);
        }
        const previousTimelineRows = previous
            ? await this.#getTimelineRows(sessionKey)
            : [];
        const indexedSnapshot = mergePlanState(
            previous?.snapshot || null,
            mergedSnapshot,
            observedAt,
            {
                authoritativeSnapshot: options.authoritativeSnapshot === true
            }
        );
        const timelineRows = buildTimelineRowsFromSnapshot(
            sessionKey,
            indexedSnapshot,
            observedAt,
            {
                previousRows: previousTimelineRows,
                authoritativeSnapshot: options.authoritativeSnapshot === true
            }
        );
        const safeSnapshot = applyTimelineIndexesToSnapshot(
            indexedSnapshot,
            timelineRows
        );
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
        await this.#writeSession(next);
        if (options.authoritativeSnapshot === true) {
            await this.#replaceTimelineRows(sessionKey, timelineRows);
        } else {
            await this.#upsertTimelineRows(timelineRows);
        }
        const record = await this.getSession(sessionKey, {
            includeSnapshot: true
        });
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

    async markSessionInterest(entry = {}) {
        const agentId = String(entry.agentId || '').trim();
        const sessionId = String(entry.sessionId || '').trim();
        if (!agentId || !sessionId) {
            throw new Error('agentId and sessionId are required');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previous = await this.getSession(sessionKey, {
            includeSnapshot: true
        });
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
        await this.#writeSession(next);
        const record = await this.getSession(sessionKey, {
            includeSnapshot: true
        });
        return {
            created: !previous,
            previous,
            changed: sessionChanged(previous, record),
            record
        };
    }

    async updateContinuityState(sessionKey, continuityState, options = {}) {
        const previous = await this.getSession(sessionKey, {
            includeSnapshot: true
        });
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
        await this.#writeSession(next);
        return await this.getSession(sessionKey, { includeSnapshot: true });
    }

    async markSessionForUpstreamSync(sessionKey, options = {}) {
        const previous = await this.getSession(sessionKey, {
            includeSnapshot: true
        });
        if (!previous) {
            return null;
        }
        const next = {
            ...previous,
            continuityState: 'resync_required',
            lastLoadedAt: '',
            lastReceivedAt: '',
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
        await this.#writeSession(next);
        return await this.getSession(sessionKey, { includeSnapshot: true });
    }

    async reconcileAgentPresence(
        agentId,
        seenSessionKeys = [],
        reconciledAt = this.now()
    ) {
        const rows = await this.listSessions({
            agentId,
            includeSnapshot: true
        });
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
            await this.#writeSession(next);
            missing.push(
                await this.getSession(row.sessionKey, { includeSnapshot: true })
            );
        }
        return missing;
    }

    async deleteSession(sessionKey) {
        const db = this.#requireDb();
        const normalizedSessionKey = String(sessionKey || '').trim();
        if (!normalizedSessionKey) {
            return null;
        }
        const previous = await this.getSession(normalizedSessionKey, {
            includeSnapshot: true
        });
        if (!previous) {
            return null;
        }
        await db.transaction([
            {
                type: 'run',
                sql: `
                    DELETE FROM acp_bus_timeline_items
                    WHERE session_key = ?
                `,
                params: [normalizedSessionKey]
            },
            {
                type: 'run',
                sql: `
                    DELETE FROM acp_bus_sessions
                    WHERE session_key = ?
                `,
                params: [normalizedSessionKey]
            }
        ]);
        return previous;
    }

    async setHotSessionKeys(sessionKeys = []) {
        const db = this.#requireDb();
        const normalized = sessionKeys
            .map((key) => String(key || '').trim())
            .filter(Boolean);
        const operations = [{
            type: 'run',
            sql: `
                UPDATE acp_bus_sessions
                SET hot_rank = NULL
            `
        }];
        for (const [index, sessionKey] of normalized.entries()) {
            operations.push({
                type: 'run',
                sql: `
                    UPDATE acp_bus_sessions
                    SET hot_rank = ?
                    WHERE session_key = ?
                `,
                params: [index, sessionKey]
            });
        }
        await db.transaction(operations);
    }

    async listSessions(options = {}) {
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
        const rows = await db.all(`
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
        `, params);
        return rows.map((row) =>
            rowToSession(row, options.includeSnapshot === true)
        );
    }

    async listMostActiveSessions(limit, options = {}) {
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
        const rows = await db.all(`
            SELECT *
            FROM acp_bus_sessions
            ${whereClause}
            ORDER BY
                upstream_updated_at DESC,
                last_activity_at DESC,
                last_seen_at DESC,
                title COLLATE NOCASE ASC
            LIMIT ${safeLimit}
        `, params);
        return rows.map((row) =>
            rowToSession(row, options.includeSnapshot === true)
        );
    }

    async listHotCandidates(limit, options = {}) {
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
        const rows = await db.all(`
            SELECT *
            FROM acp_bus_sessions
            ${whereClause}
            ORDER BY
                upstream_updated_at DESC,
                last_activity_at DESC,
                last_seen_at DESC,
                title COLLATE NOCASE ASC
            LIMIT ${safeLimit}
        `);
        return rows.map((row) =>
            rowToSession(row, options.includeSnapshot === true)
        );
    }

    async listColdRepairCandidates(limit, options = {}) {
        const db = this.#requireDb();
        const safeLimit = Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 1;
        const nowMs = Date.parse(
            typeof options.now === 'string' && options.now.trim()
                ? options.now.trim()
                : this.now()
        );
        const minAgeMs = Number.isFinite(options.minAgeMs)
            ? Math.max(0, Math.floor(options.minAgeMs))
            : 10 * 60 * 1000;
        const rows = await db.all(`
            SELECT *
            FROM acp_bus_sessions
            WHERE is_present = 1
            ORDER BY
                CASE
                    WHEN continuity_state = 'resync_required' THEN 0
                    ELSE 1
                END ASC,
                CASE
                    WHEN last_loaded_at = '' AND last_received_at = '' THEN 0
                    ELSE 1
                END ASC,
                last_loaded_at ASC,
                last_received_at ASC,
                upstream_updated_at ASC,
                title COLLATE NOCASE ASC
        `);
        const candidates = [];
        for (const row of rows) {
            const session = rowToSession(
                row,
                options.includeSnapshot === true
            );
            const lastSyncAt = maxIso(
                session.lastLoadedAt,
                session.lastReceivedAt
            );
            const lastSyncMs = Date.parse(lastSyncAt || '');
            const upstreamMs = Date.parse(session.upstreamUpdatedAt || '');
            const neverSynced = !Number.isFinite(lastSyncMs);
            const forced = session.continuityState === 'resync_required';
            if (!forced && session.hotRank !== null) {
                continue;
            }
            if (!forced && !neverSynced) {
                if (Number.isFinite(nowMs) && (nowMs - lastSyncMs) < minAgeMs) {
                    continue;
                }
                if (Number.isFinite(upstreamMs) && upstreamMs <= lastSyncMs) {
                    continue;
                }
            }
            candidates.push(session);
            if (candidates.length >= safeLimit) {
                break;
            }
        }
        return candidates;
    }

    async listHotSessions(limit, options = {}) {
        const db = this.#requireDb();
        const limitClause = Number.isFinite(limit) && limit > 0
            ? `LIMIT ${Math.floor(limit)}`
            : '';
        const rows = await db.all(`
            SELECT *
            FROM acp_bus_sessions
            WHERE hot_rank IS NOT NULL
            ORDER BY hot_rank ASC
            ${limitClause}
        `);
        return rows.map((row) =>
            rowToSession(row, options.includeSnapshot === true)
        );
    }

    async pruneSessions(limit, preserveKeys = []) {
        const db = this.#requireDb();
        const safeLimit = Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 1000;
        const preserved = new Set(
            preserveKeys.map((key) => String(key || '').trim()).filter(Boolean)
        );
        const rows = await this.listMostActiveSessions(safeLimit, {
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
        const allRows = await this.listSessions({ includeSnapshot: false });
        const operations = [];
        for (const row of allRows) {
            if (row.hotRank !== null || keep.has(row.sessionKey)) {
                continue;
            }
            operations.push(
                {
                    type: 'run',
                    sql: `
                        DELETE FROM acp_bus_sessions
                        WHERE session_key = ?
                    `,
                    params: [row.sessionKey]
                },
                {
                    type: 'run',
                    sql: `
                        DELETE FROM acp_bus_timeline_items
                        WHERE session_key = ?
                    `,
                    params: [row.sessionKey]
                }
            );
            deleted.push(row);
        }
        if (operations.length > 0) {
            await db.transaction(operations);
        }
        return deleted;
    }

    async listTimelineItems(sessionKey, options = {}) {
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
        await this.#ensureTimelineIndexes(normalizedSessionKey);
        const safeLimit = Number.isFinite(options.limit)
            ? Math.min(200, Math.max(1, Math.floor(options.limit)))
            : 30;
        const before = decodeTimelineCursor(options.before);
        const after = decodeTimelineCursor(options.after);
        let rows = [];
        if (before) {
            rows = (await db.all(`
                SELECT *
                FROM acp_bus_timeline_items
                WHERE session_key = ?
                    AND (
                        item_index < ?
                        OR (item_index = ? AND item_key < ?)
                    )
                ORDER BY item_index DESC, item_key DESC
                LIMIT ?
            `, [
                normalizedSessionKey,
                before.index,
                before.index,
                before.key,
                safeLimit
            ])).reverse();
        } else if (after) {
            rows = await db.all(`
                SELECT *
                FROM acp_bus_timeline_items
                WHERE session_key = ?
                    AND (
                        item_index > ?
                        OR (item_index = ? AND item_key > ?)
                    )
                ORDER BY item_index ASC, item_key ASC
                LIMIT ?
            `, [
                normalizedSessionKey,
                after.index,
                after.index,
                after.key,
                safeLimit
            ]);
        } else {
            rows = (await db.all(`
                SELECT *
                FROM acp_bus_timeline_items
                WHERE session_key = ?
                ORDER BY item_index DESC, item_key DESC
                LIMIT ?
            `, [normalizedSessionKey, safeLimit])).reverse();
        }
        const total = Number((await db.get(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
            WHERE session_key = ?
        `, [normalizedSessionKey]))?.count || 0);
        const bounds = await db.get(`
            SELECT
                MIN(item_index) AS min_index,
                MAX(item_index) AS max_index
            FROM acp_bus_timeline_items
            WHERE session_key = ?
        `, [normalizedSessionKey]) || {};
        const minIndex = Number(bounds.min_index || 0);
        const maxIndex = Number(bounds.max_index || 0);
        const first = rows[0] || null;
        const last = rows.at(-1) || null;
        const hasOlder = first ? Number((await db.get(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
            WHERE session_key = ?
                AND (
                    item_index < ?
                    OR (item_index = ? AND item_key < ?)
                )
        `, [
            normalizedSessionKey,
            first.item_index,
            first.item_index,
            first.item_key
        ]))?.count || 0) > 0 : false;
        const hasNewer = last ? Number((await db.get(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
            WHERE session_key = ?
                AND (
                    item_index > ?
                    OR (item_index = ? AND item_key > ?)
                )
        `, [
            normalizedSessionKey,
            last.item_index,
            last.item_index,
            last.item_key
        ]))?.count || 0) > 0 : false;
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

    async appendEvent(event = {}) {
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
        await db.run(`
            INSERT INTO acp_bus_events (
                created_at,
                type,
                agent_id,
                session_id,
                payload_json
            ) VALUES (?, ?, ?, ?, ?)
        `, [
            eventRecord.createdAt,
            eventRecord.type,
            eventRecord.agentId,
            eventRecord.sessionId,
            JSON.stringify(eventRecord.payload)
        ]);
        const row = await db.get(`
            SELECT last_insert_rowid() AS id
        `);
        await db.run(`
            DELETE FROM acp_bus_events
            WHERE id NOT IN (
                SELECT id
                FROM acp_bus_events
                ORDER BY id DESC
                LIMIT ?
            )
        `, [this.eventLimit]);
        return {
            id: Number(row?.id || 0),
            ...eventRecord
        };
    }

    async listEvents(limit = 100) {
        const db = this.#requireDb();
        const safeLimit = Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 100;
        const rows = await db.all(`
            SELECT *
            FROM acp_bus_events
            ORDER BY id DESC
            LIMIT ?
        `, [safeLimit]);
        return rows.map((row) => ({
            id: Number(row.id),
            createdAt: String(row.created_at || ''),
            type: String(row.type || ''),
            agentId: String(row.agent_id || ''),
            sessionId: String(row.session_id || ''),
            payload: parseJsonText(row.payload_json, {})
        }));
    }

    async getSummary() {
        const db = this.#requireDb();
        const sessionCount = Number((await db.get(`
            SELECT COUNT(*) AS count
            FROM acp_bus_sessions
        `))?.count || 0);
        const hotCount = Number((await db.get(`
            SELECT COUNT(*) AS count
            FROM acp_bus_sessions
            WHERE hot_rank IS NOT NULL
        `))?.count || 0);
        const eventCount = Number((await db.get(`
            SELECT COUNT(*) AS count
            FROM acp_bus_events
        `))?.count || 0);
        const timelineItemCount = Number((await db.get(`
            SELECT COUNT(*) AS count
            FROM acp_bus_timeline_items
        `))?.count || 0);
        return {
            dbPath: this.dbPath,
            sessionCount,
            hotCount,
            timelineItemCount,
            eventCount
        };
    }

}
