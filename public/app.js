import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/+esm';

// #region DOM Elements
const terminalEl = document.getElementById('terminal');
const statusEl = document.getElementById('status-pill');
const tabListEl = document.getElementById('tab-list');
const newTabButton = document.getElementById('new-tab-button');
// #endregion

// #region Xterm.js Setup
const terminal = new Terminal({
    allowTransparency: true,
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
    fontSize: 14,
    theme: {
        background: '#002b36',
        foreground: '#839496',
        cursor: '#93a1a1',
        cursorAccent: '#002b36',
        selectionBackground: '#073642',
        black: '#073642',
        red: '#dc322f',
        green: '#859900',
        yellow: '#b58900',
        blue: '#268bd2',
        magenta: '#d33682',
        cyan: '#2aa198',
        white: '#eee8d5',
        brightBlack: '#586e75',
        brightRed: '#cb4b16',
        brightGreen: '#586e75',
        brightYellow: '#657b83',
        brightBlue: '#839496',
        brightMagenta: '#6c71c4',
        brightCyan: '#93a1a1',
        brightWhite: '#fdf6e3'
    }
});
const fitAddon = new FitAddon();
const linksAddon = new WebLinksAddon();
terminal.loadAddon(fitAddon);
terminal.loadAddon(linksAddon);
terminal.open(terminalEl);
// #endregion

// This class is mostly unchanged, but it's kept for its robust reconnection logic.
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
        this._send({ type: 'input', data }, { enqueue: true });
    }

    reportResize(cols, rows) {
        this.lastResize = { type: 'resize', cols, rows };
        this._sendPendingResize();
    }

    dispose() {
        this.shouldReconnect = false;
        this.stopHeartbeat();
        if (this.retryTimer) {
            window.clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.socket?.close();
        this.queue = [];
        this.lastResize = null;
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = window.setInterval(() => {
            if (this.awaitingPong) return;
            if (this._send({ type: 'ping' })) {
                this.awaitingPong = true;
                this.heartbeatTimeout = window.setTimeout(() => {
                    if (this.awaitingPong) this.socket?.close();
                }, 5000);
            }
        }, 10000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        this.heartbeatInterval = null;
        this.heartbeatTimeout = null;
        this.awaitingPong = false;
    }

    flushQueue() {
        for (const job of this.queue) this._send(job);
        this.queue = [];
    }

    _sendPendingResize() {
        if (this.lastResize) this._send(this.lastResize);
    }

    _send(payload) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
            return true;
        }
        return false;
    }
}

// #region State Management
const state = {
    sessions: [],
    activeSessionId: null,
    connector: null,
    isRestoring: false
};
// #endregion

// #region API Functions
async function fetchSessions() {
    try {
        const response = await fetch('/api/sessions');
        if (!response.ok) throw new Error('Failed to fetch sessions');
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        setStatus('terminated'); // Show an error state
        return [];
    }
}

async function createNewSession() {
    try {
        const response = await fetch('/api/sessions', { method: 'POST' });
        if (!response.ok) throw new Error('Failed to create session');
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        return null;
    }
}
// #endregion

// #region UI Rendering
function renderTabs() {
    if (!tabListEl) return;

    const existingTabIds = new Set(
        [...tabListEl.querySelectorAll('.tab-item')].map(el => el.dataset.sessionId)
    );
    const newSessionIds = new Set(state.sessions.map(s => s.id));

    // Remove old tabs
    for (const tabId of existingTabIds) {
        if (!newSessionIds.has(tabId)) {
            tabListEl.querySelector(`[data-session-id="${tabId}"]`)?.remove();
        }
    }

    // Add or update tabs
    state.sessions.forEach(session => {
        let tab = tabListEl.querySelector(`[data-session-id="${session.id}"]`);
        if (!tab) {
            // Create new tab if it doesn't exist
            tab = document.createElement('li');
            tab.className = 'tab-item';
            tab.dataset.sessionId = session.id;
            tab.innerHTML = `
                <div class="preview-container">
                    <pre class="preview-content"></pre>
                </div>
                <div class="title">Terminal</div>
                <div class="meta">ID: ${session.id.substring(0, 8)}...</div>
                <div class="meta">Created: ${new Date(session.createdAt).toLocaleTimeString()}</div>
            `;
            tabListEl.appendChild(tab);
        }

        // Update active state
        if (session.id === state.activeSessionId) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}
// #endregion

// #region Preview WebSocket
function connectPreviewSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const endpoint = `${protocol}://${window.location.host}/ws/previews`;
    const socket = new WebSocket(endpoint);

    socket.addEventListener('message', (event) => {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'previews') {
                updatePreviews(payload.snapshots);
            }
        } catch (error) {
            console.error('Preview Error:', error);
        }
    });

    socket.addEventListener('close', () => {
        // Reconnect after a short delay
        setTimeout(connectPreviewSocket, 2000);
    });
}

function updatePreviews(snapshots) {
    snapshots.forEach(snapshot => {
        const tabEl = tabListEl.querySelector(`[data-session-id="${snapshot.id}"]`);
        if (tabEl) {
            const preEl = tabEl.querySelector('.preview-content');
            if (preEl) {
                preEl.textContent = snapshot.screen;
            }
        }
    });
}
// #endregion

// #region Core Logic
function setStatus(status) {
    if (!statusEl) return;
    const labels = {
        connecting: 'Connecting',
        connected: 'Connected',
        reconnecting: 'Reconnecting',
        terminated: 'Terminated',
        ready: 'Ready',
        unknown: 'Unknown'
    };
    statusEl.textContent = labels[status] ?? labels.unknown;
    statusEl.classList.add('visible');
    if (status === 'connected' || status === 'ready') {
        setTimeout(() => statusEl.classList.remove('visible'), 1500);
    }
}

function handleServerMessage(message) {
    switch (message.type) {
    case 'snapshot':
        terminal.reset();
        if (message.data) {
            state.isRestoring = true;
            terminal.write(message.data, () => {
                state.isRestoring = false;
            });
        }
        break;
    case 'output':
        terminal.write(message.data);
        break;
    case 'status':
        setStatus(message.status ?? 'unknown');
        if (message.status === 'terminated') {
            state.connector?.dispose();
            handleSessionTermination(state.activeSessionId);
        }
        break;
    }
}

async function switchToSession(sessionId) {
    if (!sessionId || state.activeSessionId === sessionId) {
        return;
    }

    state.activeSessionId = sessionId;
    state.connector?.dispose();
    terminal.reset();
    renderTabs();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const endpoint = `${protocol}://${window.location.host}/ws/${sessionId}`;
    state.connector = new TerminalConnector({
        endpoint,
        onMessage: handleServerMessage,
        onStatus: setStatus
    });
    state.connector.reportResize(terminal.cols, terminal.rows);
    terminal.focus();
}

async function handleSessionTermination(terminatedId) {
    state.sessions = state.sessions.filter(s => s.id !== terminatedId);
    if (state.sessions.length > 0) {
        // Switch to the first available session
        await switchToSession(state.sessions[0].id);
    } else {
        // All sessions are gone, create a new one
        const newSession = await createNewSession();
        if (newSession) {
            state.sessions.push(newSession);
            await switchToSession(newSession.id);
        } else {
            setStatus('terminated'); // Could not create a new session
        }
    }
    renderTabs();
}

async function initialize() {
    fitAddon.fit();
    terminal.focus();

    const sessions = await fetchSessions();
    if (sessions.length === 0) {
        // This case should be rare due to backend auto-creation, but handle it.
        const newSession = await createNewSession();
        if (newSession) {
            state.sessions = [newSession];
        }
    } else {
        state.sessions = sessions;
    }

    if (state.sessions.length > 0) {
        await switchToSession(state.sessions[0].id);
    } else {
        setStatus('terminated'); // Failed to get or create any session
    }
}
// #endregion

// #region Event Listeners
terminal.onData((data) => {
    if (!state.isRestoring) {
        state.connector?.sendInput(data);
    }
});

const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    state.connector?.reportResize(terminal.cols, terminal.rows);
});
resizeObserver.observe(terminalEl);

tabListEl.addEventListener('click', (event) => {
    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
        switchToSession(tabItem.dataset.sessionId);
    }
});

newTabButton.addEventListener('click', async () => {
    const newSession = await createNewSession();
    if (newSession) {
        state.sessions.push(newSession);
        await switchToSession(newSession.id);
    }
});

window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    state.connector?.dispose();
});
// #endregion

// Start the application

initialize();

connectPreviewSocket();
