import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/+esm';
import { CanvasAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-canvas@0.5.0/+esm';

// #region DOM Elements
const terminalEl = document.getElementById('terminal');
const statusEl = document.getElementById('status-pill');
const tabListEl = document.getElementById('tab-list');
const newTabButton = document.getElementById('new-tab-button');
const systemStatusBarEl = document.getElementById('system-status-bar');
// #endregion

// #region Configuration
const HEARTBEAT_INTERVAL_MS = 1000;
// #endregion

// #region FPS Counter
let frameCount = 0;
let lastFpsTime = performance.now();
let currentFps = 0;

function measureFps() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;
    }
    requestAnimationFrame(measureFps);
}
measureFps();
// #endregion

// #region Session Class
class Session {
// ... (keep existing Session class) ...
    constructor(data) {
        this.id = data.id;
        this.createdAt = data.createdAt;
        this.shell = data.shell || 'Terminal';
        this.initialCwd = data.initialCwd || '';
        
        this.title = data.title || this.shell.split('/').pop();
        this.cwd = data.cwd || this.initialCwd;
        this.env = data.env || '';
        this.cols = data.cols || 80;
        this.rows = data.rows || 24;

        this.history = '';
        this.socket = null;
        this.reconnectAttempts = 0;
        this.shouldReconnect = true;
        this.retryTimer = null;
        this.isRestoring = false;

        // Preview Terminal (Canvas renderer for performance)
        this.previewTerm = new Terminal({
            disableStdin: true,
            cursorBlink: false,
            allowTransparency: true,
            fontSize: 10,
            rows: this.rows,
            cols: this.cols,
            theme: { background: '#002b36', foreground: '#839496', cursor: 'transparent', selectionBackground: 'transparent' }
        });
        this.previewTerm.loadAddon(new CanvasAddon());
        this.wrapperElement = null;

        // Main Terminal
        this.mainTerm = new Terminal({
            allowTransparency: true,
            convertEol: true,
            cursorBlink: true,
            fontFamily: '"SF Mono Terminal", "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',
            fontSize: 12,
            rows: this.rows,
            cols: this.cols,
            theme: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642' }
        });
        this.mainFitAddon = new FitAddon();
        this.mainLinksAddon = new WebLinksAddon();
        this.mainTerm.loadAddon(this.mainFitAddon);
        this.mainTerm.loadAddon(this.mainLinksAddon);
        this.mainTerm.loadAddon(new CanvasAddon());

        // Event Listeners
        this.mainTerm.onData(data => {
            if (this.isRestoring) return;
            this.send({ type: 'input', data });
        });

        this.mainTerm.onResize(size => {
            this.previewTerm.resize(size.cols, size.rows);
            this.updatePreviewScale();
            this.send({ type: 'resize', cols: size.cols, rows: size.rows });
        });

        this.connect();
    }

    update(data) {
        let changed = false;
        if (data.title && data.title !== this.title) {
            this.title = data.title;
            changed = true;
        }
        if (data.cwd && data.cwd !== this.cwd) {
            this.cwd = data.cwd;
            changed = true;
        }
        if (data.env && data.env !== this.env) {
            this.env = data.env;
            changed = true;
        }
        
        if (data.cols && data.rows && (data.cols !== this.cols || data.rows !== this.rows)) {
            this.cols = data.cols;
            this.rows = data.rows;
            this.previewTerm.resize(this.cols, this.rows);
            this.updatePreviewScale();
        }

        if (changed) {
            this.updateTabUI();
        }
    }

    updatePreviewScale() {
        if (!this.wrapperElement) return;
        requestAnimationFrame(() => {
            if (!this.wrapperElement) return;
            this.wrapperElement.style.width = '';
            this.wrapperElement.style.height = '';
            this.wrapperElement.style.transform = '';
            
            const termWidth = this.previewTerm.element.offsetWidth;
            const termHeight = this.previewTerm.element.offsetHeight;
            
            if (termWidth === 0 || termHeight === 0) return;
            
            const container = this.wrapperElement.parentElement;
            const availableWidth = container.clientWidth;
            const availableHeight = container.clientHeight; // Use clientHeight to respect min-height
            
            // Calculate scale to fit width
            const scale = availableWidth / termWidth;
            
            this.wrapperElement.style.width = `${termWidth}px`;
            this.wrapperElement.style.height = `${termHeight}px`;
            
            const scaledHeight = termHeight * scale;
            const targetHeight = Math.max(76, scaledHeight); // Match CSS min-height
            container.style.height = `${targetHeight}px`;
            
            if (scaledHeight < targetHeight) {
                const topOffset = (targetHeight - scaledHeight) / 2;
                this.wrapperElement.style.transform = `translate(0px, ${topOffset}px) scale(${scale})`;
            } else {
                this.wrapperElement.style.transform = `scale(${scale})`;
            }
            this.wrapperElement.style.transformOrigin = 'top left';
        });
    }

    updateTabUI() {
        const tab = tabListEl.querySelector(`[data-session-id="${this.id}"]`);
        if (!tab) return;

        if (this.env) {
            tab.title = this.env;
        }

        const titleEl = tab.querySelector('.title');
        if (titleEl) titleEl.textContent = this.title;

        const metaEl = tab.querySelector('.meta-cwd');
        if (metaEl) {
            const shortened = shortenPath(this.cwd);
            metaEl.textContent = `PWD: ${shortened}`;
            metaEl.title = this.cwd;
        }
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const endpoint = `${protocol}://${window.location.host}/ws/${this.id}`;
        this.socket = new WebSocket(endpoint);

        this.socket.addEventListener('open', () => {
            this.reconnectAttempts = 0;
            if (state.activeSessionId === this.id) this.reportResize();
        });

        this.socket.addEventListener('message', (event) => {
            try {
                this.handleMessage(JSON.parse(event.data));
            } catch (_err) { /* ignore */ }
        });

        this.socket.addEventListener('close', () => {
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
                this.previewTerm.reset();
                this.mainTerm.reset();
                this.history = message.data || '';
                this.isRestoring = true;
                this.previewTerm.write(this.history);
                this.mainTerm.write(this.history, () => { this.isRestoring = false; });
                break;
            case 'output':
                this.history += message.data;
                this.writeToTerminals(message.data);
                break;
            case 'meta':
                this.update(message);
                break;
            case 'status':
                if (state.activeSessionId === this.id) setStatus(message.status);
                // Note: We don't removeSession here anymore; we let the heartbeat handle it.
                // But if the socket says 'terminated', we can mark it.
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
        if (this.mainTerm.cols && this.mainTerm.rows) {
            this.send({ type: 'resize', cols: this.mainTerm.cols, rows: this.mainTerm.rows });
        }
    }

    dispose() {
        this.shouldReconnect = false;
        clearTimeout(this.retryTimer);
        this.socket?.close();
        
        try {
            this.previewTerm.dispose();
        } catch (e) {
            if (!e.message?.includes('onRequestRedraw')) {
                console.warn('Error disposing preview terminal:', e);
            }
        }
        
        try {
            this.mainTerm.dispose();
        } catch (e) {
            if (!e.message?.includes('onRequestRedraw')) {
                console.warn('Error disposing main terminal:', e);
            }
        }
    }
}
// #endregion

// #region State Management
const state = {
    sessions: new Map(), // Map<id, Session>
    activeSessionId: null
};

async function syncSessions() {
    try {
        const response = await fetch('/api/heartbeat');
        if (!response.ok) return;
        const data = await response.json();
        
        // Handle legacy response (array) or new response (object)
        const sessions = Array.isArray(data) ? data : data.sessions;
        const system = data.system;

        reconcileSessions(sessions);
        if (system) {
            updateSystemStatus(system);
        }
    } catch (error) {
        console.error('Heartbeat failed:', error);
    }
}

function updateSystemStatus(system) {
    if (!systemStatusBarEl) return;

    const formatBytesPair = (used, total) => {
        if (total === 0) return '0/0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(total) / Math.log(k));
        const unit = sizes[i];
        const usedVal = parseFloat((used / Math.pow(k, i)).toFixed(1));
        const totalVal = parseFloat((total / Math.pow(k, i)).toFixed(1));
        return `${usedVal}/${totalVal}${unit}`;
    };

    const renderProgressBar = (percent) => {
        return `
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(100, Math.max(0, percent))}%;"></div>
            </div>
        `;
    };

    const memPercent = (system.memory.used / system.memory.total) * 100;

    const formatUptime = (seconds) => {
        const d = Math.floor(seconds / (3600 * 24));
        const h = Math.floor((seconds % (3600 * 24)) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        parts.push(`${m}m`);
        return parts.join(' ');
    };

    const items = [
        { label: 'Host', value: system.hostname },
        { label: 'OS', value: system.osName },
        { label: 'IP', value: system.ip },
        { label: 'CPU', value: `${system.cpu.usagePercent}% ${renderProgressBar(system.cpu.usagePercent)}` },
        { label: 'Mem', value: `${formatBytesPair(system.memory.used, system.memory.total)} ${memPercent.toFixed(0)}% ${renderProgressBar(memPercent)}` },
        { label: 'Up', value: formatUptime(system.uptime) },
        { label: 'Tabminal', value: formatUptime(system.processUptime) },
        { label: 'FPS', value: currentFps }
    ];

    systemStatusBarEl.innerHTML = items.map(item => `
        <div class="status-item">
            <span class="status-label">${item.label}:</span>
            <span class="status-value">${item.value}</span>
        </div>
    `).join('');
}

function reconcileSessions(remoteSessions) {
    const remoteIds = new Set(remoteSessions.map(s => s.id));
    const localIds = new Set(state.sessions.keys());

    // 1. Remove stale sessions
    for (const id of localIds) {
        if (!remoteIds.has(id)) {
            removeSession(id);
        }
    }

    // 2. Add new sessions or update existing
    for (const data of remoteSessions) {
        if (state.sessions.has(data.id)) {
            state.sessions.get(data.id).update(data);
        } else {
            const session = new Session(data);
            state.sessions.set(session.id, session);
            // If this is the first session, activate it
            if (!state.activeSessionId) {
                switchToSession(session.id);
            }
        }
    }

    // 3. Ensure active session is valid
    if (state.activeSessionId && !state.sessions.has(state.activeSessionId)) {
        state.activeSessionId = null;
        if (state.sessions.size > 0) {
            switchToSession(state.sessions.keys().next().value);
        } else {
            terminalEl.innerHTML = '';
        }
    }

    renderTabs();
}

async function createNewSession() {
    try {
        const response = await fetch('/api/sessions', { method: 'POST' });
        if (!response.ok) throw new Error('Failed to create session');
        const newSession = await response.json();
        // Immediate sync to reflect the new session
        await syncSessions();
        switchToSession(newSession.id);
    } catch (error) {
        console.error('Failed to create session:', error);
    }
}

function removeSession(id) {
    const session = state.sessions.get(id);
    if (session) {
        session.dispose();
        state.sessions.delete(id);
    }
}
// #endregion

// #region UI Logic
function renderTabs() {
    if (!tabListEl) return;

    const newTabItem = document.getElementById('new-tab-item');

    // Remove tabs that are no longer in state
    const tabElements = tabListEl.querySelectorAll('.tab-item');
    for (const el of tabElements) {
        if (!state.sessions.has(el.dataset.sessionId)) {
            el.remove();
        }
    }

    // Add or update tabs
    for (const [id, session] of state.sessions) {
        let tab = tabListEl.querySelector(`[data-session-id="${id}"]`);
        if (!tab) {
            tab = createTabElement(session);
            if (newTabItem) {
                tabListEl.insertBefore(tab, newTabItem);
            } else {
                tabListEl.appendChild(tab);
            }
            
            // Mount preview
            session.wrapperElement = tab.querySelector('.preview-terminal-wrapper');
            session.previewTerm.open(session.wrapperElement);
            session.updatePreviewScale();
            session.updateTabUI();
        }

        if (id === state.activeSessionId) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    }
}

function createTabElement(session) {
    const tab = document.createElement('li');
    tab.className = 'tab-item';
    tab.dataset.sessionId = session.id;
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-tab-button';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close Terminal';
    tab.appendChild(closeBtn);
    
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container';
    
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-terminal-wrapper';
    previewContainer.appendChild(wrapper);

    const overlay = document.createElement('div');
    overlay.className = 'tab-info-overlay';

    const title = document.createElement('div');
    title.className = 'title';

    const metaId = document.createElement('div');
    metaId.className = 'meta';
    const shortId = session.id.split('-').pop();
    metaId.textContent = `ID: ${shortId}`;

    const metaCwd = document.createElement('div');
    metaCwd.className = 'meta meta-cwd';

    const metaTime = document.createElement('div');
    metaTime.className = 'meta';
    
    const d = new Date(session.createdAt);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    let hh = d.getHours();
    const min = String(d.getMinutes()).padStart(2, '0');
    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12;
    hh = hh ? hh : 12;
    const hhStr = String(hh).padStart(2, '0');
    
    metaTime.textContent = `SINCE: ${mm}-${dd} ${hhStr}:${min} ${ampm}`;

    overlay.appendChild(title);
    overlay.appendChild(metaId);
    overlay.appendChild(metaCwd);
    overlay.appendChild(metaTime);

    tab.appendChild(previewContainer);
    tab.appendChild(overlay);
    
    return tab;
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
    if (state.activeSessionId === sessionId) return;

    state.activeSessionId = sessionId;
    renderTabs();

    const session = state.sessions.get(sessionId);
    
    // Clear main view
    terminalEl.innerHTML = '';
    
    // Mount new session
    session.mainTerm.open(terminalEl);
    session.mainFitAddon.fit();
    session.mainTerm.focus();
    
    session.reportResize();
}

function shortenPath(path) {
    if (!path) return '';
    const parts = path.split('/').filter(p => p.length > 0);
    if (parts.length === 0) return '/';
    if (parts.length <= 2) return path;
    const lastPart = parts.pop();
    const shortenedParts = parts.map(p => p[0]);
    let result = '/' + shortenedParts.join('/') + '/' + lastPart;
    if (result.length > 30) {
        result = '.../' + lastPart;
    }
    return result;
}
// #endregion

async function closeSession(id) {
    try {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        // The heartbeat will eventually sync the removal, but for better UX we can handle the UI update immediately
        // or just wait for the sync.
        // However, the requirement says: "If the closed session is the current one... select the previous one..."
        // We should handle the selection logic locally before or after the delete.
        
        const sessionIds = Array.from(state.sessions.keys());
        const index = sessionIds.indexOf(id);
        
        if (state.activeSessionId === id) {
            let nextId = null;
            if (index > 0) {
                nextId = sessionIds[index - 1];
            } else if (index < sessionIds.length - 1) {
                nextId = sessionIds[index + 1];
            }
            
            if (nextId) {
                switchToSession(nextId);
            } else {
                // No sessions left after this one is gone.
                // The backend might auto-create one, or we might need to trigger it.
                // If we rely on syncSessions, it will see 0 sessions and create one.
                // But let's be proactive.
                state.activeSessionId = null;
                terminalEl.innerHTML = '';
            }
        }
        
        // We can optimistically remove it from the map, but the heartbeat is the source of truth.
        // Let's just trigger a sync immediately after the delete returns.
        await syncSessions();
        
    } catch (error) {
        console.error('Failed to close session:', error);
    }
}

// #region Initialization & Event Listeners
const resizeObserver = new ResizeObserver(() => {
    if (state.activeSessionId && state.sessions.has(state.activeSessionId)) {
        const session = state.sessions.get(state.activeSessionId);
        session.mainFitAddon.fit();
        session.reportResize();
    }
});
resizeObserver.observe(terminalEl);

tabListEl.addEventListener('click', (event) => {
    const closeBtn = event.target.closest('.close-tab-button');
    if (closeBtn) {
        event.stopPropagation(); // Prevent switching to the tab we are closing
        const tabItem = closeBtn.closest('.tab-item');
        if (tabItem) {
            closeSession(tabItem.dataset.sessionId);
        }
        return;
    }

    const tabItem = event.target.closest('.tab-item');
    if (tabItem) {
        switchToSession(tabItem.dataset.sessionId);
    }
});

newTabButton.addEventListener('click', () => {
    createNewSession();
});

window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    for (const session of state.sessions.values()) {
        session.dispose();
    }
});

// Start the app
(async () => {
    await syncSessions();
    // If no sessions, create one
    if (state.sessions.size === 0) {
        await createNewSession();
    }
    setInterval(syncSessions, HEARTBEAT_INTERVAL_MS);
})();
// #endregion
