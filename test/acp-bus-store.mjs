import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
});
