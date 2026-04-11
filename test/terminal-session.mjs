import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// Ensure tests are deterministic and do not depend on user config files.
// Use a space to force env override while still disabling AI via trim().
process.env.TABMINAL_OPENROUTER_KEY = ' ';
process.env.TABMINAL_DEBUG = '1';
process.env.TABMINAL_PASSWORD = 'test-password';

const { TerminalSession } = await import('../src/terminal-session.mjs');

function buildExitSequence(exitCode, command) {
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    return `\u001b]1337;ExitCode=${exitCode};CommandB64=${encoded}\u0007`;
}
function buildStartSequence(command) {
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    return `\u001b]1337;CommandStartB64=${encoded}\u0007`;
}
const PROMPT_MARKER = '\u001b]1337;TabminalPrompt\u0007';
const QUERY_RESPONSE_CPR = '\u001b[30;1R';
const QUERY_RESPONSE_BG =
    '\u001b]11;rgb:0000/2b2b/3636\u0007\u001b[30;1R';

describe('TerminalSession', () => {
    let pty;
    let session;

    beforeEach(() => {
        pty = new FakePty();
        session = null;
    });

    afterEach(() => {
        if (session) {
            session.dispose();
        }
    });

    it('replays buffered output when a client attaches', async () => {
        session = new TerminalSession(pty, { historyLimit: 16 });
        pty.emitData('hello ');
        pty.emitData('world');

        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);

        const payloads = client.sent.map((raw) => JSON.parse(raw));

        assert.strictEqual(payloads[0].type, 'snapshot');
        assert.match(payloads[0].data, /hello world/);

        assert.strictEqual(payloads[1].type, 'meta');

        assert.strictEqual(payloads[2].type, 'status');
        assert.strictEqual(payloads[2].status, 'ready');
    });

    it('writes user input to the underlying pty', async () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);

        client.emit('message', JSON.stringify({
            type: 'input',
            data: 'ls\n'
        }));

        assert.strictEqual(pty.write.mock.calls.length, 1);
        assert.deepStrictEqual(pty.write.mock.calls[0].arguments, ['ls\n']);
    });

    it('accepts terminal query responses from the initial attached client only', async () => {
        session = new TerminalSession(pty);
        const owner = new MockSocket();
        const observer = new MockSocket();
        session.attach(owner);
        session.attach(observer);
        await Promise.all([
            owner.waitForMessages(3),
            observer.waitForMessages(3)
        ]);

        owner.emit('message', JSON.stringify({
            type: 'input',
            data: QUERY_RESPONSE_BG
        }));
        observer.emit('message', JSON.stringify({
            type: 'input',
            data: QUERY_RESPONSE_BG
        }));

        assert.strictEqual(pty.write.mock.calls.length, 1);
        assert.deepStrictEqual(
            pty.write.mock.calls[0].arguments,
            [QUERY_RESPONSE_BG]
        );
    });

    it('lets a client claim terminal query response ownership', async () => {
        session = new TerminalSession(pty);
        const owner = new MockSocket();
        const contender = new MockSocket();
        session.attach(owner);
        session.attach(contender);
        await Promise.all([
            owner.waitForMessages(3),
            contender.waitForMessages(3)
        ]);

        contender.emit('message', JSON.stringify({
            type: 'claim_terminal_control'
        }));
        owner.emit('message', JSON.stringify({
            type: 'input',
            data: QUERY_RESPONSE_CPR
        }));
        contender.emit('message', JSON.stringify({
            type: 'input',
            data: QUERY_RESPONSE_CPR
        }));

        assert.strictEqual(pty.write.mock.calls.length, 1);
        assert.deepStrictEqual(
            pty.write.mock.calls[0].arguments,
            [QUERY_RESPONSE_CPR]
        );
    });

    it('reassigns terminal query response ownership when the owner closes', async () => {
        session = new TerminalSession(pty);
        const owner = new MockSocket();
        const fallback = new MockSocket();
        session.attach(owner);
        session.attach(fallback);
        await Promise.all([
            owner.waitForMessages(3),
            fallback.waitForMessages(3)
        ]);

        owner.close();
        fallback.emit('message', JSON.stringify({
            type: 'input',
            data: QUERY_RESPONSE_CPR
        }));

        assert.strictEqual(pty.write.mock.calls.length, 1);
        assert.deepStrictEqual(
            pty.write.mock.calls[0].arguments,
            [QUERY_RESPONSE_CPR]
        );
    });

    it('resizes using sanitized values only', async () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);

        client.emit('message', JSON.stringify({
            type: 'resize',
            cols: -5,
            rows: 'bad'
        }));
        assert.strictEqual(pty.resize.mock.calls.length, 0);

        client.emit('message', JSON.stringify({
            type: 'resize',
            cols: 200,
            rows: 40
        }));
        assert.strictEqual(pty.resize.mock.calls.length, 1);
        assert.deepStrictEqual(pty.resize.mock.calls[0].arguments, [200, 40]);
    });

    it('ignores stale pty resize failures instead of throwing', () => {
        pty.resize = mock.fn(() => {
            const error = new Error('ioctl(2) failed');
            error.code = 'EBADF';
            throw error;
        });
        session = new TerminalSession(pty);

        assert.doesNotThrow(() => {
            session.resize(120, 40);
        });
    });

    it('stops accepting input after the pty exits', async () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);

        pty.emitExit({ exitCode: 0 });
        client.emit('message', JSON.stringify({
            type: 'input',
            data: 'echo nope'
        }));

        assert.strictEqual(pty.write.mock.calls.length, 0);
        const payloads = client.sent.map((raw) => JSON.parse(raw));

        const statusMsg = payloads.find(p => p.type === 'status' && p.status === 'terminated');
        assert.ok(statusMsg, 'Should contain terminated status');
        assert.strictEqual(statusMsg.code, 0);
        assert.strictEqual(statusMsg.signal, null);
    });

    it('trims history to configured limit', () => {
        session = new TerminalSession(pty, { historyLimit: 10 });
        pty.emitData('0123456789'); // fill
        pty.emitData('abcdef'); // push over

        assert.strictEqual(session.history, '6789abcdef');
    });

    it('captures execution output between exit markers', () => {
        session = new TerminalSession(pty);
        pty.emitData('leask@Flora$ ' + PROMPT_MARKER);
        pty.emitData(buildStartSequence('ls'));
        pty.emitData('ls\nfile.txt\n');
        pty.emitData(buildExitSequence(0, 'ls'));

        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'ls');
        assert.strictEqual(session.lastExecution.exitCode, 0);
        assert.strictEqual(session.lastExecution.input, 'ls');
        assert.strictEqual(session.lastExecution.output, 'file.txt');
    });

    it('broadcasts execution start and completion events', async () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);
        client.sent = [];

        pty.emitData(buildStartSequence('pwd'));
        pty.emitData('/tmp\n');
        pty.emitData(buildExitSequence(0, 'pwd'));

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        const started = payloads.find(
            (payload) => payload.type === 'execution'
                && payload.phase === 'started'
        );
        const completed = payloads.find(
            (payload) => payload.type === 'execution'
                && payload.phase === 'completed'
        );

        assert.ok(started);
        assert.ok(completed);
        assert.strictEqual(started.command, 'pwd');
        assert.strictEqual(completed.entry.command, 'pwd');
        assert.strictEqual(completed.entry.exitCode, 0);
    });

    it('does not broadcast internal shell ready commands as executions', async () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);
        client.sent = [];

        pty.emitData(buildStartSequence('TABMINAL_SHELL_READY=1'));
        pty.emitData(buildExitSequence(0, 'TABMINAL_SHELL_READY=1'));

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        const executionPayloads = payloads.filter(
            (payload) => payload.type === 'execution'
        );

        assert.deepStrictEqual(executionPayloads, []);
        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'TABMINAL_SHELL_READY=1');
    });

    it('broadcasts idle when a prompt arrives with a dangling execution', async () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);
        client.sent = [];

        pty.emitData(buildStartSequence('pwd'));
        pty.emitData(PROMPT_MARKER);

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        const started = payloads.find(
            (payload) => payload.type === 'execution'
                && payload.phase === 'started'
        );
        const idle = payloads.find(
            (payload) => payload.type === 'execution'
                && payload.phase === 'idle'
        );

        assert.ok(started);
        assert.ok(idle);
        assert.strictEqual(idle.executionId, started.executionId);
        assert.strictEqual(session.currentExecutionId, '');
    });

    it('resets the capture buffer for consecutive commands', () => {
        session = new TerminalSession(pty);

        pty.emitData('prompt$ ' + PROMPT_MARKER);
        pty.emitData('ls\nfoo\n');
        pty.emitData(buildExitSequence(2, 'ls'));

        pty.emitData('prompt$ ' + PROMPT_MARKER);
        pty.emitData('pwd\n/bar\n');
        pty.emitData(buildExitSequence(0, 'pwd'));

        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'pwd');
        assert.strictEqual(session.lastExecution.exitCode, 0);
        assert.strictEqual(session.lastExecution.input, 'pwd');
        assert.strictEqual(session.lastExecution.output, '/bar');
    });

    it('drops elaborate prompt decorations from captured output', () => {
        session = new TerminalSession(pty);

        const fancyPrompt =
            '\r\r\n' +
            '⎧ banner line\r\n' +
            '⎨ Paths: /vols/cache\r\n' +
            '⎩ [33m$ ❯[0m ';

        pty.emitData(fancyPrompt + PROMPT_MARKER);
        pty.emitData('ls\nclient\n');
        pty.emitData(buildExitSequence(0, 'ls'));

        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'ls');
        assert.strictEqual(session.lastExecution.input.includes('ls'), true);
        assert.strictEqual(session.lastExecution.output, 'client');
    });

    it('captures multi-line commands that use continuation prompts', () => {
        session = new TerminalSession(pty);

        pty.emitData('prompt$ ' + PROMPT_MARKER);
        const multiLineInput =
            'echo first \\\r\n' +
            '> second \\\r\n' +
            '> third\r\n';
        pty.emitData(multiLineInput + 'first second third\n');
        pty.emitData(buildExitSequence(0, 'echo first second third'));

        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'echo first second third');
        const normalizedInput = multiLineInput.replace(/\r\n/g, '\n').replace(/\s+$/, '');
        assert.strictEqual(session.lastExecution.input, normalizedInput);
        assert.strictEqual(session.lastExecution.output, 'first second third');
    });

    it('normalizes backspaces and clears within the echoed command line', () => {
        session = new TerminalSession(pty);

        pty.emitData('prompt$ ' + PROMPT_MARKER);
        pty.emitData('ls -XXXX\b\b\b\b[KBB\r\nitem\n');
        pty.emitData(buildExitSequence(0, 'ls -BB'));

        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'ls -BB');
        assert.strictEqual(session.lastExecution.input, 'ls -BB');
        assert.strictEqual(session.lastExecution.output, 'item');
    });

    it('logs each execution summary once it completes', () => {
        session = new TerminalSession(pty);
        const originalLog = console.log;
        const calls = [];
        console.log = (...args) => { calls.push(args); };

        try {
            pty.emitData('prompt$ ' + PROMPT_MARKER);
            pty.emitData('echo hi\nhi\n');
            pty.emitData(buildExitSequence(0, 'echo hi'));
        } finally {
            console.log = originalLog;
        }

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0][0], '[Terminal Execution]');
        assert.deepStrictEqual(calls[0][1], {
            command: 'echo hi',
            exitCode: 0,
            input: 'echo hi',
            output: 'hi',
            startedAt: session.lastExecution.startedAt.toISOString(),
            completedAt: session.lastExecution.completedAt.toISOString(),
            duration: session.lastExecution.completedAt.getTime() - session.lastExecution.startedAt.getTime(),
        });
    });

    it('does not forward control sequences to clients', async () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);
        client.sent = [];

        pty.emitData('prompt$ ' + PROMPT_MARKER);
        pty.emitData(`echo hi
hi
${buildExitSequence(0, 'echo hi')}`);

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        const outputMsg = payloads.find((p) => p.type === 'output' && p.data.includes('echo hi'));
        assert.ok(outputMsg);
        assert.ok(outputMsg.data.includes('\nhi\n'));
    });

    it('serializes terminal modes into the attach snapshot', async () => {
        session = new TerminalSession(pty);
        pty.emitData('\u001b[?1000h\u001b[?1006hhello');

        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        assert.strictEqual(payloads[0].type, 'snapshot');
        assert.match(payloads[0].data, /\u001b\[\?1000h/);
        assert.match(payloads[0].data, /\u001b\[\?1006h/);
        assert.match(payloads[0].data, /hello/);
    });

    it('restores a serialized snapshot for a replacement session', async () => {
        session = new TerminalSession(pty);
        pty.emitData('\u001b[?1000h\u001b[?1006hhello\r\nworld');
        const snapshot = await session.serializeSnapshot();

        const restoredSession = new TerminalSession(new FakePty());
        await restoredSession.restoreSnapshot(snapshot);

        const client = new MockSocket();
        restoredSession.attach(client);
        await client.waitForMessages(3);

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        assert.strictEqual(payloads[0].type, 'snapshot');
        assert.match(payloads[0].data, /hello/);
        assert.match(payloads[0].data, /world/);
        assert.match(payloads[0].data, /\u001b\[\?1000h/);
        assert.match(payloads[0].data, /\u001b\[\?1006h/);

        restoredSession.dispose();
    });

    it('captures split shell markers across chunks', () => {
        session = new TerminalSession(pty);

        const exitSequence = buildExitSequence(
            127,
            'definitely_not_a_real_command_123'
        );

        pty.emitData('prompt$ ' + PROMPT_MARKER.slice(0, 8));
        pty.emitData(PROMPT_MARKER.slice(8));
        pty.emitData(
            'definitely_not_a_real_command_123\nbash: command not found\n'
        );
        pty.emitData(exitSequence.slice(0, 10));
        pty.emitData(exitSequence.slice(10));

        assert.ok(session.lastExecution);
        assert.strictEqual(
            session.lastExecution.command,
            'definitely_not_a_real_command_123'
        );
        assert.strictEqual(session.lastExecution.exitCode, 127);
        assert.match(session.lastExecution.output, /command not found/);
    });

    it('does not auto-fix failed markers without captured input', async () => {
        session = new TerminalSession(pty);
        session._isAiEnabled = () => true;
        session._promptAi = mock.fn(async () => ({ text: 'ignored' }));

        pty.emitData(buildExitSequence(127, 'previous_bad_command'));
        await Promise.resolve();

        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'previous_bad_command');
        assert.strictEqual(session.lastExecution.exitCode, 127);
        assert.strictEqual(session.lastExecution.input, '');
        assert.strictEqual(session._promptAi.mock.callCount(), 0);
    });

    it('cancels an active AI response with Ctrl+C', async () => {
        session = new TerminalSession(pty);
        session._isAiEnabled = () => true;

        const client = new MockSocket();
        session.attach(client);
        await client.waitForMessages(3);
        client.sent = [];

        let streamCallback = null;
        let releasePrompt;
        const promptDone = new Promise((resolve) => {
            releasePrompt = resolve;
        });
        session._promptAi = async (_prompt, options) => {
            streamCallback = options.stream;
            await promptDone;
            return { text: 'late answer' };
        };

        const aiTask = session._handleAiCommand('test prompt');
        await Promise.resolve();

        session.write('\x03');
        await Promise.resolve();
        await streamCallback?.({ text: 'ignored after cancel' });
        releasePrompt();
        await aiTask;

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        assert.ok(
            !payloads.some(
                (payload) => payload.type === 'output'
                    && payload.data.includes('ignored after cancel')
            )
        );
        assert.strictEqual(session.executions.at(-1)?.command, 'ai');
        assert.strictEqual(session.executions.at(-1)?.exitCode, 130);
        assert.match(
            session.executions.at(-1)?.output || '',
            /cancelled/i
        );
        assert.ok(
            pty.write.mock.calls.some((call) => call.arguments[0] === '\x03')
        );
    });

    it('cancels an active AI response with Ctrl+D without sending EOF', async () => {
        session = new TerminalSession(pty);
        session._isAiEnabled = () => true;

        let releasePrompt;
        const promptDone = new Promise((resolve) => {
            releasePrompt = resolve;
        });
        session._promptAi = async () => {
            await promptDone;
            return { text: 'late answer' };
        };

        const aiTask = session._handleAiCommand('test prompt');
        await Promise.resolve();

        session.write('\x04');
        releasePrompt();
        await aiTask;

        assert.strictEqual(session.executions.at(-1)?.command, 'ai');
        assert.strictEqual(session.executions.at(-1)?.exitCode, 130);
        assert.ok(
            !pty.write.mock.calls.some((call) => call.arguments[0] === '\x04')
        );
        assert.ok(
            pty.write.mock.calls.some((call) => call.arguments[0] === '\x15')
        );
        assert.ok(
            pty.write.mock.calls.some((call) => call.arguments[0] === '\r')
        );
    });
});

class FakePty {
    constructor() {
        this.pid = 12345;
        this.cols = 80;
        this.rows = 24;
        this.write = mock.fn();
        this.resize = mock.fn();
        this._dataHandlers = new Set();
        this._exitHandlers = new Set();
    }

    onData(handler) {
        this._dataHandlers.add(handler);
        return {
            dispose: () => this._dataHandlers.delete(handler)
        };
    }

    onExit(handler) {
        this._exitHandlers.add(handler);
        return {
            dispose: () => this._exitHandlers.delete(handler)
        };
    }

    emitData(chunk) {
        for (const handler of this._dataHandlers) {
            handler(chunk);
        }
    }

    emitExit(payload) {
        for (const handler of this._exitHandlers) {
            handler(payload);
        }
    }
}

class MockSocket {
    constructor() {
        this.sent = [];
        this.readyState = 1;
        this._waiters = [];
        this._listeners = {
            message: new Set(),
            close: new Set(),
            error: new Set()
        };
    }

    send(payload) {
        this.sent.push(payload);
        for (const waiter of [...this._waiters]) {
            waiter();
        }
    }

    close() {
        if (this.readyState !== 1) {
            return;
        }
        this.readyState = 3;
        this.emit('close');
    }

    on(event, handler) {
        this._listeners[event]?.add(handler);
    }

    once(event, handler) {
        const onceHandler = (...args) => {
            this._listeners[event]?.delete(onceHandler);
            handler(...args);
        };
        this.on(event, onceHandler);
    }

    waitForMessages(count) {
        if (this.sent.length >= count) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const check = () => {
                if (this.sent.length >= count) {
                    this._waiters = this._waiters.filter((w) => w !== check);
                    resolve();
                }
            };
            this._waiters.push(check);
        });
    }

    emit(event, payload) {
        for (const handler of this._listeners[event] ?? []) {
            handler(payload);
        }
    }
}
