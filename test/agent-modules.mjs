import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AdmissionGate, SessionExecution, withDeadline, runtimeAdmission }
    from '../src/agents/admission.mjs';
import { projectExtension, supportsExtension } from '../src/agents/extensions.mjs';
import { selectAgentMessageText } from '../public/modules/agent-messages.js';
import { AcpRuntime, normalizeAgentTranscriptMessages }
    from '../src/acp-manager.mjs';
import { classifyBusCommandFailure }
    from '../src/controllers/tabminal/acp-bus-format.mjs';

it('reports uncertain runtime timeout without suggesting automatic retry', () => {
    const response = classifyBusCommandFailure(Object.assign(
        new Error('Session operation timed out'), { code: 'runtime_timeout' }
    ));
    assert.equal(response.status, 504);
    assert.equal(response.body.error.code, 'runtime_timeout');
    assert.equal(response.body.error.retryable, false);
    const disconnected = classifyBusCommandFailure(Object.assign(
        new Error('Workspace connection is no longer available'), {
            code: 'runtime_unavailable',
            details: { reason: 'workspace_disconnected' }
        }
    ));
    assert.equal(disconnected.status, 503);
    assert.equal(disconnected.body.error.code, 'runtime_unavailable');
    assert.equal(disconnected.body.error.details.reason, 'workspace_disconnected');
});

it('bounds startup concurrency and removes cancelled queued work', async () => {
    const gate = new AdmissionGate(2);
    const abort = new AbortController();
    let peak = 0;
    const job = () => gate.run(async () => {
        peak = Math.max(peak, gate.active);
        await delay(20);
    });
    const first = job();
    const second = job();
    const cancelled = gate.run(() => assert.fail('must not start'), abort.signal);
    abort.abort(new Error('cancelled'));
    await assert.rejects(cancelled, /cancelled/);
    await Promise.all([first, second, job()]);
    assert.equal(peak, 2);
    assert.equal(gate.active, 0);
    assert.equal(gate.queue.length, 0);
    await assert.rejects(gate.run(() => { throw new Error('failure'); }));
    await gate.run(() => 1);
    assert.equal(gate.active, 0);
});

it('cancel keeps execution ownership until actual settlement', () => {
    const execution = new SessionExecution();
    const lease = execution.begin();
    execution.dispatch(lease);
    assert.equal(execution.cancel(), true);
    assert.throws(() => execution.begin(), /already running/);
    assert.equal(execution.finish({}), false);
    assert.equal(execution.finish(lease), true);
    const next = execution.begin();
    assert.equal(execution.cancel(), false);
    assert.throws(() => execution.dispatch(next), /cancelled/);
    execution.finish(next);
});

it('deadlines reject hung work with a stable error code', async () => {
    await assert.rejects(withDeadline(() => new Promise(() => {}), 10), {
        code: 'runtime_timeout'
    });
});

it('preserves distinct text identities and replaces only identical ids', () => {
    assert.equal(selectAgentMessageText('old longer text', 'new'), 'new');
    assert.equal(selectAgentMessageText('old', ''), '');
    assert.equal(selectAgentMessageText('old', undefined), 'old');
    const values = normalizeAgentTranscriptMessages([
        { id: 'a', text: 'same', order: 1 },
        { id: 'b', text: 'same', order: 2 },
        { id: 'a', text: 'updated', order: 99 }
    ]);
    assert.deepEqual(values.map(({ id, text, order }) => ({ id, text, order })), [
        { id: 'a', text: 'updated', order: 1 },
        { id: 'b', text: 'same', order: 2 }
    ]);
});

it('projects versioned subagent events with bounded output and separate status', () => {
    assert.equal(supportsExtension('_lody/subagents/event', {}), false);
    assert.equal(supportsExtension('_lody/subagents/event', {
        _meta: { lody: { subagentEvents: { version: 2 } } }
    }), false);
    assert.equal(supportsExtension('_lody/subagents/event', {
        _meta: { lody: { subagentEvents: { version: 1 } } }
    }), true);
    const base = { version: 1, sessionId: 'session', runId: 'child' };
    const snapshot = projectExtension('_lody/subagents/event', {
        ...base, type: 'snapshot', snapshot: {
            state: 'running', name: 'Research',
            support: { stream: ['text'], progress: true,
                outputRead: 'none', cancel: false }
        }
    });
    assert.equal(snapshot.tool.status, 'in_progress');
    const output = projectExtension('lody/subagents/event', {
        ...base, type: 'output', update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'x'.repeat(20000) }
        }
    }, snapshot.tool);
    assert.equal(output.tool.subagent.output.length, 16384);
    assert.equal(output.tool.status, 'in_progress');
    assert.equal(projectExtension('_lody/subagents/event', {
        ...base, version: 2, type: 'snapshot', snapshot: {}
    }), null);
    assert.equal(projectExtension('_other/vendor', {}), null);
});

it('projects usage snapshots without counting the delta twice or inventing cost', () => {
    const params = { sessionId: 's', usage: {
        inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 7,
        reasoningOutputTokens: 2
    }, delta: { usage: { inputTokens: 1000 } } };
    const event = projectExtension('_lody/session/usage_update', params);
    assert.equal(event.usage.totals.totalTokens, 24);
    assert.equal(event.usage.totals.costUSD, undefined);
    assert.deepEqual(event, projectExtension('_lody/session/usage_update', params));
});

async function testRuntime(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabminal-agent-test-'));
    const runtime = new AcpRuntime({
        id: 'test', label: 'Test', command: process.execPath,
        args: [path.resolve('src/acp-test-agent.mjs')]
    }, { cwd: dir });
    t.after(async () => {
        await runtime.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    });
    const tab = await runtime.createTab({ id: 'test', cwd: dir });
    return { runtime, tab };
}

it('admits only one prompt even during asynchronous preparation', async (t) => {
    const { runtime, tab } = await testRuntime(t);
    const first = runtime.sendPrompt(tab.id, '/cancel');
    await assert.rejects(runtime.sendPrompt(tab.id, '/plan'), /already running/);
    await first;
    await runtime.cancel(tab.id);
    await withDeadline(async () => {
        while (runtime.tabs.get(tab.id).busy) await delay(10);
    }, 5000);
    assert.equal(runtime.tabs.get(tab.id).execution.current, null);
});

it('cancellation before dispatch sends no prompt or cancel upstream', async (t) => {
    const { runtime, tab } = await testRuntime(t);
    let calls = 0;
    runtime.connection.prompt = async () => { calls++; return {}; };
    runtime.connection.cancel = async () => { calls++; };
    const pending = runtime.sendPrompt(tab.id, 'not dispatched');
    await runtime.cancel(tab.id);
    await assert.rejects(pending, /cancelled/);
    assert.equal(calls, 0);
    assert.equal(runtime.tabs.get(tab.id).busy, false);
});

it('rejects stale and forged permission replies', async (t) => {
    const { runtime, tab } = await testRuntime(t);
    const permission = { status: 'pending', options: [{ optionId: 'allow' }],
        resolve: () => {} };
    runtime.tabs.get(tab.id).permissions.set('p', permission);
    await assert.rejects(runtime.resolvePermission(tab.id, 'p', 'forged'), /Invalid/);
    assert.equal(permission.status, 'pending');
    await runtime.resolvePermission(tab.id, 'p', 'allow');
    await assert.rejects(runtime.resolvePermission(tab.id, 'p', 'allow'), {
        code: 'permission_stale'
    });
});

it('streams Core child events independently of parent prompt settlement', async (t) => {
    const { runtime, tab } = await testRuntime(t);
    await runtime.sendPrompt(tab.id, '/extensions');
    const live = runtime.tabs.get(tab.id);
    await withDeadline(async () => {
        while (live.busy || live.toolCalls.size === 0) await delay(10);
    }, 5000);
    const child = [...live.toolCalls.values()].find((tool) => tool.subagent);
    assert.equal(child.status, 'in_progress');
    assert.equal(child.subagent.output, 'Child stream preserved.');
    const order = child.order;
    await withDeadline(async () => {
        while (live.toolCalls.get(child.toolCallId).status !== 'completed') {
            await delay(20);
        }
    }, 5000);
    assert.equal(live.toolCalls.get(child.toolCallId).order, order);
});

it('terminates hung initialization and disallows resurrection after disposal', async () => {
    const runtime = new AcpRuntime({
        id: 'hung', label: 'Hung', command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)']
    }, { startupTimeoutMs: 50 });
    await assert.rejects(runtime.start(), /timed out/);
    assert.equal(runtime.process, null);
    await runtime.dispose();
    await assert.rejects(runtime.start());
    assert.equal(runtime.started, false);
});

it('disposal removes a queued runtime before it can spawn', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const blockers = [runtimeAdmission.run(() => gate), runtimeAdmission.run(() => gate)];
    const runtime = new AcpRuntime({
        id: 'queued', label: 'Queued', command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)']
    });
    const started = assert.rejects(runtime.start(), /disposed/);
    try {
        await runtime.dispose();
        await started;
        assert.equal(runtime.process, null);
    } finally {
        release();
        await Promise.all(blockers);
    }
    assert.equal(runtimeAdmission.active, 0);
});
