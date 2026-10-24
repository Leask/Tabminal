// Opt-in real-provider test. Never discovers or resumes user-owned sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpManager } from '../src/acp-manager.mjs';
import { AcpBusManager } from '../src/acp-bus-manager.mjs';
import { AcpBusStore } from '../src/acp-bus-store.mjs';
import { withDeadline } from '../src/agents/admission.mjs';

const agentId = process.argv[2];
if (!['codex', 'claude', 'test-agent'].includes(agentId)) {
    throw new Error('Usage: node scripts/agent-provider-smoke.mjs codex|claude|test-agent');
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabminal-provider-'));
const manager = new AcpManager({ loadTabs: async () => [], saveTabs: async () => {} });
manager.definitions = manager.definitions.filter((entry) => entry.id === agentId);
assert.equal(manager.definitions.length, 1);
const createBus = () => new AcpBusManager({
    acpManager: manager,
    store: new AcpBusStore({ dbPath: path.join(dir, 'bus.sqlite') }),
    discoveryEnabled: false,
    discoveryCwd: dir, pollIntervalMs: 3600000,
    getCpuLoadRatio: () => 1, loadOpenTabs: async () => [],
    saveOpenTabs: async () => {}
});
let bus = createBus();
let events = 0;
bus.on('event', () => events++);
const report = { agentId, workspace: dir, steps: [] };
const step = async (name, task) => {
    const start = performance.now();
    const result = await task();
    report.steps.push({ name, ms: Math.round(performance.now() - start) });
    console.log(JSON.stringify(report.steps.at(-1)));
    return result;
};
const selectTestModel = async (tabId) => {
    const modelId = process.env.TABMINAL_SMOKE_MODEL;
    if (!modelId) return;
    const state = await bus.getOpenTab(tabId);
    const model = state.configOptions.find((option) => option.category === 'model');
    assert.ok(model, 'Provider does not advertise a model selector');
    await bus.setConfigOptionForTab(tabId, model.id, modelId);
    report.model = modelId;
};
try {
    await bus.start();
    const tab = await step('new', () => bus.createTabForUi({ agentId, cwd: dir }));
    report.sessionId = tab.acpSessionId;
    console.log(JSON.stringify({ newSessionId: report.sessionId }));
    await selectTestModel(tab.id);
    const marker = `TABMINAL_SMOKE_${Date.now()}`;
    await step('prompt_ack', () => bus.sendPromptForTab(tab.id,
        `Reply with exactly ${marker}. Do not use tools or modify files.`, [],
        { requestId: marker }));
    const getPage = () => bus.getTimelinePageForTab(tab.id, { limit: '30' });
    await step('stream_and_persist', () => withDeadline(async () => {
        while (true) {
            const page = await getPage();
            const state = await bus.getOpenTab(tab.id);
            if (state.status === 'error') throw new Error(state.errorMessage);
            if (!state.busy && page.items.some((item) =>
                item.value?.role === 'assistant'
                && item.value?.kind !== 'thought'
                && item.value?.text.includes(marker))) break;
            await delay(250);
        }
    }, 180000, 'Real provider reply'));
    const page = await getPage();
    const indexes = page.items.map((entry) => entry.index);
    assert.ok(indexes.every((index, i) => i === 0 || index === indexes[i - 1] + 1));
    const resumed = await step('resume_owned_session', () => bus.resumeTabForUi({
        agentId, cwd: dir, sessionId: report.sessionId
    }));
    assert.equal(resumed.serialized.acpSessionId, report.sessionId);
    const durations = [];
    for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await getPage();
        durations.push(performance.now() - start);
    }
    report.pageMaxMs = Math.max(...durations);
    report.events = events;
    report.indexes = indexes;
    await step('bus_restart', async () => {
        await bus.dispose();
        bus = createBus();
        await bus.start();
    });
    const restored = await step('cold_resume_owned_session', () => bus.resumeTabForUi({
        agentId, cwd: dir, sessionId: report.sessionId
    }));
    await step('restore_complete', () => withDeadline(async () => {
        while (true) {
            const state = await bus.getOpenTab(restored.serialized.id);
            if (state.status === 'error') throw new Error(state.errorMessage);
            const handle = [...bus.observedSessions.values()][0];
            const runtimeTab = handle?.runtimeEntry.runtime.tabs.get(handle.tabId);
            if (runtimeTab && !runtimeTab.busy && runtimeTab.status === 'ready') break;
            await delay(100);
        }
        const after = await bus.getTimelinePageForTab(restored.serialized.id, { limit: '30' });
        assert.ok(JSON.stringify(after).includes(marker));
    }, 120000, 'Real provider restore'));
    // Some adapters reset the model on resume. Keep an explicit test choice;
    // this does not claim persistent session preferences are implemented.
    await selectTestModel(restored.serialized.id);
    const beforeFollowup = await bus.getTimelinePageForTab(
        restored.serialized.id, { limit: '30' }
    );
    await step('resumed_prompt_ack', () => bus.sendPromptForTab(
        restored.serialized.id,
        'Reply with the exact TABMINAL_SMOKE marker from my previous message. '
            + 'Do not use tools or modify files.', [],
        { requestId: `${marker}-followup` }
    ));
    await step('resumed_context_and_reply', () => withDeadline(async () => {
        while (true) {
            const state = await bus.getOpenTab(restored.serialized.id);
            if (state.status === 'error') throw new Error(state.errorMessage);
            const page = await bus.getTimelinePageForTab(
                restored.serialized.id, { limit: '30' }
            );
            const replies = page.items.filter((item) =>
                item.value?.role === 'assistant'
                && item.value?.kind !== 'thought'
                && item.index > beforeFollowup.maxIndex);
            if (!state.busy && replies.at(-1)?.value.text.includes(marker)) {
                break;
            }
            await delay(250);
        }
    }, 180000, 'Resumed provider reply'));
    report.ok = true;
} finally {
    await bus.dispose();
    await manager.dispose();
    console.log(JSON.stringify(report, null, 2));
    await fs.rm(dir, { recursive: true, force: true });
}
