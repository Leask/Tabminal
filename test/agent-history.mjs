import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpRuntime } from '../src/acp-manager.mjs';
import { AcpBusStore } from '../src/acp-bus-store.mjs';
import { HistoryImporter } from '../src/agents/history.mjs';

async function setup(t, sessionId = 'history') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bus-history-test-'));
    const store = new AcpBusStore({ dbPath: path.join(dir, 'bus.sqlite') });
    await store.init();
    await store.upsertIndexedSession({ agentId: 'test', sessionId });
    const runtime = new AcpRuntime({
        id: 'test', label: 'History', command: process.execPath,
        args: [path.resolve('scripts/fixtures/acp-history-agent.mjs'),
            path.join(dir, 'forbidden')]
    }, { cwd: dir, readOnly: true });
    t.after(async () => {
        await runtime.dispose();
        await store.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    const key = `test::${sessionId}`;
    const stage = await store.beginHistoryImport(key);
    return { dir, store, runtime, stage, key,
        importer: new HistoryImporter(store, stage) };
}

it('stages interleaved history atomically with exact text and retained plans', async (t) => {
    const { store, key, stage, importer } = await setup(t);
    const message = (text) => importer.receive({
        sessionUpdate: 'agent_message_chunk', messageId: 'z',
        content: { type: 'text', text }
    });
    await message('```text\nhello\n``');
    await importer.receive({ sessionUpdate: 'tool_call',
        toolCallId: 'a', title: 'Tool', status: 'in_progress', index: 99 });
    await message('`\nnext');
    await importer.receive({ sessionUpdate: 'plan', entries: [
        { content: 'Unfinished historic step', status: 'pending', priority: 'medium' }
    ] });
    await importer.receive({ sessionUpdate: 'tool_call_update',
        toolCallId: 'a', status: 'completed' });
    assert.equal((await store.listTimelineItems(key)).items.length, 0);
    await store.commitHistoryImport(stage);
    const page = await store.listTimelineItems(key, { limit: 30 });
    assert.deepEqual(page.items.map((item) => item.index), [1, 2, 3]);
    assert.equal(page.items[0].value.text, '```text\nhello\n```\nnext');
    assert.equal(page.items[1].value.status, 'completed');
    assert.equal(page.items[2].value.active, false);
    assert.equal(page.items[2].value.entries[0].status, 'pending');
    assert.equal(page.items[2].value.status, 'archived');
    const mediaStage = await store.beginHistoryImport(key);
    await new HistoryImporter(store, mediaStage).receive({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: 'fixture' }
    });
    await store.commitHistoryImport(mediaStage);
    assert.equal((await store.listTimelineItems(key)).items[0].value.text, '[image]');
    const next = await store.beginHistoryImport(key);
    await store.commitHistoryImport(next);
    assert.equal((await store.listTimelineItems(key)).items.length, 0);
});

it('rejects a replay swap superseded by live persistence', async (t) => {
    const { store, key, stage, importer } = await setup(t);
    await importer.receive({ sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'obsolete' } });
    await store.saveObservedSession({ agentId: 'test', acpSessionId: 'history',
        messages: [{ id: 'live', role: 'assistant', text: 'live' }] });
    assert.equal(await store.commitHistoryImport(stage), null);
    const page = await store.listTimelineItems(key);
    assert.equal(page.items[0].value.text, 'live');
    assert.equal((await store.db.get(
        'SELECT COUNT(*) AS count FROM acp_bus_history_items'
    )).count, 0);
});

it('streams 3000 wire history messages without any attached session', async (t) => {
    const { store, key, stage, importer, runtime } = await setup(t, 'large');
    const started = performance.now();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    t.after(() => clearInterval(timer));
    let seen = 0;
    let peakHeap = process.memoryUsage().heapUsed;
    const baseline = peakHeap;
    await runtime.readSessionHistory('large', async (update) => {
        await importer.receive(update);
        if (++seen % 50 === 0) {
            peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
            await delay(2);
        }
    });
    assert.equal(seen, 3000);
    assert.equal(runtime.tabs.size, 0);
    await store.commitHistoryImport(stage);
    assert.equal((await store.getSession(key)).messageCount, 3000);
    const latest = await store.listTimelineItems(key, { limit: 30 });
    assert.equal(latest.items[0].index, 2971);
    assert.equal(latest.items.at(-1).index, 3000);
    const readStart = performance.now();
    for (let i = 0; i < 20; i++) await store.listTimelineItems(key, { limit: 30 });
    t.diagnostic(JSON.stringify({ importMs: performance.now() - started,
        averagePageMs: (performance.now() - readStart) / 20, ticks,
        heapGrowthMiB: (peakHeap - baseline) / 1048576 }));
    assert.ok(ticks > 10, 'event loop must remain responsive during ingestion');
    // A live suffix must not replace the persisted history counts.
    await store.saveObservedSession({ agentId: 'test', acpSessionId: 'large',
        messages: [{ id: 'new', role: 'assistant', text: 'next' }] });
    assert.equal((await store.getSession(key)).messageCount, 3001);
});

it('disposes failed history transport and denies file writes', async (t) => {
    const { store, stage, runtime, importer, dir } = await setup(t, 'denied');
    await assert.rejects(runtime.readSessionHistory('denied',
        (update) => importer.receive(update)), { code: -32603 });
    assert.equal(runtime.disposed, true);
    assert.equal(runtime.historyRead, null);
    assert.equal(runtime.tabs.size, 0);
    await assert.rejects(fs.stat(path.join(dir, 'forbidden')), { code: 'ENOENT' });
    await store.abortHistoryImport(stage);
});

it('keeps partial failed wire history invisible', async (t) => {
    const { store, key, stage, runtime, importer } = await setup(t, 'failed');
    await assert.rejects(runtime.readSessionHistory('failed',
        (update) => importer.receive(update)), { code: -32603 });
    assert.equal(runtime.disposed, true);
    assert.equal((await store.listTimelineItems(key)).items.length, 0);
    await store.abortHistoryImport(stage);
});
