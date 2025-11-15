import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/+esm';
import { CanvasAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-canvas@0.5.0/+esm';

// #region DOM Elements
const terminalEl = document.getElementById('terminal');
const statusEl = document.getElementById('status-pill');
const tabListEl = document.getElementById('tab-list');
const newTabButton = document.getElementById('new-tab-button');
// #endregion

// #region Session Management
class Session {
    constructor(data) {
        this.id = data.id;
        this.createdAt = data.createdAt;
        this.history = ''; // Client-side history buffer
        this.socket = null;
        this.reconnectAttempts = 0;
        this.shouldReconnect = true;
        this.retryTimer = null;
        this.heartbeatInterval = null;
        this.heartbeatTimeout = null;
        this.awaitingPong = false;
        this.isRestoring = false;

        // Preview Terminal (Sidebar)
        this.previewTerm = new Terminal({
            allowTransparency: true,
            cursorBlink: false,
            disableStdin: true, // Read-only
            fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
            fontSize: 10, // Smaller font for preview
            theme: {
                background: '#002b36',
                foreground: '#839496',
                cursor: 'transparent', // Hide cursor in preview
                selectionBackground: 'transparent',
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
            },
            rows: 24, // Default, will be resized by fit addon or content
            cols: 80
        });
        this.previewFitAddon = new FitAddon();
        this.previewTerm.loadAddon(this.previewFitAddon);
        this.previewTerm.loadAddon(new CanvasAddon());

        // Main Terminal (Active View) - Created on demand or kept alive?
        // To ensure "live" switching without re-buffering, we keep it alive but unmounted.
        this.mainTerm = new Terminal({
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
        this.mainFitAddon = new FitAddon();
        this.mainLinksAddon = new WebLinksAddon();
        this.mainTerm.loadAddon(this.mainFitAddon);
        this.mainTerm.loadAddon(this.mainLinksAddon);
        this.mainTerm.loadAddon(new CanvasAddon());

        // Hook up input on main terminal
        this.mainTerm.onData(data => {
            if (this.isRestoring) return;
            this.send({ type: 'input', data });
        });

        // Handle resizing on main terminal
        this.mainTerm.onResize(size => {
            this.send({ type: 'resize', cols: size.cols, rows: size.rows });
        });

        this.connect();
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const endpoint = `${protocol}://${window.location.host}/ws/${this.id}`;
        
        this.socket = new WebSocket(endpoint);

        this.socket.addEventListener('open', () => {
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            // If this is the active session, report resize immediately
            if (state.activeSessionId === this.id) {
                this.reportResize();
            }
        });

        this.socket.addEventListener('message', (event) => {
            try {
                const payload = JSON.parse(event.data);
                this.handleMessage(payload);
            } catch (_err) {
                // ignore
            }
        });

        this.socket.addEventListener('close', () => {
            this.stopHeartbeat();
            if (this.shouldReconnect) {
                const wait = Math.min(5000, 500 * 2 ** this.reconnectAttempts);
                this.reconnectAttempts++;
                this.retryTimer = setTimeout(() => this.connect(), wait);
            }
        });
    }

    handleMessage(message) {
        switch (message.type) {
            case 'snapshot':
                // Reset terminals and write history
                this.previewTerm.reset();
                this.mainTerm.reset();
                this.history = message.data || '';
                
                this.isRestoring = true;
                this.previewTerm.write(this.history);
                this.mainTerm.write(this.history, () => {
                    this.isRestoring = false;
                });
                break;
            case 'output':
                this.history += message.data;
                this.writeToTerminals(message.data);
                break;
            case 'pong':
                this.awaitingPong = false;
                break;
            case 'status':
                if (state.activeSessionId === this.id) {
                    setStatus(message.status);
                }
                if (message.status === 'terminated') {
                    this.dispose();
                    removeSession(this.id);
                }
                break;
        }
    }

    writeToTerminals(data) {
        this.previewTerm.write(data);
        this.mainTerm.write(data);
    }

    send(payload) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
        }
    }

    reportResize() {
        // We only care about the main terminal's size for the PTY
        if (this.mainTerm.cols && this.mainTerm.rows) {
            this.send({
                type: 'resize',
                cols: this.mainTerm.cols,
                rows: this.mainTerm.rows
            });
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (this.awaitingPong) return;
            this.send({ type: 'ping' });
            this.awaitingPong = true;
            this.heartbeatTimeout = setTimeout(() => {
                if (this.awaitingPong) this.socket?.close();
            }, 5000);
        }, 10000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        this.heartbeatInterval = null;
        this.heartbeatTimeout = null;
        this.awaitingPong = false;
    }

    dispose() {
        this.shouldReconnect = false;
        this.stopHeartbeat();
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.socket?.close();
        this.previewTerm.dispose();
        this.mainTerm.dispose();
    }
}

const state = {
    sessions: new Map(), // Map<id, Session>
    activeSessionId: null
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

// #region UI Logic
function renderTabs() {
    if (!tabListEl) return;

    const existingTabIds = new Set(
        [...tabListEl.querySelectorAll('.tab-item')].map(el => el.dataset.sessionId)
    );
    const currentSessionIds = new Set(state.sessions.keys());

    // Remove old tabs
    for (const tabId of existingTabIds) {
        if (!currentSessionIds.has(tabId)) {
            const tab = tabListEl.querySelector(`[data-session-id="${tabId}"]`);
            tab?.remove();
        }
    }

    // Add or update tabs
    for (const [id, session] of state.sessions) {
        let tab = tabListEl.querySelector(`[data-session-id="${id}"]`);
        if (!tab) {
            tab = document.createElement('li');
            tab.className = 'tab-item';
            tab.dataset.sessionId = id;
            
            const previewContainer = document.createElement('div');
            previewContainer.className = 'preview-container';
            
            const wrapper = document.createElement('div');
            wrapper.className = 'preview-terminal-wrapper';
            previewContainer.appendChild(wrapper);

            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = 'Terminal';

            const metaId = document.createElement('div');
            metaId.className = 'meta';
            metaId.textContent = `ID: ${id.substring(0, 8)}...`;

            const metaTime = document.createElement('div');
            metaTime.className = 'meta';
            metaTime.textContent = `Created: ${new Date(session.createdAt).toLocaleTimeString()}`;

            tab.appendChild(previewContainer);
            tab.appendChild(title);
            tab.appendChild(metaId);
            tab.appendChild(metaTime);
            tabListEl.appendChild(tab);

            // Mount the preview terminal
            session.previewTerm.open(wrapper);
            session.previewFitAddon.fit();
        }

        if (id === state.activeSessionId) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    }
}

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

async function switchToSession(sessionId) {
    if (!sessionId || !state.sessions.has(sessionId)) return;

    // Unmount current terminal if any
    if (state.activeSessionId && state.sessions.has(state.activeSessionId)) {
        const currentSession = state.sessions.get(state.activeSessionId);
        // We don't dispose, just detach from DOM? xterm doesn't have a simple detach.
        // But we can clear the container.
    }

    state.activeSessionId = sessionId;
    renderTabs();

    const session = state.sessions.get(sessionId);
    
    // Clear the main terminal container
    terminalEl.innerHTML = '';
    
    // Mount the new session's main terminal
    session.mainTerm.open(terminalEl);
    session.mainFitAddon.fit();
    session.mainTerm.focus();
    
    // Trigger a resize report to sync PTY size
    session.reportResize();
}

async function removeSession(id) {
    if (state.sessions.has(id)) {
        state.sessions.delete(id);
        renderTabs();
        
        if (state.activeSessionId === id) {
            state.activeSessionId = null;
            terminalEl.innerHTML = ''; // Clear main view
            
            // Switch to another session if available
            if (state.sessions.size > 0) {
                await switchToSession(state.sessions.keys().next().value);
            } else {
                // Create new session if none left
                const newSessionData = await createNewSession();
                if (newSessionData) {
                    const newSession = new Session(newSessionData);
                    state.sessions.set(newSession.id, newSession);
                    await switchToSession(newSession.id);
                }
            }
        }
    }
}

async function initialize() {
    const sessionsData = await fetchSessions();
    
    if (sessionsData.length === 0) {
        const newSessionData = await createNewSession();
        if (newSessionData) {
            sessionsData.push(newSessionData);
        }
    }

    for (const data of sessionsData) {
        const session = new Session(data);
        state.sessions.set(session.id, session);
    }

    renderTabs();

    if (state.sessions.size > 0) {
        await switchToSession(state.sessions.keys().next().value);
    }
}
// #endregion

// #region Event Listeners
const resizeObserver = new ResizeObserver(() => {
    if (state.activeSessionId && state.sessions.has(state.activeSessionId)) {
        const session = state.sessions.get(state.activeSessionId);
        session.mainFitAddon.fit();
        session.reportResize();
    }
});
resizeObserver.observe(terminalEl);

tabListEl.addEventListener('click', (event) => {
    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
        switchToSession(tabItem.dataset.sessionId);
    }
});

newTabButton.addEventListener('click', async () => {
    const newSessionData = await createNewSession();
    if (newSessionData) {
        const session = new Session(newSessionData);
        state.sessions.set(session.id, session);
        await switchToSession(session.id);
    }
});

window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    for (const session of state.sessions.values()) {
        session.dispose();
    }
});
// #endregion

// Start
initialize();