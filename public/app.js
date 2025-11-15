import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/+esm';

const HEARTBEAT_INTERVAL = 10000;
const HEARTBEAT_TIMEOUT = 5000;

class TerminalConnector {
    constructor({ endpoint, onMessage, onStatus }) {
        this.endpoint = endpoint;
        this.onMessage = onMessage;
        this.onStatus = onStatus;
        this.reconnectAttempts = 0;
        this.shouldReconnect = true;
        this.queue = [];
        this.lastResize = null;
        this.retryTimer = null;
        this.heartbeatInterval = null;
        this.heartbeatTimeout = null;
        this.awaitingPong = false;
        this.connect();
    }

    connect() {
        this.onStatus?.('connecting');
        const socket = new WebSocket(this.endpoint);
        this.socket = socket;

        socket.addEventListener('open', () => {
            this.reconnectAttempts = 0;
            this.onStatus?.('connected');
            this.flushQueue();
            this._sendPendingResize();
            this.startHeartbeat();
        });

        socket.addEventListener('message', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.type === 'pong') {
                    this.handlePong();
                    return;
                }
                this.onMessage?.(payload);
            } catch (_err) {
                // swallow malformed payloads
            }
        });

        socket.addEventListener('close', () => {
            this.stopHeartbeat();
            if (!this.shouldReconnect) {
                this.onStatus?.('terminated');
                return;
            }
            this.onStatus?.('reconnecting');
            const wait = Math.min(5000, 500 * 2 ** this.reconnectAttempts);
            this.reconnectAttempts += 1;
            this.retryTimer = window.setTimeout(() => {
                this.retryTimer = null;
                this.connect();
            }, wait);
        });

        socket.addEventListener('error', () => {
            socket.close();
        });
    }

    sendInput(data) {
        this._send(
            { type: 'input', data },
            { enqueue: true }
        );
    }

    reportResize(cols, rows) {
        this.lastResize = {
            type: 'resize',
            cols,
            rows
        };
        this._sendPendingResize();
    }

    freeze() {
        this.shouldReconnect = false;
        this.stopHeartbeat();
        this._clearRetryTimer();
        this.socket?.close();
    }

    dispose() {
        this.shouldReconnect = false;
        this.stopHeartbeat();
        this._clearRetryTimer();
        this.socket?.close();
        this.queue = [];
        this.lastResize = null;
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = window.setInterval(() => {
            if (this.awaitingPong) {
                return;
            }
            if (this._send({ type: 'ping' })) {
                this.awaitingPong = true;
                this.heartbeatTimeout = window.setTimeout(() => {
                    if (this.awaitingPong) {
                        this.socket?.close();
                    }
                }, HEARTBEAT_TIMEOUT);
            }
        }, HEARTBEAT_INTERVAL);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            window.clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.heartbeatTimeout) {
            window.clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
        this.awaitingPong = false;
    }

    flushQueue() {
        if (!this.queue.length) {
            return;
        }
        const pending = [...this.queue];
        this.queue = [];
        for (const job of pending) {
            this._send(job);
        }
    }

    _sendPendingResize() {
        if (!this.lastResize) {
            return;
        }
        this._send(this.lastResize);
    }

    _send(payload, options = {}) {
        const socket = this.socket;
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(payload));
            return true;
        }
        if (options.enqueue) {
            this.queue.push(payload);
        }
        return false;
    }

    _clearRetryTimer() {
        if (this.retryTimer) {
            window.clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    handlePong() {
        this.awaitingPong = false;
        if (this.heartbeatTimeout) {
            window.clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
    }
}

const terminalEl = document.getElementById('terminal');
const statusEl = document.getElementById('status-pill');

const terminal = new Terminal({
    allowTransparency: true,
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
    fontSize: 14,
    theme: {
        background: '#050709',
        cursor: '#7dd3fc',
        cursorAccent: '#050709',
        foreground: '#f8fafc',
        black: '#0f172a'
    }
});
const fitAddon = new FitAddon();
const linksAddon = new WebLinksAddon();
terminal.loadAddon(fitAddon);
terminal.loadAddon(linksAddon);
terminal.open(terminalEl);
fitAddon.fit();
terminal.focus();

const connector = new TerminalConnector({
    endpoint: buildWebSocketUrl('/ws'),
    onMessage: handleServerMessage,
    onStatus: setStatus
});
connector.reportResize(terminal.cols, terminal.rows);

terminal.onData((data) => {
    connector.sendInput(data);
});

const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    connector.reportResize(terminal.cols, terminal.rows);
});
resizeObserver.observe(terminalEl);

window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    connector.dispose();
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        return;
    }
    fitAddon.fit();
    connector.reportResize(terminal.cols, terminal.rows);
});

function handleServerMessage(message) {
    switch (message.type) {
    case 'snapshot':
        terminal.reset();
        if (message.data) {
            terminal.write(message.data);
        }
        break;
    case 'output':
        terminal.write(message.data);
        break;
    case 'status':
        setStatus(message.status ?? 'unknown');
        if (message.status === 'terminated') {
            connector.freeze();
        }
        break;
    case 'pong':
    default:
        break;
    }
}

function setStatus(state) {
    if (!statusEl) {
        return;
    }
    const labels = {
        connecting: '連線中',
        connected: '已連線',
        reconnecting: '重新連線',
        terminated: '程序已結束',
        ready: '可用',
        unknown: '狀態未知'
    };
    statusEl.textContent = labels[state] ?? labels.unknown;
    statusEl.classList.add('visible');
    if (state === 'connected' || state === 'ready') {
        window.setTimeout(() => {
            statusEl.classList.remove('visible');
        }, 1500);
    }
}

function buildWebSocketUrl(pathname) {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}${pathname}`;
}
