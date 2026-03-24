import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/+esm';
import { CanvasAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-canvas@0.5.0/+esm';
import { SearchAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-search@0.13.0/+esm';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify/+esm';
import {
    normalizeBaseUrl,
    getServerEndpointKeyFromUrl,
    getUrlHostname,
    normalizeHostAlias,
    isAccessRedirectResponse,
    buildAccessLoginUrl,
    isLikelyAccessLoginResponse,
    buildTokenStorageKey,
    makeSessionKey,
    splitSessionKey,
    hashPassword
} from './modules/url-auth.js';
import {
    shortenPath,
    getEnvValue,
    getDisplayHost,
    renderSessionHostMeta
} from './modules/session-meta.js';
import {
    NotificationManager,
    ToastManager
} from './modules/notifications.js';

// Detect Mobile/Tablet (focus on touch capability for font sizing)
// Logic: If the device supports touch, we assume it needs larger fonts (14px)
const IS_MOBILE = navigator.maxTouchPoints > 0;

const AGENT_MESSAGE_MAX_RENDER_BYTES = 64 * 1024;

// #region DOM Elements
const terminalEl = document.getElementById('terminal');
const tabListEl = document.getElementById('tab-list');
const legacyNewTabButton = document.getElementById('new-tab-button');
const loginModal = document.getElementById('login-modal');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const serverControlsEl = document.getElementById('server-controls');
const addServerButton = document.getElementById('add-server-button');
const addServerModal = document.getElementById('add-server-modal');
const addServerForm = document.getElementById('add-server-form');
const addServerUrlInput = document.getElementById('server-url-input');
const addServerHostInput = document.getElementById('server-host-input');
const addServerPasswordInput = document.getElementById('server-password-input');
const addServerError = document.getElementById('add-server-error');
const addServerCancel = document.getElementById('add-server-cancel');
const addServerTitle = addServerModal?.querySelector('h2') || null;
const addServerDescription = addServerModal?.querySelector('p') || null;
const addServerSubmitButton = addServerForm?.querySelector('button[type="submit"]') || null;
const terminalWrapper = document.getElementById('terminal-wrapper');
const editorPane = document.getElementById('editor-pane');
// #endregion

// #region Configuration
const HEARTBEAT_INTERVAL_MS = 1000;
const RECONNECT_RETRY_MS = 5000;
const MAIN_SERVER_ID = 'main';
const RUNTIME_BOOT_ID_STORAGE_KEY = 'tabminal_runtime_boot_id';
const FILE_WORKSPACE_TAB_PREFIX = 'file:';
const AGENT_WORKSPACE_TAB_PREFIX = 'agent:';
const CLOSE_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
const AGENT_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M9 7V5"></path><path d="M15 7V5"></path><path d="M12 17v2"></path><path d="M5 12H3"></path><path d="M21 12h-2"></path><path d="M9 11h.01"></path><path d="M15 11h.01"></path><path d="M9.5 14c.7.67 1.53 1 2.5 1s1.8-.33 2.5-1"></path></svg>';
const serverModalState = {
    mode: 'add',
    targetServerId: null
};
let primaryServerBootId = '';
let runtimeReloadScheduled = false;
// #endregion

function makeFileWorkspaceTabKey(filePath) {
    return `${FILE_WORKSPACE_TAB_PREFIX}${filePath}`;
}

function makeAgentTabKey(serverId, tabId) {
    return `${AGENT_WORKSPACE_TAB_PREFIX}${serverId}:${tabId}`;
}

function isAgentWorkspaceTabKey(key) {
    return typeof key === 'string'
        && key.startsWith(AGENT_WORKSPACE_TAB_PREFIX);
}

function isFileWorkspaceTabKey(key) {
    return typeof key === 'string'
        && key.startsWith(FILE_WORKSPACE_TAB_PREFIX);
}

function workspaceKeyToFilePath(key) {
    if (!isFileWorkspaceTabKey(key)) return '';
    return key.slice(FILE_WORKSPACE_TAB_PREFIX.length);
}

// #region Sidebar Toggle (Mobile)
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

if (sidebarToggle && sidebar && sidebarOverlay) {
    const closeSidebar = () => {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('open');
    };

    sidebarToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('open');
    });

    sidebarOverlay.addEventListener('click', closeSidebar);

    // Close sidebar when a tab is clicked (Mobile UX)
    if (tabListEl) {
        tabListEl.addEventListener('click', (e) => {
            // Only close if we actually clicked a tab item (not empty space)
            if (e.target.closest('.tab-item') && window.innerWidth < 768) {
                closeSidebar();
            }
        });
    }
}
// #endregion

// #region Auth and Server Client
async function probeAccessLoginUrl(server, path = '/api/heartbeat') {
    if (!server || server.isPrimary) return '';
    try {
        const response = await fetch(server.resolveUrl(path), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...server.getHeaders()
            },
            body: JSON.stringify({ updates: { sessions: [] } }),
            credentials: 'include',
            redirect: 'manual',
            cache: 'no-store'
        });
        if (!isLikelyAccessLoginResponse(response)) {
            return '';
        }
        return buildAccessLoginUrl(server);
    } catch {
        return '';
    }
}

function openAccessLoginPage(server) {
    if (!server || server.isPrimary) return false;
    const targetUrl = buildAccessLoginUrl(server);
    const link = document.createElement('a');
    link.href = targetUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
}

function readRuntimeBootId() {
    try {
        return localStorage.getItem(RUNTIME_BOOT_ID_STORAGE_KEY) || '';
    } catch {
        return '';
    }
}

function persistRuntimeBootId(bootId) {
    try {
        localStorage.setItem(RUNTIME_BOOT_ID_STORAGE_KEY, bootId);
        return localStorage.getItem(RUNTIME_BOOT_ID_STORAGE_KEY) === bootId;
    } catch {
        return false;
    }
}

function handlePrimaryRuntimeVersion(data) {
    const runtime = data?.runtime;
    const bootIdRaw = runtime?.bootId;
    if (!bootIdRaw) return;
    const bootId = String(bootIdRaw);
    if (!bootId) return;
    const storedBootId = readRuntimeBootId();

    if (!primaryServerBootId) {
        primaryServerBootId = bootId;
        if (storedBootId === bootId) {
            return;
        }
        const persisted = persistRuntimeBootId(bootId);
        if (storedBootId && persisted && !runtimeReloadScheduled) {
            runtimeReloadScheduled = true;
            console.info('[Runtime] Syncing app shell cache key with server boot id.');
            window.location.reload();
        }
        return;
    }
    if (primaryServerBootId === bootId) {
        if (storedBootId !== bootId) {
            persistRuntimeBootId(bootId);
        }
        return;
    }
    if (runtimeReloadScheduled) return;

    primaryServerBootId = bootId;
    const persisted = persistRuntimeBootId(bootId);
    if (!persisted) {
        console.warn('[Runtime] Failed to persist cache key; skip forced reload.');
        return;
    }
    runtimeReloadScheduled = true;
    console.info('[Runtime] Main server restarted. Reloading app shell.');
    window.location.reload();
}

class AuthManager {
    showLoginModal(errorMsg = '') {
        loginModal.style.display = 'flex';
        passwordInput.value = '';
        passwordInput.focus();
        loginError.textContent = errorMsg || '';
    }

    hideLoginModal() {
        loginModal.style.display = 'none';
        loginError.textContent = '';
    }
}

class ServerClient {
    constructor(data, { isPrimary = false } = {}) {
        this.id = data.id;
        this.host = normalizeHostAlias(data.host);
        this.baseUrl = normalizeBaseUrl(data.baseUrl);
        this.isPrimary = isPrimary;
        this.connectionStatus = 'disconnected';
        this.lastSystemData = null;
        this.lastLatency = 0;
        this.heartbeatHistory = [];
        this.heartbeatHasInitialized = false;
        this.heartbeatLastUpdateTime = performance.now();
        this.heartbeatSmoothedMaxVal = 1;
        this.heartbeatTimer = null;
        this.nextSyncAt = 0;
        this.agentStateLoaded = false;
        this.needsAccessLogin = false;
        this.accessLoginUrl = '';
        this.expandedPaths = new Set();
        this.modelStore = new Map();
        const key = buildTokenStorageKey(this.id);
        const persistedToken = typeof data.token === 'string' ? data.token : '';
        if (this.isPrimary) {
            this.token = persistedToken || localStorage.getItem(key) || '';
            if (this.token) {
                localStorage.setItem(key, this.token);
            }
        } else {
            this.token = persistedToken;
            localStorage.removeItem(key);
        }
        this.isAuthenticated = !!this.token;
        this.needsLogin = !this.isAuthenticated;
    }

    setToken(token) {
        const normalizedToken = typeof token === 'string' ? token.trim() : '';
        this.token = normalizedToken;
        this.isAuthenticated = !!this.token;
        this.needsLogin = !this.isAuthenticated;
        this.nextSyncAt = 0;

        const key = buildTokenStorageKey(this.id);
        if (this.isPrimary) {
            if (this.token) {
                localStorage.setItem(key, this.token);
            } else {
                localStorage.removeItem(key);
            }
        } else {
            localStorage.removeItem(key);
        }
    }

    toJSON() {
        return {
            id: this.id,
            host: this.host,
            baseUrl: this.baseUrl,
            token: this.token
        };
    }

    getHeaders() {
        return this.token ? { 'Authorization': this.token } : {};
    }

    resolveUrl(path) {
        return new URL(path, `${this.baseUrl}/`).toString();
    }

    resolveWsUrl(sessionId, token = '') {
        const base = new URL(this.baseUrl);
        const shouldUseSecureWs = (
            base.protocol === 'https:'
            || window.location.protocol === 'https:'
        );
        const wsProtocol = shouldUseSecureWs ? 'wss:' : 'ws:';
        const wsUrl = new URL(`/ws/${sessionId}`, `${wsProtocol}//${base.host}`);
        if (token) {
            wsUrl.searchParams.set('token', token);
        }
        return wsUrl.toString();
    }

    resolveAgentWsUrl(tabId, token = '') {
        const base = new URL(this.baseUrl);
        const shouldUseSecureWs = (
            base.protocol === 'https:'
            || window.location.protocol === 'https:'
        );
        const wsProtocol = shouldUseSecureWs ? 'wss:' : 'ws:';
        const wsUrl = new URL(
            `/ws/agents/${tabId}`,
            `${wsProtocol}//${base.host}`
        );
        if (token) {
            wsUrl.searchParams.set('token', token);
        }
        return wsUrl.toString();
    }

    async login(password) {
        const hashed = await hashPassword(password);
        await this.loginWithToken(hashed);
    }

    async loginWithToken(token) {
        this.setToken(token);
        this.needsAccessLogin = false;
        this.accessLoginUrl = '';
        renderServerControls();
        await syncServer(this);
        this.startHeartbeat();
    }

    clearAuth() {
        this.setToken('');
        this.needsAccessLogin = false;
        this.accessLoginUrl = '';
        this.agentStateLoaded = false;
        this.stopHeartbeat();
        if (!this.isPrimary) {
            syncServerList().catch(() => {});
        }
    }

    async fetch(path, options = {}) {
        const headers = {
            ...options.headers,
            ...this.getHeaders()
        };
        const response = await fetch(this.resolveUrl(path), {
            ...options,
            headers,
            credentials: options.credentials || 'include',
            redirect: options.redirect || (this.isPrimary ? 'follow' : 'manual')
        });
        if (!this.isPrimary && isAccessRedirectResponse(response)) {
            this.handleAccessRedirect();
            const error = new Error('Cloudflare Access redirect');
            error.code = 'ACCESS_REDIRECT';
            throw error;
        }
        if (response.status === 401) {
            this.handleUnauthorized();
            throw new Error('Unauthorized');
        }
        if (response.status === 403) {
            const data = await response.json().catch(() => ({}));
            this.handleUnauthorized(data.error || 'Service locked');
            throw new Error('Service locked');
        }
        return response;
    }

    handleUnauthorized(message = '') {
        this.needsAccessLogin = false;
        this.accessLoginUrl = '';
        if (this.isPrimary) {
            this.clearAuth();
            setStatus(this, 'reconnecting');
            renderServerControls();
            auth.showLoginModal(message || 'Authentication required.');
        } else {
            // Keep sub-host token untouched; only stop sync and require manual reconnect.
            this.stopHeartbeat();
            this.nextSyncAt = 0;
            setStatus(this, 'reconnecting');
            renderServerControls();
            alert(`${getDisplayHost(this)} needs login.`, {
                type: 'warning',
                title: 'Host'
            });
        }
    }

    handleAccessRedirect() {
        if (this.isPrimary) return;
        const loginUrl = buildAccessLoginUrl(this);
        const wasRequired = this.needsAccessLogin;
        this.needsAccessLogin = true;
        this.accessLoginUrl = loginUrl;
        setStatus(this, 'reconnecting');
        renderServerControls();
        if (!wasRequired) {
            alert(
                `${getDisplayHost(this)} needs Cloudflare login. `
                + 'Click "Cloudflare Login".',
                {
                    type: 'warning',
                    title: 'Host'
                }
            );
        }
    }

    startHeartbeat() {
        if (!this.isAuthenticated || this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(() => {
            syncServer(this);
        }, HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (!this.heartbeatTimer) return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }
}

const auth = new AuthManager();
// #endregion

// #region Editor Manager
class EditorManager {
    constructor() {
        this.currentSession = null;
        this.iconMap = null;
        
        // DOM Elements
        this.pane = document.getElementById('editor-pane');
        this.resizer = document.getElementById('editor-resizer');
        this.tabsContainer = document.getElementById('editor-tabs');
        this.contentContainer = document.getElementById('editor-content');
        this.monacoContainer = document.getElementById('monaco-container');
        this.imagePreviewContainer = document.getElementById('image-preview-container');
        this.imagePreview = document.getElementById('image-preview');
        this.emptyState = document.getElementById('empty-editor-state');
        this.agentContainer = null;
        this.agentHeader = null;
        this.agentMeta = null;
        this.agentToolbar = null;
        this.agentModeSelect = null;
        this.agentNewChatButton = null;
        this.agentCommands = null;
        this.agentTranscript = null;
        this.agentTools = null;
        this.agentPermissions = null;
        this.agentPrompt = null;
        this.agentSendButton = null;
        this.agentHint = null;
        this.agentFixedActions = null;
        this.agentCommandMenu = null;
        this.agentCommandSuggestions = [];
        this.agentCommandIndex = 0;

        this.initResizer();
        this.initAgentPanel();
        this.initMonaco();
        this.loadIconMap();
    }

    initAgentPanel() {
        this.agentContainer = document.createElement('div');
        this.agentContainer.className = 'agent-panel';
        this.agentContainer.style.display = 'none';

        const header = document.createElement('div');
        header.className = 'agent-panel-header';
        header.style.display = 'none';

        const headerTop = document.createElement('div');
        headerTop.className = 'agent-panel-header-top';

        const headerMain = document.createElement('div');
        headerMain.className = 'agent-panel-header-main';

        this.agentHeader = document.createElement('div');
        this.agentHeader.className = 'agent-panel-title';

        this.agentMeta = document.createElement('div');
        this.agentMeta.className = 'agent-panel-meta';

        headerMain.appendChild(this.agentHeader);
        headerMain.appendChild(this.agentMeta);

        this.agentModeSelect = document.createElement('select');
        this.agentModeSelect.className = 'agent-panel-mode-select';
        this.agentModeSelect.addEventListener('change', async () => {
            const modeId = this.agentModeSelect.value;
            if (!modeId) return;
            await this.setActiveAgentMode(modeId);
        });

        this.agentNewChatButton = document.createElement('button');
        this.agentNewChatButton.type = 'button';
        this.agentNewChatButton.className = 'agent-panel-button secondary';
        this.agentNewChatButton.textContent = 'New Chat';
        this.agentNewChatButton.addEventListener('click', async () => {
            const agentTab = getActiveAgentTab();
            if (!agentTab) return;
            await this.createSiblingAgentTab(agentTab);
        });

        headerTop.appendChild(headerMain);
        header.appendChild(headerTop);

        this.agentTools = document.createElement('div');
        this.agentTools.className = 'agent-panel-tools';

        this.agentPermissions = document.createElement('div');
        this.agentPermissions.className = 'agent-panel-permissions';

        this.agentTranscript = document.createElement('div');
        this.agentTranscript.className = 'agent-panel-transcript';
        this.agentTranscript.addEventListener('click', (event) => {
            const anchor = event.target.closest('a');
            if (!anchor) return;
            const href = anchor.getAttribute('href') || '';
            if (!href.startsWith('/')) {
                return;
            }
            event.preventDefault();
            void this.openFile(href);
        });

        const composer = document.createElement('div');
        composer.className = 'agent-panel-composer';

        this.agentPrompt = document.createElement('textarea');
        this.agentPrompt.className = 'agent-panel-input';
        this.agentPrompt.placeholder = AGENT_PROMPT_PLACEHOLDER;
        this.agentPrompt.rows = 3;
        this.agentPrompt.addEventListener('input', () => {
            this.updateAgentComposerActions();
        });
        this.agentPrompt.addEventListener('blur', () => {
            setTimeout(() => {
                this.hideAgentCommandMenu();
            }, 120);
        });
        this.agentPrompt.addEventListener('keydown', (event) => {
            const activeTabKey = this.getActiveWorkspaceTabKey();
            const agentTab = isAgentWorkspaceTabKey(activeTabKey)
                ? state.agentTabs.get(activeTabKey)
                : null;

            if (this.agentCommandSuggestions.length > 0) {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.moveAgentCommandSelection(1);
                    return;
                }
                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.moveAgentCommandSelection(-1);
                    return;
                }
                if (
                    event.key === 'Tab'
                    || (
                        event.key === 'Enter'
                        && !event.shiftKey
                        && !event.altKey
                        && !event.ctrlKey
                        && !event.metaKey
                    )
                ) {
                    event.preventDefault();
                    this.applyAgentCommandSuggestion();
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    this.hideAgentCommandMenu();
                    return;
                }
            }

            if (
                event.ctrlKey
                && !event.metaKey
                && !event.altKey
                && event.key.toLowerCase() === 'j'
            ) {
                event.preventDefault();
                insertTextareaText(this.agentPrompt, '\n');
                return;
            }

            if (event.key === 'Escape' && agentTab?.busy) {
                event.preventDefault();
                void this.cancelActiveAgentPrompt();
                return;
            }

            if (
                event.key === 'Enter'
                && !event.shiftKey
                && !event.altKey
                && !event.ctrlKey
                && !event.metaKey
            ) {
                event.preventDefault();
                if (!agentTab?.busy) {
                    void this.submitActiveAgentPrompt();
                }
                return;
            }

            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (!agentTab?.busy) {
                    void this.submitActiveAgentPrompt();
                }
            }
        });

        this.agentCommandMenu = document.createElement('div');
        this.agentCommandMenu.className = 'agent-command-menu';
        this.agentCommandMenu.style.display = 'none';

        const actions = document.createElement('div');
        actions.className = 'agent-panel-actions';

        this.agentCommands = document.createElement('div');
        this.agentCommands.className = 'agent-panel-commands';

        this.agentFixedActions = document.createElement('div');
        this.agentFixedActions.className = 'agent-panel-fixed-actions';

        this.agentSendButton = document.createElement('button');
        this.agentSendButton.type = 'button';
        this.agentSendButton.className = 'agent-panel-button';
        this.agentSendButton.textContent = 'Send';
        this.agentSendButton.addEventListener('click', () => {
            const activeTabKey = this.getActiveWorkspaceTabKey();
            const agentTab = isAgentWorkspaceTabKey(activeTabKey)
                ? state.agentTabs.get(activeTabKey)
                : null;
            if (agentTab?.busy) {
                void this.cancelActiveAgentPrompt();
                return;
            }
            void this.submitActiveAgentPrompt();
        });

        this.agentFixedActions.appendChild(this.agentModeSelect);
        this.agentFixedActions.appendChild(this.agentNewChatButton);
        this.agentFixedActions.appendChild(this.agentSendButton);

        actions.appendChild(this.agentCommands);
        actions.appendChild(this.agentFixedActions);
        composer.appendChild(this.agentPrompt);
        composer.appendChild(this.agentCommandMenu);
        composer.appendChild(actions);

        this.agentHint = document.createElement('div');
        this.agentHint.className = 'agent-panel-hint';
        composer.appendChild(this.agentHint);

        this.agentContainer.appendChild(header);
        this.agentContainer.appendChild(this.agentTools);
        this.agentContainer.appendChild(this.agentPermissions);
        this.agentContainer.appendChild(this.agentTranscript);
        this.agentContainer.appendChild(composer);
        this.contentContainer.appendChild(this.agentContainer);
    }

    getActiveWorkspaceTabKey(session = this.currentSession) {
        if (!session) return '';
        const explicitKey = session.workspaceState?.activeTabKey || '';
        if (explicitKey) {
            if (
                isAgentWorkspaceTabKey(explicitKey)
                && state.agentTabs.has(explicitKey)
            ) {
                return explicitKey;
            }
            if (
                isFileWorkspaceTabKey(explicitKey)
                && session.editorState.openFiles.includes(
                    workspaceKeyToFilePath(explicitKey)
                )
            ) {
                return explicitKey;
            }
        }
        if (session.editorState.activeFilePath) {
            return makeFileWorkspaceTabKey(session.editorState.activeFilePath);
        }
        const agentTabs = getAgentTabsForSession(session);
        return agentTabs[0]?.key || '';
    }

    getModelStore(session = this.currentSession) {
        return session ? session.server.modelStore : null;
    }

    getModel(filePath, session = this.currentSession) {
        const store = this.getModelStore(session);
        if (!store) return null;
        return store.get(filePath) || null;
    }

    setModel(filePath, value, session = this.currentSession) {
        const store = this.getModelStore(session);
        if (!store) return;
        store.set(filePath, value);
    }

    async loadIconMap() {
        try {
            const res = await fetch('/icons/map.json');
            this.iconMap = await res.json();
        } catch (e) {
            console.error('Failed to load icon map', e);
        }
    }

    getIcon(name, isDirectory, isExpanded) {
        if (!this.iconMap) return isDirectory ? (isExpanded ? '📂' : '📁') : '📄';
        
        if (isDirectory) {
            const folderIcon = isExpanded ? (this.iconMap.folderOpen || 'folder-src-open') : (this.iconMap.folder || 'folder-src');
            return `<img src="/icons/${folderIcon}.svg" class="file-icon" alt="folder">`;
        }

        const lowerName = name.toLowerCase();
        if (this.iconMap.filenames[lowerName]) {
            return `<img src="/icons/${this.iconMap.filenames[lowerName]}.svg" class="file-icon" alt="file">`;
        }

        const parts = name.split('.');
        if (parts.length > 1) {
            const ext = parts.pop().toLowerCase();
            if (this.iconMap.extensions[ext]) {
                return `<img src="/icons/${this.iconMap.extensions[ext]}.svg" class="file-icon" alt="file">`;
            }
        }

        return `<img src="/icons/${this.iconMap.default || 'document'}.svg" class="file-icon" alt="file">`;
    }

    initResizer() {
        let startY, startHeight;
        const onMouseMove = (e) => {
            const dy = e.clientY - startY;
            const newHeight = startHeight + dy;
            const containerHeight = this.pane.parentElement.clientHeight;
            const resizerHeight = this.resizer.offsetHeight;
            
            if (newHeight > 100 && newHeight < containerHeight - resizerHeight - 50) {
                const flex = `0 0 ${newHeight}px`;
                this.pane.style.flex = flex;
                if (this.currentSession) {
                    this.currentSession.layoutState.editorFlex = flex;
                }
                this.layout();
            }
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            const termWrapper = document.getElementById('terminal-wrapper');
            if (termWrapper) termWrapper.style.pointerEvents = '';
        };
        this.resizer.addEventListener('mousedown', (e) => {
            startY = e.clientY;
            startHeight = this.pane.offsetHeight;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'row-resize';
            const termWrapper = document.getElementById('terminal-wrapper');
            if (termWrapper) termWrapper.style.pointerEvents = 'none';
        });
    }

    refreshSessionTree(session) {
        if (!session || !session.fileTreeElement) return;
        session.fileTreeElement.innerHTML = '';
        this.renderTree(session.cwd, session.fileTreeElement, session);
    }

    initMonaco() {
        require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' }});
        require(['vs/editor/editor.main'], (monaco) => {
            this.monacoInstance = monaco;
            this.editor = monaco.editor.create(this.monacoContainer, {
                value: '',
                language: 'plaintext',
                theme: 'solarized-dark',
                automaticLayout: false,
                minimap: { enabled: true },
                rulers: [80, 120],
                fontSize: IS_MOBILE ? 14 : 12,
                fontFamily: "'Monaspace Neon', \"SF Mono Terminal\", \"SFMono-Regular\", \"SF Mono\", \"JetBrains Mono\", Menlo, Consolas, monospace",
                scrollBeyondLastLine: false,
            });
            
            this.editor.onDidChangeModelContent(() => {
                if (!this.currentSession) return;
                const filePath = this.currentSession.editorState.activeFilePath;
                if (!filePath) return;
                
                const pending = getPendingSession(this.currentSession.key);
                pending.fileWrites.set(filePath, this.editor.getValue());
            });
            
            monaco.editor.defineTheme('solarized-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [
                    { token: '', background: '002b36', foreground: '839496' },
                    { token: 'keyword', foreground: '859900' },
                    { token: 'string', foreground: '2aa198' },
                    { token: 'number', foreground: 'd33682' },
                    { token: 'comment', foreground: '586e75' },
                ],
                colors: {
                    'editor.background': '#002b36',
                    'editor.foreground': '#839496',
                    'editorCursor.foreground': '#93a1a1',
                    'editor.lineHighlightBackground': '#073642',
                    'editorLineNumber.foreground': '#586e75',
                }
            });
            monaco.editor.setTheme('solarized-dark');
            
            // Process pending models
            for (const server of state.servers.values()) {
                for (const [path, file] of server.modelStore) {
                    if (file.type === 'text' && !file.model && file.content !== null) {
                        file.model = monaco.editor.createModel(file.content, undefined, monaco.Uri.file(path));
                    }
                }
            }

            if (this.currentSession) {
                this.switchTo(this.currentSession);
            }
        });
    }

    updateEditorPaneVisibility() {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;
        const hasOpenFiles = state.openFiles.length > 0;
        const hasAgentTabs = getAgentTabsForSession(this.currentSession).length > 0;
        const shouldShow = state.isVisible && (hasOpenFiles || hasAgentTabs);
        
        this.pane.style.display = shouldShow ? 'flex' : 'none';
        this.resizer.style.display = shouldShow ? 'flex' : 'none';
        
        if (shouldShow) {
            this.layout();
        } else {
            if (this.currentSession) {
                requestAnimationFrame(() => this.currentSession.mainFitAddon.fit());
            }
        }
    }

    toggle() {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;
        state.isVisible = !state.isVisible;
        
        const tab = document.querySelector(`.tab-item[data-session-key="${this.currentSession.key}"]`);
        if (tab) {
            if (state.isVisible) tab.classList.add('editor-open');
            else tab.classList.remove('editor-open');
        }
        
        if (state.isVisible) {
            // Only render if empty (first open)
            if (this.currentSession.fileTreeElement && this.currentSession.fileTreeElement.children.length === 0) {
                this.refreshSessionTree(this.currentSession);
            }
            this.renderEditorTabs();
            const activeKey = this.getActiveWorkspaceTabKey(this.currentSession);
            if (activeKey) {
                this.activateWorkspaceTab(activeKey, true);
            }
        }
        
        this.updateEditorPaneVisibility();
        this.currentSession.saveState();
    }

    switchTo(session) {
        if (this.currentSession && this.editor && this.currentSession.editorState.activeFilePath) {
            const prevState = this.currentSession.editorState;
            const prevFile = this.getModel(prevState.activeFilePath, this.currentSession);
            if (prevFile && prevFile.type === 'text') {
                prevState.viewStates.set(prevState.activeFilePath, this.editor.saveViewState());
            }
        }

        this.currentSession = session;
        if (!session) {
            this.pane.style.display = 'none';
            this.resizer.style.display = 'none';
            return;
        }

        const state = session.editorState;

        // Only render tabs and content, file tree is persistent in sidebar
        if (state.isVisible) {
            this.renderEditorTabs();
            const activeKey = this.getActiveWorkspaceTabKey(session);
            if (activeKey) {
                this.activateWorkspaceTab(activeKey, true);
            } else {
                this.showEmptyState();
            }
        }
        
        this.updateEditorPaneVisibility();
        
        // Restore layout
        if (session.layoutState) {
            this.pane.style.flex = session.layoutState.editorFlex;
        } else {
            this.pane.style.flex = '2 1 0%';
        }
    }

    layout() {
        // console.log('[Editor] layout called');
        if (!this.currentSession || !this.currentSession.editorState.isVisible) return;
        this.currentSession.mainFitAddon.fit();
        if (this.editor) {
            const width = this.pane.clientWidth;
            const height = this.pane.clientHeight - 35; // Subtract fixed safety margin
            
            if (width > 0 && height > 0) {
                this.editor.layout({ width, height });
            } else {
                this.editor.layout();
            }
        }
    }

    async renderTree(dirPath, container, session) {
        try {
            const res = await session.server.fetch(`/api/fs/list?path=${encodeURIComponent(dirPath)}`);
            if (!res.ok) return;
            const files = await res.json();

            const ul = document.createElement('ul');
            
            for (const file of files) {
                const li = document.createElement('li');
                const div = document.createElement('div');
                div.className = 'file-tree-item';
                if (file.isDirectory) div.classList.add('is-dir');
                
                let isExpanded = false;
                if (file.isDirectory && session.server.expandedPaths.has(file.path)) {
                    isExpanded = true;
                    li.classList.add('expanded');
                }

                const icon = document.createElement('span');
                icon.className = 'icon';
                icon.innerHTML = this.getIcon(file.name, file.isDirectory, isExpanded);
                
                const name = document.createElement('span');
                name.textContent = file.name;
                
                div.appendChild(icon);
                div.appendChild(name);
                
                div.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (file.isDirectory) {
                        if (li.classList.contains('expanded')) {
                            li.classList.remove('expanded');
                            session.server.expandedPaths.delete(file.path);
                            session.server.fetch('/api/memory/expand', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ path: file.path, expanded: false })
                            });
                            
                            icon.innerHTML = this.getIcon(file.name, true, false);
                            const childUl = li.querySelector('ul');
                            if (childUl) childUl.remove();
                        } else {
                            li.classList.add('expanded');
                            session.server.expandedPaths.add(file.path);
                            session.server.fetch('/api/memory/expand', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ path: file.path, expanded: true })
                            });
                            
                            icon.innerHTML = this.getIcon(file.name, true, true);
                            await this.renderTree(file.path, li, session);
                        }
                    } else {
                        this.openFile(file.path);
                    }
                });

                li.appendChild(div);
                
                if (isExpanded) {
                    this.renderTree(file.path, li, session);
                }

                ul.appendChild(li);
            }
            container.appendChild(ul);
        } catch (err) {
            console.error('Failed to render tree:', err);
        }
    }

    async openFile(filePath) {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;

        if (!state.openFiles.includes(filePath)) {
            state.openFiles.push(filePath);
            this.renderEditorTabs();
        }
        
        this.updateEditorPaneVisibility();

        if (!this.getModel(filePath)) {
            const ext = filePath.split('.').pop().toLowerCase();
            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext);
            
            let model = null;
            let content = null;
            let readonly = false;

            if (!isImage) {
                try {
                    const res = await this.currentSession.server.fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
                    if (!res.ok) throw new Error('Failed to read file');
                    const data = await res.json();
                    content = data.content;
                    readonly = data.readonly;
                    
                    if (this.monacoInstance) {
                        const uri = this.monacoInstance.Uri.file(filePath);
                        const existing = this.monacoInstance.editor.getModel(uri);
                        if (existing) {
                            existing.setValue(content);
                            model = existing;
                        } else {
                            model = this.monacoInstance.editor.createModel(content, undefined, uri);
                        }
                    }
                } catch (err) {
                    alert(`Failed to open file: ${err.message}`, { type: 'error', title: 'Error' });
                    this.closeFile(filePath);
                    return;
                }
            }

            this.setModel(filePath, {
                type: isImage ? 'image' : 'text',
                model: model,
                content: content,
                readonly: readonly
            });
        }

        this.activateFileTab(filePath);
        this.currentSession.saveState();
    }

    closeFile(filePath) {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;

        const index = state.openFiles.indexOf(filePath);
        if (index > -1) {
            state.openFiles.splice(index, 1);
        }

        this.renderEditorTabs();
        this.updateEditorPaneVisibility();
        
        if (state.activeFilePath === filePath) {
            if (state.openFiles.length > 0) {
                this.activateFileTab(state.openFiles[state.openFiles.length - 1]);
            } else {
                const agentTabs = getAgentTabsForSession(this.currentSession);
                if (agentTabs.length > 0) {
                    this.activateAgentTab(agentTabs[0].key);
                } else {
                    state.activeFilePath = null;
                    if (this.currentSession.workspaceState) {
                        this.currentSession.workspaceState.activeTabKey = '';
                    }
                    this.showEmptyState();
                }
            }
        }
        
        // Save state AFTER updating activeFilePath
        this.currentSession.saveState();
    }

    renderEditorTabs() {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;
        const activeWorkspaceTabKey = this.getActiveWorkspaceTabKey();

        this.tabsContainer.innerHTML = '';
        for (const path of state.openFiles) {
            const tab = document.createElement('div');
            tab.className = 'editor-tab';
            if (makeFileWorkspaceTabKey(path) === activeWorkspaceTabKey) {
                tab.classList.add('active');
            }
            
            const fileModel = this.getModel(path);
            if (fileModel && fileModel.readonly) {
                tab.classList.add('readonly');
            }
            
            const name = path.split('/').pop();
            const span = document.createElement('span');
            span.textContent = name;
            
            const closeBtn = document.createElement('span');
            closeBtn.className = 'close-btn';
            closeBtn.innerHTML = CLOSE_ICON_SVG;
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                this.closeFile(path);
            };
            
            tab.onclick = () => this.activateFileTab(path);
            
            tab.appendChild(span);
            tab.appendChild(closeBtn);
            this.tabsContainer.appendChild(tab);
        }

        for (const agentTab of getAgentTabsForSession(this.currentSession)) {
            const tab = document.createElement('div');
            tab.className = 'editor-tab agent-editor-tab';
            if (agentTab.key === activeWorkspaceTabKey) {
                tab.classList.add('active');
            }

            const icon = document.createElement('span');
            icon.className = 'agent-editor-tab-icon';
            icon.innerHTML = AGENT_ICON_SVG;

            const label = document.createElement('span');
            label.textContent = getAgentDisplayLabel(agentTab);

            const closeBtn = document.createElement('span');
            closeBtn.className = 'close-btn';
            closeBtn.innerHTML = CLOSE_ICON_SVG;
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                void this.closeAgentTab(agentTab.key);
            };

            tab.onclick = () => this.activateAgentTab(agentTab.key);

            tab.appendChild(icon);
            tab.appendChild(label);
            tab.appendChild(closeBtn);
            this.tabsContainer.appendChild(tab);
        }
    }

    activateWorkspaceTab(workspaceTabKey, isRestore = false) {
        if (isAgentWorkspaceTabKey(workspaceTabKey)) {
            this.activateAgentTab(workspaceTabKey, isRestore);
            return;
        }
        this.activateFileTab(workspaceKeyToFilePath(workspaceTabKey), isRestore);
    }

    activateFileTab(filePath, isRestore = false) {
        if (!this.currentSession) return;
        if (!filePath) return;
        const state = this.currentSession.editorState;

        if (!isRestore && state.activeFilePath && state.activeFilePath !== filePath) {
            const currentGlobal = this.getModel(state.activeFilePath);
            if (currentGlobal && currentGlobal.type === 'text' && this.editor) {
                state.viewStates.set(state.activeFilePath, this.editor.saveViewState());
            }
        }

        state.activeFilePath = filePath;
        this.currentSession.workspaceState.activeTabKey = makeFileWorkspaceTabKey(filePath);
        this.currentSession.saveState();
        const file = this.getModel(filePath);
        
        this.renderEditorTabs();
        this.emptyState.style.display = 'none';

        if (!file) {
            this.openFile(filePath, true);
            return;
        }

        if (file.type === 'image') {
            this.agentContainer.style.display = 'none';
            this.monacoContainer.style.display = 'none';
            this.imagePreviewContainer.style.display = 'flex';
            
            this.imagePreview.onerror = () => {
                alert(`Failed to load image: ${filePath.split('/').pop()}`, { type: 'error', title: 'Error' });
                this.closeFile(filePath);
                this.imagePreview.onerror = null;
            };
            
            this.imagePreview.src = this.currentSession.server.resolveUrl(
                `/api/fs/raw?path=${encodeURIComponent(filePath)}&token=${this.currentSession.server.token}`
            );
        } else {
            this.agentContainer.style.display = 'none';
            this.imagePreviewContainer.style.display = 'none';
            this.monacoContainer.style.display = 'block';
            
            if (!file.model && file.content !== null && this.monacoInstance) {
                file.model = this.monacoInstance.editor.createModel(file.content, undefined, this.monacoInstance.Uri.file(filePath));
            }

            if (this.editor && file.model) {
                this.editor.setModel(file.model);
                this.editor.updateOptions({ readOnly: !!file.readonly });
                
                const savedViewState = state.viewStates.get(filePath);
                if (savedViewState) {
                    this.editor.restoreViewState(savedViewState);
                }
                this.editor.focus();
                // Force layout to ensure content is visible
                requestAnimationFrame(() => this.editor.layout());
            }
        }
    }

    activateAgentTab(agentTabKey, isRestore = false) {
        if (!this.currentSession) return;
        const agentTab = state.agentTabs.get(agentTabKey);
        if (!agentTab) {
            this.showEmptyState();
            return;
        }
        if (
            agentTab.terminalSessionId
            && agentTab.terminalSessionId !== this.currentSession.id
        ) {
            return;
        }

        if (
            !isRestore
            && this.editor
            && this.currentSession.editorState.activeFilePath
        ) {
            const filePath = this.currentSession.editorState.activeFilePath;
            const model = this.getModel(filePath);
            if (model && model.type === 'text') {
                this.currentSession.editorState.viewStates.set(
                    filePath,
                    this.editor.saveViewState()
                );
            }
        }

        this.currentSession.workspaceState.activeTabKey = agentTabKey;
        this.currentSession.saveState();
        this.renderEditorTabs();
        this.monacoContainer.style.display = 'none';
        this.imagePreviewContainer.style.display = 'none';
        this.emptyState.style.display = 'none';
        this.agentContainer.style.display = 'flex';
        this.renderAgentPanel(agentTab);
    }

    async closeAgentTab(agentTabKey) {
        const agentTab = state.agentTabs.get(agentTabKey);
        if (!agentTab) return;
        await agentTab.close();
        removeAgentTab(agentTabKey);
    }

    renderAgentPanel(agentTab) {
        this.agentHeader.textContent = '';
        this.agentMeta.textContent = '';

        this.agentModeSelect.innerHTML = '';
        const modeOptions = normalizeAgentModes(agentTab.availableModes);
        if (modeOptions.length > 1) {
            for (const mode of modeOptions) {
                const option = document.createElement('option');
                option.value = mode.id;
                option.textContent = mode.name;
                option.title = mode.description || mode.name;
                option.selected = mode.id === agentTab.currentModeId;
                this.agentModeSelect.appendChild(option);
            }
            this.agentModeSelect.style.display = '';
        } else {
            this.agentModeSelect.style.display = 'none';
        }

        this.agentCommands.innerHTML = '';
        const commands = normalizeAgentCommands(agentTab.availableCommands);
        if (commands.length > 0) {
            for (const command of commands.slice(0, 6)) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'agent-command-chip';
                button.textContent = `/${command.name}`;
                button.title = command.description || '';
                button.onclick = () => {
                    const suffix = command.inputHint
                        ? ` ${command.inputHint}`
                        : ' ';
                    this.agentPrompt.focus();
                    this.agentPrompt.value = `/${command.name}${suffix}`;
                    this.updateAgentComposerActions(agentTab);
                };
                this.agentCommands.appendChild(button);
            }
            this.agentCommands.style.display = 'flex';
        } else {
            this.agentCommands.style.display = 'none';
        }

        this.agentTranscript.innerHTML = '';
        const timeline = getAgentTimelineItems(agentTab);
        if (timeline.length === 0) {
            this.agentTranscript.appendChild(
                this.buildAgentEmptyState(agentTab)
            );
        } else {
            for (const entry of timeline) {
                let node = null;
                if (entry.type === 'message') {
                    node = this.buildAgentMessageNode(agentTab, entry.value);
                } else if (entry.type === 'tool') {
                    node = this.buildAgentToolNode(agentTab, entry.value);
                } else if (entry.type === 'permission') {
                    node = this.buildAgentPermissionNode(
                        agentTab,
                        entry.value
                    );
                }
                if (node) {
                    this.agentTranscript.appendChild(node);
                }
            }
        }
        this.agentTranscript.scrollTop = this.agentTranscript.scrollHeight;
        this.agentTools.innerHTML = '';
        this.agentTools.style.display = 'none';
        this.agentPermissions.innerHTML = '';
        this.agentPermissions.style.display = 'none';

        this.agentPrompt.disabled = false;
        this.agentPrompt.placeholder = buildAgentPromptPlaceholder(agentTab);
        this.updateAgentComposerActions(agentTab);
    }

    buildAgentEmptyState(agentTab) {
        const card = document.createElement('div');
        card.className = 'agent-empty-state';

        const title = document.createElement('div');
        title.className = 'agent-empty-state-title';
        title.textContent = agentTab.busy
            ? `${getAgentBaseName(agentTab)} is thinking`
            : `${getAgentBaseName(agentTab)} is ready`;
        card.appendChild(title);

        const body = document.createElement('div');
        body.className = 'agent-empty-state-body';
        body.textContent = agentTab.busy
            ? 'Waiting for the current run to produce output.'
            : 'Ask for code review, implementation, debugging, or '
                + 'explanations in this workspace.';
        card.appendChild(body);

        if (!agentTab.busy) {
            const prompts = getAgentStarterPrompts(agentTab);
            if (prompts.length > 0) {
                const actions = document.createElement('div');
                actions.className = 'agent-empty-state-actions';
                for (const prompt of prompts) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'agent-empty-state-action';
                    button.textContent = prompt;
                    button.onclick = () => {
                        this.agentPrompt.focus();
                        this.agentPrompt.value = prompt;
                        this.updateAgentComposerActions(agentTab);
                    };
                    actions.appendChild(button);
                }
                card.appendChild(actions);
            }
        }

        return card;
    }

    buildAgentMessageNode(agentTab, message) {
        const item = document.createElement('div');
        item.className = `agent-message ${message.role} ${message.kind}`;

        const role = document.createElement('div');
        role.className = 'agent-message-role';
        role.textContent = getAgentMessageRoleLabel(agentTab, message);

        const body = document.createElement('div');
        body.className = 'agent-message-body';
        if (
            message.role === 'assistant'
            && message.kind === 'message'
        ) {
            body.classList.add('markdown');
            body.innerHTML = renderAgentMessageMarkdown(message.text || '');
        } else {
            body.classList.add('plain');
            body.textContent = message.text || '';
        }

        item.appendChild(role);
        item.appendChild(body);
        return item;
    }

    buildAgentToolNode(agentTab, toolCall) {
        const node = document.createElement('div');
        node.className = 'agent-tool-call';

        const role = document.createElement('div');
        role.className = 'agent-message-role';
        role.textContent = buildAgentTimelineRoleLabel(agentTab, 'tool');
        node.appendChild(role);

        const header = document.createElement('div');
        header.className = 'agent-tool-call-header';

        const title = document.createElement('div');
        title.className = 'agent-tool-call-title';
        title.textContent = getAgentToolTitle(toolCall);

        const status = document.createElement('span');
        status.className = `agent-status-pill ${normalizeStatusClass(toolCall.status)}`;
        status.textContent = getAgentStatusLabel(toolCall.status);

        header.appendChild(title);
        header.appendChild(status);
        node.appendChild(header);

        const meta = document.createElement('div');
        meta.className = 'agent-tool-call-meta';
        meta.textContent = buildAgentToolMeta(toolCall);
        if (meta.textContent) {
            node.appendChild(meta);
        }

        const sections = buildAgentToolSections(toolCall);
        if (sections.length > 0) {
            const sectionContainer = document.createElement('div');
            sectionContainer.className = 'agent-tool-call-sections';
            for (const section of sections) {
                const details = document.createElement('details');
                details.className = 'agent-tool-call-section';
                const summary = document.createElement('summary');
                summary.appendChild(
                    buildAgentSectionSummaryLabel(section.label)
                );
                const preview = buildAgentSectionSummaryPreview(section.text);
                if (preview) {
                    summary.appendChild(
                        buildAgentSectionSummaryPreviewNode(preview)
                    );
                }
                const body = document.createElement('pre');
                body.className = 'agent-tool-call-body';
                body.textContent = section.text;
                details.appendChild(summary);
                details.appendChild(body);
                sectionContainer.appendChild(details);
            }
            node.appendChild(sectionContainer);
        }

        return node;
    }

    buildAgentPermissionNode(agentTab, permission) {
        const card = document.createElement('div');
        card.className = 'agent-permission-card';

        const role = document.createElement('div');
        role.className = 'agent-message-role';
        role.textContent = buildAgentTimelineRoleLabel(
            agentTab,
            permission.status === 'pending'
                ? 'permission request'
                : 'permission'
        );
        card.appendChild(role);

        const titleRow = document.createElement('div');
        titleRow.className = 'agent-tool-call-header';

        const title = document.createElement('div');
        title.className = 'agent-permission-title';
        title.textContent = getAgentPermissionTitle(permission);

        const status = document.createElement('span');
        status.className = `agent-status-pill ${normalizeStatusClass(
            permission.status || 'pending'
        )}`;
        status.textContent = getAgentPermissionStatusLabel(permission);

        titleRow.appendChild(title);
        titleRow.appendChild(status);
        card.appendChild(titleRow);

        const meta = document.createElement('div');
        meta.className = 'agent-tool-call-meta';
        meta.textContent = buildAgentPermissionMeta(permission);
        if (meta.textContent) {
            card.appendChild(meta);
        }

        const summaryText = buildAgentPermissionSummary(permission);
        if (summaryText) {
            const body = document.createElement('pre');
            body.className = 'agent-tool-call-body';
            body.textContent = summaryText;
            card.appendChild(body);
        }

        const sections = buildAgentPermissionSections(permission);
        if (sections.length > 0) {
            const sectionContainer = document.createElement('div');
            sectionContainer.className = 'agent-tool-call-sections';
            for (const section of sections) {
                const details = document.createElement('details');
                details.className = 'agent-tool-call-section';
                const summary = document.createElement('summary');
                summary.appendChild(
                    buildAgentSectionSummaryLabel(section.label)
                );
                const preview = buildAgentSectionSummaryPreview(section.text);
                if (preview) {
                    summary.appendChild(
                        buildAgentSectionSummaryPreviewNode(preview)
                    );
                }
                const body = document.createElement('pre');
                body.className = 'agent-tool-call-body';
                body.textContent = section.text;
                details.appendChild(summary);
                details.appendChild(body);
                sectionContainer.appendChild(details);
            }
            card.appendChild(sectionContainer);
        }

        if (permission.status === 'pending') {
            const options = document.createElement('div');
            options.className = 'agent-permission-options';

            for (const option of permission.options || []) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'agent-permission-option';
                if (option.kind === 'allow_once') {
                    button.classList.add('primary');
                } else if (
                    option.kind === 'reject_once'
                    || option.kind === 'reject_always'
                ) {
                    button.classList.add('danger');
                }
                const optionId = option.optionId || option.id || '';
                button.textContent = option.name || optionId || 'Allow';
                button.onclick = async () => {
                    try {
                        await agentTab.resolvePermission(
                            permission.id,
                            optionId
                        );
                    } catch (error) {
                        alert(error.message, {
                            type: 'error',
                            title: 'Agent'
                        });
                    }
                };
                options.appendChild(button);
            }

            const cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'agent-permission-option secondary';
            cancelButton.textContent = 'Cancel';
            cancelButton.onclick = async () => {
                try {
                    await agentTab.resolvePermission(permission.id, '');
                } catch (error) {
                    alert(error.message, {
                        type: 'error',
                        title: 'Agent'
                    });
                }
            };
            options.appendChild(cancelButton);
            card.appendChild(options);
        }

        return card;
    }

    async submitActiveAgentPrompt() {
        const activeTabKey = this.getActiveWorkspaceTabKey();
        if (!isAgentWorkspaceTabKey(activeTabKey)) return;
        const agentTab = state.agentTabs.get(activeTabKey);
        if (!agentTab) return;
        if (agentTab.busy) return;
        const text = this.agentPrompt.value.trim();
        if (!text) return;
        this.agentPrompt.value = '';
        try {
            await agentTab.sendPrompt(text);
            agentTab.busy = true;
            agentTab.status = 'running';
            this.renderAgentPanel(agentTab);
        } catch (error) {
            alert(error.message, {
                type: 'error',
                title: 'Agent'
            });
        }
    }

    async cancelActiveAgentPrompt() {
        const activeTabKey = this.getActiveWorkspaceTabKey();
        if (!isAgentWorkspaceTabKey(activeTabKey)) return;
        const agentTab = state.agentTabs.get(activeTabKey);
        if (!agentTab) return;
        try {
            await agentTab.cancel();
        } catch (error) {
            alert(error.message, {
                type: 'error',
                title: 'Agent'
            });
        }
    }

    async setActiveAgentMode(modeId) {
        const activeTabKey = this.getActiveWorkspaceTabKey();
        const agentTab = isAgentWorkspaceTabKey(activeTabKey)
            ? state.agentTabs.get(activeTabKey) || null
            : null;
        if (!agentTab || !modeId || modeId === agentTab.currentModeId) return;
        try {
            await agentTab.setMode(modeId);
        } catch (error) {
            alert(error.message, {
                type: 'error',
                title: 'Agent'
            });
        }
    }

    async createSiblingAgentTab(agentTab) {
        const session = agentTab?.getLinkedSession?.() || null;
        if (!session) return;
        try {
            await createAgentTab(session, agentTab.agentId, {
                cwd: agentTab.cwd || session.cwd || session.initialCwd || '/',
                modeId: agentTab.currentModeId || ''
            });
        } catch (error) {
            alert(error.message, {
                type: 'error',
                title: 'Agent'
            });
        }
    }

    updateAgentComposerActions(agentTab = null) {
        const activeTabKey = this.getActiveWorkspaceTabKey();
        const activeAgentTab = agentTab || (
            isAgentWorkspaceTabKey(activeTabKey)
                ? state.agentTabs.get(activeTabKey) || null
                : null
        );
        const busy = !!activeAgentTab?.busy;
        this.agentSendButton.textContent = busy ? 'Stop' : 'Send';
        this.agentSendButton.disabled = !busy && !this.agentPrompt.value.trim();
        if (busy) {
            this.agentHint.textContent = 'Esc stops the current run.';
            this.agentHint.style.display = '';
        } else {
            this.agentHint.textContent = '';
            this.agentHint.style.display = 'none';
        }
        this.renderAgentCommandMenu(activeAgentTab);
    }

    renderAgentCommandMenu(agentTab = null) {
        if (!this.agentCommandMenu) return;
        const suggestions = getAgentCommandSuggestions(
            agentTab,
            this.agentPrompt?.value || ''
        );
        this.agentCommandSuggestions = suggestions;
        if (suggestions.length === 0) {
            this.hideAgentCommandMenu();
            return;
        }
        this.agentCommandIndex = Math.max(
            0,
            Math.min(this.agentCommandIndex, suggestions.length - 1)
        );
        this.agentCommandMenu.innerHTML = '';
        for (const [index, command] of suggestions.entries()) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'agent-command-option';
            if (index === this.agentCommandIndex) {
                button.classList.add('active');
            }
            const name = document.createElement('span');
            name.className = 'agent-command-option-name';
            name.textContent = `/${command.name}`;
            button.appendChild(name);
            if (command.description) {
                const meta = document.createElement('span');
                meta.className = 'agent-command-option-meta';
                meta.textContent = command.description;
                button.appendChild(meta);
            }
            button.addEventListener('mousedown', (event) => {
                event.preventDefault();
            });
            button.addEventListener('click', () => {
                this.agentCommandIndex = index;
                this.applyAgentCommandSuggestion();
            });
            this.agentCommandMenu.appendChild(button);
        }
        this.agentCommandMenu.style.display = 'flex';
    }

    hideAgentCommandMenu() {
        if (!this.agentCommandMenu) return;
        this.agentCommandSuggestions = [];
        this.agentCommandIndex = 0;
        this.agentCommandMenu.style.display = 'none';
        this.agentCommandMenu.innerHTML = '';
    }

    moveAgentCommandSelection(delta) {
        if (this.agentCommandSuggestions.length === 0) return;
        const nextIndex = this.agentCommandIndex + delta;
        this.agentCommandIndex = nextIndex < 0
            ? this.agentCommandSuggestions.length - 1
            : nextIndex % this.agentCommandSuggestions.length;
        this.renderAgentCommandMenu(getActiveAgentTab());
    }

    applyAgentCommandSuggestion() {
        const command = this.agentCommandSuggestions[this.agentCommandIndex];
        if (!command) return;
        const suffix = command.inputHint
            ? ` ${command.inputHint}`
            : ' ';
        this.agentPrompt.focus();
        this.agentPrompt.value = `/${command.name}${suffix}`;
        this.agentPrompt.setSelectionRange(
            this.agentPrompt.value.length,
            this.agentPrompt.value.length
        );
        this.hideAgentCommandMenu();
        this.updateAgentComposerActions(getActiveAgentTab());
    }

    showEmptyState() {
        this.monacoContainer.style.display = 'none';
        this.imagePreviewContainer.style.display = 'none';
        this.agentContainer.style.display = 'none';
        this.emptyState.style.display = 'flex';
    }
}

const AGENT_PROMPT_PLACEHOLDER = [
    'Answer to the Ultimate Question of Life, the Universe, '
        + 'and Everything',
    '// Enter sends. Shift+Enter or Ctrl+J inserts a newline.'
];

const editorManager = new EditorManager();
// #endregion

const agentDropdownEl = document.createElement('div');
agentDropdownEl.className = 'agent-dropdown';
agentDropdownEl.style.display = 'none';
document.body.appendChild(agentDropdownEl);

function closeAgentDropdown() {
    agentDropdownEl.style.display = 'none';
    agentDropdownEl.innerHTML = '';
}

function openAgentDropdown(session, anchor) {
    if (!session || !anchor) return;
    const definitions = getAgentDefinitionsForServer(session.serverId);
    agentDropdownEl.innerHTML = '';

    for (const definition of definitions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-dropdown-item';
        if (definition.available === false) {
            button.classList.add('unavailable');
            button.setAttribute('aria-disabled', 'true');
        }
        const label = document.createElement('span');
        label.className = 'agent-dropdown-label';
        label.textContent = definition.label;

        const meta = document.createElement('span');
        meta.className = 'agent-dropdown-meta';
        meta.textContent = buildAgentDefinitionMeta(definition);

        button.appendChild(label);
        button.appendChild(meta);
        button.onclick = async (event) => {
            event.stopPropagation();
            if (definition.available === false) {
                alert(buildAgentSetupMessage(definition), {
                    type: 'warning',
                    title: 'Agent setup'
                });
                return;
            }
            button.disabled = true;
            try {
                await createAgentTab(session, definition.id);
                closeAgentDropdown();
                if (state.activeSessionKey !== session.key) {
                    await switchToSession(session.key);
                } else {
                    refreshWorkspaceIfSessionActive(session);
                }
            } catch (error) {
                alert(error.message, {
                    type: 'error',
                    title: 'Agent'
                });
            } finally {
                button.disabled = definition.available === false;
            }
        };
        agentDropdownEl.appendChild(button);
    }

    if (definitions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'agent-dropdown-empty';
        empty.textContent = 'No agents available';
        agentDropdownEl.appendChild(empty);
    } else if (definitions.some((definition) => definition.available === false)) {
        const note = document.createElement('div');
        note.className = 'agent-dropdown-empty';
        note.textContent = 'Agents run on the current host. Install or configure them there.';
        agentDropdownEl.appendChild(note);
    }

    const rect = anchor.getBoundingClientRect();
    agentDropdownEl.style.display = 'flex';
    agentDropdownEl.style.top = `${rect.bottom + window.scrollY + 6}px`;
    agentDropdownEl.style.left = `${rect.left + window.scrollX}px`;
}

document.addEventListener('click', (event) => {
    if (event.target.closest('.toggle-agent-btn')) {
        return;
    }
    if (!event.target.closest('.agent-dropdown')) {
        closeAgentDropdown();
    }
});

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
    constructor(data, server) {
        this.server = server;
        this.serverId = server.id;
        this.id = data.id;
        this.key = makeSessionKey(this.serverId, this.id);
        this.createdAt = data.createdAt;
        this.shell = data.shell || 'Terminal';
        this.initialCwd = data.initialCwd || '';
        
        this.title = data.title || this.shell.split('/').pop();
        this.cwd = data.cwd || this.initialCwd;
        this.env = data.env || '';
        this.cols = data.cols || 80;
        this.rows = data.rows || 24;
        
        this.saveStateTimer = null;

        this.editorState = {
            isVisible: data.editorState?.isVisible || false,
            root: this.cwd,
            openFiles: data.editorState?.openFiles || [],
            activeFilePath: data.editorState?.activeFilePath || null,
            viewStates: new Map() // Path -> ViewState
        };
        this.workspaceState = {
            activeTabKey: data.editorState?.activeWorkspaceTabKey
                || (data.editorState?.activeFilePath
                    ? makeFileWorkspaceTabKey(data.editorState.activeFilePath)
                    : '')
        };
        
        this.layoutState = {
            editorFlex: '2 1 0%'
        };
        this.wrapperElement = null;
        this._createTerminals();

        this.connect();
    }

    _createTerminals() {
        this.previewTerm = new Terminal({
            disableStdin: true,
            cursorBlink: false,
            allowTransparency: true,
            fontSize: 10,
            rows: this.rows,
            cols: this.cols,
            theme: {
                background: '#002b36',
                foreground: '#839496',
                cursor: 'transparent',
                selectionBackground: 'transparent'
            }
        });

        if (window.innerWidth >= 768) {
            this.previewTerm.loadAddon(new CanvasAddon());
        }

        this.mainTerm = new Terminal({
            allowTransparency: true,
            convertEol: true,
            cursorBlink: true,
            fontFamily: "'Monaspace Neon', \"SF Mono Terminal\", \"SFMono-Regular\", \"SF Mono\", \"JetBrains Mono\", Menlo, Consolas, monospace",
            fontSize: IS_MOBILE ? 14 : 12,
            rows: this.rows,
            cols: this.cols,
            theme: {
                background: '#002b36',
                foreground: '#839496',
                cursor: '#93a1a1',
                cursorAccent: '#002b36',
                selectionBackground: '#073642'
            }
        });
        this.mainFitAddon = new FitAddon();
        this.mainLinksAddon = new WebLinksAddon();
        this.searchAddon = new SearchAddon();
        this.mainTerm.loadAddon(this.mainFitAddon);
        this.mainTerm.loadAddon(this.mainLinksAddon);
        this.mainTerm.loadAddon(this.searchAddon);
        this.mainTerm.loadAddon(new CanvasAddon());

        this.mainTerm.onData((data) => {
            if (this.isRestoring) return;
            this.send({ type: 'input', data });
        });

        this.mainTerm.onResize((size) => {
            this.previewTerm.resize(size.cols, size.rows);
            this.updatePreviewScale();

            const pending = getPendingSession(this.key);
            pending.resize = { cols: size.cols, rows: size.rows };
        });
    }

    recreateTerminals() {
        const wasActive = state.activeSessionKey === this.key;
        const previewWrapper = this.wrapperElement;

        try {
            this.previewTerm?.dispose();
        } catch (e) {
            if (!e.message?.includes('onRequestRedraw')) {
                console.warn('Error disposing preview terminal:', e);
            }
        }

        try {
            this.mainTerm?.dispose();
        } catch (e) {
            if (!e.message?.includes('onRequestRedraw')) {
                console.warn('Error disposing main terminal:', e);
            }
        }

        this._createTerminals();

        if (previewWrapper && window.innerWidth >= 768) {
            previewWrapper.innerHTML = '';
            this.previewTerm.open(previewWrapper);
            this.updatePreviewScale();
        }

        if (wasActive && terminalEl) {
            terminalEl.innerHTML = '';
            this.mainTerm.open(terminalEl);
            this.mainFitAddon.fit();
            this.mainTerm.focus();
        }
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
            
            if (this.editorState) {
                this.editorState.root = this.cwd;
                if (this.editorState.isVisible) {
                    editorManager.refreshSessionTree(this);
                }
            }
        }
        if (data.env && data.env !== this.env) {
            this.env = data.env;
            changed = true;
        }
        
        if (data.cols && data.rows && (data.cols !== this.cols || data.rows !== this.rows)) {
            this.cols = data.cols;
            this.rows = data.rows;
            if (this.previewTerm) {
                this.previewTerm.resize(this.cols, this.rows);
                this.updatePreviewScale();
            }
        }

        if (changed) {
            this.updateTabUI();
        }
    }

    updatePreviewScale() {
        if (!this.wrapperElement || !this.previewTerm) return;
        requestAnimationFrame(() => {
            if (!this.wrapperElement || !this.previewTerm) return;
            this.wrapperElement.style.width = '';
            this.wrapperElement.style.height = '';
            this.wrapperElement.style.transform = '';
            
            const termWidth = this.previewTerm.element.offsetWidth;
            const termHeight = this.previewTerm.element.offsetHeight;
            
            if (termWidth === 0 || termHeight === 0) return;
            
            const container = this.wrapperElement.parentElement;
            const availableWidth = container.clientWidth;
            
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
        const tab = tabListEl.querySelector(`[data-session-key="${this.key}"]`);
        if (!tab) return;

        if (this.env) {
            tab.title = this.env;
        }

        const titleEl = tab.querySelector('.title');
        if (titleEl) titleEl.textContent = this.title;

        const metaEl = tab.querySelector('.meta-cwd');
        if (metaEl) {
            const shortened = shortenPath(this.cwd, this.env);
            metaEl.textContent = `PWD: ${shortened}`;
            metaEl.title = this.cwd;
        }

        const serverEl = tab.querySelector('.meta-server');
        if (serverEl) {
            renderSessionHostMeta(serverEl, this);
        }
    }

    saveState() {
        const pending = getPendingSession(this.key);
        pending.editorState = {
            isVisible: this.editorState.isVisible,
            root: this.editorState.root,
            openFiles: this.editorState.openFiles,
            activeFilePath: this.editorState.activeFilePath,
            activeWorkspaceTabKey: this.workspaceState.activeTabKey || ''
        };
    }

    connect() {
        if (!this.server.isAuthenticated) return;

        // Prevent duplicate connection attempts
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const endpoint = this.server.resolveWsUrl(this.id, this.server.token);
        try {
            this.socket = new WebSocket(endpoint);
        } catch (error) {
            const hostName = getDisplayHost(this.server);
            console.error(`[WS] Failed to connect ${hostName}:`, error);
            setStatus(this.server, 'reconnecting');
            if (error?.name === 'SecurityError') {
                alert(
                    `${hostName} WebSocket blocked in HTTPS context. `
                    + 'Use HTTPS/WSS endpoint for this host.',
                    { type: 'warning', title: 'Connection' }
                );
            }
            return;
        }

        this.socket.addEventListener('open', () => {
            this.reconnectAttempts = 0;
            if (state.activeSessionKey === this.key) this.reportResize();
        });

        this.socket.addEventListener('message', (event) => {
            try {
                this.handleMessage(JSON.parse(event.data));
            } catch { /* ignore */ }
        });

        this.socket.addEventListener('close', () => {
            // We rely on the global heartbeat (syncSessions) to handle reconnection.
            // This event listener just allows the socket to be garbage collected.
        });
        
        this.socket.addEventListener('error', () => {
            // Often fires on 401 or connection refused
        });
    }

    handleMessage(message) {
        switch (message.type) {
            case 'snapshot':
                this.isRestoring = true;
                this.recreateTerminals();
                if (this.previewTerm) this.previewTerm.write(message.data || '');
                this.mainTerm.write(message.data || '', () => {
                    this.isRestoring = false;
                    if (state.activeSessionKey === this.key) {
                        this.mainFitAddon.fit();
                        this.mainTerm.focus();
                        this.reportResize();
                    }
                });
                break;
            case 'output':
                this.writeToTerminals(message.data);
                break;
            case 'meta':
                this.update(message);
                break;
            case 'status':
                if (state.activeSessionKey === this.key) setStatus(this.server, message.status);
                break;
        }
    }

    writeToTerminals(data) {
        if (this.previewTerm) this.previewTerm.write(data);
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
            if (this.previewTerm) this.previewTerm.dispose();
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

class AgentTab {
    constructor(data, server) {
        this.server = server;
        this.serverId = server.id;
        this.id = data.id;
        this.key = makeAgentTabKey(this.serverId, this.id);
        this.socket = null;
        this.update(data);
        this.connect();
    }

    getLinkedSession() {
        if (!this.terminalSessionId) return null;
        return state.sessions.get(
            makeSessionKey(this.serverId, this.terminalSessionId)
        ) || null;
    }

    notifyUi() {
        const session = this.getLinkedSession();
        if (!session) return;
        refreshWorkspaceIfSessionActive(session);
    }

    update(data) {
        this.runtimeId = data.runtimeId || '';
        this.runtimeKey = data.runtimeKey || '';
        this.acpSessionId = data.acpSessionId || '';
        this.agentId = data.agentId || '';
        this.agentLabel = data.agentLabel || 'Agent';
        this.commandLabel = data.commandLabel || '';
        this.terminalSessionId = data.terminalSessionId || '';
        this.cwd = data.cwd || '';
        this.createdAt = data.createdAt || new Date().toISOString();
        this.status = data.status || 'ready';
        this.busy = !!data.busy;
        this.errorMessage = data.errorMessage || '';
        this.currentModeId = data.currentModeId || '';
        this.availableModes = Array.isArray(data.availableModes)
            ? data.availableModes
            : [];
        this.availableCommands = Array.isArray(data.availableCommands)
            ? data.availableCommands
            : [];
        this.messages = Array.isArray(data.messages)
            ? data.messages.map((message) => ({ ...message }))
            : [];
        this.toolCalls = new Map();
        for (const toolCall of data.toolCalls || []) {
            if (toolCall?.toolCallId) {
                this.toolCalls.set(toolCall.toolCallId, { ...toolCall });
            }
        }
        this.permissions = new Map();
        for (const permission of data.permissions || []) {
            if (permission?.id) {
                this.permissions.set(permission.id, { ...permission });
            }
        }
    }

    connect() {
        if (!this.server.isAuthenticated) return;
        if (
            this.socket
            && (
                this.socket.readyState === WebSocket.OPEN
                || this.socket.readyState === WebSocket.CONNECTING
            )
        ) {
            return;
        }

        const endpoint = this.server.resolveAgentWsUrl(
            this.id,
            this.server.token
        );
        this.socket = new WebSocket(endpoint);
        this.socket.addEventListener('message', (event) => {
            try {
                this.handleMessage(JSON.parse(event.data));
            } catch {
                // Ignore malformed agent payloads.
            }
        });
        this.socket.addEventListener('close', () => {
            this.socket = null;
            if (this.status === 'running') {
                this.status = 'disconnected';
                this.busy = false;
                this.notifyUi();
            }
        });
    }

    handleMessage(message) {
        switch (message.type) {
            case 'snapshot':
                this.update(message.tab || {});
                break;
            case 'message_open':
                this.messages.push({ ...message.message });
                break;
            case 'message_chunk':
                this.#appendChunk(message);
                break;
            case 'session_update':
                this.#applySessionUpdate(message.update || {});
                if (message.tab?.currentModeId || message.tab?.modeId) {
                    this.currentModeId = message.tab.currentModeId
                        || message.tab.modeId;
                }
                if (Array.isArray(message.tab?.availableModes)) {
                    this.availableModes = message.tab.availableModes;
                }
                if (Array.isArray(message.tab?.availableCommands)) {
                    this.availableCommands = message.tab.availableCommands;
                }
                break;
            case 'permission_request':
                if (message.permission?.id) {
                    this.permissions.set(message.permission.id, {
                        ...message.permission
                    });
                }
                break;
            case 'permission_resolved': {
                const permission = this.permissions.get(message.permissionId);
                if (permission) {
                    permission.status = message.status || permission.status;
                    permission.selectedOptionId = message.selectedOptionId
                        || permission.selectedOptionId
                        || '';
                }
                break;
            }
            case 'status':
                this.status = message.status || this.status;
                this.busy = !!message.busy;
                this.errorMessage = message.errorMessage || '';
                break;
            case 'complete':
                this.status = message.status || 'ready';
                this.busy = !!message.busy;
                break;
            default:
                break;
        }
        this.notifyUi();
    }

    #appendChunk(message) {
        const last = this.messages[this.messages.length - 1] || null;
        if (
            last
            && last.streamKey === message.streamKey
            && last.role === message.role
            && last.kind === message.kind
        ) {
            last.text += message.text || '';
            return;
        }

        this.messages.push({
            id: crypto.randomUUID(),
            streamKey: message.streamKey,
            role: message.role || 'assistant',
            kind: message.kind || 'message',
            text: message.text || ''
        });
    }

    #applySessionUpdate(update) {
        switch (update.sessionUpdate) {
            case 'tool_call':
                if (update.toolCallId) {
                    this.toolCalls.set(update.toolCallId, { ...update });
                }
                break;
            case 'tool_call_update': {
                const previous = this.toolCalls.get(update.toolCallId) || {};
                this.toolCalls.set(update.toolCallId, {
                    ...previous,
                    ...update
                });
                break;
            }
            case 'current_mode_update':
                this.currentModeId = update.currentModeId || update.modeId || '';
                break;
            case 'available_commands_update':
                this.availableCommands = Array.isArray(update.availableCommands)
                    ? update.availableCommands
                    : [];
                break;
            default:
                break;
        }
    }

    async sendPrompt(text) {
        const response = await this.server.fetch(
            `/api/agents/tabs/${this.id}/prompt`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            }
        );
        if (!response.ok) {
            await throwResponseError(response, 'Failed to send prompt');
        }
        await syncAgentsForServer(this.server, { force: true });
    }

    async #waitForSettled(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await syncAgentsForServer(this.server, { force: true });
            const current = state.agentTabs.get(this.key);
            if (!current || !current.busy) {
                return;
            }
            await new Promise((resolve) => {
                setTimeout(resolve, 150);
            });
        }
    }

    async cancel() {
        const response = await this.server.fetch(
            `/api/agents/tabs/${this.id}/cancel`,
            {
                method: 'POST'
            }
        );
        if (!response.ok) {
            await throwResponseError(response, 'Failed to stop prompt');
        }
        await this.#waitForSettled();
    }

    async resolvePermission(permissionId, optionId = '') {
        const response = await this.server.fetch(
            `/api/agents/tabs/${this.id}/permissions/${permissionId}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ optionId })
            }
        );
        if (!response.ok) {
            await throwResponseError(response, 'Failed to resolve permission');
        }
        await syncAgentsForServer(this.server, { force: true });
    }

    async setMode(modeId) {
        const response = await this.server.fetch(
            `/api/agents/tabs/${this.id}/mode`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modeId })
            }
        );
        if (!response.ok) {
            await throwResponseError(response, 'Failed to switch mode');
        }
        const data = await response.json();
        this.update(data);
        this.notifyUi();
    }

    async close() {
        await this.server.fetch(`/api/agents/tabs/${this.id}`, {
            method: 'DELETE'
        });
    }

    dispose() {
        this.socket?.close();
        this.socket = null;
    }
}

// #region State Management
const state = {
    servers: new Map(), // serverId -> ServerClient
    sessions: new Map(), // sessionKey -> Session
    agentDefinitions: new Map(), // serverId -> definitions[]
    agentTabs: new Map(), // agentTabKey -> AgentTab
    activeSessionKey: null,
    serverRegistryLoaded: false
};

const pendingChanges = {
    sessions: new Map() // sessionKey -> { resize, editorState, fileWrites: Map<path, content> }
};

const shiftMap = {
    '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+',
    '[': '{', ']': '}', '\\': '|', ';': ':', '\'': '"', ',': '<', '.': '>', '/': '?'
};

function getPendingSession(id) {
    if (!pendingChanges.sessions.has(id)) {
        pendingChanges.sessions.set(id, { fileWrites: new Map() });
    }
    return pendingChanges.sessions.get(id);
}

function getMainServer() {
    return state.servers.get(MAIN_SERVER_ID) || null;
}

function getActiveSession() {
    if (!state.activeSessionKey) return null;
    return state.sessions.get(state.activeSessionKey) || null;
}

function getActiveServer() {
    return getActiveSession()?.server || getMainServer();
}

function getSessionsForServer(serverId) {
    return Array.from(state.sessions.values()).filter(
        session => session.serverId === serverId
    );
}

function getAgentDefinitionsForServer(serverId) {
    return state.agentDefinitions.get(serverId) || [];
}

function getAgentTabsForServer(serverId) {
    return Array.from(state.agentTabs.values()).filter(
        (tab) => tab.serverId === serverId
    );
}

function getAgentTabsForSession(session) {
    if (!session) return [];
    return getAgentTabsForServer(session.serverId).filter(
        (tab) => tab.terminalSessionId === session.id
    );
}

function getActiveAgentTab() {
    const activeSession = getActiveSession();
    if (!activeSession) return null;
    const activeKey = activeSession.workspaceState?.activeTabKey || '';
    if (!isAgentWorkspaceTabKey(activeKey)) return null;
    return state.agentTabs.get(activeKey) || null;
}

function normalizeAgentModes(modes) {
    if (!Array.isArray(modes)) return [];
    return modes
        .map((mode) => {
            const id = mode?.id || mode?.modeId || '';
            if (!id) return null;
            return {
                id,
                name: mode?.name || id,
                description: mode?.description || ''
            };
        })
        .filter(Boolean);
}

function normalizeAgentCommands(commands) {
    if (!Array.isArray(commands)) return [];
    return commands
        .map((command) => {
            const name = typeof command?.name === 'string'
                ? command.name.trim()
                : '';
            if (!name) return null;
            return {
                name,
                description: command?.description || '',
                inputHint: command?.input?.hint || ''
            };
        })
        .filter(Boolean);
}

function getAgentCommandSuggestions(agentTab, promptValue) {
    if (!agentTab?.availableCommands || agentTab.busy) return [];
    const source = String(promptValue || '');
    const trimmed = source.replace(/^\s+/, '');
    const firstLine = trimmed.split('\n', 1)[0] || '';
    if (!firstLine.startsWith('/')) return [];

    const commandToken = firstLine.slice(1);
    if (/\s/.test(commandToken)) return [];

    const query = commandToken.toLowerCase();
    const commands = normalizeAgentCommands(agentTab.availableCommands);
    const ranked = commands.filter((command) => {
        const name = command.name.toLowerCase();
        return !query || name.startsWith(query) || name.includes(query);
    });

    ranked.sort((left, right) => {
        const leftStarts = left.name.toLowerCase().startsWith(query);
        const rightStarts = right.name.toLowerCase().startsWith(query);
        if (leftStarts !== rightStarts) {
            return leftStarts ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
    });

    return ranked.slice(0, 8);
}

function getCurrentAgentModeLabel(agentTab) {
    const currentModeId = agentTab?.currentModeId || '';
    if (!currentModeId) return '';
    return normalizeAgentModes(agentTab?.availableModes).find(
        (mode) => mode.id === currentModeId
    )?.name || currentModeId;
}

function getAgentSessionUser(agentTab) {
    const session = agentTab?.getLinkedSession?.() || null;
    if (!session) return 'user';
    return getEnvValue(session.env, 'USER')
        || getEnvValue(session.env, 'LOGNAME')
        || getEnvValue(session.env, 'USERNAME')
        || 'user';
}

function getAgentBaseName(agentTab) {
    const rawLabel = String(agentTab?.agentLabel || 'Agent').trim();
    const cleaned = rawLabel.replace(
        /\s+(CLI|Agent|Adapter)$/i,
        ''
    ).trim();
    return cleaned || rawLabel || 'Agent';
}

function getAgentStarterPrompts(agentTab) {
    switch (String(agentTab?.agentId || '')) {
        case 'codex':
            return [
                'Review this workspace for issues.',
                'Explain how auth works here.',
                'Fix the ACP smoke flow.'
            ];
        case 'claude':
            return [
                'Summarize this codebase.',
                'Find the riskiest regression here.',
                'Propose a small refactor.'
            ];
        case 'gemini':
            return [
                'Explain this repository structure.',
                'Review this code for bugs.',
                'Suggest a minimal implementation plan.'
            ];
        default:
            return [
                'Inspect this workspace.',
                'Explain the current architecture.',
                'Suggest the next implementation step.'
            ];
    }
}

function buildAgentPromptPlaceholder(agentTab) {
    if (!agentTab) {
        return AGENT_PROMPT_PLACEHOLDER.join('\n');
    }
    const session = agentTab.getLinkedSession();
    const modeLabel = getCurrentAgentModeLabel(agentTab);
    const cwd = agentTab.cwd
        ? shortenPath(
            agentTab.cwd,
            session?.env || ''
        )
        : '';
    const metaLine = [
        `Host ${getDisplayHost(agentTab.server)}`,
        cwd ? `CWD ${cwd}` : '',
        modeLabel ? `Mode ${modeLabel}` : '',
        `Status ${agentTab.status}${agentTab.busy ? ' (running)' : ''}`
    ].filter(Boolean).join(' · ');
    return [
        ...AGENT_PROMPT_PLACEHOLDER,
        `// ${metaLine}`
    ].join('\n');
}

function getAgentMessageRoleLabel(agentTab, message) {
    const role = String(message?.role || 'assistant').toLowerCase();
    const kind = String(message?.kind || 'message').toLowerCase();

    let roleLabel = message?.role || 'assistant';
    if (role === 'user') {
        roleLabel = getAgentSessionUser(agentTab);
    } else if (role === 'assistant') {
        roleLabel = getAgentBaseName(agentTab);
    }

    if (kind === 'message') {
        return roleLabel;
    }
    return `${roleLabel} · ${message.kind || kind}`;
}

function getAgentTimelineItems(agentTab) {
    if (!agentTab) return [];
    const items = [];

    for (const message of agentTab.messages || []) {
        items.push({
            type: 'message',
            order: Number.isFinite(message?.order) ? message.order : 0,
            value: message
        });
    }

    for (const toolCall of agentTab.toolCalls?.values?.() || []) {
        items.push({
            type: 'tool',
            order: Number.isFinite(toolCall?.order) ? toolCall.order : 0,
            value: toolCall
        });
    }

    for (const permission of agentTab.permissions?.values?.() || []) {
        items.push({
            type: 'permission',
            order: Number.isFinite(permission?.order) ? permission.order : 0,
            value: permission
        });
    }

    items.sort((left, right) => {
        if (left.order !== right.order) {
            return left.order - right.order;
        }
        const typeOrder = {
            message: 0,
            tool: 1,
            permission: 2
        };
        return (typeOrder[left.type] || 0) - (typeOrder[right.type] || 0);
    });

    return items;
}

function getAgentDisplayLabel(agentTab) {
    if (!agentTab) return 'Agent';
    const session = agentTab.getLinkedSession();
    if (!session) {
        return agentTab.agentLabel || 'Agent';
    }

    const siblings = getAgentTabsForSession(session)
        .filter((tab) => tab.agentLabel === agentTab.agentLabel)
        .sort((left, right) => {
            const created = (left.createdAt || '').localeCompare(
                right.createdAt || ''
            );
            if (created !== 0) return created;
            return left.id.localeCompare(right.id);
        });
    if (siblings.length <= 1) {
        return agentTab.agentLabel || 'Agent';
    }
    const index = siblings.findIndex((tab) => tab.key === agentTab.key);
    const suffix = index >= 0 ? index + 1 : siblings.length;
    return `${agentTab.agentLabel || 'Agent'} #${suffix}`;
}

function buildAgentTimelineRoleLabel(agentTab, kind) {
    return `${getAgentBaseName(agentTab)} · ${kind}`;
}

function normalizeStatusClass(status = '') {
    const value = String(status || 'pending').toLowerCase();
    if (
        value.includes('complete')
        || value.includes('success')
        || value.includes('select')
        || value.includes('approve')
    ) {
        return 'completed';
    }
    if (value.includes('cancel')) {
        return 'cancelled';
    }
    if (value.includes('error') || value.includes('fail')) {
        return 'error';
    }
    if (value.includes('run') || value.includes('progress')) {
        return 'running';
    }
    return 'pending';
}

function getAgentStatusLabel(status = '') {
    const value = String(status || 'pending').toLowerCase();
    if (value.includes('approve')) return 'allowed';
    if (value.includes('select')) return 'allowed';
    if (value.includes('abort')) return 'denied';
    if (value.includes('complete') || value.includes('success')) {
        return 'completed';
    }
    if (value.includes('cancel')) return 'cancelled';
    if (value.includes('error') || value.includes('fail')) return 'error';
    if (value.includes('run') || value.includes('progress')) return 'running';
    return 'pending';
}

function getPermissionOptionById(permission, optionId) {
    if (!optionId) return null;
    return Array.isArray(permission?.options)
        ? permission.options.find(
            (option) => (option.optionId || option.id || '') === optionId
        ) || null
        : null;
}

function getAgentPermissionStatusLabel(permission) {
    const status = String(permission?.status || 'pending').toLowerCase();
    const selected = getPermissionOptionById(
        permission,
        permission?.selectedOptionId || ''
    );
    const kind = String(selected?.kind || '').toLowerCase();

    if (kind === 'allow_always') return 'allowed always';
    if (kind === 'allow_once') return 'allowed once';
    if (kind === 'reject_always') return 'denied always';
    if (kind === 'reject_once') return 'denied';
    if (status.includes('abort')) return 'denied';
    return getAgentStatusLabel(status);
}

function escapeHtml(text) {
    return String(text || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderAgentInlineMarkdown(text) {
    const source = String(text || '');
    const pattern = /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))/g;
    let result = '';
    let lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
        const [token, codeToken, , linkLabel, linkHref] = match;
        result += escapeHtml(source.slice(lastIndex, match.index));
        if (codeToken) {
            result += `<code>${escapeHtml(codeToken.slice(1, -1))}</code>`;
        } else if (linkLabel && linkHref) {
            result += `<a href="${escapeHtml(linkHref)}">${escapeHtml(linkLabel)}</a>`;
        } else {
            result += escapeHtml(token);
        }
        lastIndex = (match.index || 0) + token.length;
    }
    result += escapeHtml(source.slice(lastIndex));
    return result;
}

function normalizeAgentMessageText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/([.!?`'")])([A-Z[`"])/g, '$1\n\n$2');
}

function renderAgentMessageMarkdown(text) {
    const source = normalizeAgentMessageText(text);
    if (!source) return '';

    const lines = source.split('\n');
    const blocks = [];
    let paragraph = [];
    let list = [];
    let codeFence = null;
    let codeLines = [];

    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        blocks.push(
            `<p>${paragraph.map(renderAgentInlineMarkdown).join('<br>')}</p>`
        );
        paragraph = [];
    };

    const flushList = () => {
        if (list.length === 0) return;
        blocks.push(
            `<ul>${list.map((item) => (
                `<li>${renderAgentInlineMarkdown(item)}</li>`
            )).join('')}</ul>`
        );
        list = [];
    };

    const flushCode = () => {
        if (codeFence === null) return;
        const languageClass = codeFence
            ? ` class="language-${escapeHtml(codeFence)}"`
            : '';
        blocks.push(
            `<pre><code${languageClass}>${escapeHtml(
                codeLines.join('\n')
            )}</code></pre>`
        );
        codeFence = null;
        codeLines = [];
    };

    for (const line of lines) {
        const fenceMatch = line.match(/^```(.*)$/);
        if (fenceMatch) {
            flushParagraph();
            flushList();
            if (codeFence === null) {
                codeFence = fenceMatch[1].trim();
            } else {
                flushCode();
            }
            continue;
        }

        if (codeFence !== null) {
            codeLines.push(line);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            flushList();
            continue;
        }

        const listMatch = line.match(/^[-*]\s+(.*)$/);
        if (listMatch) {
            flushParagraph();
            list.push(listMatch[1]);
            continue;
        }

        flushList();
        paragraph.push(line);
    }

    flushParagraph();
    flushList();
    flushCode();

    const html = blocks.join('');
    return DOMPurify.sanitize(html);
}

function truncateAgentDetail(text, limit = AGENT_MESSAGE_MAX_RENDER_BYTES) {
    const value = String(text || '');
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}\n\n…truncated…`;
}

function buildAgentSectionSummaryLabel(label) {
    const node = document.createElement('span');
    node.className = 'agent-tool-call-summary-label';
    node.textContent = label;
    return node;
}

function buildAgentSectionSummaryPreview(text) {
    const value = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!value) return '';
    return value.length > 96
        ? `${value.slice(0, 93)}…`
        : value;
}

function buildAgentSectionSummaryPreviewNode(text) {
    const node = document.createElement('span');
    node.className = 'agent-tool-call-summary-preview';
    node.textContent = text;
    return node;
}

function extractToolPaths(toolLike) {
    if (!Array.isArray(toolLike?.locations)) return [];
    return toolLike.locations
        .map((item) => item?.path || '')
        .filter(Boolean);
}

function normalizeToolPathLabel(path) {
    if (!path) return '';
    const value = String(path);
    const basename = value.split('/').filter(Boolean).pop();
    return basename ? `${basename} · ${value}` : value;
}

function toolTitleIncludesPath(title, path) {
    const titleValue = String(title || '').toLowerCase();
    const pathValue = String(path || '').toLowerCase();
    if (!titleValue || !pathValue) return false;
    if (titleValue.includes(pathValue)) return true;
    const basename = pathValue.split('/').filter(Boolean).pop() || '';
    return basename ? titleValue.includes(basename) : false;
}

function summarizeToolChanges(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') return '';
    if (!rawInput.changes || typeof rawInput.changes !== 'object') return '';
    const lines = Object.entries(rawInput.changes)
        .slice(0, 5)
        .map(([path, change]) => {
            const kind = change?.type || 'change';
            return `${kind}: ${path}`;
        });
    if (lines.length === 0) return '';
    const extra = Object.keys(rawInput.changes).length - lines.length;
    if (extra > 0) {
        lines.push(`…and ${extra} more change${extra === 1 ? '' : 's'}`);
    }
    return lines.join('\n');
}

function summarizeAgentRawInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') return '';
    const changeSummary = summarizeToolChanges(rawInput);
    if (changeSummary) {
        return changeSummary;
    }
    if (typeof rawInput.command === 'string' && rawInput.command) {
        return rawInput.command;
    }
    if (Array.isArray(rawInput.command) && rawInput.command.length > 0) {
        return rawInput.command.join(' ');
    }
    if (typeof rawInput.path === 'string' && rawInput.path) {
        return rawInput.path;
    }
    if (Array.isArray(rawInput.paths) && rawInput.paths.length > 0) {
        return rawInput.paths.join('\n');
    }
    return JSON.stringify(rawInput, null, 2);
}

function summarizeAgentRawOutput(rawOutput) {
    if (!rawOutput || typeof rawOutput !== 'object') return '';
    const parts = [];
    if (typeof rawOutput.stdout === 'string' && rawOutput.stdout) {
        parts.push(`STDOUT\n${rawOutput.stdout}`);
    }
    if (typeof rawOutput.stderr === 'string' && rawOutput.stderr) {
        parts.push(`STDERR\n${rawOutput.stderr}`);
    }
    if (
        typeof rawOutput.aggregated_output === 'string'
        && rawOutput.aggregated_output
        && parts.length === 0
    ) {
        parts.push(`OUTPUT\n${rawOutput.aggregated_output}`);
    }
    if (
        typeof rawOutput.formatted_output === 'string'
        && rawOutput.formatted_output
        && parts.length === 0
    ) {
        parts.push(`OUTPUT\n${rawOutput.formatted_output}`);
    }
    if (parts.length > 0) {
        return truncateAgentDetail(parts.join('\n\n'));
    }
    if (rawOutput.success === false) {
        return 'Tool call failed.';
    }
    if (
        typeof rawOutput.exit_code === 'number'
        && rawOutput.exit_code !== 0
    ) {
        return `Exit code ${rawOutput.exit_code}`;
    }
    return '';
}

function summarizeToolCallContent(toolCall) {
    if (!Array.isArray(toolCall?.content)) return '';
    const lines = [];
    for (const item of toolCall.content) {
        if (item?.type === 'content' && item.content?.type === 'text') {
            if (item.content.text) {
                lines.push(item.content.text);
            }
            continue;
        }
        if (item?.type === 'terminal' && item.terminalId) {
            lines.push(`Terminal: ${item.terminalId}`);
            continue;
        }
        if (item?.type === 'diff' && item.path) {
            lines.push(`Diff: ${normalizeToolPathLabel(item.path)}`);
        }
    }
    return truncateAgentDetail(lines.join('\n\n'));
}

function getAgentToolTitle(toolCall) {
    if (toolCall?.title) return toolCall.title;
    const command = Array.isArray(toolCall?.rawInput?.command)
        ? toolCall.rawInput.command.join(' ')
        : '';
    if (command) {
        return command.length > 80
            ? `${command.slice(0, 77)}...`
            : command;
    }
    if (toolCall?.kind === 'execute') return 'Command execution';
    if (toolCall?.kind === 'read') return 'Read';
    if (toolCall?.kind === 'edit') return 'Edit';
    if (toolCall?.kind === 'search') return 'Search';
    if (toolCall?.kind === 'fetch') return 'Fetch';
    return toolCall?.toolCallId || 'Tool call';
}

function buildAgentToolMeta(toolCall) {
    const parts = [];
    if (toolCall?.kind) parts.push(toolCall.kind);
    if (toolCall?.rawInput?.cwd) parts.push(toolCall.rawInput.cwd);
    const paths = extractToolPaths(toolCall);
    if (paths.length > 0) {
        const title = getAgentToolTitle(toolCall);
        if (paths.length > 1) {
            parts.push(`${paths.length} paths`);
        } else if (!toolTitleIncludesPath(title, paths[0])) {
            parts.push(normalizeToolPathLabel(paths[0]));
        }
    }
    return parts.join(' · ');
}

function buildAgentToolSections(toolCall) {
    const sections = [];
    const paths = extractToolPaths(toolCall);
    const title = getAgentToolTitle(toolCall);
    if (paths.length > 0 && !(
        paths.length === 1 && toolTitleIncludesPath(title, paths[0])
    )) {
        sections.push({
            label: paths.length === 1 ? 'Path' : 'Paths',
            text: truncateAgentDetail(
                paths.map((path) => normalizeToolPathLabel(path)).join('\n')
            )
        });
    }
    const rawInput = summarizeAgentRawInput(toolCall?.rawInput);
    if (rawInput) {
        sections.push({
            label: 'Input',
            text: truncateAgentDetail(rawInput)
        });
    }
    const content = summarizeToolCallContent(toolCall);
    if (content) {
        sections.push({
            label: 'Content',
            text: content
        });
    }
    const rawOutput = summarizeAgentRawOutput(toolCall?.rawOutput);
    if (rawOutput) {
        sections.push({
            label: 'Output',
            text: rawOutput
        });
    }
    return sections;
}

function buildAgentPermissionMeta(permission) {
    return buildAgentToolMeta(permission?.toolCall || {});
}

function buildAgentPermissionSummary(permission) {
    const content = summarizeToolCallContent(permission?.toolCall || {});
    const paths = extractToolPaths(permission?.toolCall || {});
    const lines = String(content || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const expectedDiffLines = paths.map((path) =>
        `Diff: ${normalizeToolPathLabel(path)}`
    );
    const hasOnlyPathDiffs = lines.length > 0
        && lines.length === expectedDiffLines.length
        && lines.every((line) => expectedDiffLines.includes(line));
    if (hasOnlyPathDiffs) return '';
    if (content) return content;
    return '';
}

function buildAgentPermissionSections(permission) {
    const sections = buildAgentToolSections(permission?.toolCall || {});
    const selectedOption = getPermissionOptionById(
        permission,
        permission?.selectedOptionId || ''
    );
    if (selectedOption) {
        sections.push({
            label: 'Decision',
            text: selectedOption.name
                || selectedOption.optionId
                || selectedOption.kind
                || 'Selected option'
        });
    }
    const optionLines = permission?.status === 'pending'
        && Array.isArray(permission?.options)
        ? permission.options.map((option) => {
            const label = option?.name || option?.optionId || '';
            const kind = option?.kind ? ` (${option.kind})` : '';
            return `${label}${kind}`;
        }).filter(Boolean)
        : [];
    if (optionLines.length > 0) {
        sections.push({
            label: 'Options',
            text: optionLines.join('\n')
        });
    }
    return sections;
}

function getAgentPermissionTitle(permission) {
    return permission?.toolCall?.title
        || getAgentToolTitle(permission?.toolCall || {})
        || 'Permission required';
}

function buildAgentDefinitionMeta(definition) {
    if (definition.available === false) {
        if (definition.id === 'gemini'
            && definition.reason === 'API key missing') {
            return 'Set GEMINI_API_KEY or GOOGLE_API_KEY on this host';
        }
        if (definition.reason === 'not installed') {
            return `Install or expose: ${definition.commandLabel}`;
        }
        return definition.reason || 'Unavailable';
    }
    if (definition.id === 'codex') {
        return 'Codex ACP adapter · requires codex login on this host';
    }
    if (definition.id === 'claude') {
        return 'Claude Code ACP adapter · requires Claude auth on this host';
    }
    return definition.description || definition.commandLabel || '';
}

function buildAgentSetupMessage(definition) {
    if (!definition) {
        return 'This agent is not ready on the current host.';
    }
    if (
        definition.id === 'gemini'
        && definition.reason === 'API key missing'
    ) {
        return 'Gemini CLI is installed on this host, but Tabminal was '
            + 'started without GEMINI_API_KEY or GOOGLE_API_KEY. Export one '
            + 'of those variables in the service environment, then restart '
            + 'this host.';
    }
    if (definition.reason === 'not installed') {
        return `Install or expose ${definition.commandLabel} on the current `
            + 'host, then restart Tabminal.';
    }
    return definition.reason || 'This agent is not ready on the current host.';
}

async function throwResponseError(response, fallbackMessage) {
    let message = fallbackMessage;
    try {
        const payload = await response.json();
        if (payload?.error) {
            message = payload.error;
        }
    } catch {
        // Ignore invalid JSON error bodies.
    }
    throw new Error(message);
}

function insertTextareaText(textarea, text) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.setRangeText(text, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function refreshWorkspaceIfSessionActive(session) {
    if (!session) return;
    if (state.activeSessionKey !== session.key) return;
    if (editorManager.currentSession?.key !== session.key) {
        editorManager.switchTo(session);
        return;
    }
    const activeKey = editorManager.getActiveWorkspaceTabKey(session);
    editorManager.renderEditorTabs();
    if (activeKey) {
        editorManager.activateWorkspaceTab(activeKey, true);
    } else {
        editorManager.showEmptyState();
    }
    editorManager.updateEditorPaneVisibility();
}

function upsertAgentTab(server, data) {
    const key = makeAgentTabKey(server.id, data.id);
    const existing = state.agentTabs.get(key);
    if (existing) {
        existing.update(data);
        existing.connect();
        existing.notifyUi();
        return existing;
    }
    const agentTab = new AgentTab(data, server);
    state.agentTabs.set(key, agentTab);
    return agentTab;
}

function removeAgentTab(agentTabKey) {
    const agentTab = state.agentTabs.get(agentTabKey);
    if (!agentTab) return;
    const session = agentTab.getLinkedSession();
    agentTab.dispose();
    state.agentTabs.delete(agentTabKey);

    if (
        session
        && session.workspaceState?.activeTabKey === agentTabKey
    ) {
        const files = session.editorState.openFiles;
        if (files.length > 0) {
            session.workspaceState.activeTabKey = makeFileWorkspaceTabKey(
                files[files.length - 1]
            );
        } else {
            const remaining = getAgentTabsForSession(session);
            session.workspaceState.activeTabKey = remaining[0]?.key || '';
        }
    }

    refreshWorkspaceIfSessionActive(session);
}

function removeAgentTabsForTerminalSession(session) {
    if (!session) return;
    const keys = getAgentTabsForSession(session).map((tab) => tab.key);
    for (const key of keys) {
        removeAgentTab(key);
    }
}

async function syncAgentsForServer(server, { force = false } = {}) {
    if (!server || !server.isAuthenticated) return;
    if (!force && server.agentStateLoaded) return;

    const response = await server.fetch('/api/agents');
    if (!response.ok) {
        throw new Error(`Failed to load agents: HTTP ${response.status}`);
    }
    const data = await response.json();
    state.agentDefinitions.set(
        server.id,
        Array.isArray(data?.definitions) ? data.definitions : []
    );

    const seenKeys = new Set();
    for (const tabData of data?.tabs || []) {
        const key = makeAgentTabKey(server.id, tabData.id);
        seenKeys.add(key);
        upsertAgentTab(server, tabData);
    }

    for (const agentTab of getAgentTabsForServer(server.id)) {
        if (seenKeys.has(agentTab.key)) continue;
        removeAgentTab(agentTab.key);
    }

    server.agentStateLoaded = true;
    const activeSession = getActiveSession();
    const sessions = getSessionsForServer(server.id);
    for (const session of sessions) {
        const activeKey = session.workspaceState?.activeTabKey || '';
        if (
            isAgentWorkspaceTabKey(activeKey)
            && state.agentTabs.has(activeKey)
        ) {
            session.editorState.isVisible = true;
            session.saveState();
        }
    }

    if (activeSession && activeSession.serverId === server.id) {
        const activeKey = editorManager.getActiveWorkspaceTabKey(activeSession);
        if (activeKey) {
            editorManager.switchTo(activeSession);
            return;
        }
    }

    const preferredSession = sessions.find((session) => {
        const activeKey = session.workspaceState?.activeTabKey || '';
        return (
            isAgentWorkspaceTabKey(activeKey)
            && state.agentTabs.has(activeKey)
        );
    }) || sessions.find(
        (session) => getAgentTabsForSession(session).length > 0
    );

    if (preferredSession) {
        if (!preferredSession.workspaceState.activeTabKey) {
            preferredSession.workspaceState.activeTabKey = (
                getAgentTabsForSession(preferredSession)[0]?.key || ''
            );
        }
        preferredSession.editorState.isVisible = true;
        preferredSession.saveState();
        switchToSession(preferredSession.key);
    }
}

async function createAgentTab(session, agentId, options = {}) {
    if (!session || !agentId) return null;
    const response = await session.server.fetch('/api/agents/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            agentId,
            cwd: options.cwd || session.cwd || session.initialCwd || '/',
            terminalSessionId: session.id,
            modeId: options.modeId || ''
        })
    });
    if (!response.ok) {
        await throwResponseError(response, 'Failed to create agent tab');
    }
    const data = await response.json();
    const agentTab = upsertAgentTab(session.server, data);
    session.editorState.isVisible = true;
    session.workspaceState.activeTabKey = agentTab.key;
    session.saveState();
    if (state.activeSessionKey === session.key) {
        if (editorManager.currentSession?.key !== session.key) {
            editorManager.switchTo(session);
        }
        editorManager.activateAgentTab(agentTab.key);
        editorManager.updateEditorPaneVisibility();
    } else {
        refreshWorkspaceIfSessionActive(session);
    }
    return agentTab;
}

function getServerEndpointKey(server) {
    if (!server) return '';
    return getServerEndpointKeyFromUrl(server.baseUrl);
}

function findServerByEndpointKey(endpointKey, excludeServerId = '') {
    for (const server of state.servers.values()) {
        if (excludeServerId && server.id === excludeServerId) continue;
        try {
            if (getServerEndpointKey(server) === endpointKey) {
                return server;
            }
        } catch {
            // Ignore invalid entries and continue.
        }
    }
    return null;
}

function getPersistedServers() {
    return Array.from(state.servers.values())
        .map(server => server.toJSON());
}

async function saveServerRegistryToBackend() {
    const mainServer = getMainServer();
    if (!mainServer || !mainServer.isAuthenticated) return;
    const payload = { servers: getPersistedServers() };

    const response = await mainServer.fetch('/api/cluster', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        throw new Error(`Failed to save host list: HTTP ${response.status}`);
    }
}

async function loadServerRegistryFromBackend() {
    const mainServer = getMainServer();
    if (!mainServer || !mainServer.isAuthenticated) return [];
    const response = await mainServer.fetch('/api/cluster');
    if (!response.ok) {
        throw new Error(`Failed to load host list: HTTP ${response.status}`);
    }
    const raw = await response.text();
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        throw new Error('Failed to load host list: invalid JSON response');
    }
    if (Array.isArray(payload)) {
        return payload;
    }
    if (Array.isArray(payload?.servers)) {
        return payload.servers;
    }
    throw new Error('Failed to load host list: missing servers array');
}

function resetServerEndpoint(server, normalizedUrl) {
    const currentUrl = normalizeBaseUrl(server.baseUrl);
    if (currentUrl === normalizedUrl) return false;

    server.stopHeartbeat();
    const sessionKeys = getSessionsForServer(server.id).map(session => session.key);
    for (const sessionKey of sessionKeys) {
        removeSession(sessionKey);
    }
    if (state.activeSessionKey && sessionKeys.includes(state.activeSessionKey)) {
        state.activeSessionKey = null;
        terminalEl.innerHTML = '';
    }

    server.baseUrl = normalizedUrl;
    server.modelStore.clear();
    server.expandedPaths.clear();
    server.agentStateLoaded = false;
    server.lastSystemData = null;
    server.lastLatency = 0;
    server.needsAccessLogin = false;
    server.accessLoginUrl = '';
    server.connectionStatus = 'disconnected';
    statusMemory.delete(server.id);
    return true;
}

function createServerClient(data, { isPrimary = false } = {}) {
    const { id, baseUrl } = data;
    const host = normalizeHostAlias(data.host);
    const normalized = normalizeBaseUrl(baseUrl);
    const endpointKey = getServerEndpointKeyFromUrl(normalized);
    const existing = findServerByEndpointKey(endpointKey);
    if (existing) {
        if (data.host !== undefined) {
            existing.host = host;
        }
        if (typeof data.token === 'string') {
            existing.setToken(data.token);
        }
        resetServerEndpoint(existing, normalized);
        if (isPrimary) {
            existing.isPrimary = true;
        }
        return existing;
    }
    const safeId = typeof id === 'string' ? id.trim() : '';
    const finalId = safeId && !state.servers.has(safeId)
        ? safeId
        : (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
    const server = new ServerClient({
        id: finalId,
        baseUrl: normalized,
        host: host,
        token: typeof data.token === 'string' ? data.token : ''
    }, { isPrimary });
    state.servers.set(server.id, server);
    return server;
}

function bootstrapServers() {
    createServerClient({
        id: MAIN_SERVER_ID,
        baseUrl: window.location.origin
    }, { isPrimary: true });
    renderServerControls();
}

async function hydrateServerRegistry() {
    if (state.serverRegistryLoaded) {
        return;
    }
    const mainServer = getMainServer();
    if (!mainServer) {
        return;
    }
    if (!mainServer.isAuthenticated) {
        return;
    }
    try {
        const serverConfigs = await loadServerRegistryFromBackend();
        const mainKey = getServerEndpointKey(mainServer);
        const mainHostname = getUrlHostname(mainServer.baseUrl);
        const deduplicated = new Map();
        for (const raw of serverConfigs) {
            try {
                const normalizedUrl = normalizeBaseUrl(raw?.baseUrl);
                const endpointKey = getServerEndpointKeyFromUrl(normalizedUrl);
                const hostname = getUrlHostname(normalizedUrl);
                if (
                    !endpointKey
                    || endpointKey === mainKey
                    || (hostname && mainHostname && hostname === mainHostname)
                ) {
                    continue;
                }
                deduplicated.set(endpointKey, {
                    id: typeof raw?.id === 'string' ? raw.id : '',
                    baseUrl: normalizedUrl,
                    host: normalizeHostAlias(raw?.host),
                    token: typeof raw?.token === 'string' ? raw.token : ''
                });
            } catch (error) {
                console.warn('Skip invalid host config from backend:', raw, error);
            }
        }

        for (const serverData of deduplicated.values()) {
            createServerClient(serverData);
        }
        state.serverRegistryLoaded = true;
    } catch (error) {
        console.warn('Failed to load host list from backend:', error);
        state.serverRegistryLoaded = false;
        alert('Failed to load host list from backend.', {
            type: 'warning',
            title: 'Host'
        });
    }
    renderServerControls();
}

async function syncServerList() {
    try {
        await saveServerRegistryToBackend();
    } catch (error) {
        console.warn('Failed to save host list:', error);
        alert('Failed to save host list.', {
            type: 'warning',
            title: 'Host'
        });
    }
}

async function fetchExpandedPaths(server) {
    try {
        const res = await server.fetch('/api/memory/expanded');
        if (res.ok) {
            const list = await res.json();
            server.expandedPaths.clear();
            list.forEach(path => server.expandedPaths.add(path));
        }
    } catch (e) { console.error(e); }
}

async function syncServer(server) {
    if (!server || !server.isAuthenticated) return;
    const now = Date.now();
    const wasReconnecting = server.connectionStatus === 'reconnecting';
    const shouldRefreshAgents = !server.agentStateLoaded || wasReconnecting;
    if (
        wasReconnecting
        && server.nextSyncAt
        && now < server.nextSyncAt
    ) {
        return;
    }

    for (const session of getSessionsForServer(server.id)) {
        if (!session.socket || session.socket.readyState === WebSocket.CLOSED) {
            session.connect();
        }
    }

    const updates = { sessions: [] };
    for (const [sessionKey, pending] of pendingChanges.sessions) {
        const { serverId, sessionId } = splitSessionKey(sessionKey);
        if (serverId !== server.id) continue;

        const sessionUpdate = { id: sessionId };
        let hasUpdate = false;

        if (pending.resize) {
            sessionUpdate.resize = pending.resize;
            hasUpdate = true;
        }
        if (pending.editorState) {
            sessionUpdate.editorState = pending.editorState;
            hasUpdate = true;
        }
        if (pending.fileWrites && pending.fileWrites.size > 0) {
            sessionUpdate.fileWrites = Array.from(pending.fileWrites.entries()).map(([path, content]) => ({ path, content }));
            hasUpdate = true;
        }

        if (hasUpdate) {
            updates.sessions.push(sessionUpdate);
        }
    }

    const startTime = Date.now();

    try {
        const response = await server.fetch('/api/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates })
        });
        
        const latency = Date.now() - startTime;

        if (!response.ok) {
            if (!wasReconnecting) {
                console.warn(
                    `[Heartbeat] ${getDisplayHost(server)} returned HTTP ${response.status}. Reconnecting...`
                );
            }
            server.nextSyncAt = Date.now() + RECONNECT_RETRY_MS;
            setStatus(server, 'reconnecting');
            server.lastLatency = -1;
            pushServerHeartbeat(server, -1);
            updateServerControlMetric(server);
            if (getActiveServer()?.id === server.id) {
                updateSystemStatus(null, -1, server);
            }
            return;
        }
        
        // Clear sent updates
        for (const update of updates.sessions) {
            const pending = pendingChanges.sessions.get(
                makeSessionKey(server.id, update.id)
            );
            if (!pending) continue;
            
            if (update.resize) delete pending.resize;
            if (update.editorState) delete pending.editorState;
            if (update.fileWrites) {
                for (const file of update.fileWrites) {
                    pending.fileWrites.delete(file.path);
                }
            }
        }

        const data = await response.json();
        server.nextSyncAt = 0;
        if (server.isPrimary) {
            handlePrimaryRuntimeVersion(data);
        }
        server.needsAccessLogin = false;
        server.accessLoginUrl = '';
        setStatus(server, 'connected');
        if (data.system) {
            server.lastSystemData = data.system;
            server.lastLatency = latency;
            pushServerHeartbeat(server, latency);
            updateServerControlMetric(server);
            if (getActiveServer()?.id === server.id) {
                updateSystemStatus(data.system, latency, server);
            }
        } else {
            pushServerHeartbeat(server, latency);
            updateServerControlMetric(server);
        }

        const sessions = Array.isArray(data) ? data : data.sessions;
        reconcileSessions(server, sessions || []);
        if (shouldRefreshAgents) {
            try {
                await syncAgentsForServer(server, { force: true });
            } catch (error) {
                console.warn('Failed to sync agents:', error);
            }
        }
    } catch (error) {
        if (!wasReconnecting) {
            console.warn(
                `[Heartbeat] ${getDisplayHost(server)} unavailable (${formatHeartbeatError(error)}). Reconnecting...`
            );
        }
        if (!server.isAuthenticated) return;
        server.nextSyncAt = Date.now() + RECONNECT_RETRY_MS;
        setStatus(server, 'reconnecting');
        server.lastLatency = -1;
        pushServerHeartbeat(server, -1);
        updateServerControlMetric(server);
        if (getActiveServer()?.id === server.id) {
            updateSystemStatus(null, -1, server);
        }
    }
}

function formatHeartbeatError(error) {
    if (!error) return 'unknown error';
    if (typeof error === 'string') return error;
    if (error.code === 'ACCESS_REDIRECT') {
        return 'cloudflare access login required';
    }
    const name = typeof error.name === 'string' ? error.name : '';
    const message = typeof error.message === 'string' ? error.message : '';
    if (name === 'TypeError' && message.includes('Failed to fetch')) {
        return 'network blocked or endpoint unreachable';
    }
    if (message) return message;
    if (name) return name;
    return 'unknown error';
}

let lastLatency = 0;
const TOTAL_POINTS = 110;
const VISIBLE_POINTS = 100;
const BUFFER_POINTS = 5;
const latencyHistory = new Array(TOTAL_POINTS).fill(0); 
let hasInitializedHistory = false;
let lastUpdateTime = performance.now();
let smoothedMaxVal = 1;
let currentBottomGap = 0;

const heartbeatCanvas = document.getElementById('heartbeat-canvas');

function updateCanvasSize() {
    if (!heartbeatCanvas) return;
    let bottomGap = 0;
    
    if (window.visualViewport) {
        // Sanity check: If height is invalid (iPad PWA bug), assume full screen (0 gap)
        if (window.visualViewport.height > 100) {
            bottomGap = window.innerHeight - (window.visualViewport.height + window.visualViewport.offsetTop);
        } else {
            bottomGap = 0;
        }
    }
    
    currentBottomGap = bottomGap;
    
    if (bottomGap < 10) {
        heartbeatCanvas.style.height = '0px';
        heartbeatCanvas.style.display = 'none';
    } else {
        heartbeatCanvas.style.height = `${bottomGap}px`;
        heartbeatCanvas.style.display = 'block';
    }
}

// Cubic B-Spline Interpolation
// Creates a C2 continuous curve that approximates points, filtering noise for a premium look.
function cubicBSpline(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    
    const b0 = (1 - t) * (1 - t) * (1 - t) / 6;
    const b1 = (3 * t3 - 6 * t2 + 4) / 6;
    const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
    const b3 = t3 / 6;
    
    return p0 * b0 + p1 * b1 + p2 * b2 + p3 * b3;
}

function ensureServerHeartbeatState(server) {
    if (!server) return;
    if (!Array.isArray(server.heartbeatHistory) || server.heartbeatHistory.length === 0) {
        server.heartbeatHistory = new Array(TOTAL_POINTS).fill(0);
    }
    if (typeof server.heartbeatHasInitialized !== 'boolean') {
        server.heartbeatHasInitialized = false;
    }
    if (typeof server.heartbeatLastUpdateTime !== 'number') {
        server.heartbeatLastUpdateTime = performance.now();
    }
    if (typeof server.heartbeatSmoothedMaxVal !== 'number') {
        server.heartbeatSmoothedMaxVal = 1;
    }
}

function isServerHealthy(server) {
    if (!server) return false;
    return server.connectionStatus === 'connected' || server.connectionStatus === 'ready';
}

function formatServerLatency(server) {
    if (!isServerHealthy(server) || !Number.isFinite(server.lastLatency) || server.lastLatency < 0) {
        return '-- ms';
    }
    return `${Math.round(server.lastLatency)} ms`;
}

function pushServerHeartbeat(server, latency) {
    if (!server) return;
    ensureServerHeartbeatState(server);
    if (!server.heartbeatHasInitialized && latency > 0) {
        server.heartbeatHasInitialized = true;
        for (let i = 0; i < TOTAL_POINTS; i++) {
            server.heartbeatHistory[i] = 10 + Math.random() * 70;
        }
    }
    server.heartbeatLastUpdateTime = performance.now();
    server.heartbeatHistory.push(latency);
    if (server.heartbeatHistory.length > TOTAL_POINTS) {
        server.heartbeatHistory.shift();
    }
}

function drawServerHeartbeatCanvas(canvas, server) {
    if (!canvas || !server) return;
    ensureServerHeartbeatState(server);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);

    const history = server.heartbeatHistory;
    if (history.length < 2) return;

    const now = performance.now();
    const progress = Math.min((now - server.heartbeatLastUpdateTime) / 1000, 1.0);
    const step = width / VISIBLE_POINTS;

    let maxVal = 0;
    for (const val of history) {
        if (val > maxVal) maxVal = val;
    }
    const effectiveMax = Math.max(maxVal, 50);
    server.heartbeatSmoothedMaxVal += (effectiveMax - server.heartbeatSmoothedMaxVal) * 0.05;

    const padding = 3;
    const drawHeight = height - (padding * 2);
    if (drawHeight <= 0) return;
    const getY = (val) => (height - padding) - (val / server.heartbeatSmoothedMaxVal) * drawHeight;

    const len = history.length;
    const getX = (i) => width + step * (BUFFER_POINTS - len + 1 + i - progress);
    const getVal = (v) => (v === -1 ? 0 : v);

    let p0, p1, p2, p3;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';

    for (let i = 0; i < len - 1; i++) {
        const rawP1 = history[i];
        const rawP2 = history[Math.min(len - 1, i + 1)];
        const isError = rawP1 === -1 || rawP2 === -1;

        ctx.beginPath();
        ctx.strokeStyle = isError ? '#dc322f' : '#268bd2';

        p0 = getVal(history[Math.max(0, i - 1)]);
        p1 = getVal(rawP1);
        p2 = getVal(rawP2);
        p3 = getVal(history[Math.min(len - 1, i + 2)]);

        for (let t = 0; t <= 1; t += 0.1) {
            const x = getX(i) + t * step;
            let val = cubicBSpline(p0, p1, p2, p3, t);
            if (val < 0) val = 0;
            if (t === 0) ctx.moveTo(x, getY(val));
            else ctx.lineTo(x, getY(val));
        }
        ctx.stroke();
    }
}

function drawServerHeartbeats() {
    if (!serverControlsEl) return;
    const canvases = serverControlsEl.querySelectorAll('.server-heartbeat-canvas');
    for (const canvas of canvases) {
        const row = canvas.closest('.server-row');
        if (!row) continue;
        const serverId = row.dataset.serverId;
        if (!serverId) continue;
        const server = state.servers.get(serverId);
        if (!server) continue;
        drawServerHeartbeatCanvas(canvas, server);
    }
}

function drawHeartbeat() {
    updateCanvasSize();
    
    const bottomCanvas = document.getElementById('heartbeat-canvas');
    const desktopCanvas = document.getElementById('desktop-heartbeat-canvas');
    
    let targetCanvas = null;
    let useMaxHeight = false;
    
    // Decision Logic
    if (currentBottomGap > 10) {
        // Mobile Mode: Use bottom canvas
        if (desktopCanvas) desktopCanvas.style.display = 'none';
        if (bottomCanvas) {
            bottomCanvas.style.display = 'block';
            targetCanvas = bottomCanvas;
        }
    } else {
        // Desktop Mode: Use status bar canvas
        if (bottomCanvas) bottomCanvas.style.display = 'none';
        if (desktopCanvas) {
            desktopCanvas.style.display = 'block';
            targetCanvas = desktopCanvas;
            useMaxHeight = true;
        }
    }
    
    if (!targetCanvas) return;
    
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;

    const width = targetCanvas.clientWidth;
    const height = targetCanvas.clientHeight;
    
    if (width === 0 || height === 0) return;

    if (targetCanvas.width !== width || targetCanvas.height !== height) {
        targetCanvas.width = width;
        targetCanvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);
    
    if (latencyHistory.length < 2) return;

    // Calculate Scroll Progress
    const now = performance.now();
    const progress = Math.min((now - lastUpdateTime) / 1000, 1.0); 
    
    const step = width / VISIBLE_POINTS;
    
    // Smooth Scaling
    let maxVal = 0;
    for (const val of latencyHistory) if (val > maxVal) maxVal = val;
    const effectiveMax = Math.max(maxVal, 50);
    smoothedMaxVal += (effectiveMax - smoothedMaxVal) * 0.05;
    
    const verticalRange = useMaxHeight ? smoothedMaxVal : (smoothedMaxVal / 0.8);
    
    const padding = 3;
    const drawHeight = height - (padding * 2);
    const getY = (val) => (height - padding) - (val / verticalRange) * drawHeight;

    ctx.beginPath();
    ctx.strokeStyle = '#268bd2';
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';

    const len = latencyHistory.length;
    
    const getX = (i) => width + step * (BUFFER_POINTS - len + 1 + i - progress);
    const getVal = (v) => (v === -1 ? 0 : v);

    let p0, p1, p2, p3;

    // 1. Draw Fill (Only for mobile/bottom view)
    if (!useMaxHeight) {
        ctx.beginPath();
        
        p0 = getVal(latencyHistory[0]);
        p1 = getVal(latencyHistory[0]);
        p2 = getVal(latencyHistory[Math.min(len - 1, 1)]);
        p3 = getVal(latencyHistory[Math.min(len - 1, 2)]);
        
        ctx.moveTo(getX(0), getY(getVal(latencyHistory[0])));

        for (let i = 0; i < len - 1; i++) {
            p0 = getVal(latencyHistory[Math.max(0, i - 1)]);
            p1 = getVal(latencyHistory[i]);
            p2 = getVal(latencyHistory[Math.min(len - 1, i + 1)]);
            p3 = getVal(latencyHistory[Math.min(len - 1, i + 2)]);
            
            for (let t = 0; t <= 1; t += 0.1) {
                const x = getX(i) + t * step;
                let val = cubicBSpline(p0, p1, p2, p3, t);
                if (val < 0) val = 0;
                ctx.lineTo(x, getY(val));
            }
        }
        
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.fillStyle = 'rgba(38, 139, 210, 0.1)';
        ctx.fill();
    }

    // 2. Draw Lines
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';

    for (let i = 0; i < len - 1; i++) {
        const rawP1 = latencyHistory[i];
        const rawP2 = latencyHistory[Math.min(len - 1, i + 1)];
        const isError = rawP1 === -1 || rawP2 === -1;
        
        ctx.beginPath();
        ctx.strokeStyle = isError ? '#dc322f' : '#268bd2';
        
        p0 = getVal(latencyHistory[Math.max(0, i - 1)]);
        p1 = getVal(rawP1);
        p2 = getVal(rawP2);
        p3 = getVal(latencyHistory[Math.min(len - 1, i + 2)]);
        
        for (let t = 0; t <= 1; t += 0.1) {
            const x = getX(i) + t * step;
            let val = cubicBSpline(p0, p1, p2, p3, t);
            if (val < 0) val = 0;
            
            if (t === 0) ctx.moveTo(x, getY(val));
            else ctx.lineTo(x, getY(val));
        }
        ctx.stroke();
    }
}

function animateHeartbeat() {
    requestAnimationFrame(animateHeartbeat);
    drawHeartbeat();
    drawServerHeartbeats();
}
animateHeartbeat();

function updateSystemStatus(system, latency, server = getActiveServer()) {
    const textGroup = document.getElementById('status-text-group');
    if (!textGroup) return; // Should exist in HTML now

    if (server && system) {
        server.lastSystemData = system;
    }
    if (latency !== null && latency !== undefined) {
        // Initialize history with random data on first real packet to avoid empty graph
        if (!hasInitializedHistory && latency > 0) {
            hasInitializedHistory = true;
            // Generate fake history ending near 'latency'
            // Pure random noise between 10 and 80
            for (let i = 0; i < TOTAL_POINTS; i++) {
                latencyHistory[i] = 10 + Math.random() * 70;
            }
        }

        lastLatency = latency;
        if (server) {
            server.lastLatency = latency;
        }
        lastUpdateTime = performance.now();
        latencyHistory.push(latency);
        // Keep enough history to fill screen + buffer
        // We need DISPLAY_POINTS + 1 to scroll smoothly
        if (latencyHistory.length > TOTAL_POINTS) latencyHistory.shift();
    }
    
    const data = system || server?.lastSystemData;
    if (!data) return;

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

    const memPercent = (data.memory.used / data.memory.total) * 100;

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

    const connectionStatus = server?.connectionStatus || 'disconnected';
    const isHealthy = connectionStatus === 'connected' || connectionStatus === 'ready';
    const heartbeatColor = isHealthy ? '#859900' : '#dc322f';
    const statusSuffix = isHealthy ? '' : ` (${connectionStatus || 'unknown'})`;
    const timeText = isHealthy ? `${server?.lastLatency ?? lastLatency}ms` : 'Offline';
    const heartbeatValue = `<span style="color: ${heartbeatColor}"><span class="heartbeat-dot"></span>${timeText}${statusSuffix}</span>`;
    const sessionCount = server ? getSessionsForServer(server.id).length : state.sessions.size;
    const displayHost = server ? getDisplayHost(server) : (data.hostname || 'N/A');

    const items = [
        { label: 'Host', value: displayHost },
        { label: 'Kernel', value: data.osName },
        { label: 'IP', value: data.ip },
        { label: 'CPU', value: `${data.cpu.count}x ${data.cpu.speed} ${data.cpu.usagePercent}% ${renderProgressBar(data.cpu.usagePercent)}` },
        { label: 'Mem', value: `${formatBytesPair(data.memory.used, data.memory.total)} ${memPercent.toFixed(0)}% ${renderProgressBar(memPercent)}` },
        { label: 'Up', value: formatUptime(data.uptime) },
        { label: 'Tabminal', value: `${sessionCount}> ${formatUptime(data.processUptime)}` },
        { label: 'FPS', value: currentFps },
        { label: 'Heartbeat', value: heartbeatValue }
    ];

    textGroup.innerHTML = items.map(item => `
        <div class="status-item">
            <span class="status-label">${item.label}:</span>
            <span class="status-value">${item.value}</span>
        </div>
    `).join('');
}

function reconcileSessions(server, remoteSessions) {
    const remoteIds = new Set(remoteSessions.map(session => session.id));
    const localSessions = getSessionsForServer(server.id);

    for (const session of localSessions) {
        if (!remoteIds.has(session.id)) {
            removeSession(session.key);
        }
    }

    for (const data of remoteSessions) {
        const key = makeSessionKey(server.id, data.id);
        if (state.sessions.has(key)) {
            state.sessions.get(key).update(data);
        } else {
            const session = new Session(data, server);
            state.sessions.set(key, session);
            if (!state.activeSessionKey) {
                switchToSession(session.key);
            }
        }
    }

    if (state.activeSessionKey && !state.sessions.has(state.activeSessionKey)) {
        state.activeSessionKey = null;
        if (state.sessions.size > 0) {
            switchToSession(state.sessions.keys().next().value);
        } else {
            terminalEl.innerHTML = '';
        }
    }

    renderTabs();
}

async function createNewSession(server = getActiveServer()) {
    if (!server) return;
    if (server.needsLogin || !server.isAuthenticated) {
        const password = window.prompt(`Password for ${getDisplayHost(server)}`);
        if (!password) return;
        await server.login(password);
    }
    try {
        const options = {};
        const activeSession = getActiveSession();
        if (activeSession && activeSession.serverId === server.id && activeSession.cwd) {
            options.cwd = activeSession.cwd;
        }

        const response = await server.fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options)
        });
        if (!response.ok) throw new Error('Failed to create session');
        const newSession = await response.json();
        const sessionKey = makeSessionKey(server.id, newSession.id);
        await syncServer(server);
        await switchToSession(
            sessionKey,
            { scrollTabIntoView: true }
        );
    } catch (error) {
        console.error('Failed to create session:', error);
    }
}

function removeSession(key) {
    const session = state.sessions.get(key);
    if (session) {
        removeAgentTabsForTerminalSession(session);
        session.dispose();
        state.sessions.delete(key);
    }
    pendingChanges.sessions.delete(key);
}
// #endregion

// #region UI Logic
function renderTabs() {
    if (!tabListEl) return;

    const newTabItem = document.getElementById('new-tab-item');

    // Remove tabs that are no longer in state
    const tabElements = tabListEl.querySelectorAll('.tab-item');
    for (const el of tabElements) {
        if (!state.sessions.has(el.dataset.sessionKey)) {
            el.remove();
        }
    }

    // Add or update tabs
    for (const [key, session] of state.sessions) {
        let tab = tabListEl.querySelector(`[data-session-key="${key}"]`);
        if (!tab) {
            tab = createTabElement(session);
            if (newTabItem) {
                tabListEl.insertBefore(tab, newTabItem);
            } else {
                tabListEl.appendChild(tab);
            }
            
            // Mount preview
            // Only mount on Desktop to save resources and avoid visual clutter on mobile
            if (window.innerWidth >= 768) {
                session.wrapperElement = tab.querySelector('.preview-terminal-wrapper');
                session.previewTerm.open(session.wrapperElement);
                session.updatePreviewScale();
            }
            session.updateTabUI();
        }

        // Force sync editor state class
        if (session.editorState && session.editorState.isVisible) {
            tab.classList.add('editor-open');
        } else {
            tab.classList.remove('editor-open');
        }

        if (key === state.activeSessionKey) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    }
}

function scrollSessionTabIntoView(sessionKey, behavior = 'smooth') {
    if (!tabListEl || !sessionKey) return;
    const tab = tabListEl.querySelector(`.tab-item[data-session-key="${sessionKey}"]`);
    if (!tab) return;

    const containerRect = tabListEl.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const newTabItem = document.getElementById('new-tab-item');

    let obscuredBottom = 0;
    if (newTabItem) {
        const newTabRect = newTabItem.getBoundingClientRect();
        obscuredBottom = Math.max(0, containerRect.bottom - newTabRect.top);
        obscuredBottom = Math.min(obscuredBottom, tabListEl.clientHeight);
    }

    const visibleTop = tabListEl.scrollTop;
    const visibleBottom = (
        tabListEl.scrollTop
        + tabListEl.clientHeight
        - obscuredBottom
    );

    const tabTop = tabRect.top - containerRect.top + tabListEl.scrollTop;
    const tabBottom = tabRect.bottom - containerRect.top + tabListEl.scrollTop;

    let targetTop = tabListEl.scrollTop;
    if (tabTop < visibleTop) {
        targetTop = tabTop;
    } else if (tabBottom > visibleBottom) {
        targetTop = tabBottom - (tabListEl.clientHeight - obscuredBottom);
    } else {
        return;
    }

    const maxTop = Math.max(0, tabListEl.scrollHeight - tabListEl.clientHeight);
    targetTop = Math.min(Math.max(0, targetTop), maxTop);

    tabListEl.scrollTo({
        top: targetTop,
        behavior
    });
}

function createTabElement(session) {
    const tab = document.createElement('li');
    tab.className = 'tab-item';
    if (session.editorState && session.editorState.isVisible) {
        tab.classList.add('editor-open');
    }
    tab.dataset.sessionKey = session.key;
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-tab-button';
    closeBtn.innerHTML = CLOSE_ICON_SVG;
    closeBtn.title = 'Close Terminal';
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        closeSession(session.key);
    };
    tab.appendChild(closeBtn);

    const toggleEditorBtn = document.createElement('button');
    toggleEditorBtn.className = 'toggle-editor-btn';
    toggleEditorBtn.innerHTML = '<img src="/icons/folder-src.svg" style="width: 16px; height: 16px; vertical-align: middle;">';
    toggleEditorBtn.title = 'Toggle File Editor';
    toggleEditorBtn.onclick = (e) => {
        e.stopPropagation();
        if (state.activeSessionKey !== session.key) {
            switchToSession(session.key).then(() => editorManager.toggle());
        } else {
            editorManager.toggle();
        }
    };
    tab.appendChild(toggleEditorBtn);

    const agentBtn = document.createElement('button');
    agentBtn.className = 'toggle-agent-btn';
    agentBtn.innerHTML = AGENT_ICON_SVG;
    agentBtn.title = 'Open Agent';
    agentBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!session.server.agentStateLoaded) {
            try {
                await syncAgentsForServer(session.server, { force: true });
            } catch (error) {
                alert(error.message, {
                    type: 'error',
                    title: 'Agent'
                });
                return;
            }
        }
        openAgentDropdown(session, agentBtn);
    };
    tab.appendChild(agentBtn);
    
    const fileTree = document.createElement('div');
    fileTree.className = 'tab-file-tree';
    session.fileTreeElement = fileTree;
    
    if (session.editorState && session.editorState.isVisible) {
        editorManager.renderTree(session.cwd, fileTree, session);
    }
    tab.appendChild(fileTree);
    
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

    const metaServer = document.createElement('div');
    metaServer.className = 'meta meta-server';
    renderSessionHostMeta(metaServer, session);

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
    overlay.appendChild(metaServer);
    overlay.appendChild(metaCwd);
    overlay.appendChild(metaTime);

    tab.appendChild(previewContainer);
    tab.appendChild(overlay);
    
    tab.onclick = () => switchToSession(session.key);

    // Fix iOS double-tap issue
    let touchStartY = 0;
    let isScrolling = false;

    tab.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        isScrolling = false;
    }, { passive: true });

    tab.addEventListener('touchmove', (e) => {
        if (Math.abs(e.touches[0].clientY - touchStartY) > 5) {
            isScrolling = true;
        }
    }, { passive: true });

    tab.addEventListener('touchend', (e) => {
        if (isScrolling) return;
        // Allow buttons to handle their own events
        if (e.target.closest('button') || e.target.closest('.file-tree-item')) return;
        
        if (e.cancelable) e.preventDefault(); // Prevent mouse emulation (hover/click)
        switchToSession(session.key);
    });
    
    return tab;
}

function findServerControlRow(serverId) {
    if (!serverControlsEl) return null;
    const rows = serverControlsEl.querySelectorAll('.server-row');
    for (const row of rows) {
        if (row.dataset.serverId === serverId) {
            return row;
        }
    }
    return null;
}

function updateServerControlMetric(server) {
    if (!server) return;
    const row = findServerControlRow(server.id);
    if (!row) return;
    const latencyGroupEl = row.querySelector('.server-latency-group');
    const latencyEl = row.querySelector('.server-latency-value');
    const offline = !isServerHealthy(server);
    if (latencyGroupEl) {
        latencyGroupEl.classList.toggle('offline', offline);
    }
    if (latencyEl) {
        latencyEl.textContent = formatServerLatency(server);
        latencyEl.classList.toggle('offline', offline);
    }
}

async function removeServer(serverId, { persist = true } = {}) {
    const server = state.servers.get(serverId);
    if (!server || server.isPrimary) return;

    server.stopHeartbeat();
    for (const agentTab of getAgentTabsForServer(serverId)) {
        removeAgentTab(agentTab.key);
    }
    state.agentDefinitions.delete(serverId);
    const keysToDelete = Array.from(state.sessions.values())
        .filter(session => session.serverId === serverId)
        .map(session => session.key);
    for (const key of keysToDelete) {
        removeSession(key);
    }

    state.servers.delete(serverId);
    localStorage.removeItem(buildTokenStorageKey(serverId));
    if (persist) {
        await syncServerList();
    }

    if (state.activeSessionKey && !state.sessions.has(state.activeSessionKey)) {
        state.activeSessionKey = null;
    }
    if (!state.activeSessionKey && state.sessions.size > 0) {
        await switchToSession(state.sessions.keys().next().value);
    } else {
        renderTabs();
    }
    renderServerControls();
}

function closeServerModal() {
    if (!addServerModal) return;
    addServerModal.style.display = 'none';
    if (addServerError) {
        addServerError.textContent = '';
    }
}

function openServerModal(mode, server = null) {
    if (
        !addServerModal
        || !addServerUrlInput
        || !addServerHostInput
        || !addServerPasswordInput
    ) {
        return false;
    }

    serverModalState.mode = mode;
    serverModalState.targetServerId = server?.id || null;

    if (mode === 'reconnect' && server) {
        if (addServerTitle) {
            addServerTitle.textContent = 'Reconnect Host';
        }
        if (addServerDescription) {
            addServerDescription.textContent = 'Update host and URL.';
        }
        if (addServerSubmitButton) {
            addServerSubmitButton.textContent = 'Save and Reconnect';
        }
        addServerHostInput.placeholder = 'Host (auto-detect)';
        addServerPasswordInput.placeholder = 'Password (use current)';
        addServerPasswordInput.required = false;
        addServerUrlInput.value = server.baseUrl;
        addServerHostInput.value = server.host || '';
    } else {
        if (addServerTitle) {
            addServerTitle.textContent = 'Add Host';
        }
        if (addServerDescription) {
            addServerDescription.textContent = 'Register another Tabminal host.';
        }
        if (addServerSubmitButton) {
            addServerSubmitButton.textContent = 'Register';
        }
        addServerHostInput.placeholder = 'Host (auto-detect)';
        addServerPasswordInput.placeholder = 'Password (use current)';
        addServerPasswordInput.required = false;
        addServerUrlInput.value = '';
        addServerHostInput.value = '';
    }

    addServerPasswordInput.value = '';
    if (addServerError) {
        addServerError.textContent = '';
    }
    addServerModal.style.display = 'flex';
    addServerUrlInput.focus();
    return true;
}

function renderServerControls() {
    if (!serverControlsEl) return;
    serverControlsEl.innerHTML = '';

    for (const server of state.servers.values()) {
        const row = document.createElement('div');
        row.className = 'server-row';
        row.dataset.serverId = server.id;
        const hostName = getDisplayHost(server);

        const mainButton = document.createElement('button');
        mainButton.type = 'button';
        mainButton.className = 'server-main-button';
        const requiresReconnectAction = (
            server.needsLogin
            || !server.isAuthenticated
            || server.connectionStatus === 'reconnecting'
        );
        if (requiresReconnectAction) {
            mainButton.classList.add('needs-login');
        }
        const latencyClass = isServerHealthy(server)
            ? 'server-latency-group'
            : 'server-latency-group offline';
        mainButton.innerHTML = `
            <span class="server-action-text"></span>
            <span class="server-metrics">
                <span class="${latencyClass}">
                    <span class="heartbeat-dot server-heartbeat-dot"></span>
                    <span class="server-latency-value">${formatServerLatency(server)}</span>
                </span>
                <canvas class="server-heartbeat-canvas" aria-hidden="true"></canvas>
            </span>
        `;
        const actionTextEl = mainButton.querySelector('.server-action-text');
        if (actionTextEl) {
            const prefix = server.needsAccessLogin
                ? 'Cloudflare Login '
                : (requiresReconnectAction ? 'Reconnect ' : 'New Tab @ ');
            actionTextEl.textContent = prefix;
            const hostEl = document.createElement('span');
            hostEl.className = 'host-emphasis';
            hostEl.textContent = hostName;
            actionTextEl.appendChild(hostEl);
        }
        mainButton.onclick = async () => {
            try {
                if (requiresReconnectAction) {
                    if (server.needsAccessLogin) {
                        openAccessLoginPage(server);
                    } else {
                        const shouldProbeAccessLogin = (
                            !server.isPrimary
                            && server.isAuthenticated
                            && server.connectionStatus === 'reconnecting'
                        );
                        if (shouldProbeAccessLogin) {
                            const loginUrl = await probeAccessLoginUrl(server);
                            if (loginUrl) {
                                server.needsAccessLogin = true;
                                server.accessLoginUrl = loginUrl;
                                renderServerControls();
                                openAccessLoginPage(server);
                                return;
                            }
                        }
                        const opened = openServerModal('reconnect', server);
                        if (!opened) {
                            const password = window.prompt(`Password for ${hostName}`);
                            if (!password) return;
                            await server.login(password);
                            await fetchExpandedPaths(server);
                        }
                    }
                } else {
                    await createNewSession(server);
                }
            } catch (err) {
                console.error(err);
                alert(`Failed to connect ${hostName}.`, {
                    type: 'error',
                    title: 'Host'
                });
            }
            renderServerControls();
        };

        row.appendChild(mainButton);
        if (!server.isPrimary) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'server-delete-button';
            deleteButton.title = `Remove ${hostName}`;
            deleteButton.innerHTML = CLOSE_ICON_SVG;
            deleteButton.onclick = async () => {
                const confirmed = window.confirm(`Remove host "${hostName}"?`);
                if (!confirmed) return;
                await removeServer(server.id);
            };
            row.appendChild(deleteButton);
        }
        serverControlsEl.appendChild(row);
        updateServerControlMetric(server);
    }
}

// #region Notification Manager
const notificationManager = new NotificationManager();

document.addEventListener('click', () => {
    notificationManager.requestPermission();
}, { once: true, capture: true });
// #endregion

// #region Toast Manager
const toastManager = new ToastManager();
// Unified Notification Hub
window.alert = (message, options = {}) => {
    let type = 'info';
    let title = 'Tabminal';

    // Handle shorthand: alert("msg", "error")
    if (typeof options === 'string') {
        type = options;
    } else if (typeof options === 'object') {
        if (options.type) type = options.type;
        if (options.title) title = options.title;
    }

    // Strategy: Try System Notification First
    // If the user has granted permission and the browser supports it, send it there.
    // We use the message as the body.
    const sent = notificationManager.send(title, message);

    // If system notification failed (no permission, closed, etc.), fallback to in-app Toast
    if (!sent) {
        toastManager.show(title, message, type);
    }
};
// #endregion

const statusMemory = new Map();

function setStatus(server, status) {
    if (!server) return;
    const prevStatus = statusMemory.get(server.id) || null;
    if (status === prevStatus) return;
    statusMemory.set(server.id, status);
    server.connectionStatus = status;
    renderServerControls();

    const activeServer = getActiveServer();
    if (!activeServer || activeServer.id !== server.id) return;
    const hostName = getDisplayHost(server);
    const target = hostName || 'host';

    if (status === 'reconnecting') {
        alert(`Lost connection to ${target}. Reconnecting...`, {
            type: 'warning',
            title: 'Connection'
        });
    } else if (status === 'connected' && prevStatus === 'reconnecting') {
        alert(`Connection to ${target} restored.`, {
            type: 'success',
            title: 'Connection'
        });
    } else if (status === 'terminated') {
        alert(`Session on ${target} has ended.`, {
            type: 'error',
            title: 'Connection'
        });
    } else if (status === 'connected' && !prevStatus) {
        alert(`Connected to ${target}.`, {
            type: 'success',
            title: 'Connection'
        });
    }
}

async function switchToSession(sessionKey, options = {}) {
    const { scrollTabIntoView = false } = options;
    if (!sessionKey || !state.sessions.has(sessionKey)) return;
    if (state.activeSessionKey === sessionKey) {
        if (scrollTabIntoView) {
            scrollSessionTabIntoView(sessionKey);
        }
        return;
    }

    state.activeSessionKey = sessionKey;
    renderTabs();
    if (scrollTabIntoView) {
        scrollSessionTabIntoView(sessionKey);
        requestAnimationFrame(() => {
            scrollSessionTabIntoView(sessionKey, 'auto');
        });
    }

    const session = state.sessions.get(sessionKey);
    
    // Clear main view
    terminalEl.innerHTML = '';
    
    // Mount new session
    session.mainTerm.open(terminalEl);
    session.mainFitAddon.fit();
    session.mainTerm.focus();
    
    // Double check focus
    requestAnimationFrame(() => {
        session.mainTerm.focus();
    });
    
    session.reportResize();
    
    // Sync editor state
    editorManager.switchTo(session);
    if (session.server.lastSystemData) {
        updateSystemStatus(session.server.lastSystemData, session.server.lastLatency, session.server);
    }
}

// #endregion

async function closeSession(sessionKey) {
    const session = state.sessions.get(sessionKey);
    if (!session) return;
    try {
        const mainServer = getMainServer();
        const orderedKeys = Array.from(state.sessions.keys());
        const currentIndex = orderedKeys.indexOf(sessionKey);
        await session.server.fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
        await syncServer(session.server);
        
        if (state.activeSessionKey === sessionKey) {
            const keys = Array.from(state.sessions.keys());
            let nextKey = null;
            if (keys.length > 0) {
                const fallbackIndex = Math.max(0, Math.min(currentIndex, keys.length - 1));
                nextKey = keys[fallbackIndex];
            }

            if (nextKey) {
                switchToSession(nextKey);
            } else {
                state.activeSessionKey = null;
                terminalEl.innerHTML = '';
            }
        }

        if (state.sessions.size === 0 && mainServer) {
            await createNewSession(mainServer);
        }
    } catch (error) {
        console.error('Failed to close session:', error);
    }
}

// #region Initialization & Event Listeners
const resizeObserver = new ResizeObserver(() => {
    if (state.activeSessionKey && state.sessions.has(state.activeSessionKey)) {
        const session = state.sessions.get(state.activeSessionKey);
        session.mainFitAddon.fit();
        session.reportResize();
        
        if (session.editorState && session.editorState.isVisible) {
            editorManager.layout();
        }
    }
});
if (terminalWrapper) {
    resizeObserver.observe(terminalWrapper);
}
if (editorPane) {
    resizeObserver.observe(editorPane);
}

if (tabListEl) {
    tabListEl.addEventListener('click', (event) => {
        const closeBtn = event.target.closest('.close-tab-button');
        if (closeBtn) {
            event.stopPropagation(); // Prevent switching to the tab we are closing
            const tabItem = closeBtn.closest('.tab-item');
            if (tabItem) {
                closeSession(tabItem.dataset.sessionKey);
            }
            return;
        }

        const tabItem = event.target.closest('.tab-item');
        if (tabItem) {
            switchToSession(tabItem.dataset.sessionKey);
        }
    });
}

if (
    addServerButton
    && addServerModal
    && addServerForm
    && addServerUrlInput
    && addServerHostInput
    && addServerPasswordInput
    && addServerError
    && addServerCancel
) {
    addServerButton.addEventListener('click', () => {
        openServerModal('add');
    });

    addServerCancel.addEventListener('click', () => {
        closeServerModal();
    });

    addServerModal.addEventListener('click', (event) => {
        if (event.target === addServerModal) {
            closeServerModal();
        }
    });

    addServerModal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeServerModal();
        }
    });

    addServerForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        addServerError.textContent = '';

        const url = addServerUrlInput.value.trim();
        const host = addServerHostInput.value.trim();
        const password = addServerPasswordInput.value;
        const mode = serverModalState.mode;

        if (!url) {
            addServerError.textContent = 'URL is required.';
            return;
        }

        let normalizedUrl = '';
        let normalizedHost = '';

        let server = null;
        let createdNewServer = false;
        let replacedServerEndpoint = false;
        let duplicateServerToRemove = null;

        try {
            normalizedUrl = normalizeBaseUrl(url);
            normalizedHost = normalizeHostAlias(host);
            const endpointKey = getServerEndpointKeyFromUrl(normalizedUrl);

            if (mode === 'reconnect' && serverModalState.targetServerId) {
                server = state.servers.get(serverModalState.targetServerId) || null;
                if (!server) {
                    addServerError.textContent = 'Host no longer exists.';
                    return;
                }

                const duplicated = findServerByEndpointKey(endpointKey, server.id);
                if (duplicated) {
                    if (duplicated.isPrimary) {
                        addServerError.textContent = 'Main host already uses this URL.';
                        return;
                    }
                    duplicateServerToRemove = duplicated.id;
                }

                server.host = normalizedHost;
                replacedServerEndpoint = resetServerEndpoint(server, normalizedUrl);
            } else {
                const existing = findServerByEndpointKey(endpointKey);
                if (existing) {
                    server = existing;
                    server.host = normalizedHost;
                    replacedServerEndpoint = resetServerEndpoint(server, normalizedUrl);
                } else {
                    createdNewServer = true;
                    server = createServerClient({
                        baseUrl: normalizedUrl,
                        host: normalizedHost
                    });
                }
            }
        } catch {
            addServerError.textContent = 'Invalid URL.';
            return;
        }

        try {
            let authToken = '';
            if (password) {
                authToken = await hashPassword(password);
            } else {
                const candidates = [];
                if (mode === 'reconnect' && server) {
                    candidates.push(server);
                }
                candidates.push(getActiveServer(), getMainServer());
                const inheritedServer = candidates.find(item => item?.token) || null;
                authToken = inheritedServer?.token || '';
                if (!authToken) {
                    addServerError.textContent = 'No inherited password available.';
                    if (createdNewServer && !server.isPrimary) {
                        await removeServer(server.id, { persist: false });
                    }
                    return;
                }
            }

            await server.loginWithToken(authToken);
            await fetchExpandedPaths(server);
            await syncServer(server);
            server.startHeartbeat();
            if (duplicateServerToRemove) {
                await removeServer(duplicateServerToRemove, { persist: false });
            }
            await syncServerList();
            renderServerControls();
            renderTabs();
            addServerForm.reset();
            closeServerModal();
            if (!state.activeSessionKey && state.sessions.size > 0) {
                await switchToSession(state.sessions.keys().next().value);
            }
        } catch (error) {
            console.error(error);
            addServerError.textContent = 'Failed to authenticate this host.';
            if (createdNewServer && !server.isPrimary) {
                await removeServer(server.id, { persist: false });
            } else if (replacedServerEndpoint) {
                alert(`Failed to reconnect ${getDisplayHost(server)}. Check URL/password.`, {
                    type: 'warning',
                    title: 'Host'
                });
            }
        }
    });
} else if (legacyNewTabButton) {
    console.warn('[Tabminal] Legacy sidebar detected, enabling fallback new-tab button.');
    legacyNewTabButton.addEventListener('click', () => {
        createNewSession(getMainServer());
    });
}

if (loginForm && passwordInput) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = passwordInput.value;
        try {
            const mainServer = getMainServer();
            if (!mainServer) return;
            await mainServer.login(password);
            auth.hideLoginModal();
            await initApp();
        } catch (err) {
            console.error(err);
        }
    });
}

window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    for (const session of state.sessions.values()) {
        session.dispose();
    }
    for (const server of state.servers.values()) {
        server.stopHeartbeat();
    }
});

async function initApp() {
    const mainServer = getMainServer();
    if (!mainServer) return;

    if (!mainServer.isAuthenticated) {
        auth.showLoginModal();
        return;
    }

    auth.hideLoginModal();
    await hydrateServerRegistry();

    for (const server of state.servers.values()) {
        if (!server.isAuthenticated) continue;
        await fetchExpandedPaths(server);
        await syncServer(server);
        server.startHeartbeat();
    }

    if (state.sessions.size === 0) {
        await createNewSession(mainServer);
    } else if (state.activeSessionKey) {
        const session = state.sessions.get(state.activeSessionKey);
        if (session) session.mainTerm.focus();
    } else {
        await switchToSession(state.sessions.keys().next().value);
    }
    
    // Force focus again after layout settles
    setTimeout(() => {
        if (state.activeSessionKey) {
            const session = state.sessions.get(state.activeSessionKey);
            if (session) session.mainTerm.focus();
        }
    }, 200);

    renderTabs();
    renderServerControls();
}

// Start the app
const virtualKeys = document.getElementById('virtual-keys');

if (virtualKeys) {
    const handleKey = (key) => {
        if (!state.activeSessionKey || !state.sessions.has(state.activeSessionKey)) return;
        const session = state.sessions.get(state.activeSessionKey);
        
        if (navigator.vibrate) navigator.vibrate(10);

        let data = '';
        if (key === 'ESC') data = '\x1b';
        else if (key === 'TAB') data = '\t';
        else if (key === 'CTRL_C') data = '\x03'; // Ctrl+C
        else if (key === 'UP') data = '\x1b[A';
        else if (key === 'DOWN') data = '\x1b[B';
        else if (key === 'RIGHT') data = '\x1b[C';
        else if (key === 'LEFT') data = '\x1b[D';
        else data = key;

        session.send({ type: 'input', data });
        session.mainTerm.focus();
    };

    let repeatTimer = null;
    let repeatStartTimer = null;

    const stopRepeat = () => {
        clearTimeout(repeatStartTimer);
        clearInterval(repeatTimer);
        repeatStartTimer = null;
        repeatTimer = null;
    };

    const startRepeat = (btn) => {
        stopRepeat();
        const key = btn.dataset.key;
        
        // Immediate trigger
        handleKey(key, btn);
        
        // Delay before repeating
        repeatStartTimer = setTimeout(() => {
            repeatTimer = setInterval(() => {
                handleKey(key, btn);
            }, 80); // Fast repeat (12.5hz)
        }, 700); // Initial delay
    };

    // Touch Events
    virtualKeys.addEventListener('touchstart', (e) => {
        const btn = e.target.closest('button');
        if (btn) {
            e.preventDefault(); // Prevent ghost clicks and focus loss
            startRepeat(btn);
        }
    }, { passive: false });

    virtualKeys.addEventListener('touchend', stopRepeat);
    virtualKeys.addEventListener('touchcancel', stopRepeat);

    // Mouse Events (Desktop testing)
    virtualKeys.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('button');
        if (btn) {
            e.preventDefault();
            startRepeat(btn);
        }
    });

    // Global mouseup to catch release outside button
    window.addEventListener('mouseup', stopRepeat);
}

// Soft Keyboard Logic
const modCtrl = document.getElementById('mod-ctrl');
const modAlt = document.getElementById('mod-alt');
const modShift = document.getElementById('mod-shift');
const modSym = document.getElementById('mod-sym');
const softKeyboard = document.getElementById('soft-keyboard');

if (modCtrl && modAlt && modShift && modSym && softKeyboard) {
    const modifiers = { ctrl: false, alt: false, shift: false, sym: false };
    
    // Basic HHKB-like layout (12 keys max)
    const rows = [
        ['1','2','3','4','5','6','7','8','9','0','-','='],
        ['q','w','e','r','t','y','u','i','o','p','[',']'],
        ['a','s','d','f','g','h','j','k','l',';','\''],
        ['`','z','x','c','v','b','n','m',',','.','/','\\']
    ];
    
    const getShiftChar = (c) => {
        if (shiftMap[c]) return shiftMap[c];
        if (c.length === 1 && /[a-z]/.test(c)) return c.toUpperCase();
        return '';
    };

    softKeyboard.innerHTML = rows.map(row => 
        `<div class="row">
            ${row.map(char => {
                const shiftChar = getShiftChar(char);
                const shiftLabel = shiftChar ? `<span class="key-shift">${shiftChar}</span>` : '';
                return `<div class="soft-key" data-char="${char}">
                    <span class="key-main">${char}</span>
                    ${shiftLabel}
                </div>`;
            }).join('')}
        </div>`
    ).join('');

    const updateState = () => {
        const anyActive = modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.sym;

        modCtrl.classList.toggle('active', modifiers.ctrl);
        modAlt.classList.toggle('active', modifiers.alt);
        modShift.classList.toggle('active', modifiers.shift);
        
        // SYM reflects overall visibility
        modSym.classList.toggle('active', anyActive);
        
        // Visual Flip: Shift only if Ctrl is not active (to avoid confusion)
        const isVisualShift = modifiers.shift && !modifiers.ctrl;
        softKeyboard.classList.toggle('shift-mode', isVisualShift);
        
        softKeyboard.style.display = anyActive ? 'flex' : 'none';
    };

    const toggleMod = (name) => {
        modifiers[name] = !modifiers[name];
        updateState();
    };

    modCtrl.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); toggleMod('ctrl'); });
    modAlt.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); toggleMod('alt'); });
    modShift.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); toggleMod('shift'); });
    
    modSym.addEventListener('touchstart', (e) => { 
        e.preventDefault(); 
        e.stopPropagation(); 
        
        // Smart Toggle: If keyboard is open, close everything. If closed, open sym.
        const isKeyboardVisible = modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.sym;
        
        if (isKeyboardVisible) {
            modifiers.ctrl = false;
            modifiers.alt = false;
            modifiers.shift = false;
            modifiers.sym = false;
        } else {
            modifiers.sym = true;
        }
        updateState();
    });

    softKeyboard.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const keyEl = e.target.closest('.soft-key');
        if (!keyEl) return;
        
        keyEl.classList.add('active');
        setTimeout(() => keyEl.classList.remove('active'), 100);
        
        if (navigator.vibrate) navigator.vibrate(10);
        
        let char = keyEl.dataset.char;
        
        // Apply Modifiers Logic
        let data = char;
        
        if (modifiers.shift) {
            if (data.length === 1 && /[a-z]/.test(data)) {
                data = data.toUpperCase();
            } else if (shiftMap[data]) {
                data = shiftMap[data];
            }
        }
        
        if (modifiers.ctrl) {
            if (data.length === 1 && /[a-z]/.test(data)) {
                // Use lowercase for ctrl calculation standard
                data = String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
            } else if (data.length === 1 && /[A-Z]/.test(data)) {
                 // If already upper (due to shift?), ctrl+shift+a -> \x01
                 data = String.fromCharCode(data.charCodeAt(0) - 64);
            } else if (data === '[') data = '\x1b';
            else if (data === '?') data = '\x7f'; // Ctrl+? often mapped to Del
            // Add more ctrl maps if needed (e.g. Ctrl+\ -> \x1c)
            else if (data === '\\') data = '\x1c';
            else if (data === ']') data = '\x1d';
            else if (data === '^') data = '\x1e';
            else if (data === '_') data = '\x1f';
        }
        
        if (modifiers.alt) {
            data = '\x1b' + data;
        }

        if (state.activeSessionKey) {
            state.sessions.get(state.activeSessionKey).send({ type: 'input', data });
        }
        
        // Auto-close Logic
        if (modifiers.ctrl || modifiers.alt) {
            // Shortcut Mode: One-shot, close everything (including keyboard)
            modifiers.ctrl = false;
            modifiers.alt = false;
            modifiers.shift = false;
            modifiers.sym = false;
        }
        // Shift stays active until toggled off (Continuous input)
        
        updateState();
    });
}

// Search Bar Logic
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchNext = document.getElementById('search-next');
const searchPrev = document.getElementById('search-prev');
const searchClose = document.getElementById('search-close');
const searchResults = document.getElementById('search-results');
const searchCaseBtn = document.getElementById('search-case');
const searchWordBtn = document.getElementById('search-word');
const searchRegexBtn = document.getElementById('search-regex');

let searchOptions = {
    caseSensitive: false,
    wholeWord: false,
    regex: false
};

if (searchBar) {
    const updateUI = (found) => {
        if (!found) {
            searchResults.textContent = 'No results';
            searchNext.disabled = true;
            searchPrev.disabled = true;
        } else {
            searchResults.textContent = 'Found';
            searchNext.disabled = false;
            searchPrev.disabled = false;
        }
    };

    const doSearch = (forward = true) => {
        if (!state.activeSessionKey || !state.sessions.has(state.activeSessionKey)) return;
        const addon = state.sessions.get(state.activeSessionKey).searchAddon;
        const term = searchInput.value;
        
        let found = false;
        if (forward) found = addon.findNext(term, searchOptions);
        else found = addon.findPrevious(term, searchOptions);
        
        updateUI(found);
    };

    const toggleOption = (btn, key) => {
        searchOptions[key] = !searchOptions[key];
        btn.classList.toggle('active', searchOptions[key]);
        doSearch(true);
    };

    if (searchCaseBtn) searchCaseBtn.onclick = () => toggleOption(searchCaseBtn, 'caseSensitive');
    if (searchWordBtn) searchWordBtn.onclick = () => toggleOption(searchWordBtn, 'wholeWord');
    if (searchRegexBtn) searchRegexBtn.onclick = () => toggleOption(searchRegexBtn, 'regex');

    // Initial State
    searchNext.disabled = true;
    searchPrev.disabled = true;

    searchInput.addEventListener('input', (e) => {
        if (!state.activeSessionKey) return;
        const term = e.target.value;
        if (!term) {
            updateUI(false);
            searchResults.textContent = ''; // Empty when clear? Or No results? VS Code clears. 
            // But user asked for "No results always".
            // My updateUI sets 'No results'.
            return;
        }
        
        // Incremental search
        const found = state.sessions.get(state.activeSessionKey).searchAddon.findNext(term, {
            incremental: true, 
            ...searchOptions 
        });
        
        updateUI(found);
    });
    
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch(!e.shiftKey);
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            searchBar.style.display = 'none';
            state.sessions.get(state.activeSessionKey)?.mainTerm.focus();
        }
    });

    searchNext.addEventListener('click', () => doSearch(true));
    searchPrev.addEventListener('click', () => doSearch(false));
    
    searchClose.addEventListener('click', () => {
        searchBar.style.display = 'none';
        state.sessions.get(state.activeSessionKey)?.mainTerm.focus();
    });
}

const shortcutsModal = document.getElementById('shortcuts-modal');

function closeShortcutsModal() {
    if (!shortcutsModal) return;
    shortcutsModal.style.display = 'none';
    if (state.activeSessionKey && state.sessions.has(state.activeSessionKey)) {
        state.sessions.get(state.activeSessionKey).mainTerm.focus();
    }
}

if (shortcutsModal) {
    shortcutsModal.addEventListener('click', (event) => {
        if (event.target === shortcutsModal) {
            closeShortcutsModal();
        }
    });
}

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    if (
        e.key === 'Escape'
        && shortcutsModal
        && shortcutsModal.style.display === 'flex'
    ) {
        e.preventDefault();
        closeShortcutsModal();
        return;
    }

    const activeAgentTab = getActiveAgentTab();
    const activeElement = document.activeElement;
    const agentPanelHasFocus = !!(
        activeAgentTab
        && editorManager?.agentContainer
        && editorManager.agentContainer.style.display !== 'none'
        && activeElement
        && editorManager.agentContainer.contains(activeElement)
    );
    if (
        e.key === 'Escape'
        && !e.ctrlKey
        && !e.metaKey
        && !e.altKey
        && activeAgentTab?.busy
        && agentPanelHasFocus
    ) {
        e.preventDefault();
        void editorManager.cancelActiveAgentPrompt();
        return;
    }

    // Ctrl+F or Cmd+F for Search
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        // If editor has focus, let Monaco handle it
        if (editorManager && editorManager.editor && editorManager.editor.hasTextFocus()) {
            return;
        }

        e.preventDefault();
        if (searchBar) {
            searchBar.style.display = 'flex';
            searchInput.focus();
            searchInput.select();
        }
        return;
    }

    if (!e.ctrlKey) return; // Ctrl is mandatory

    const key = e.key.toLowerCase();
    const code = e.code;
    
    // Ctrl + Shift Context
    if (e.shiftKey && !e.altKey) {
        // Ctrl + Shift + T: New Tab
        if (key === 't') {
            e.preventDefault();
            createNewSession();
            return;
        }
        
        // Ctrl + Shift + W: Close Tab
        if (key === 'w') {
            e.preventDefault();
            if (state.activeSessionKey) {
                closeSession(state.activeSessionKey);
            }
            return;
        }
        
        // Ctrl + Shift + E: Toggle Editor
        if (key === 'e') {
            e.preventDefault();
            if (editorManager && state.activeSessionKey && state.sessions.has(state.activeSessionKey)) {
                editorManager.toggle(state.sessions.get(state.activeSessionKey));
            }
            return;
        }

        // Ctrl + Shift + ?: Help
        if (key === '?' || (code === 'Slash' && e.shiftKey)) {
            e.preventDefault();
            if (shortcutsModal) {
                shortcutsModal.style.display = 'flex';
                const closeBtn = shortcutsModal.querySelector('button');
                if (closeBtn) closeBtn.focus();
            }
            return;
        }
        
        // Ctrl + Shift + [ / ]: Switch Tab
        if (code === 'BracketLeft' || code === 'BracketRight') {
            e.preventDefault();
            const direction = code === 'BracketLeft' ? -1 : 1;
            
            const sessionIds = Array.from(state.sessions.keys());
            if (sessionIds.length > 1) {
                const currentIdx = sessionIds.indexOf(state.activeSessionKey);
                let newIdx = currentIdx + direction;
                if (newIdx < 0) newIdx = sessionIds.length - 1;
                if (newIdx >= sessionIds.length) newIdx = 0;
                switchToSession(sessionIds[newIdx]);
            }
        }
    }
    
    // Ctrl Only Context (Focus Switching)
    if (!e.shiftKey && !e.altKey) {
        if (code === 'ArrowUp') {
            e.preventDefault();
            if (editorManager && editorManager.pane.style.display !== 'none') {
                editorManager.editor.focus();
            }
            return;
        }
        if (code === 'ArrowDown') {
            e.preventDefault();
            if (state.activeSessionKey && state.sessions.has(state.activeSessionKey)) {
                state.sessions.get(state.activeSessionKey).mainTerm.focus();
            }
            return;
        }
    }
    
    // Ctrl + Option (Alt) Context
    if (e.altKey && !e.shiftKey) {
        // Ctrl + Option + [ / ]: Switch Editor File
        if (code === 'BracketLeft' || code === 'BracketRight') {
            e.preventDefault();
            const direction = code === 'BracketLeft' ? -1 : 1;
            
            if (editorManager && editorManager.currentSession) {
                const s = editorManager.currentSession.editorState;
                const files = s.openFiles;
                if (files.length > 1) {
                    const currentIdx = files.indexOf(s.activeFilePath);
                    let newIdx = currentIdx + direction;
                    if (newIdx < 0) newIdx = files.length - 1;
                    if (newIdx >= files.length) newIdx = 0;
                    editorManager.activateTab(files[newIdx]);
                }
            }
        }
    }
}, true); // Use capture phase to override editor/terminal


// Start the app
bootstrapServers();
initApp();
// #endregion
