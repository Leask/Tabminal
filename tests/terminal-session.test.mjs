import { describe, expect, it, vi, beforeEach } from 'vitest';

import { TerminalSession } from '../src/terminal-session.mjs';

describe('TerminalSession', () => {
    let pty;

    beforeEach(() => {
        pty = new FakePty();
    });

    it('replays buffered output when a client attaches', () => {
        const session = new TerminalSession(pty, { historyLimit: 16 });
        pty.emitData('hello ');
        pty.emitData('world');

        const client = new MockSocket();
        session.attach(client);

        const payloads = client.sent.map((raw) => JSON.parse(raw));
        expect(payloads[0]).toMatchObject({
            type: 'snapshot',
            data: 'hello world'
        });
        expect(payloads[1]).toMatchObject({
            type: 'meta'
        });
        expect(payloads[2]).toMatchObject({
            type: 'status',
            status: 'ready'
        });
    });

    it('writes user input to the underlying pty', () => {
        const session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);

        client.emit('message', JSON.stringify({
            type: 'input',
            data: 'ls\n'
        }));

        expect(pty.write).toHaveBeenCalledWith('ls\n');
    });

    it('resizes using sanitized values only', () => {
        const session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);

        client.emit('message', JSON.stringify({
            type: 'resize',
            cols: -5,
            rows: 'bad'
        }));
        expect(pty.resize).not.toHaveBeenCalled();

        client.emit('message', JSON.stringify({
            type: 'resize',
            cols: 200,
            rows: 40
        }));
        expect(pty.resize).toHaveBeenCalledWith(200, 40);
    });

    it('stops accepting input after the pty exits', () => {
        const session = new TerminalSession(pty);
        const client = new MockSocket();
        session.attach(client);

        pty.emitExit({ exitCode: 0 });
        client.emit('message', JSON.stringify({
            type: 'input',
            data: 'echo nope'
        }));

        expect(pty.write).not.toHaveBeenCalled();
        const payloads = client.sent.map((raw) => JSON.parse(raw));
        expect(payloads).toContainEqual({
            type: 'status',
            status: 'terminated',
            code: 0,
            signal: null
        });
    });

    it('trims history to configured limit', () => {
        const session = new TerminalSession(pty, { historyLimit: 10 });
        pty.emitData('0123456789'); // fill
        pty.emitData('abcdef'); // push over

        const client = new MockSocket();
        session.attach(client);
        const payloads = client.sent.map((raw) => JSON.parse(raw));
        expect(payloads[0]).toMatchObject({
            data: '6789abcdef'
        });
    });
});

class FakePty {
    constructor() {
        this.write = vi.fn();
        this.resize = vi.fn();
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
