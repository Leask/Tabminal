import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { AcpBusStore } from '../src/acp-bus-store.mjs';

async function createTempDbPath(prefix) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return {
        dir,
        dbPath: path.join(dir, 'acp-bus.sqlite')
    };
}

async function withStore(prefix, callback) {
    const { dir, dbPath } = await createTempDbPath(prefix);
    const store = new AcpBusStore({ dbPath });
    await store.init();
    try {
        await callback(store);
    } finally {
        store.close();
        await fs.rm(dir, { recursive: true, force: true });
    }
}

describe('AcpBusStore', () => {
    it('migrates a legacy session table before creating new indexes', async () => {
        const { dir, dbPath } = await createTempDbPath('acp-bus-store-');
        const db = new DatabaseSync(dbPath);
        db.exec(`
            CREATE TABLE acp_bus_sessions (
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
        `);
        db.close();
        const store = new AcpBusStore({ dbPath });
        try {
            await store.init();
            const summary = store.getSummary();
            assert.equal(summary.sessionCount, 0);
            assert.equal(summary.timelineItemCount, 0);
        } finally {
            store.close();
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('keeps indexed activity anchored to upstream updated time', async () => {
        await withStore('acp-bus-store-', async (store) => {
            const first = store.upsertIndexedSession({
                agentId: 'codex',
                sessionId: 's-1',
                cwd: '/tmp/project',
                title: 'Session 1',
                updatedAt: '2026-04-14T10:00:00.000Z',
                seenAt: '2026-04-14T10:00:05.000Z'
            });
            assert.equal(
                first.record.lastActivityAt,
                '2026-04-14T10:00:00.000Z'
            );

            const second = store.upsertIndexedSession({
                agentId: 'codex',
                sessionId: 's-1',
                cwd: '/tmp/project',
                title: 'Session 1',
                updatedAt: '2026-04-14T10:00:00.000Z',
                seenAt: '2026-04-14T10:05:00.000Z'
            });
            assert.equal(
                second.record.lastActivityAt,
                '2026-04-14T10:00:00.000Z'
            );
            assert.equal(
                second.record.lastSeenAt,
                '2026-04-14T10:05:00.000Z'
            );
        });
    });

    it('persists observed snapshots and counts message metadata', async () => {
        await withStore('acp-bus-store-', async (store) => {
            const saved = store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-2',
                cwd: '/tmp/project',
                title: 'Observed session',
                status: 'ready',
                busy: false,
                errorMessage: '',
                messages: [{ id: 'm-1' }, { id: 'm-2' }],
                toolCalls: [{ id: 't-1' }]
            }, {
                continuityState: 'live',
                observedAt: '2026-04-14T10:10:00.000Z',
                attachedAt: '2026-04-14T10:10:00.000Z',
                loadedAt: '2026-04-14T10:10:00.000Z',
                liveAt: '2026-04-14T10:10:00.000Z'
            });

            assert.equal(saved.record.messageCount, 2);
            assert.equal(saved.record.toolCallCount, 1);
            assert.equal(saved.record.continuityState, 'live');

            const loaded = store.getSession(saved.record.sessionKey, {
                includeSnapshot: true
            });
            assert.equal(loaded.snapshot.title, 'Observed session');
            assert.equal(loaded.snapshot.messages.length, 2);
        });
    });

    it('preserves cached transcript content while a live attach is restoring', async () => {
        await withStore('acp-bus-store-', async (store) => {
            store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-3',
                cwd: '/tmp/project',
                title: 'Observed session',
                status: 'ready',
                busy: false,
                errorMessage: '',
                messages: [{ id: 'm-1' }, { id: 'm-2' }],
                toolCalls: [{ id: 't-1' }],
                permissions: [],
                plan: [],
                usage: { totals: { inputTokens: 10 } },
                terminals: []
            }, {
                continuityState: 'cached',
                observedAt: '2026-04-14T10:10:00.000Z'
            });

            const updated = store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-3',
                cwd: '/tmp/project',
                title: 'Observed session',
                status: 'restoring',
                busy: true,
                errorMessage: '',
                messages: [],
                toolCalls: [],
                permissions: [],
                plan: [],
                usage: null,
                terminals: []
            }, {
                continuityState: 'live',
                observedAt: '2026-04-14T10:11:00.000Z',
                preserveSnapshotContent: true
            });

            assert.equal(updated.record.status, 'restoring');
            assert.equal(updated.record.busy, true);
            assert.equal(updated.record.messageCount, 2);
            assert.equal(updated.record.toolCallCount, 1);

            const loaded = store.getSession(updated.record.sessionKey, {
                includeSnapshot: true
            });
            assert.equal(loaded.snapshot.status, 'restoring');
            assert.equal(loaded.snapshot.busy, true);
            assert.equal(loaded.snapshot.messages.length, 2);
            assert.equal(loaded.snapshot.toolCalls.length, 1);
            assert.deepEqual(loaded.snapshot.usage, {
                totals: { inputTokens: 10 }
            });
        });
    });

    it('stores timeline rows and pages them by cursor', async () => {
        await withStore('acp-bus-store-', async (store) => {
            store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-page',
                cwd: '/tmp/project',
                title: 'Paged session',
                status: 'ready',
                busy: false,
                errorMessage: '',
                messages: [
                    { id: 'm-1', role: 'user', kind: 'message', text: 'one', order: 1 },
                    { id: 'm-2', role: 'assistant', kind: 'message', text: 'two', order: 2 },
                    { id: 'm-3', role: 'user', kind: 'message', text: 'three', order: 3 }
                ],
                toolCalls: [{
                    toolCallId: 't-1',
                    title: 'tool',
                    status: 'completed',
                    order: 4
                }],
                permissions: [],
                plan: [],
                usage: null,
                terminals: []
            }, {
                continuityState: 'live',
                observedAt: '2026-04-14T10:10:00.000Z'
            });

            const latest = store.listTimelineItems('codex::s-page', {
                limit: 2
            });
            assert.equal(latest.total, 4);
            assert.deepEqual(latest.items.map((item) => item.itemKey), [
                'message:m-3',
                'tool:t-1'
            ]);
            assert.equal(latest.hasOlder, true);
            assert.equal(latest.hasNewer, false);

            const older = store.listTimelineItems('codex::s-page', {
                before: latest.prevCursor,
                limit: 2
            });
            assert.deepEqual(older.items.map((item) => item.itemKey), [
                'message:m-1',
                'message:m-2'
            ]);
            assert.equal(older.hasOlder, false);
            assert.equal(older.hasNewer, true);

            const newer = store.listTimelineItems('codex::s-page', {
                after: older.nextCursor,
                limit: 2
            });
            assert.deepEqual(newer.items.map((item) => item.itemKey), [
                'message:m-3',
                'tool:t-1'
            ]);
        });
    });

    it('rebuilds timeline rows for authoritative snapshots', async () => {
        await withStore('acp-bus-store-', async (store) => {
            store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-rebuild',
                cwd: '/tmp/project',
                messages: [
                    { id: 'm-1', role: 'user', text: 'one', order: 1 },
                    { id: 'm-stale', role: 'assistant', text: 'old', order: 2 }
                ],
                toolCalls: []
            }, {
                observedAt: '2026-04-14T10:00:00.000Z'
            });

            store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-rebuild',
                cwd: '/tmp/project',
                messages: [
                    { id: 'm-1', role: 'user', text: 'one', order: 1 },
                    { id: 'm-2', role: 'assistant', text: 'two', order: 2 }
                ],
                toolCalls: []
            }, {
                observedAt: '2026-04-14T10:01:00.000Z',
                authoritativeSnapshot: true
            });

            const page = store.listTimelineItems('codex::s-rebuild', {
                limit: 10
            });
            assert.deepEqual(page.items.map((item) => item.itemKey), [
                'message:m-1',
                'message:m-2'
            ]);
            assert.equal(page.minOrder, 1);
            assert.equal(page.maxOrder, 2);
        });
    });

    it('stores active and completed plan blocks with explicit state', async () => {
        await withStore('acp-bus-store-', async (store) => {
            store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-plan',
                cwd: '/tmp/project',
                messages: [],
                toolCalls: [],
                plan: [{
                    content: 'Run benchmark',
                    status: 'in_progress',
                    priority: 'medium',
                    order: 1
                }]
            }, {
                observedAt: '2026-04-14T10:00:00.000Z'
            });

            let page = store.listTimelineItems('codex::s-plan', { limit: 10 });
            assert.equal(page.items.length, 1);
            assert.equal(page.items[0].type, 'plan');
            assert.equal(page.items[0].value.active, true);

            store.saveObservedSession({
                agentId: 'codex',
                acpSessionId: 's-plan',
                cwd: '/tmp/project',
                messages: [],
                toolCalls: [],
                plan: [{
                    content: 'Run benchmark',
                    status: 'completed',
                    priority: 'medium',
                    order: 1
                }]
            }, {
                observedAt: '2026-04-14T10:01:00.000Z',
                preserveSnapshotContent: true
            });

            page = store.listTimelineItems('codex::s-plan', { limit: 10 });
            assert.equal(
                page.items.some((item) => item.value.active === false),
                true
            );
        });
    });

    it('preserves hot sessions during cache pruning', async () => {
        await withStore('acp-bus-store-', async (store) => {
            const sessions = [
                ['s-1', '2026-04-14T10:00:00.000Z'],
                ['s-2', '2026-04-14T10:01:00.000Z'],
                ['s-3', '2026-04-14T10:02:00.000Z']
            ];
            for (const [sessionId, updatedAt] of sessions) {
                store.upsertIndexedSession({
                    agentId: 'codex',
                    sessionId,
                    cwd: '/tmp/project',
                    title: sessionId,
                    updatedAt,
                    seenAt: updatedAt
                });
            }

            store.setHotSessionKeys(['codex::s-1']);
            const removed = store.pruneSessions(1, []);
            const remaining = store.listSessions();

            assert.equal(removed.length, 1);
            assert.deepEqual(remaining.map((row) => row.sessionKey).sort(), [
                'codex::s-1',
                'codex::s-3'
            ]);
            assert.ok(
                remaining.some((row) => row.sessionKey === 'codex::s-1')
            );
        });
    });

    it('returns inserted event envelopes while pruning old events', async () => {
        await withStore('acp-bus-store-', async (store) => {
            store.eventLimit = 1;
            const first = store.appendEvent({
                createdAt: '2026-04-14T10:00:00.000Z',
                type: 'first',
                agentId: 'codex',
                sessionId: 's-1',
                payload: { value: 1 }
            });
            const second = store.appendEvent({
                createdAt: '2026-04-14T10:01:00.000Z',
                type: 'second',
                agentId: 'codex',
                sessionId: 's-1',
                payload: { value: 2 }
            });

            assert.equal(first.id > 0, true);
            assert.equal(second.id > first.id, true);
            assert.deepEqual(store.listEvents(10).map((event) => event.type), [
                'second'
            ]);
        });
    });
});
