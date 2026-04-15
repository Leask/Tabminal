import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE_DIR = path.join(os.homedir(), '.tabminal');
const DEFAULT_DB_PATH = path.join(BASE_DIR, 'acp-bus.sqlite');
const DEFAULT_EVENT_LIMIT = 2000;

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
        snapshot
    };
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
        'continuityState',
        'hotRank',
        'status',
        'busy',
        'errorMessage',
        'messageCount',
        'toolCallCount',
        'isPresent'
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
                continuity_state TEXT NOT NULL DEFAULT 'cold',
                hot_rank INTEGER,
                status TEXT NOT NULL DEFAULT '',
                busy INTEGER NOT NULL DEFAULT 0,
                error_message TEXT NOT NULL DEFAULT '',
                message_count INTEGER NOT NULL DEFAULT 0,
                tool_call_count INTEGER NOT NULL DEFAULT 0,
                is_present INTEGER NOT NULL DEFAULT 1,
                snapshot_json TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_acp_bus_sessions_agent
                ON acp_bus_sessions(agent_id);
            CREATE INDEX IF NOT EXISTS idx_acp_bus_sessions_activity
                ON acp_bus_sessions(last_activity_at DESC);
            CREATE INDEX IF NOT EXISTS idx_acp_bus_sessions_hot
                ON acp_bus_sessions(hot_rank ASC);
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
                continuity_state,
                hot_rank,
                status,
                busy,
                error_message,
                message_count,
                tool_call_count,
                is_present,
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
                @continuityState,
                @hotRank,
                @status,
                @busy,
                @errorMessage,
                @messageCount,
                @toolCallCount,
                @isPresent,
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
                continuity_state = excluded.continuity_state,
                hot_rank = excluded.hot_rank,
                status = excluded.status,
                busy = excluded.busy,
                error_message = excluded.error_message,
                message_count = excluded.message_count,
                tool_call_count = excluded.tool_call_count,
                is_present = excluded.is_present,
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
            continuityState: record.continuityState,
            hotRank: Number.isInteger(record.hotRank) ? record.hotRank : null,
            status: record.status,
            busy: record.busy ? 1 : 0,
            errorMessage: record.errorMessage,
            messageCount: record.messageCount,
            toolCallCount: record.toolCallCount,
            isPresent: record.isPresent ? 1 : 0,
            snapshotJson: record.snapshotJson
        });
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
            continuityState: previous?.continuityState || 'cold',
            hotRank: previous?.hotRank ?? null,
            status: previous?.status || '',
            busy: previous?.busy || false,
            errorMessage: previous?.errorMessage || '',
            messageCount: previous?.messageCount || 0,
            toolCallCount: previous?.toolCallCount || 0,
            isPresent: true,
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
        const safeSnapshot = cloneSerializable(snapshot, null);
        const agentId = String(safeSnapshot?.agentId || '').trim();
        const sessionId = String(safeSnapshot?.acpSessionId || '').trim();
        if (!agentId || !sessionId || !safeSnapshot) {
            throw new Error('Observed snapshot must include agentId and sessionId');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previous = this.getSession(sessionKey, { includeSnapshot: true });
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
            snapshotJson: JSON.stringify(safeSnapshot)
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

    markSessionInterest(entry = {}) {
        const agentId = String(entry.agentId || '').trim();
        const sessionId = String(entry.sessionId || '').trim();
        if (!agentId || !sessionId) {
            throw new Error('agentId and sessionId are required');
        }
        const sessionKey = buildAcpBusSessionKey(agentId, sessionId);
        const previous = this.getSession(sessionKey, { includeSnapshot: true });
        const interestedAt = typeof entry.interestedAt === 'string'
            && entry.interestedAt.trim()
            ? entry.interestedAt.trim()
            : this.now();
        const next = {
            sessionKey,
            agentId,
            sessionId,
            cwd: String(entry.cwd || previous?.cwd || '').trim(),
            title: typeof entry.title === 'string'
                ? entry.title
                : (previous?.title || ''),
            upstreamUpdatedAt: previous?.upstreamUpdatedAt || '',
            lastActivityAt: maxIso(previous?.lastActivityAt, interestedAt),
            lastSeenAt: previous?.lastSeenAt || '',
            lastAttachedAt: previous?.lastAttachedAt || '',
            lastLoadedAt: previous?.lastLoadedAt || '',
            lastLiveAt: previous?.lastLiveAt || '',
            continuityState: previous?.continuityState || 'cold',
            hotRank: previous?.hotRank ?? null,
            status: previous?.status || '',
            busy: previous?.busy || false,
            errorMessage: previous?.errorMessage || '',
            messageCount: previous?.messageCount || 0,
            toolCallCount: previous?.toolCallCount || 0,
            isPresent: previous?.isPresent ?? true,
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
                last_activity_at DESC,
                upstream_updated_at DESC,
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
                last_activity_at DESC,
                upstream_updated_at DESC,
                title COLLATE NOCASE ASC
            LIMIT ${safeLimit}
        `).all(...params);
        return rows.map((row) => rowToSession(row, options.includeSnapshot === true));
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
            : 100;
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
        for (const row of allRows) {
            if (row.hotRank !== null || keep.has(row.sessionKey)) {
                continue;
            }
            remove.run(row.sessionKey);
            deleted.push(row);
        }
        return deleted;
    }

    appendEvent(event = {}) {
        const db = this.#requireDb();
        const createdAt = typeof event.createdAt === 'string'
            && event.createdAt.trim()
            ? event.createdAt.trim()
            : this.now();
        const payload = cloneSerializable(event.payload, {});
        db.prepare(`
            INSERT INTO acp_bus_events (
                created_at,
                type,
                agent_id,
                session_id,
                payload_json
            ) VALUES (?, ?, ?, ?, ?)
        `).run(
            createdAt,
            String(event.type || '').trim(),
            String(event.agentId || '').trim(),
            String(event.sessionId || '').trim(),
            JSON.stringify(payload)
        );
        db.prepare(`
            DELETE FROM acp_bus_events
            WHERE id NOT IN (
                SELECT id
                FROM acp_bus_events
                ORDER BY id DESC
                LIMIT ?
            )
        `).run(this.eventLimit);
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
        return {
            dbPath: this.dbPath,
            sessionCount,
            hotCount,
            eventCount
        };
    }
}
