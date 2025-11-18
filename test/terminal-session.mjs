import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import { TerminalSession } from '../src/terminal-session.mjs';

function buildExitSequence(exitCode, command) {
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    return `\u001b]1337;ExitCode=${exitCode};CommandB64=${encoded}\u0007`;
}
const PROMPT_MARKER = '\u001b]1337;TabminalPrompt\u0007';

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

    it('replays buffered output when a client attaches', () => {
        session = new TerminalSession(pty, { historyLimit: 16 });
        pty.emitData('hello ');
        pty.emitData('world');

        const client = new MockSocket();
        session.attach(client);

        const payloads = client.sent.map((raw) => JSON.parse(raw));

        assert.strictEqual(payloads[0].type, 'snapshot');
        assert.strictEqual(payloads[0].data, 'hello world');

        assert.strictEqual(payloads[1].type, 'meta');

        assert.strictEqual(payloads[2].type, 'status');
        assert.strictEqual(payloads[2].status, 'ready');
    });

    it('writes user input to the underlying pty', () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);

        client.emit('message', JSON.stringify({
            type: 'input',
            data: 'ls\n'
        }));

        assert.strictEqual(pty.write.mock.calls.length, 1);
        assert.deepStrictEqual(pty.write.mock.calls[0].arguments, ['ls\n']);
    });

    it('resizes using sanitized values only', () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);

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

    it('stops accepting input after the pty exits', () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);

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

        const client = new MockSocket();
        session.attach(client);
        const payloads = client.sent.map((raw) => JSON.parse(raw));
        assert.strictEqual(payloads[0].data, '6789abcdef');
    });

    it('captures execution output between exit markers', () => {
        session = new TerminalSession(pty);
        pty.emitData('leask@Flora$ ' + PROMPT_MARKER);
        pty.emitData('ls\nfile.txt\n');
        pty.emitData(buildExitSequence(0, 'ls'));

        assert.ok(session.lastExecution);
        assert.strictEqual(session.lastExecution.command, 'ls');
        assert.strictEqual(session.lastExecution.exitCode, 0);
        assert.strictEqual(session.lastExecution.input, 'ls');
        assert.strictEqual(session.lastExecution.output, 'file.txt');
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

    it('does not forward control sequences to clients', () => {
        session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);
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
        this._listeners = {
            message: new Set(),
            close: new Set(),
            error: new Set()
        };
    }

    send(payload) {
        this.sent.push(payload);
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

    emit(event, payload) {
        for (const handler of this._listeners[event] ?? []) {
            handler(payload);
        }
    }
}
