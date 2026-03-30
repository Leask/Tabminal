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
const agentSetupModal = document.getElementById('agent-setup-modal');
const agentSetupForm = document.getElementById('agent-setup-form');
const agentSetupTitle = document.getElementById('agent-setup-title');
const agentSetupDescription = document.getElementById(
    'agent-setup-description'
);
const agentSetupFeedback = document.getElementById('agent-setup-feedback');
const agentSetupReset = document.getElementById('agent-setup-reset');
const agentSetupCancel = document.getElementById('agent-setup-cancel');
const agentSetupSave = document.getElementById('agent-setup-save');
const agentSetupGemini = document.getElementById('agent-setup-gemini');
const agentSetupGeminiKey = document.getElementById('agent-setup-gemini-key');
const agentSetupGoogleKey = document.getElementById('agent-setup-google-key');
const agentSetupGeminiNote = document.getElementById('agent-setup-gemini-note');
const agentSetupClaude = document.getElementById('agent-setup-claude');
const agentSetupClaudeKey = document.getElementById('agent-setup-claude-key');
const agentSetupClaudeUseVertex = document.getElementById(
    'agent-setup-claude-use-vertex'
);
const agentSetupClaudeProject = document.getElementById(
    'agent-setup-claude-project'
);
const agentSetupClaudeRegion = document.getElementById(
    'agent-setup-claude-region'
);
const agentSetupClaudeCredentials = document.getElementById(
    'agent-setup-claude-credentials'
);
const agentSetupClaudeNote = document.getElementById('agent-setup-claude-note');
const agentSetupCopilot = document.getElementById('agent-setup-copilot');
const agentSetupCopilotToken = document.getElementById(
    'agent-setup-copilot-token'
);
const agentSetupCopilotNote = document.getElementById(
    'agent-setup-copilot-note'
);
const confirmModal = document.getElementById('confirm-modal');
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const confirmModalNote = document.getElementById('confirm-modal-note');
const confirmModalCancel = document.getElementById('confirm-modal-cancel');
const confirmModalConfirm = document.getElementById('confirm-modal-confirm');
const terminalWrapper = document.getElementById('terminal-wrapper');
const editorPane = document.getElementById('editor-pane');
// #endregion

// #region Configuration
const HEARTBEAT_INTERVAL_MS = 1000;
const RECONNECT_RETRY_MS = 5000;
const FILE_TREE_REFRESH_INTERVAL_MS = 3000;
const FILE_VERSION_CHECK_INTERVAL_MS = 3000;
const MAIN_SERVER_ID = 'main';
const RUNTIME_BOOT_ID_STORAGE_KEY = 'tabminal_runtime_boot_id';
const WORKSPACE_DEVICE_ID_STORAGE_KEY = 'tabminal_workspace_device_id';
const RECENT_AGENT_USAGE_STORAGE_KEY = 'tabminal_recent_agent_usage';
const FILE_WORKSPACE_TAB_PREFIX = 'file:';
const AGENT_WORKSPACE_TAB_PREFIX = 'agent:';
const TERMINAL_WORKSPACE_TAB_KEY = 'terminal:main';
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'svg',
    'webp'
]);
const SUPPORTED_PDF_EXTENSIONS = new Set([
    'pdf'
]);
const PDFJS_VERSION = '5.6.205';
const PDFJS_MODULE_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
const CLOSE_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
const AGENT_ICON_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M9 7V5"></path><path d="M15 7V5"></path><path d="M12 17v2"></path><path d="M5 12H3"></path><path d="M21 12h-2"></path><path d="M9 11h.01"></path><path d="M15 11h.01"></path><path d="M9.5 14c.7.67 1.53 1 2.5 1s1.8-.33 2.5-1"></path></svg>';
const TERMINAL_TAB_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m8 10 3 2-3 2"></path><path d="M13 15h4"></path></svg>';
const MANAGED_TERMINAL_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 12h.01"></path><path d="M12 9v6"></path><path d="M9 12h6"></path><path d="M18 8v2"></path><path d="M19 9h-2"></path></svg>';
const BELL_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5a4.5 4.5 0 0 0-4.5 4.5v2.4c0 1.2-.41 2.37-1.17 3.3L5 16.5h14l-1.33-1.8a5.66 5.66 0 0 1-1.17-3.3V9A4.5 4.5 0 0 0 12 4.5"></path><path d="M10.25 19a1.75 1.75 0 0 0 3.5 0"></path></svg>';
const SPINNER_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"></path></svg>';
const ATTACH_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.82l8.49-8.49"></path></svg>';
const CHEVRON_DOWN_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>';
const MODE_SELECT_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7v5c0 5 3.4 8.7 8 9 4.6-.3 8-4 8-9V7l-8-4Z"></path><path d="m9.5 12 1.7 1.7 3.3-3.4"></path></svg>';
const MODEL_SELECT_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 7 12 11 19.5 7 12 3Z"></path><path d="M4.5 12 12 16 19.5 12"></path><path d="M4.5 17 12 21 19.5 17"></path></svg>';
const THOUGHT_SELECT_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 21h4"></path><path d="M8 14a5 5 0 1 1 8 0c-.8.63-1.28 1.12-1.6 2H9.6c-.32-.88-.8-1.37-1.6-2Z"></path></svg>';
const TERMINAL_TAB_MODE_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M4 9h16"></path><path d="m9 15 3-3 3 3"></path></svg>';
const TERMINAL_AUTO_MODE_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="5" rx="1.5"></rect><rect x="4" y="14" width="16" height="5" rx="1.5"></rect></svg>';
const PLUS_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>';
const RENAME_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m12 20 7-7"></path><path d="M16 6.5a1.8 1.8 0 1 1 2.5 2.5L8 19.5 4 20l.5-4L16 6.5Z"></path></svg>';
const DELETE_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 12h10l1-12"></path><path d="M9 7V4h6v3"></path></svg>';
const NEW_FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5V17A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17Z"></path><path d="M12 10.5v5"></path><path d="M9.5 13h5"></path></svg>';
const NEW_FILE_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7l4 4V20.5H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5Z"></path><path d="M14 3.5V8h4"></path><path d="M12 11v6"></path><path d="M9 14h6"></path></svg>';
const TERMINAL_FONT_FAMILY = '\'Monaspace Neon\', "SF Mono Terminal", '
    + '"SFMono-Regular", "SF Mono", "JetBrains Mono", Menlo, Consolas, '
    + 'monospace';
const MAIN_TERMINAL_THEME = {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642'
};
const serverModalState = {
    mode: 'add',
    targetServerId: null
};
const agentSetupState = {
    serverId: '',
    agentId: '',
    retrySessionKey: '',
    retryAgentTabKey: '',
    retryPromptText: '',
    retryAnchor: null
};
let primaryServerBootId = '';
let runtimeReloadScheduled = false;
let pdfJsLibPromise = null;
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

function isTerminalWorkspaceTabKey(key) {
    return key === TERMINAL_WORKSPACE_TAB_KEY;
}

function isFileWorkspaceTabKey(key) {
    return typeof key === 'string'
        && key.startsWith(FILE_WORKSPACE_TAB_PREFIX);
}

function isCompactWorkspaceMode() {
    return !!window.__tabminalCompactWorkspaceMode;
}

function isSupportedImagePath(filePath) {
    if (typeof filePath !== 'string') {
        return false;
    }
    const dotIndex = filePath.lastIndexOf('.');
    if (dotIndex === -1) {
        return false;
    }
    const ext = filePath.slice(dotIndex + 1).toLowerCase();
    return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

function isSupportedPdfPath(filePath) {
    if (typeof filePath !== 'string') {
        return false;
    }
    const dotIndex = filePath.lastIndexOf('.');
    if (dotIndex === -1) {
        return false;
    }
    const ext = filePath.slice(dotIndex + 1).toLowerCase();
    return SUPPORTED_PDF_EXTENSIONS.has(ext);
}

async function loadPdfJs() {
    if (!pdfJsLibPromise) {
        pdfJsLibPromise = import(PDFJS_MODULE_URL)
            .then((pdfjsLib) => {
                pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
                return pdfjsLib;
            });
    }
    return await pdfJsLibPromise;
}

function isCompactTerminalTabsMode() {
    return !!window.__tabminalCompactTerminalTabsMode;
}

function isForcedTerminalWorkspaceMode() {
    return isCompactWorkspaceMode() || isCompactTerminalTabsMode();
}

function getTerminalFontSize() {
    return IS_MOBILE ? 14 : 12;
}

function buildMainTerminalTheme() {
    return {
        ...MAIN_TERMINAL_THEME
    };
}

function workspaceKeyToFilePath(key) {
    if (!isFileWorkspaceTabKey(key)) return '';
    return key.slice(FILE_WORKSPACE_TAB_PREFIX.length);
}

function getWorkspaceDeviceId() {
    try {
        let value = localStorage.getItem(WORKSPACE_DEVICE_ID_STORAGE_KEY) || '';
        if (!value) {
            value = crypto.randomUUID();
            localStorage.setItem(WORKSPACE_DEVICE_ID_STORAGE_KEY, value);
        }
        return value;
    } catch {
        return 'ephemeral-device';
    }
}

function uniqueStringList(values) {
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(
        values.filter(
            (value) => typeof value === 'string' && value.length > 0
        )
    ));
}

function normalizeWorkspaceSnapshot(input = {}, fallback = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const base = fallback && typeof fallback === 'object' ? fallback : {};
    const updatedAt = Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : (
            Number.isFinite(base.updatedAt)
                ? base.updatedAt
                : 0
        );
    const updatedBy = typeof source.updatedBy === 'string'
        ? source.updatedBy
        : (
            typeof base.updatedBy === 'string'
                ? base.updatedBy
                : ''
        );
    return {
        updatedAt,
        updatedBy,
        isVisible: !!source.isVisible,
        openFiles: uniqueStringList(source.openFiles),
        terminalDisplayMode: source.terminalDisplayMode === 'tab'
            ? 'tab'
            : 'auto',
        expandedPaths: uniqueStringList(source.expandedPaths)
    };
}

function compareWorkspaceSnapshots(left, right) {
    const leftUpdatedAt = Number.isFinite(left?.updatedAt) ? left.updatedAt : 0;
    const rightUpdatedAt = Number.isFinite(right?.updatedAt)
        ? right.updatedAt
        : 0;
    if (leftUpdatedAt !== rightUpdatedAt) {
        return leftUpdatedAt - rightUpdatedAt;
    }
    const leftUpdatedBy = typeof left?.updatedBy === 'string'
        ? left.updatedBy
        : '';
    const rightUpdatedBy = typeof right?.updatedBy === 'string'
        ? right.updatedBy
        : '';
    return leftUpdatedBy.localeCompare(rightUpdatedBy);
}

function buildWorkspaceSnapshotForSession(session, overrides = {}) {
    return normalizeWorkspaceSnapshot({
        ...session.sharedWorkspaceState,
        isVisible: session.editorState.isVisible,
        openFiles: session.editorState.openFiles,
        terminalDisplayMode: session.sharedWorkspaceState.terminalDisplayMode,
        expandedPaths: session.sharedWorkspaceState.expandedPaths,
        ...overrides
    });
}

function touchSharedWorkspace(session, overrides = {}) {
    if (!session) return null;
    const snapshot = buildWorkspaceSnapshotForSession(session, {
        ...overrides,
        updatedAt: Date.now(),
        updatedBy: getWorkspaceDeviceId()
    });
    session.sharedWorkspaceState = snapshot;
    return snapshot;
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

    sidebarToggle.addEventListener('pointerdown', (event) => {
        if (!isCompactWorkspaceMode()) {
            return;
        }
        event.preventDefault();
    });

    sidebarToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('open');
    });

    sidebarOverlay.addEventListener('click', closeSidebar);

    // Close sidebar when a tab is clicked (Mobile UX)
    if (tabListEl) {
        tabListEl.addEventListener('click', (e) => {
            // Only close if we actually clicked a tab item (not empty space)
            if (e.target.closest('.tab-item') && isCompactWorkspaceMode()) {
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

function getLoadedRuntimeAssetKey() {
    const assetKey = window.__tabminalRuntimeAssetKey;
    return typeof assetKey === 'string' ? assetKey : '';
}

function handlePrimaryRuntimeVersion(data) {
    const runtime = data?.runtime;
    const bootIdRaw = runtime?.bootId;
    if (!bootIdRaw) return;
    const bootId = String(bootIdRaw);
    if (!bootId) return;
    const storedBootId = readRuntimeBootId();
    const loadedAssetKey = getLoadedRuntimeAssetKey();
    const needsShellReload = loadedAssetKey !== bootId;

    if (!primaryServerBootId) {
        primaryServerBootId = bootId;
        if (storedBootId === bootId && !needsShellReload) {
            return;
        }
        const persisted = persistRuntimeBootId(bootId);
        if (persisted && needsShellReload && !runtimeReloadScheduled) {
            runtimeReloadScheduled = true;
            console.info(
                '[Runtime] Syncing app shell cache key with server boot id.'
            );
            window.location.reload();
        }
        return;
    }
    if (primaryServerBootId === bootId) {
        if (storedBootId !== bootId) {
            persistRuntimeBootId(bootId);
        }
        if (needsShellReload && !runtimeReloadScheduled) {
            runtimeReloadScheduled = true;
            console.info(
                '[Runtime] Reloading app shell to match server boot id.'
            );
            window.location.reload();
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
        this.syncPromise = null;
        this.pendingImmediateSync = false;
        this.immediateSyncTimer = null;
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
        this.agentTimestampTimer = null;
        this.treeRefreshTimer = null;
        
        // DOM Elements
        this.pane = document.getElementById('editor-pane');
        this.resizer = document.getElementById('editor-resizer');
        this.tabsContainer = document.getElementById('editor-tabs');
        this.contentContainer = document.getElementById('editor-content');
        this.monacoContainer = document.getElementById('monaco-container');
        this.imagePreviewContainer = document.getElementById('image-preview-container');
        this.imagePreview = document.getElementById('image-preview');
        this.pdfPreviewContainer = document.getElementById(
            'pdf-preview-container'
        );
        this.pdfPreviewStatus = document.getElementById('pdf-preview-status');
        this.pdfPreviewStatusPrimary = document.getElementById(
            'pdf-preview-status-primary'
        );
        this.pdfPreviewStatusSecondary = document.getElementById(
            'pdf-preview-status-secondary'
        );
        this.pdfPreviewPages = document.getElementById('pdf-preview-pages');
        this.emptyState = document.getElementById('empty-editor-state');
        this.terminalWrapper = terminalWrapper;
        this.terminalOriginalParent = terminalWrapper?.parentElement || null;
        this.terminalOriginalNextSibling = terminalWrapper?.nextSibling || null;
        this.terminalTabHost = document.createElement('div');
        this.terminalTabHost.className = 'terminal-tab-host';
        this.contentContainer.appendChild(this.terminalTabHost);
        this.terminalLayoutButton = null;
        this.agentContainer = null;
        this.agentHeader = null;
        this.agentMeta = null;
        this.agentToolbar = null;
        this.agentModeSelect = null;
        this.agentModelSelect = null;
        this.agentThoughtSelect = null;
        this.agentModeSelectShell = null;
        this.agentModelSelectShell = null;
        this.agentThoughtSelectShell = null;
        this.agentNewChatButton = null;
        this.agentUsageHud = null;
        this.agentUsageHudHovered = false;
        this.agentUsageHudHighlightTimer = null;
        this.agentUsageHudHighlightedMetricKeys = new Set();
        this.agentUsageHudMetricSignatures = new Map();
        this.agentUsageHudLastTabId = '';
        this.agentPlan = null;
        this.agentTopActions = null;
        this.agentCommands = null;
        this.agentTranscript = null;
        this.agentTools = null;
        this.agentPermissions = null;
        this.agentPrompt = null;
        this.agentAttachmentInput = null;
        this.agentAttachmentButton = null;
        this.agentScrollBottomButton = null;
        this.agentAttachmentList = null;
        this.agentSendButton = null;
        this.agentHint = null;
        this.agentFixedActions = null;
        this.agentCommandMenu = null;
        this.agentCommandSuggestions = [];
        this.agentCommandIndex = 0;
        this.agentCommandMenuStateKey = '';
        this.agentCommandMenuToken = 0;
        this.isApplyingAgentPromptState = false;
        this.suppressAgentCommandMenu = false;
        this.agentEmbeddedEditors = [];
        this.agentEmbeddedTerminals = new Map();
        this.agentTranscriptLayout = null;
        this.pdfPreviewState = {
            path: '',
            sessionKey: '',
            renderToken: 0,
            document: null,
            loadingTask: null,
            metadata: '',
            renderedWidth: 0,
            relayoutTimer: 0
        };
        this.fileVersionCheckTimer = null;
        this.fileVersionCheckPromise = null;
        this.fileConflictDialogKey = '';
        this.suppressFileWriteCapture = false;
        this.agentTranscriptResizeObserver = null;

        this.initTerminalControls();
        this.initResizer();
        this.initAgentPanel();
        this.initMonaco();
        this.loadIconMap();
        this.agentTimestampTimer = window.setInterval(() => {
            this.refreshAgentTimelineTimestamps();
            this.refreshAgentUsageHud();
        }, 1000);
        this.fileVersionCheckTimer = window.setInterval(() => {
            void this.checkActiveFileVersion();
        }, FILE_VERSION_CHECK_INTERVAL_MS);
    }

    isTerminalTabPinned(session = this.currentSession) {
        return session?.sharedWorkspaceState?.terminalDisplayMode === 'tab';
    }

    canToggleTerminalWorkspaceMode(session = this.currentSession) {
        return !!session && !isForcedTerminalWorkspaceMode();
    }

    hasCompactWorkspaceTabs(session = this.currentSession) {
        return !!session
            && (
                isForcedTerminalWorkspaceMode()
                || this.isTerminalTabPinned(session)
            );
    }

    hasVisibleWorkspaceTabs(session = this.currentSession) {
        if (!session) return false;
        return this.hasCompactWorkspaceTabs(session)
            || session.editorState.openFiles.length > 0
            || getAgentTabsForSession(session).length > 0;
    }

    initTerminalControls() {
        if (!this.terminalWrapper) return;

        this.terminalLayoutButton = document.createElement('button');
        this.terminalLayoutButton.type = 'button';
        this.terminalLayoutButton.className = 'terminal-layout-button';
        this.terminalLayoutButton.style.display = 'none';
        this.terminalLayoutButton.addEventListener('click', () => {
            if (!this.canToggleTerminalWorkspaceMode()) return;
            const nextMode = this.isTerminalTabPinned(this.currentSession)
                ? 'auto'
                : 'tab';
            this.setTerminalDisplayMode(nextMode);
        });
        this.terminalWrapper.appendChild(this.terminalLayoutButton);
    }

    updateTerminalLayoutButton() {
        if (!this.terminalLayoutButton) return;

        if (
            !this.canToggleTerminalWorkspaceMode()
            || !this.hasVisibleWorkspaceTabs(this.currentSession)
        ) {
            this.terminalLayoutButton.style.display = 'none';
            this.terminalLayoutButton.classList.remove('active');
            return;
        }

        const pinned = this.isTerminalTabPinned(this.currentSession);
        const label = pinned
            ? 'Restore automatic terminal layout'
            : 'Show terminal as a workspace tab';

        this.terminalLayoutButton.style.display = 'inline-flex';
        this.terminalLayoutButton.classList.toggle('active', pinned);
        this.terminalLayoutButton.innerHTML = pinned
            ? TERMINAL_AUTO_MODE_ICON_SVG
            : TERMINAL_TAB_MODE_ICON_SVG;
        this.terminalLayoutButton.title = label;
        this.terminalLayoutButton.setAttribute('aria-label', label);
    }

    setTerminalDisplayMode(mode) {
        if (!this.currentSession) return;

        const nextMode = mode === 'tab' ? 'tab' : 'auto';
        const session = this.currentSession;
        const activeElement = document.activeElement;
        const terminalControlHasFocus = !!(
            activeElement
            && this.terminalWrapper
            && this.terminalWrapper.contains(activeElement)
        );

        if (isForcedTerminalWorkspaceMode()) {
            session.sharedWorkspaceState.terminalDisplayMode = 'auto';
            this.updateTerminalLayoutButton();
            return;
        }

        if (
            (session.sharedWorkspaceState.terminalDisplayMode || 'auto')
            === nextMode
        ) {
            this.updateTerminalLayoutButton();
            return;
        }

        session.sharedWorkspaceState.terminalDisplayMode = nextMode;
        if (nextMode === 'tab') {
            session.workspaceState.activeTabKey = TERMINAL_WORKSPACE_TAB_KEY;
        } else if (
            isTerminalWorkspaceTabKey(session.workspaceState.activeTabKey || '')
        ) {
            session.workspaceState.activeTabKey =
                this.getPreferredNonTerminalWorkspaceTabKey(session);
        }

        session.saveState({ touchWorkspace: true });
        this.switchTo(session);
        this.updateEditorPaneVisibility();
        renderTabs();

        if (terminalControlHasFocus) {
            requestAnimationFrame(() => {
                if (
                    state.activeSessionKey === session.key
                    && state.sessions.has(session.key)
                ) {
                    session.mainTerm.focus();
                }
            });
        }
    }

    getPreferredNonTerminalWorkspaceTabKey(session = this.currentSession) {
        if (!session) return '';

        const lastNonTerminal = session.workspaceState?.lastNonTerminalTabKey;
        if (isAgentWorkspaceTabKey(lastNonTerminal)) {
            if (state.agentTabs.has(lastNonTerminal)) {
                return lastNonTerminal;
            }
        } else if (isFileWorkspaceTabKey(lastNonTerminal)) {
            const filePath = workspaceKeyToFilePath(lastNonTerminal);
            if (session.editorState.openFiles.includes(filePath)) {
                return lastNonTerminal;
            }
        }

        const activeFilePath = session.editorState.activeFilePath;
        if (
            activeFilePath
            && session.editorState.openFiles.includes(activeFilePath)
        ) {
            return makeFileWorkspaceTabKey(activeFilePath);
        }

        const agentTabs = getAgentTabsForSession(session);
        if (agentTabs.length > 0) {
            return agentTabs[0].key;
        }

        if (session.editorState.openFiles.length > 0) {
            return makeFileWorkspaceTabKey(
                session.editorState.openFiles[
                    session.editorState.openFiles.length - 1
                ]
            );
        }

        return '';
    }

    syncTerminalWorkspacePlacement(
        activeKey = this.getActiveWorkspaceTabKey(this.currentSession)
    ) {
        if (!this.terminalWrapper || !this.terminalTabHost) return;

        const compact = this.hasCompactWorkspaceTabs(this.currentSession);
        const terminalActive = compact && isTerminalWorkspaceTabKey(activeKey);

        if (terminalActive) {
            if (this.terminalWrapper.parentElement !== this.terminalTabHost) {
                this.terminalTabHost.appendChild(this.terminalWrapper);
            }
            this.terminalTabHost.style.display = 'flex';
            this.terminalWrapper.style.display = 'flex';
            this.terminalWrapper.classList.add('workspace-tab-active');
        } else {
            this.terminalTabHost.style.display = 'none';
            this.terminalWrapper.classList.remove('workspace-tab-active');
            if (
                this.terminalOriginalParent
                && this.terminalWrapper.parentElement
                    !== this.terminalOriginalParent
            ) {
                this.terminalOriginalParent.insertBefore(
                    this.terminalWrapper,
                    this.terminalOriginalNextSibling
                );
            }
            this.terminalWrapper.style.display = compact ? 'none' : 'flex';
        }

        this.updateTerminalLayoutButton();
    }

    saveActiveEditorViewState(session = this.currentSession) {
        if (!session || !this.editor) return;
        const filePath = session.editorState?.activeFilePath;
        if (!filePath) return;
        const file = this.getModel(filePath, session);
        if (!file || file.type !== 'text') return;
        session.editorState.viewStates.set(
            filePath,
            this.editor.saveViewState()
        );
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
        this.agentModeSelect.dataset.selectorRole = 'mode';
        this.agentModeSelect.setAttribute('aria-label', 'Permissions');
        this.agentModeSelect.addEventListener('change', async () => {
            const modeId = this.agentModeSelect.value;
            if (!modeId) return;
            await this.setActiveAgentMode(modeId);
        });
        this.agentModeSelectShell = this.buildAgentCompactSelectShell(
            this.agentModeSelect,
            MODE_SELECT_ICON_SVG,
            'Permissions'
        );

        this.agentModelSelect = document.createElement('select');
        this.agentModelSelect.className = 'agent-panel-mode-select';
        this.agentModelSelect.dataset.selectorRole = 'model';
        this.agentModelSelect.setAttribute('aria-label', 'Model');
        this.agentModelSelect.style.display = 'none';
        this.agentModelSelect.addEventListener('change', async () => {
            const configId = this.agentModelSelect.dataset.configId || '';
            const valueId = this.agentModelSelect.value;
            if (!configId || !valueId) return;
            await this.setActiveAgentConfigOption(configId, valueId);
        });
        this.agentModelSelectShell = this.buildAgentCompactSelectShell(
            this.agentModelSelect,
            MODEL_SELECT_ICON_SVG,
            'Model'
        );

        this.agentThoughtSelect = document.createElement('select');
        this.agentThoughtSelect.className = 'agent-panel-mode-select';
        this.agentThoughtSelect.dataset.selectorRole = 'thought_level';
        this.agentThoughtSelect.setAttribute('aria-label', 'Thought depth');
        this.agentThoughtSelect.style.display = 'none';
        this.agentThoughtSelect.addEventListener('change', async () => {
            const configId = this.agentThoughtSelect.dataset.configId || '';
            const valueId = this.agentThoughtSelect.value;
            if (!configId || !valueId) return;
            await this.setActiveAgentConfigOption(configId, valueId);
        });
        this.agentThoughtSelectShell = this.buildAgentCompactSelectShell(
            this.agentThoughtSelect,
            THOUGHT_SELECT_ICON_SVG,
            'Thought depth'
        );

        this.agentNewChatButton = document.createElement('button');
        this.agentNewChatButton.type = 'button';
        this.agentNewChatButton.className = 'terminal-layout-button agent-panel-top-button';
        this.agentNewChatButton.innerHTML = PLUS_ICON_SVG;
        this.agentNewChatButton.title = 'New Chat';
        this.agentNewChatButton.setAttribute('aria-label', 'New Chat');
        this.agentNewChatButton.addEventListener('click', async () => {
            const agentTab = getActiveAgentTab();
            if (!agentTab) return;
            await this.createSiblingAgentTab(agentTab);
        });

        this.agentUsageHud = document.createElement('div');
        this.agentUsageHud.className = 'agent-usage-hud';
        this.agentUsageHud.style.display = 'none';
        this.agentUsageHud.addEventListener('mouseenter', () => {
            this.agentUsageHudHovered = true;
            this.clearAgentUsageHudHighlights();
        });
        this.agentUsageHud.addEventListener('mouseleave', () => {
            this.agentUsageHudHovered = false;
        });

        this.agentSetupButton = document.createElement('button');
        this.agentSetupButton.type = 'button';
        this.agentSetupButton.className = 'agent-panel-button secondary';
        this.agentSetupButton.textContent = 'Setup';
        this.agentSetupButton.style.display = 'none';
        this.agentSetupButton.addEventListener('click', () => {
            const agentTab = getActiveAgentTab();
            if (!agentTab) return;
            this.openAgentSetupForTab(agentTab);
        });

        headerTop.appendChild(headerMain);
        header.appendChild(headerTop);

        this.agentTools = document.createElement('div');
        this.agentTools.className = 'agent-panel-tools';

        this.agentPermissions = document.createElement('div');
        this.agentPermissions.className = 'agent-panel-permissions';

        this.agentPlan = document.createElement('div');
        this.agentPlan.className = 'agent-plan-panel';
        this.agentPlan.style.display = 'none';

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
        this.agentTranscript.addEventListener('scroll', () => {
            this.updateAgentScrollBottomButton();
            this.rememberAgentTranscriptLayout();
        });
        this.agentTranscriptResizeObserver = new ResizeObserver(() => {
            const shouldPinToBottom = this.isAgentTranscriptLayoutNearBottom(
                this.agentTranscriptLayout,
                36
            );
            this.scheduleAgentTranscriptViewportUpdate(shouldPinToBottom);
        });
        this.agentTranscriptResizeObserver.observe(this.agentTranscript);

        const composer = document.createElement('div');
        composer.className = 'agent-panel-composer';

        this.agentAttachmentInput = document.createElement('input');
        this.agentAttachmentInput.type = 'file';
        this.agentAttachmentInput.multiple = true;
        this.agentAttachmentInput.className = 'agent-panel-file-input';
        this.agentAttachmentInput.addEventListener('change', (event) => {
            const files = Array.from(event.target.files || []);
            void this.addAgentAttachments(files);
            this.agentAttachmentInput.value = '';
        });

        this.agentAttachmentList = document.createElement('div');
        this.agentAttachmentList.className = 'agent-attachment-list';
        this.agentAttachmentList.style.display = 'none';

        this.agentPrompt = document.createElement('textarea');
        this.agentPrompt.className = 'agent-panel-input';
        this.agentPrompt.placeholder = AGENT_PROMPT_PLACEHOLDER.join('\n');
        this.agentPrompt.rows = 3;
        this.agentPrompt.addEventListener('input', () => {
            const activeTabKey = this.getActiveWorkspaceTabKey();
            const agentTab = isAgentWorkspaceTabKey(activeTabKey)
                ? state.agentTabs.get(activeTabKey) || null
                : null;
            if (agentTab) {
                agentTab.promptDraft = this.agentPrompt.value;
                if (!this.isApplyingAgentPromptState) {
                    agentTab.promptHistoryIndex = null;
                }
            }
            this.updateAgentComposerActions();
        });
        this.agentPrompt.addEventListener('blur', () => {
            setTimeout(() => {
                if (
                    document.activeElement?.classList?.contains(
                        'xterm-helper-textarea'
                    )
                    && this.agentCommandSuggestions.length > 0
                ) {
                    return;
                }
                this.hideAgentCommandMenu();
            }, 120);
        });
        for (const eventName of ['dragenter', 'dragover']) {
            this.agentPrompt.addEventListener(eventName, (event) => {
                if (!event.dataTransfer?.files?.length) return;
                event.preventDefault();
                composer.classList.add('drag-over');
            });
        }
        for (const eventName of ['dragleave', 'dragend']) {
            this.agentPrompt.addEventListener(eventName, () => {
                composer.classList.remove('drag-over');
            });
        }
        this.agentPrompt.addEventListener('drop', (event) => {
            const files = Array.from(event.dataTransfer?.files || []);
            if (files.length === 0) return;
            event.preventDefault();
            composer.classList.remove('drag-over');
            void this.addAgentAttachments(files);
        });
        this.agentPrompt.addEventListener('keydown', (event) => {
            const activeTabKey = this.getActiveWorkspaceTabKey();
            const agentTab = isAgentWorkspaceTabKey(activeTabKey)
                ? state.agentTabs.get(activeTabKey)
                : null;

            if (
                agentTab
                && this.agentCommandSuggestions.length > 0
                && Number.isInteger(agentTab.promptHistoryIndex)
            ) {
                this.exitAgentPromptHistoryBrowsing(agentTab);
            }

            if (this.agentCommandSuggestions.length > 0) {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.moveAgentCommandSelection(1);
                    return;
                }
                if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
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
                    event.stopImmediatePropagation();
                    void this.applyAgentCommandSuggestion();
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.hideAgentCommandMenu();
                    return;
                }
            }

            if (
                (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                && this.handleAgentPromptHistoryKey(event, agentTab)
            ) {
                return;
            }

            if (
                agentTab
                && Number.isInteger(agentTab.promptHistoryIndex)
                && event.key !== 'ArrowUp'
                && event.key !== 'ArrowDown'
                && ![
                    'Shift',
                    'Control',
                    'Alt',
                    'Meta'
                ].includes(event.key)
            ) {
                this.exitAgentPromptHistoryBrowsing(agentTab);
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
                void this.submitActiveAgentPrompt();
                return;
            }

            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void this.submitActiveAgentPrompt();
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

        this.agentScrollBottomButton = document.createElement('button');
        this.agentScrollBottomButton.type = 'button';
        this.agentScrollBottomButton.className =
            'agent-panel-button secondary icon-only';
        this.agentScrollBottomButton.innerHTML = CHEVRON_DOWN_ICON_SVG;
        this.agentScrollBottomButton.title = 'Scroll to latest message';
        this.agentScrollBottomButton.setAttribute(
            'aria-label',
            'Scroll to latest message'
        );
        this.agentScrollBottomButton.style.display = 'none';
        this.agentScrollBottomButton.addEventListener('click', () => {
            this.scrollAgentTranscriptToBottom();
        });

        this.agentAttachmentButton = document.createElement('button');
        this.agentAttachmentButton.type = 'button';
        this.agentAttachmentButton.className =
            'agent-panel-button secondary icon-only agent-attach-button';
        this.agentAttachmentButton.innerHTML = ATTACH_ICON_SVG;
        this.agentAttachmentButton.title = 'Add attachments';
        this.agentAttachmentButton.setAttribute(
            'aria-label',
            'Add attachments'
        );
        this.agentAttachmentButton.addEventListener('click', () => {
            if (this.agentAttachmentButton.disabled) return;
            this.agentAttachmentInput?.click();
        });

        this.agentSendButton = document.createElement('button');
        this.agentSendButton.type = 'button';
        this.agentSendButton.className = 'agent-panel-button';
        this.agentSendButton.textContent = 'Send';
        this.agentSendButton.addEventListener('click', () => {
            void this.submitActiveAgentPrompt();
        });

        this.agentFixedActions.appendChild(this.agentScrollBottomButton);
        this.agentFixedActions.appendChild(this.agentModelSelectShell);
        this.agentFixedActions.appendChild(this.agentThoughtSelectShell);
        this.agentFixedActions.appendChild(this.agentModeSelectShell);
        this.agentFixedActions.appendChild(this.agentSetupButton);
        this.agentFixedActions.appendChild(this.agentAttachmentButton);
        this.agentFixedActions.appendChild(this.agentSendButton);

        actions.appendChild(this.agentCommands);
        actions.appendChild(this.agentFixedActions);
        composer.appendChild(this.agentAttachmentInput);
        composer.appendChild(this.agentAttachmentList);
        composer.appendChild(this.agentPrompt);
        composer.appendChild(this.agentCommandMenu);
        composer.appendChild(actions);

        this.agentActivity = document.createElement('div');
        this.agentActivity.className = 'agent-panel-activity';
        this.agentActivity.style.display = 'none';
        this.agentActivityCancelButton = document.createElement('button');
        this.agentActivityCancelButton.type = 'button';
        this.agentActivityCancelButton.className = 'agent-activity-action';
        this.agentActivityCancelButton.title = 'Current activity';
        this.agentActivityCancelButton.setAttribute(
            'aria-label',
            'Current activity'
        );
        this.agentActivityCancelButton.disabled = true;
        this.agentActivityCancelButton.addEventListener('click', () => {
            void this.cancelActiveAgentPrompt();
        });
        this.agentActivityPrimaryIcon = document.createElement('span');
        this.agentActivityPrimaryIcon.className =
            'agent-panel-activity-icon agent-activity-action-primary';
        this.agentActivityStopIcon = document.createElement('span');
        this.agentActivityStopIcon.className = 'agent-activity-action-stop';
        this.agentActivityStopIcon.innerHTML = CLOSE_ICON_SVG;
        this.agentActivityCancelButton.appendChild(
            this.agentActivityPrimaryIcon
        );
        this.agentActivityCancelButton.appendChild(
            this.agentActivityStopIcon
        );
        this.agentActivityLabel = document.createElement('span');
        this.agentActivityLabel.className = 'agent-panel-activity-label';
        this.agentActivity.appendChild(this.agentActivityCancelButton);
        this.agentActivity.appendChild(this.agentActivityLabel);

        this.agentQueue = document.createElement('div');
        this.agentQueue.className = 'agent-panel-queue';
        this.agentQueue.style.display = 'none';

        this.agentContainer.appendChild(header);
        this.agentContainer.appendChild(this.agentUsageHud);
        this.agentContainer.appendChild(this.agentNewChatButton);
        this.agentContainer.appendChild(this.agentTools);
        this.agentContainer.appendChild(this.agentPermissions);
        this.agentContainer.appendChild(this.agentTranscript);
        this.agentContainer.appendChild(this.agentActivity);
        this.agentContainer.appendChild(this.agentPlan);
        this.agentContainer.appendChild(this.agentQueue);
        this.agentContainer.appendChild(composer);
        this.contentContainer.appendChild(this.agentContainer);
    }

    buildAgentCompactSelectShell(selectEl, iconSvg, label) {
        const shell = document.createElement('div');
        shell.className = 'agent-panel-select-shell';
        shell.dataset.selectorRole = selectEl?.dataset?.selectorRole || '';
        shell.style.display = selectEl?.style?.display === 'none' ? 'none' : '';

        const icon = document.createElement('span');
        icon.className = 'agent-panel-select-shell-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = iconSvg;

        shell.appendChild(icon);
        shell.appendChild(selectEl);
        shell.title = label;
        return shell;
    }

    getActiveWorkspaceTabKey(session = this.currentSession) {
        if (!session) return '';
        const explicitKey = session.workspaceState?.activeTabKey || '';
        const compact = this.hasCompactWorkspaceTabs(session);
        if (compact && isTerminalWorkspaceTabKey(explicitKey)) {
            return explicitKey;
        }
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
        if (!compact && isTerminalWorkspaceTabKey(explicitKey)) {
            const fallback = this.getPreferredNonTerminalWorkspaceTabKey(
                session
            );
            session.workspaceState.activeTabKey = fallback;
            return fallback;
        }
        if (session.editorState.activeFilePath) {
            return makeFileWorkspaceTabKey(session.editorState.activeFilePath);
        }
        const agentTabs = getAgentTabsForSession(session);
        if (agentTabs.length > 0) {
            return agentTabs[0].key;
        }
        if (compact) {
            return TERMINAL_WORKSPACE_TAB_KEY;
        }
        return '';
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

    normalizePendingFileWrite(write, entry = null) {
        if (write && typeof write === 'object' && !Array.isArray(write)) {
            return {
                content: typeof write.content === 'string' ? write.content : '',
                expectedVersion: typeof write.expectedVersion === 'string'
                    ? write.expectedVersion
                    : (
                        typeof entry?.version === 'string'
                            ? entry.version
                            : ''
                    ),
                blocked: write.blocked === true,
                force: write.force === true
            };
        }
        return {
            content: typeof write === 'string' ? write : '',
            expectedVersion: typeof entry?.version === 'string'
                ? entry.version
                : '',
            blocked: false,
            force: false
        };
    }

    queuePendingFileWrite(session, filePath, content, overrides = {}) {
        if (!session || !filePath) return;
        const pending = getPendingSession(session.key);
        const entry = this.getModel(filePath, session);
        const previous = this.normalizePendingFileWrite(
            pending.fileWrites.get(filePath),
            entry
        );
        pending.fileWrites.set(filePath, {
            ...previous,
            content,
            expectedVersion: typeof overrides.expectedVersion === 'string'
                ? overrides.expectedVersion
                : previous.expectedVersion,
            blocked: overrides.blocked ?? false,
            force: overrides.force ?? false
        });
    }

    getPendingFileWrite(session, filePath) {
        if (!session || !filePath) return null;
        const pending = getPendingSession(session.key);
        if (!pending?.fileWrites?.has(filePath)) {
            return null;
        }
        return this.normalizePendingFileWrite(
            pending.fileWrites.get(filePath),
            this.getModel(filePath, session)
        );
    }

    getTextFileEntry(filePath, session = this.currentSession) {
        const entry = this.getModel(filePath, session);
        if (!entry || entry.type !== 'text') {
            return null;
        }
        if (typeof entry.contentVersion !== 'string') {
            entry.contentVersion = typeof entry.version === 'string'
                ? entry.version
                : '';
        }
        return entry;
    }

    getCurrentTextFileContent(filePath, session = this.currentSession) {
        const entry = this.getTextFileEntry(filePath, session);
        if (!entry) return '';
        try {
            if (typeof entry.model?.getValue === 'function') {
                return entry.model.getValue();
            }
        } catch {
            // Ignore model access failures and fall back to cached content.
        }
        return typeof entry.content === 'string' ? entry.content : '';
    }

    isActiveTextFile(session, filePath) {
        if (!session || !filePath) return false;
        if (this.currentSession?.key !== session.key) return false;
        if (state.activeSessionKey !== session.key) return false;
        if (session.editorState.activeFilePath !== filePath) return false;
        return this.getActiveWorkspaceTabKey(session)
            === makeFileWorkspaceTabKey(filePath);
    }

    updateTextFileEntry(filePath, updates, session = this.currentSession) {
        const entry = this.getTextFileEntry(filePath, session);
        if (!entry || !updates || typeof updates !== 'object') {
            return null;
        }
        Object.assign(entry, updates);
        return entry;
    }

    updateActiveEditorReadOnlyState(session, filePath, readonly) {
        if (!this.isActiveTextFile(session, filePath) || !this.editor) {
            return;
        }
        this.editor.updateOptions({ readOnly: !!readonly });
        this.renderEditorTabs();
    }

    applyProgrammaticTextContent(entry, nextContent) {
        if (
            !entry?.model
            || typeof entry.model.getValue !== 'function'
            || typeof entry.model.setValue !== 'function'
        ) {
            entry.content = nextContent;
            return;
        }
        const currentValue = entry.model.getValue();
        if (currentValue === nextContent) {
            entry.content = nextContent;
            return;
        }
        this.suppressFileWriteCapture = true;
        try {
            entry.model.setValue(nextContent);
        } finally {
            this.suppressFileWriteCapture = false;
        }
        entry.content = nextContent;
    }

    async readTextFileSnapshot(session, filePath) {
        if (!session || !filePath) {
            throw new Error('File path required');
        }
        const response = await session.server.fetch(
            `/api/fs/read?path=${encodeURIComponent(filePath)}`
        );
        if (!response.ok) {
            await throwResponseError(response, 'Failed to read file');
        }
        return await response.json();
    }

    async readTextFileInfo(session, filePath) {
        if (!session || !filePath) {
            throw new Error('File path required');
        }
        const response = await session.server.fetch(
            `/api/fs/info?path=${encodeURIComponent(filePath)}`
        );
        if (!response.ok) {
            await throwResponseError(response, 'Failed to inspect file');
        }
        return await response.json();
    }

    applyTextFileSnapshot(session, filePath, snapshot, options = {}) {
        const entry = this.getTextFileEntry(filePath, session);
        if (!entry || !snapshot || typeof snapshot !== 'object') {
            return null;
        }
        const useLocalContent = options.useLocalContent === true;
        const nextReadonly = !!snapshot.readonly;
        const nextVersion = typeof snapshot.version === 'string'
            ? snapshot.version
            : entry.version || '';
        const nextContent = typeof snapshot.content === 'string'
            ? snapshot.content
            : entry.content || '';

        if (!entry.model && this.monacoInstance) {
            const uri = this.monacoInstance.Uri.file(filePath);
            const existing = this.monacoInstance.editor.getModel(uri);
            entry.model = existing || this.monacoInstance.editor.createModel(
                typeof entry.content === 'string' ? entry.content : '',
                undefined,
                uri
            );
        }

        if (!useLocalContent) {
            const restoreViewState = (
                this.isActiveTextFile(session, filePath)
                && this.editor
                && this.editor.getModel?.() === entry.model
            )
                ? this.editor.saveViewState()
                : null;
            this.applyProgrammaticTextContent(entry, nextContent);
            if (restoreViewState && this.editor) {
                this.editor.restoreViewState(restoreViewState);
            }
            entry.contentVersion = nextVersion;
        } else if (typeof snapshot.content === 'string') {
            entry.content = snapshot.content;
            entry.contentVersion = nextVersion;
        }

        entry.version = nextVersion;
        entry.readonly = nextReadonly;
        entry.size = Number.isFinite(snapshot.size) ? snapshot.size : entry.size;
        entry.mtimeMs = Number.isFinite(snapshot.mtimeMs)
            ? snapshot.mtimeMs
            : entry.mtimeMs;
        entry.lastDismissedRemoteVersion = '';
        this.updateActiveEditorReadOnlyState(session, filePath, nextReadonly);
        return entry;
    }

    getFileConflictDialogKey(session, filePath, version, source) {
        return [
            session?.key || '',
            filePath || '',
            version || '',
            source || ''
        ].join(':');
    }

    async promptTextFileConflict(session, filePath, snapshot, source) {
        if (!session || !filePath || !snapshot) {
            return 'dismiss';
        }
        const version = typeof snapshot.version === 'string'
            ? snapshot.version
            : '';
        const dialogKey = this.getFileConflictDialogKey(
            session,
            filePath,
            version,
            source
        );
        if (this.fileConflictDialogKey === dialogKey) {
            return 'dismiss';
        }
        this.fileConflictDialogKey = dialogKey;
        const fileName = filePath.split('/').pop() || filePath;
        const keepLocal = await showConfirmModal({
            title: source === 'save-conflict'
                ? 'Save Conflict'
                : 'File Changed on Disk',
            message: source === 'save-conflict'
                ? `“${fileName}” changed on disk before Tabminal could save it.`
                : `“${fileName}” was modified outside Tabminal.`,
            note: 'Use Remote reloads the disk version. Use Local keeps your '
                + 'current editor contents and overwrites the remote change '
                + 'on the next save.',
            confirmLabel: 'Use Local',
            cancelLabel: 'Use Remote',
            preferredFocus: 'cancel',
            allowDismiss: false,
            returnFocus: this.isActiveTextFile(session, filePath)
                ? this.monacoContainer
                : document.activeElement
        });
        this.fileConflictDialogKey = '';
        return keepLocal ? 'local' : 'remote';
    }

    async resolveTextFileConflict(session, filePath, snapshot, source) {
        const entry = this.getTextFileEntry(filePath, session);
        if (!entry || !snapshot) {
            return;
        }
        const decision = await this.promptTextFileConflict(
            session,
            filePath,
            snapshot,
            source
        );
        if (decision === 'remote') {
            const remoteSnapshot = typeof snapshot.content === 'string'
                ? snapshot
                : await this.readTextFileSnapshot(session, filePath);
            this.applyTextFileSnapshot(session, filePath, remoteSnapshot);
            this.clearPendingFileWrite(session.key, filePath);
            if (this.isActiveTextFile(session, filePath)) {
                this.renderEditorTabs();
            }
            return;
        }

        if (decision === 'local') {
            const currentContent = this.getCurrentTextFileContent(
                filePath,
                session
            );
            this.applyTextFileSnapshot(session, filePath, snapshot, {
                useLocalContent: true
            });
            this.queuePendingFileWrite(session, filePath, currentContent, {
                expectedVersion: typeof snapshot.version === 'string'
                    ? snapshot.version
                    : entry.version || '',
                blocked: false,
                force: false
            });
            requestImmediateServerSync(session.server, 0);
        }
    }

    async applyFileWriteResults(server, sessionResults, sentFileWrites) {
        if (!server || !Array.isArray(sessionResults)) {
            return;
        }
        for (const update of sessionResults) {
            const session = state.sessions.get(
                makeSessionKey(server.id, update?.id)
            );
            if (!session || !Array.isArray(update?.fileWrites)) {
                continue;
            }
            for (const result of update.fileWrites) {
                const filePath = typeof result?.path === 'string'
                    ? result.path
                    : '';
                if (!filePath) continue;
                const entry = this.getTextFileEntry(filePath, session);
                const sentWrite = sentFileWrites?.get(update.id)?.get(filePath)
                    || null;
                if (!entry) {
                    this.clearPendingFileWrite(session.key, filePath);
                    continue;
                }
                if (result.status === 'ok') {
                    const currentWrite = this.getPendingFileWrite(
                        session,
                        filePath
                    );
                    const sentContent = sentWrite?.content
                        ?? this.getCurrentTextFileContent(filePath, session);
                    entry.content = sentContent;
                    entry.version = typeof result.version === 'string'
                        ? result.version
                        : entry.version || '';
                    entry.contentVersion = entry.version;
                    entry.readonly = !!result.readonly;
                    entry.lastDismissedRemoteVersion = '';
                    const hasNewerPendingWrite = !!(
                        currentWrite
                        && sentWrite
                        && (
                            currentWrite.content !== sentWrite.content
                            || currentWrite.expectedVersion
                                !== sentWrite.expectedVersion
                            || currentWrite.force !== sentWrite.force
                        )
                    );
                    if (hasNewerPendingWrite) {
                        this.queuePendingFileWrite(
                            session,
                            filePath,
                            currentWrite.content,
                            {
                                expectedVersion: entry.version,
                                blocked: false,
                                force: currentWrite.force
                            }
                        );
                    } else {
                        this.clearPendingFileWrite(session.key, filePath);
                    }
                    this.updateActiveEditorReadOnlyState(
                        session,
                        filePath,
                        entry.readonly
                    );
                    continue;
                }
                if (result.status === 'conflict') {
                    this.queuePendingFileWrite(
                        session,
                        filePath,
                        this.getCurrentTextFileContent(filePath, session),
                        {
                            expectedVersion: typeof result.version === 'string'
                                ? result.version
                                : entry.version || '',
                            blocked: true,
                            force: false
                        }
                    );
                    await this.resolveTextFileConflict(
                        session,
                        filePath,
                        result,
                        'save-conflict'
                    );
                    continue;
                }
                this.queuePendingFileWrite(
                    session,
                    filePath,
                    this.getCurrentTextFileContent(filePath, session),
                    {
                        blocked: true
                    }
                );
                alert(result?.error || 'Failed to save file.', {
                    type: 'error',
                    title: 'Save Error'
                });
            }
        }
    }

    async checkActiveFileVersion() {
        if (
            this.fileVersionCheckPromise
            || document.visibilityState === 'hidden'
            || isConfirmModalOpen()
        ) {
            return;
        }
        const session = this.currentSession;
        const filePath = session?.editorState?.activeFilePath || '';
        if (!this.isActiveTextFile(session, filePath)) {
            return;
        }
        const entry = this.getTextFileEntry(filePath, session);
        if (!entry || entry.readonly) {
            return;
        }
        this.fileVersionCheckPromise = (async () => {
            try {
                const info = await this.readTextFileInfo(session, filePath);
                if (
                    !info
                    || typeof info.version !== 'string'
                    || !info.version
                    || info.version === entry.version
                    || info.version === entry.lastDismissedRemoteVersion
                ) {
                    return;
                }
                const pendingWrite = this.getPendingFileWrite(session, filePath);
                if (pendingWrite?.blocked) {
                    return;
                }
                await this.resolveTextFileConflict(
                    session,
                    filePath,
                    info,
                    'remote-change'
                );
            } catch (error) {
                console.warn('Failed to check file version:', error);
            }
        })();
        try {
            await this.fileVersionCheckPromise;
        } finally {
            this.fileVersionCheckPromise = null;
        }
    }

    clearPendingFileWrite(sessionKey, filePath) {
        const pending = pendingChanges.sessions.get(sessionKey);
        pending?.fileWrites?.delete(filePath);
    }

    remapTreePath(pathValue, oldPath, newPath, isDirectory) {
        if (typeof pathValue !== 'string' || pathValue.length === 0) {
            return pathValue;
        }
        if (pathValue === oldPath) {
            return newPath;
        }
        if (
            isDirectory
            && pathValue.startsWith(`${oldPath}/`)
        ) {
            return `${newPath}${pathValue.slice(oldPath.length)}`;
        }
        return pathValue;
    }

    remapWorkspaceTabKey(key, oldPath, newPath, isDirectory) {
        if (!isFileWorkspaceTabKey(key)) return key;
        const filePath = workspaceKeyToFilePath(key);
        const nextPath = this.remapTreePath(
            filePath,
            oldPath,
            newPath,
            isDirectory
        );
        return nextPath ? makeFileWorkspaceTabKey(nextPath) : key;
    }

    cloneRenamedModelEntry(entry, nextPath) {
        if (!entry || typeof entry !== 'object') return entry;
        const nextEntry = {
            ...entry
        };
        if (nextEntry.model) {
            let nextContent = nextEntry.content;
            try {
                if (typeof nextEntry.model.getValue === 'function') {
                    nextContent = nextEntry.model.getValue();
                }
            } catch {
                // Ignore content extraction failure and keep cached content.
            }
            nextEntry.content = nextContent;

            if (
                this.monacoInstance
                && typeof nextEntry.model.getLanguageId === 'function'
            ) {
                const oldModel = nextEntry.model;
                const languageId = oldModel.getLanguageId();
                const uri = this.monacoInstance.Uri.file(nextPath);
                const existingModel = this.monacoInstance.editor.getModel(uri);
                if (existingModel && existingModel !== oldModel) {
                    existingModel.setValue(nextContent ?? '');
                    nextEntry.model = existingModel;
                } else {
                    nextEntry.model = this.monacoInstance.editor.createModel(
                        nextContent ?? '',
                        languageId,
                        uri
                    );
                }
                if (nextEntry.model !== oldModel) {
                    try {
                        oldModel.dispose();
                    } catch {
                        // Ignore disposal failures for stale models.
                    }
                }
                return nextEntry;
            }
        }
        return nextEntry;
    }

    remapModelStorePaths(server, oldPath, newPath, isDirectory) {
        if (!server?.modelStore) return false;
        const nextEntries = [];
        let changed = false;
        for (const [path, entry] of server.modelStore.entries()) {
            const nextPath = this.remapTreePath(
                path,
                oldPath,
                newPath,
                isDirectory
            );
            if (nextPath !== path) {
                changed = true;
                nextEntries.push([
                    nextPath,
                    this.cloneRenamedModelEntry(entry, nextPath)
                ]);
                server.modelStore.delete(path);
            }
        }
        for (const [nextPath, entry] of nextEntries) {
            server.modelStore.set(nextPath, entry);
        }
        return changed;
    }

    remapPendingFileWrites(sessionKey, oldPath, newPath, isDirectory) {
        const pending = pendingChanges.sessions.get(sessionKey);
        if (!pending?.fileWrites || pending.fileWrites.size === 0) {
            return false;
        }
        const nextEntries = [];
        let changed = false;
        for (const [path, content] of pending.fileWrites.entries()) {
            const nextPath = this.remapTreePath(
                path,
                oldPath,
                newPath,
                isDirectory
            );
            if (nextPath !== path) {
                changed = true;
                pending.fileWrites.delete(path);
                nextEntries.push([nextPath, content]);
            }
        }
        for (const [nextPath, content] of nextEntries) {
            pending.fileWrites.set(nextPath, content);
        }
        return changed;
    }

    pathMatchesTarget(pathValue, targetPath, isDirectory) {
        if (typeof pathValue !== 'string' || pathValue.length === 0) {
            return false;
        }
        if (pathValue === targetPath) {
            return true;
        }
        return !!(
            isDirectory
            && pathValue.startsWith(`${targetPath}/`)
        );
    }

    removeDeletedModelStorePaths(server, targetPath, isDirectory) {
        if (!server?.modelStore) return false;
        let changed = false;
        for (const [path, entry] of [...server.modelStore.entries()]) {
            if (!this.pathMatchesTarget(path, targetPath, isDirectory)) {
                continue;
            }
            changed = true;
            try {
                entry?.model?.dispose?.();
            } catch {
                // Ignore stale model disposal failures.
            }
            server.modelStore.delete(path);
        }
        return changed;
    }

    removeDeletedPendingFileWrites(sessionKey, targetPath, isDirectory) {
        const pending = pendingChanges.sessions.get(sessionKey);
        if (!pending?.fileWrites || pending.fileWrites.size === 0) {
            return false;
        }
        let changed = false;
        for (const path of [...pending.fileWrites.keys()]) {
            if (!this.pathMatchesTarget(path, targetPath, isDirectory)) {
                continue;
            }
            changed = true;
            pending.fileWrites.delete(path);
        }
        return changed;
    }

    applyRenamedPathToSession(session, oldPath, newPath, isDirectory) {
        let workspaceChanged = false;
        let visualChanged = false;

        const remapList = (values) => {
            const nextValues = [];
            for (const value of values) {
                const nextValue = this.remapTreePath(
                    value,
                    oldPath,
                    newPath,
                    isDirectory
                );
                if (!nextValues.includes(nextValue)) {
                    nextValues.push(nextValue);
                }
            }
            return nextValues;
        };

        const nextOpenFiles = remapList(session.editorState.openFiles);
        if (
            JSON.stringify(nextOpenFiles)
            !== JSON.stringify(session.editorState.openFiles)
        ) {
            session.editorState.openFiles = nextOpenFiles;
            session.sharedWorkspaceState.openFiles = [...nextOpenFiles];
            workspaceChanged = true;
            visualChanged = true;
        }

        const nextExpandedPaths = remapList(
            session.sharedWorkspaceState.expandedPaths
        );
        if (
            JSON.stringify(nextExpandedPaths)
            !== JSON.stringify(session.sharedWorkspaceState.expandedPaths)
        ) {
            session.sharedWorkspaceState.expandedPaths = nextExpandedPaths;
            workspaceChanged = true;
        }

        const nextActiveFilePath = this.remapTreePath(
            session.editorState.activeFilePath,
            oldPath,
            newPath,
            isDirectory
        );
        if (nextActiveFilePath !== session.editorState.activeFilePath) {
            session.editorState.activeFilePath = nextActiveFilePath || null;
            visualChanged = true;
        }

        const nextActiveTabKey = this.remapWorkspaceTabKey(
            session.workspaceState.activeTabKey,
            oldPath,
            newPath,
            isDirectory
        );
        if (nextActiveTabKey !== session.workspaceState.activeTabKey) {
            session.workspaceState.activeTabKey = nextActiveTabKey;
            visualChanged = true;
        }

        const nextLastNonTerminalTabKey = this.remapWorkspaceTabKey(
            session.workspaceState.lastNonTerminalTabKey,
            oldPath,
            newPath,
            isDirectory
        );
        if (
            nextLastNonTerminalTabKey
            !== session.workspaceState.lastNonTerminalTabKey
        ) {
            session.workspaceState.lastNonTerminalTabKey =
                nextLastNonTerminalTabKey;
        }

        if (session.editorState.viewStates.size > 0) {
            const nextViewStates = new Map();
            for (const [path, viewState] of session.editorState.viewStates) {
                nextViewStates.set(
                    this.remapTreePath(path, oldPath, newPath, isDirectory),
                    viewState
                );
            }
            session.editorState.viewStates = nextViewStates;
        }

        const nextSelectedTreePath = this.remapTreePath(
            session.selectedTreePath,
            oldPath,
            newPath,
            isDirectory
        );
        if (nextSelectedTreePath !== session.selectedTreePath) {
            session.selectedTreePath = nextSelectedTreePath || '';
            visualChanged = true;
        }

        const nextEditingTreePath = this.remapTreePath(
            session.treeEditingPath,
            oldPath,
            newPath,
            isDirectory
        );
        if (nextEditingTreePath !== session.treeEditingPath) {
            session.treeEditingPath = nextEditingTreePath || '';
        }

        const nextPendingFocusPath = this.remapTreePath(
            session.pendingTreeFocusPath,
            oldPath,
            newPath,
            isDirectory
        );
        if (nextPendingFocusPath !== session.pendingTreeFocusPath) {
            session.pendingTreeFocusPath = nextPendingFocusPath || '';
        }

        const nextPendingRenameFocusPath = this.remapTreePath(
            session.pendingTreeRenameFocusPath,
            oldPath,
            newPath,
            isDirectory
        );
        if (
            nextPendingRenameFocusPath
            !== session.pendingTreeRenameFocusPath
        ) {
            session.pendingTreeRenameFocusPath =
                nextPendingRenameFocusPath || '';
        }

        return {
            workspaceChanged,
            visualChanged
        };
    }

    applyDeletedPathToSession(session, targetPath, isDirectory) {
        let workspaceChanged = false;
        let visualChanged = false;

        const filterList = (values) => values.filter(
            (value) => !this.pathMatchesTarget(value, targetPath, isDirectory)
        );

        const nextOpenFiles = filterList(session.editorState.openFiles);
        if (
            JSON.stringify(nextOpenFiles)
            !== JSON.stringify(session.editorState.openFiles)
        ) {
            session.editorState.openFiles = nextOpenFiles;
            session.sharedWorkspaceState.openFiles = [...nextOpenFiles];
            workspaceChanged = true;
            visualChanged = true;
        }

        const nextExpandedPaths = filterList(
            session.sharedWorkspaceState.expandedPaths
        );
        if (
            JSON.stringify(nextExpandedPaths)
            !== JSON.stringify(session.sharedWorkspaceState.expandedPaths)
        ) {
            session.sharedWorkspaceState.expandedPaths = nextExpandedPaths;
            workspaceChanged = true;
        }

        if (
            this.pathMatchesTarget(
                session.editorState.activeFilePath,
                targetPath,
                isDirectory
            )
        ) {
            session.editorState.activeFilePath = nextOpenFiles[0] || null;
            visualChanged = true;
        }

        if (session.editorState.viewStates.size > 0) {
            const nextViewStates = new Map();
            let changed = false;
            for (const [path, viewState] of session.editorState.viewStates) {
                if (this.pathMatchesTarget(path, targetPath, isDirectory)) {
                    changed = true;
                    continue;
                }
                nextViewStates.set(path, viewState);
            }
            if (changed) {
                session.editorState.viewStates = nextViewStates;
            }
        }

        if (
            this.pathMatchesTarget(
                session.selectedTreePath,
                targetPath,
                isDirectory
            )
        ) {
            session.selectedTreePath = '';
            visualChanged = true;
        }

        if (
            this.pathMatchesTarget(
                session.treeEditingPath,
                targetPath,
                isDirectory
            )
        ) {
            session.treeEditingPath = '';
        }

        if (
            this.pathMatchesTarget(
                session.pendingTreeFocusPath,
                targetPath,
                isDirectory
            )
        ) {
            session.pendingTreeFocusPath = '';
        }

        if (
            this.pathMatchesTarget(
                session.pendingTreeRenameFocusPath,
                targetPath,
                isDirectory
            )
        ) {
            session.pendingTreeRenameFocusPath = '';
        }

        const activeTabKey = session.workspaceState.activeTabKey || '';
        if (
            isFileWorkspaceTabKey(activeTabKey)
            && this.pathMatchesTarget(
                workspaceKeyToFilePath(activeTabKey),
                targetPath,
                isDirectory
            )
        ) {
            session.workspaceState.activeTabKey = '';
            visualChanged = true;
        }

        const lastNonTerminal = session.workspaceState.lastNonTerminalTabKey || '';
        if (
            isFileWorkspaceTabKey(lastNonTerminal)
            && this.pathMatchesTarget(
                workspaceKeyToFilePath(lastNonTerminal),
                targetPath,
                isDirectory
            )
        ) {
            session.workspaceState.lastNonTerminalTabKey = '';
        }

        return {
            workspaceChanged,
            visualChanged
        };
    }

    focusTreePath(session, path) {
        if (!session?.fileTreeElement || !path) return;
        requestAnimationFrame(() => {
            const item = Array.from(
                session.fileTreeElement.querySelectorAll('li')
            ).find((candidate) => candidate.dataset.path === path);
            const row = item?.querySelector('.file-tree-item');
            if (row) {
                row.scrollIntoView({ block: 'nearest' });
                session.fileTreeElement.focus({ preventScroll: true });
            }
        });
    }

    keepTreeFocus(session) {
        if (!session?.fileTreeElement || session.treeEditingPath) {
            return;
        }
        requestAnimationFrame(() => {
            if (!session?.fileTreeElement || session.treeEditingPath) {
                return;
            }
            session.fileTreeElement.focus({ preventScroll: true });
        });
    }

    handleRenamedPaths(server, oldPath, newPath, isDirectory) {
        this.remapModelStorePaths(server, oldPath, newPath, isDirectory);

        let currentSessionAffected = false;
        for (const session of state.sessions.values()) {
            if (session.serverId !== server.id) continue;

            const { workspaceChanged, visualChanged } =
                this.applyRenamedPathToSession(
                    session,
                    oldPath,
                    newPath,
                    isDirectory
                );
            const pendingChanged = this.remapPendingFileWrites(
                session.key,
                oldPath,
                newPath,
                isDirectory
            );

            if (workspaceChanged || pendingChanged) {
                session.saveState({ touchWorkspace: true });
            }

            if (visualChanged && session.key === state.activeSessionKey) {
                currentSessionAffected = true;
            }

            if (session.editorState.isVisible) {
                this.requestSessionTreeRefresh(session);
            }
        }

        if (!currentSessionAffected || !this.currentSession) {
            return;
        }

        this.renderEditorTabs();
        this.updateEditorPaneVisibility();
        const activeKey = this.getActiveWorkspaceTabKey(this.currentSession);
        if (isFileWorkspaceTabKey(activeKey)) {
            this.activateFileTab(
                workspaceKeyToFilePath(activeKey),
                true,
                { focusEditor: false }
            );
            return;
        }
        if (isAgentWorkspaceTabKey(activeKey)) {
            this.activateAgentTab(activeKey, true);
            return;
        }
        if (isTerminalWorkspaceTabKey(activeKey)) {
            this.activateTerminalTab(true);
        }
    }

    handleDeletedPaths(server, targetPath, isDirectory) {
        this.removeDeletedModelStorePaths(server, targetPath, isDirectory);

        let currentSessionAffected = false;
        for (const session of state.sessions.values()) {
            if (session.serverId !== server.id) continue;

            const { workspaceChanged, visualChanged } =
                this.applyDeletedPathToSession(
                    session,
                    targetPath,
                    isDirectory
                );
            const pendingChanged = this.removeDeletedPendingFileWrites(
                session.key,
                targetPath,
                isDirectory
            );

            if (workspaceChanged || pendingChanged) {
                session.saveState({ touchWorkspace: true });
            }

            if (visualChanged && session.key === state.activeSessionKey) {
                currentSessionAffected = true;
            }

            if (session.editorState.isVisible) {
                this.requestSessionTreeRefresh(session);
            }
        }

        if (!currentSessionAffected || !this.currentSession) {
            return;
        }

        this.renderEditorTabs();
        this.updateEditorPaneVisibility();
        const activeKey = this.getActiveWorkspaceTabKey(this.currentSession);
        if (isFileWorkspaceTabKey(activeKey)) {
            this.activateFileTab(
                workspaceKeyToFilePath(activeKey),
                true,
                { focusEditor: false }
            );
            return;
        }
        if (isAgentWorkspaceTabKey(activeKey)) {
            this.activateAgentTab(activeKey, true);
            return;
        }
        if (isTerminalWorkspaceTabKey(activeKey)) {
            this.activateTerminalTab(true);
            return;
        }
        this.showEmptyState();
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
        session.fileTreeRenderToken = (session.fileTreeRenderToken || 0) + 1;
        const renderToken = session.fileTreeRenderToken;
        const scrollTop = session.fileTreeElement.scrollTop;
        void this.renderTree(
            session.cwd,
            session.fileTreeElement,
            session,
            renderToken
        ).finally(() => {
            if (
                session.fileTreeElement
                && session.fileTreeRenderToken === renderToken
            ) {
                session.fileTreeElement.scrollTop = scrollTop;
            }
        });
        this.updateTreeAutoRefresh();
    }

    isSessionTreeVisible(session) {
        return !!session?.fileTreeElement && !!session?.editorState?.isVisible;
    }

    canRefreshSessionTree(session) {
        return this.isSessionTreeVisible(session) && !session.treeEditingPath;
    }

    refreshVisibleSessionTrees() {
        for (const session of state.sessions.values()) {
            if (this.canRefreshSessionTree(session)) {
                this.requestSessionTreeRefresh(session);
            }
        }
    }

    requestSessionTreeRefresh(session, { force = false } = {}) {
        if (!force && !this.canRefreshSessionTree(session)) {
            this.updateTreeAutoRefresh();
            return;
        }
        if (session.fileTreeRefreshQueued) return;
        session.fileTreeRefreshQueued = true;
        requestAnimationFrame(() => {
            session.fileTreeRefreshQueued = false;
            if (force || this.canRefreshSessionTree(session)) {
                this.refreshSessionTree(session);
            } else {
                this.updateTreeAutoRefresh();
            }
        });
    }

    updateTreeAutoRefresh() {
        const shouldRun = (
            document.visibilityState === 'visible'
            && Array.from(state.sessions.values()).some(
                (session) => this.canRefreshSessionTree(session)
            )
        );
        if (shouldRun && !this.treeRefreshTimer) {
            this.treeRefreshTimer = window.setInterval(() => {
                if (document.visibilityState !== 'visible') {
                    this.updateTreeAutoRefresh();
                    return;
                }
                const hasVisibleTrees = Array.from(
                    state.sessions.values()
                ).some((session) => this.canRefreshSessionTree(session));
                if (!hasVisibleTrees) {
                    this.updateTreeAutoRefresh();
                    return;
                }
                this.refreshVisibleSessionTrees();
            }, FILE_TREE_REFRESH_INTERVAL_MS);
            return;
        }
        if (!shouldRun && this.treeRefreshTimer) {
            window.clearInterval(this.treeRefreshTimer);
            this.treeRefreshTimer = null;
        }
    }

    setSelectedTreePath(session, path, { preserveFocus = false } = {}) {
        if (!session) return;
        const nextPath = typeof path === 'string' ? path : '';
        if (session.selectedTreePath === nextPath) return;
        session.selectedTreePath = nextPath;
        if (preserveFocus && nextPath) {
            session.pendingTreeFocusPath = nextPath;
        }
        if (this.isSessionTreeVisible(session)) {
            this.syncSelectedTreePath(session);
        }
    }

    syncSelectedTreePath(session) {
        if (!session?.fileTreeElement) return;
        const selectedPath = session.selectedTreePath || '';
        Array.from(
            session.fileTreeElement.querySelectorAll('.file-tree-item')
        ).forEach((row) => {
            const rowPath = row.parentElement?.dataset.path || '';
            row.classList.toggle(
                'selected',
                selectedPath.length > 0 && rowPath === selectedPath
            );
        });
    }

    getVisibleTreeRows(session) {
        if (!session?.fileTreeElement) return [];
        return Array.from(
            session.fileTreeElement.querySelectorAll('li > .file-tree-item')
        ).filter((row) => row instanceof HTMLElement);
    }

    getDomSelectedTreePath(session) {
        return session?.fileTreeElement?.querySelector(
            '.file-tree-item.selected'
        )?.parentElement?.dataset.path || '';
    }

    moveTreeSelection(session, delta) {
        if (!session || !delta) return false;
        const rows = this.getVisibleTreeRows(session);
        if (rows.length === 0) return false;

        const currentPath = this.getDomSelectedTreePath(session)
            || session.selectedTreePath
            || session.editorState.activeFilePath
            || '';
        let currentIndex = rows.findIndex(
            (row) => row.parentElement?.dataset.path === currentPath
        );
        if (currentIndex === -1) {
            currentIndex = delta > 0 ? -1 : rows.length;
        }

        const nextIndex = Math.max(
            0,
            Math.min(rows.length - 1, currentIndex + delta)
        );
        const nextRow = rows[nextIndex];
        const nextPath = nextRow?.parentElement?.dataset.path || '';
        if (!nextPath) return false;

        this.setSelectedTreePath(session, nextPath, { preserveFocus: true });
        nextRow.scrollIntoView({ block: 'nearest' });
        session.fileTreeElement?.focus({ preventScroll: true });
        return true;
    }

    beginSelectedTreeRename(session) {
        if (!session) return false;
        const selectedPath = this.getDomSelectedTreePath(session)
            || session.selectedTreePath
            || '';
        if (!selectedPath) return false;

        const item = session.fileTreeElement?.querySelector(
            `li[data-path="${CSS.escape(selectedPath)}"]`
        );
        const row = item?.querySelector('.file-tree-item');
        const nameEl = row?.querySelector('.file-tree-name');
        if (
            !item
            || !row
            || !nameEl
            || item.dataset.renameable !== '1'
        ) {
            return false;
        }

        const renameButton = row.querySelector('.file-tree-rename-btn');
        if (
            renameButton instanceof HTMLButtonElement
            && !renameButton.disabled
        ) {
            renameButton.click();
            return true;
        }

        this.beginTreeRename(session, {
            path: selectedPath,
            name: nameEl.textContent || '',
            isDirectory: item.dataset.isDirectory === '1',
            renameable: true
        });
        return true;
    }

    async deleteSelectedTreeEntry(session) {
        if (!session) return false;
        const selectedPath = this.getDomSelectedTreePath(session)
            || session.selectedTreePath
            || '';
        if (!selectedPath) return false;

        const item = session.fileTreeElement?.querySelector(
            `li[data-path="${CSS.escape(selectedPath)}"]`
        );
        const row = item?.querySelector('.file-tree-item');
        const nameEl = row?.querySelector('.file-tree-name');
        if (
            !item
            || !row
            || !nameEl
            || item.dataset.deleteable !== '1'
        ) {
            return false;
        }

        await this.deleteTreeEntry(session, {
            path: selectedPath,
            name: nameEl.textContent || '',
            isDirectory: item.dataset.isDirectory === '1',
            deleteable: true
        });
        return true;
    }

    async createTreeEntry(session, parentPath, kind) {
        if (!session || typeof parentPath !== 'string' || !parentPath) {
            return;
        }

        try {
            const response = await session.server.fetch('/api/fs/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parentPath,
                    kind
                })
            });
            if (!response.ok) {
                await throwResponseError(response, 'Failed to create path');
            }

            const payload = await response.json();
            if (
                parentPath !== '.'
                && !session.sharedWorkspaceState.expandedPaths.includes(parentPath)
            ) {
                session.sharedWorkspaceState.expandedPaths =
                    uniqueStringList([
                        ...session.sharedWorkspaceState.expandedPaths,
                        parentPath
                    ]);
                session.saveState({ touchWorkspace: true });
                void session.server.fetch('/api/memory/expand', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: parentPath,
                        expanded: true
                    })
                });
            }

            this.beginTreeRename(session, {
                path: payload.path,
                name: payload.name,
                isDirectory: !!payload.isDirectory,
                renameable: true
            });
        } catch (_error) {
            alert(error.message || 'Failed to create path', {
                type: 'error',
                title: 'Files'
            });
        }
    }

    cancelTreeRename(session) {
        if (!session || !session.treeEditingPath) return;
        session.treeEditingPath = '';
        session.treeRenameSubmitting = false;
        session.pendingTreeRenameFocusPath = '';
        if (this.isSessionTreeVisible(session)) {
            this.requestSessionTreeRefresh(session);
        }
    }

    beginTreeRename(session, file) {
        if (!session || !file?.renameable) return;
        session.selectedTreePath = file.path;
        session.pendingTreeFocusPath = '';
        session.treeEditingPath = file.path;
        session.treeRenameSubmitting = false;
        session.pendingTreeRenameFocusPath = file.path;
        this.requestSessionTreeRefresh(session, { force: true });
    }

    async deleteTreeEntry(session, file) {
        if (!session || !file?.deleteable) {
            return;
        }
        const confirmed = await showConfirmModal({
            title: file.isDirectory
                ? '⚠️ Delete Folder'
                : '⚠️ Delete File',
            message: file.isDirectory
                ? `Delete folder "${file.name}" and all of its contents?`
                : `Delete file "${file.name}"?`,
            note: 'ℹ️ Deleted items do not go to the Trash.',
            confirmLabel: 'Delete',
            danger: true,
            returnFocus: session.fileTreeElement
        });
        if (!confirmed) {
            session.fileTreeElement?.focus({ preventScroll: true });
            return;
        }

        try {
            const response = await session.server.fetch('/api/fs/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: file.path
                })
            });
            if (!response.ok) {
                await throwResponseError(response, 'Failed to delete path');
            }
            const payload = await response.json();
            session.selectedTreePath = '';
            session.pendingTreeFocusPath = '';
            session.pendingTreeRenameFocusPath = '';
            session.treeEditingPath = '';
            this.handleDeletedPaths(
                session.server,
                payload.path || file.path,
                !!payload.isDirectory
            );
            this.requestSessionTreeRefresh(session);
            session.fileTreeElement?.focus({ preventScroll: true });
        } catch (_error) {
            alert(error.message || 'Failed to delete path', {
                type: 'error',
                title: 'Files'
            });
        }
    }

    async commitTreeRename(session, file, nextName) {
        if (!session || !file || typeof nextName !== 'string') {
            return;
        }
        if (nextName.length === 0) {
            return;
        }
        if (nextName === file.name) {
            this.cancelTreeRename(session);
            this.focusTreePath(session, file.path);
            return;
        }

        session.treeRenameSubmitting = true;
        try {
            const response = await session.server.fetch('/api/fs/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: file.path,
                    newName: nextName
                })
            });
            if (!response.ok) {
                if (response.status === 409) {
                    let message = 'A file or folder with that name already exists.';
                    try {
                        const payload = await response.json();
                        if (payload?.error) {
                            message = payload.error;
                        }
                    } catch {
                        // Ignore invalid JSON error bodies.
                    }
                    await showConfirmModal({
                        title: 'Rename Failed',
                        message,
                        confirmLabel: 'OK',
                        hideCancel: true
                    });
                    session.treeRenameSubmitting = false;
                    requestAnimationFrame(() => {
                        const renameInput = session.fileTreeElement?.querySelector(
                            '.file-tree-rename-input'
                        );
                        if (renameInput instanceof HTMLInputElement) {
                            renameInput.focus({ preventScroll: true });
                            renameInput.setSelectionRange(
                                0,
                                renameInput.value.length
                            );
                        }
                    });
                    return;
                }
                await throwResponseError(response, 'Failed to rename path');
            }
            const payload = await response.json();
            session.treeEditingPath = '';
            session.treeRenameSubmitting = false;
            session.pendingTreeRenameFocusPath = '';
            session.selectedTreePath = payload.newPath || file.path;
            session.pendingTreeFocusPath = payload.newPath || file.path;
            this.handleRenamedPaths(
                session.server,
                file.path,
                payload.newPath || file.path,
                !!payload.isDirectory
            );
            this.requestSessionTreeRefresh(session);
            this.focusTreePath(session, session.pendingTreeFocusPath);
        } catch (error) {
            session.treeRenameSubmitting = false;
            this.cancelTreeRename(session);
            alert(error.message || 'Failed to rename path', {
                type: 'error',
                title: 'Files'
            });
        }
    }

    ensureTreeList(container) {
        const existing = Array.from(container.children).find(
            (child) => child.tagName === 'UL'
        );
        if (existing) return existing;
        const list = document.createElement('ul');
        container.appendChild(list);
        return list;
    }

    getTreeChildList(item) {
        return Array.from(item.children).find((child) => child.tagName === 'UL')
            || null;
    }

    getTreeItemExpanded(filePath, session) {
        return session.sharedWorkspaceState.expandedPaths.includes(filePath);
    }

    updateTreeCreateRow(list, dirPath, creatable, session) {
        let row = Array.from(list.children).find(
            (child) => child.classList?.contains('file-tree-create-entry')
        );

        if (!creatable) {
            row?.remove();
            return;
        }

        if (!row) {
            row = document.createElement('li');
            row.className = 'file-tree-create-entry';

            const actions = document.createElement('div');
            actions.className = 'file-tree-create-actions';

            const newFolderButton = document.createElement('button');
            newFolderButton.type = 'button';
            newFolderButton.className = 'file-tree-new-folder-btn';
            newFolderButton.title = 'New Folder';
            newFolderButton.innerHTML = NEW_FOLDER_ICON_SVG;
            actions.appendChild(newFolderButton);

            const newFileButton = document.createElement('button');
            newFileButton.type = 'button';
            newFileButton.className = 'file-tree-new-file-btn';
            newFileButton.title = 'New File';
            newFileButton.innerHTML = NEW_FILE_ICON_SVG;
            actions.appendChild(newFileButton);

            row.appendChild(actions);
        }

        const newFolderButton = row.querySelector('.file-tree-new-folder-btn');
        const newFileButton = row.querySelector('.file-tree-new-file-btn');

        if (newFolderButton instanceof HTMLButtonElement) {
            newFolderButton.setAttribute(
                'aria-label',
                `New folder in ${dirPath}`
            );
            newFolderButton.onmousedown = (event) => {
                event.preventDefault();
                event.stopPropagation();
            };
            newFolderButton.onclick = (event) => {
                event.stopPropagation();
                void this.createTreeEntry(session, dirPath, 'directory');
            };
        }

        if (newFileButton instanceof HTMLButtonElement) {
            newFileButton.setAttribute('aria-label', `New file in ${dirPath}`);
            newFileButton.onmousedown = (event) => {
                event.preventDefault();
                event.stopPropagation();
            };
            newFileButton.onclick = (event) => {
                event.stopPropagation();
                void this.createTreeEntry(session, dirPath, 'file');
            };
        }

        list.appendChild(row);
    }

    updateTreeItem(li, file, session, renderToken) {
        li.dataset.path = file.path;
        li.dataset.isDirectory = file.isDirectory ? '1' : '0';
        li.dataset.renameable = file.renameable ? '1' : '0';
        li.dataset.deleteable = file.deleteable ? '1' : '0';

        let row = Array.from(li.children).find(
            (child) => child.classList?.contains('file-tree-item')
        );
        if (!row) {
            row = document.createElement('div');
            row.className = 'file-tree-item';
            li.prepend(row);
        }
        row.tabIndex = -1;

        let icon = row.querySelector('.icon');
        if (!icon) {
            icon = document.createElement('span');
            icon.className = 'icon';
            row.appendChild(icon);
        }

        let renameButton = row.querySelector('.file-tree-rename-btn');
        if (!renameButton) {
            renameButton = document.createElement('button');
            renameButton.type = 'button';
            renameButton.className = 'file-tree-rename-btn';
            renameButton.title = 'Rename';
            renameButton.setAttribute('aria-label', `Rename ${file.name}`);
            renameButton.innerHTML = RENAME_ICON_SVG;
            row.appendChild(renameButton);
        }

        let deleteButton = row.querySelector('.file-tree-delete-btn');
        if (!deleteButton) {
            deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'file-tree-delete-btn';
            deleteButton.title = 'Delete';
            deleteButton.setAttribute('aria-label', `Delete ${file.name}`);
            deleteButton.innerHTML = DELETE_ICON_SVG;
            row.appendChild(deleteButton);
        }

        let name = row.querySelector('.file-tree-name');
        if (!name) {
            name = document.createElement('span');
            name.className = 'file-tree-name';
            row.appendChild(name);
        }

        let renameInput = row.querySelector('.file-tree-rename-input');
        const isEditing = session.treeEditingPath === file.path;
        if (isEditing && !renameInput) {
            renameInput = document.createElement('input');
            renameInput.type = 'text';
            renameInput.className = 'file-tree-rename-input';
            row.appendChild(renameInput);
        } else if (!isEditing && renameInput) {
            renameInput.remove();
            renameInput = null;
        }

        row.className = 'file-tree-item';
        if (file.isDirectory) {
            row.classList.add('is-dir');
        }
        row.classList.toggle(
            'active',
            !file.isDirectory
            && session.editorState.activeFilePath === file.path
        );
        row.classList.toggle(
            'selected',
            session.selectedTreePath === file.path
        );
        row.classList.toggle('editing', isEditing);

        const isExpanded = file.isDirectory
            && this.getTreeItemExpanded(file.path, session);
        li.classList.toggle('expanded', isExpanded);
        icon.innerHTML = this.getIcon(file.name, file.isDirectory, isExpanded);
        name.textContent = file.name;
        name.style.display = isEditing ? 'none' : '';
        renameButton.style.display = isEditing ? 'none' : '';
        deleteButton.style.display = isEditing ? 'none' : '';
        renameButton.hidden = !file.renameable;
        renameButton.disabled = !file.renameable;
        renameButton.title = `Rename ${file.name}`;
        renameButton.setAttribute('aria-label', `Rename ${file.name}`);
        renameButton.onmousedown = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        renameButton.onclick = (event) => {
            event.stopPropagation();
            this.beginTreeRename(session, file);
        };

        deleteButton.hidden = !file.deleteable;
        deleteButton.disabled = !file.deleteable;
        deleteButton.title = `Delete ${file.name}`;
        deleteButton.setAttribute('aria-label', `Delete ${file.name}`);
        deleteButton.onmousedown = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        deleteButton.onclick = (event) => {
            event.stopPropagation();
            void this.deleteTreeEntry(session, file);
        };

        if (renameInput) {
            if (document.activeElement !== renameInput) {
                renameInput.value = file.name;
            }
            renameInput.onkeydown = async (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.cancelTreeRename(session);
                    this.focusTreePath(session, file.path);
                    return;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    await this.commitTreeRename(
                        session,
                        file,
                        renameInput.value
                    );
                }
            };
            renameInput.onmousedown = (event) => {
                event.stopPropagation();
            };
            renameInput.onclick = (event) => {
                event.stopPropagation();
            };
            renameInput.onfocus = (event) => {
                event.stopPropagation();
            };
            renameInput.onblur = () => {
                if (!session.treeRenameSubmitting) {
                    this.cancelTreeRename(session);
                }
            };

            if (session.pendingTreeRenameFocusPath === file.path) {
                session.pendingTreeRenameFocusPath = '';
                requestAnimationFrame(() => {
                    renameInput.focus({ preventScroll: true });
                    renameInput.setSelectionRange(
                        0,
                        renameInput.value.length
                    );
                });
            }
        }

        row.onclick = async (e) => {
            e.stopPropagation();
            if (e.target.closest('.file-tree-rename-btn')) {
                return;
            }
            if (e.target.closest('.file-tree-delete-btn')) {
                return;
            }
            if (e.target.closest('.file-tree-rename-input')) {
                return;
            }
            this.setSelectedTreePath(session, file.path, {
                preserveFocus: true
            });
            session.fileTreeElement?.focus({ preventScroll: true });
            if (file.isDirectory) {
                if (li.classList.contains('expanded')) {
                    li.classList.remove('expanded');
                    session.sharedWorkspaceState.expandedPaths =
                        session.sharedWorkspaceState.expandedPaths
                            .filter((path) => path !== file.path);
                    session.saveState({ touchWorkspace: true });
                    void session.server.fetch('/api/memory/expand', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            path: file.path,
                            expanded: false
                        })
                    });
                    icon.innerHTML = this.getIcon(file.name, true, false);
                    const childUl = this.getTreeChildList(li);
                    if (childUl) {
                        childUl.remove();
                    }
                    this.updateTreeAutoRefresh();
                    return;
                }

                li.classList.add('expanded');
                session.sharedWorkspaceState.expandedPaths =
                    uniqueStringList([
                        ...session.sharedWorkspaceState.expandedPaths,
                        file.path
                    ]);
                session.saveState({ touchWorkspace: true });
                void session.server.fetch('/api/memory/expand', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: file.path,
                        expanded: true
                    })
                });

                icon.innerHTML = this.getIcon(file.name, true, true);
                await this.renderTree(file.path, li, session, renderToken);
                this.updateTreeAutoRefresh();
                session.fileTreeElement?.focus({ preventScroll: true });
                return;
            }

            await this.openFile(file.path, session, {
                focusEditor: false
            });
            this.focusTreePath(session, file.path);
            session.pendingTreeFocusPath = file.path;
            this.requestSessionTreeRefresh(session);
        };

        row.onmousedown = (event) => {
            if (
                event.target.closest('.file-tree-rename-btn')
                || event.target.closest('.file-tree-delete-btn')
                || event.target.closest('.file-tree-rename-input')
            ) {
                return;
            }
            event.preventDefault();
            session.fileTreeElement?.focus({ preventScroll: true });
        };

        row.onkeydown = null;

        if (!isExpanded) {
            const childUl = this.getTreeChildList(li);
            if (childUl) {
                childUl.remove();
            }
        }

        if (session.pendingTreeFocusPath === file.path) {
            session.pendingTreeFocusPath = '';
            requestAnimationFrame(() => {
                row.scrollIntoView({ block: 'nearest' });
                session.fileTreeElement?.focus({ preventScroll: true });
            });
        }
    }

    reconcileTreeList(list, dirPath, files, creatable, session, renderToken) {
        const existingItems = new Map();
        Array.from(list.children).forEach((child) => {
            if (child.tagName === 'LI' && child.dataset.path) {
                existingItems.set(child.dataset.path, child);
            }
        });

        const orderedItems = [];
        for (const file of files) {
            let li = existingItems.get(file.path) || null;
            if (!li) {
                li = document.createElement('li');
            } else {
                existingItems.delete(file.path);
            }
            this.updateTreeItem(li, file, session, renderToken);
            orderedItems.push(li);
        }

        for (const li of existingItems.values()) {
            li.remove();
        }

        for (const li of orderedItems) {
            list.appendChild(li);
        }

        this.updateTreeCreateRow(list, dirPath, creatable, session);
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
                if (this.suppressFileWriteCapture) return;
                if (!this.currentSession) return;
                const filePath = this.currentSession.editorState.activeFilePath;
                if (!filePath) return;
                const entry = this.getTextFileEntry(filePath, this.currentSession);
                if (!entry) return;
                const nextContent = this.editor.getValue();
                if (
                    nextContent === (entry.content || '')
                    && (entry.contentVersion || '') === (entry.version || '')
                ) {
                    this.clearPendingFileWrite(this.currentSession.key, filePath);
                    return;
                }
                entry.lastDismissedRemoteVersion = '';
                this.queuePendingFileWrite(
                    this.currentSession,
                    filePath,
                    nextContent
                );
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

    clearPdfPreview(preserveDocument = false) {
        const state = this.pdfPreviewState;
        state.renderToken += 1;
        clearTimeout(state.relayoutTimer);
        state.relayoutTimer = 0;
        if (!preserveDocument) {
            const documentRef = state.document;
            state.document = null;
            state.loadingTask = null;
            state.path = '';
            state.sessionKey = '';
            state.metadata = '';
            state.renderedWidth = 0;
            if (documentRef && typeof documentRef.destroy === 'function') {
                Promise.resolve(documentRef.destroy()).catch(() => {});
            }
        }
        if (this.pdfPreviewPages) {
            this.pdfPreviewPages.innerHTML = '';
        }
        this.setPdfPreviewStatus('', '');
    }

    hidePdfPreview() {
        this.pdfPreviewContainer.style.display = 'none';
    }

    getPdfPreviewUrl(filePath, session = this.currentSession) {
        if (!session) return '';
        return session.server.resolveUrl(
            `/api/fs/raw?path=${encodeURIComponent(filePath)}`
            + `&token=${session.server.token}`
        );
    }

    getPdfPreviewTargetWidth() {
        if (!this.pdfPreviewPages) {
            return 0;
        }
        const width = this.pdfPreviewPages.clientWidth - 36;
        return Math.max(240, Math.floor(Math.min(width, 960)));
    }

    setPdfPreviewStatus(primary = '', secondary = '') {
        const nextPrimary = String(primary || '').trim();
        const nextSecondary = String(secondary || '').trim();
        if (this.pdfPreviewStatusPrimary) {
            this.pdfPreviewStatusPrimary.textContent = nextPrimary;
        }
        if (this.pdfPreviewStatusSecondary) {
            this.pdfPreviewStatusSecondary.textContent = nextSecondary;
            this.pdfPreviewStatusSecondary.title = nextSecondary;
        }
        if (this.pdfPreviewStatus) {
            this.pdfPreviewStatus.classList.toggle(
                'is-empty',
                !nextPrimary && !nextSecondary
            );
        }
    }

    formatPdfByteSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            return '';
        }
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const decimals = value >= 100 || unitIndex === 0 ? 0 : 1;
        return `${value.toFixed(decimals)} ${units[unitIndex]}`;
    }

    describePdfPageSize(viewport) {
        if (!viewport) {
            return '';
        }
        const width = Math.min(viewport.width, viewport.height);
        const height = Math.max(viewport.width, viewport.height);
        const near = (targetWidth, targetHeight) => (
            Math.abs(width - targetWidth) < 2
            && Math.abs(height - targetHeight) < 2
        );
        if (near(595.276, 841.89)) return 'A4';
        if (near(612, 792)) return 'Letter';
        return '';
    }

    async loadPdfMetadata(documentRef) {
        const parts = [];
        try {
            const meta = await documentRef.getMetadata();
            const version = String(meta?.info?.PDFFormatVersion || '').trim();
            parts.push(version ? `PDF ${version}` : 'PDF');
        } catch {
            parts.push('PDF');
        }

        try {
            const firstPage = await documentRef.getPage(1);
            const pageSize = this.describePdfPageSize(
                firstPage.getViewport({ scale: 1 })
            );
            if (pageSize) {
                parts.push(pageSize);
            }
        } catch {
            // Ignore optional page-size metadata failures.
        }

        try {
            const downloadInfo = await documentRef.getDownloadInfo();
            const byteSize = this.formatPdfByteSize(downloadInfo?.length);
            if (byteSize) {
                parts.push(byteSize);
            }
        } catch {
            // Ignore optional size metadata failures.
        }

        return parts.join(' · ');
    }

    schedulePdfPreviewRelayout() {
        const state = this.pdfPreviewState;
        if (
            !this.pdfPreviewContainer
            || this.pdfPreviewContainer.style.display === 'none'
            || !state.document
            || !state.path
        ) {
            return;
        }
        clearTimeout(state.relayoutTimer);
        state.relayoutTimer = window.setTimeout(() => {
            const nextWidth = this.getPdfPreviewTargetWidth();
            if (
                nextWidth > 0
                && Math.abs(nextWidth - state.renderedWidth) > 24
            ) {
                void this.renderPdfPreview(state.path);
            }
        }, 120);
    }

    async loadPdfDocument(filePath, session, renderToken) {
        const state = this.pdfPreviewState;
        const url = this.getPdfPreviewUrl(filePath, session);
        const pdfjsLib = await loadPdfJs();
        if (state.renderToken !== renderToken) {
            return null;
        }

        let loadingTask = pdfjsLib.getDocument({
            url
        });
        state.loadingTask = loadingTask;
        try {
            return await loadingTask.promise;
        } catch (_error) {
            if (state.renderToken !== renderToken) {
                return null;
            }
            loadingTask = pdfjsLib.getDocument({
                url,
                disableWorker: true
            });
            state.loadingTask = loadingTask;
            return await loadingTask.promise;
        }
    }

    async renderPdfPreview(filePath) {
        const session = this.currentSession;
        if (!session || !filePath) {
            return;
        }
        const state = this.pdfPreviewState;
        const renderToken = state.renderToken + 1;
        const targetSessionKey = session.key;
        const nextWidth = this.getPdfPreviewTargetWidth();
        if (nextWidth <= 0) {
            requestAnimationFrame(() => {
                if (
                    this.currentSession?.key === targetSessionKey
                    && this.currentSession?.editorState.activeFilePath === filePath
                ) {
                    void this.renderPdfPreview(filePath);
                }
            });
            return;
        }

        if (
            state.path !== filePath
            || state.sessionKey !== targetSessionKey
        ) {
            this.clearPdfPreview();
        } else {
            this.clearPdfPreview(true);
        }
        state.renderToken = renderToken;
        state.path = filePath;
        state.sessionKey = targetSessionKey;
        this.setPdfPreviewStatus('Loading PDF…', '');

        try {
            let documentRef = state.document;
            if (!documentRef) {
                documentRef = await this.loadPdfDocument(
                    filePath,
                    session,
                    renderToken
                );
                if (!documentRef || state.renderToken !== renderToken) {
                    return;
                }
                state.document = documentRef;
                state.metadata = await this.loadPdfMetadata(documentRef);
                if (state.renderToken !== renderToken) {
                    return;
                }
            }

            state.renderedWidth = nextWidth;
            if (this.pdfPreviewPages) {
                this.pdfPreviewPages.innerHTML = '';
            }
            const pageCount = documentRef.numPages;
            this.setPdfPreviewStatus(
                `${pageCount} page${pageCount === 1 ? '' : 's'}`,
                state.metadata || 'PDF'
            );

            for (let pageNumber = 1; pageNumber <= documentRef.numPages; pageNumber += 1) {
                if (state.renderToken !== renderToken) {
                    return;
                }
                const page = await documentRef.getPage(pageNumber);
                if (state.renderToken !== renderToken) {
                    return;
                }
                const baseViewport = page.getViewport({ scale: 1 });
                const scale = nextWidth / baseViewport.width;
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d', {
                    alpha: false
                });
                if (!context) {
                    throw new Error('Failed to create PDF canvas context');
                }
                const outputScale = Math.max(1, window.devicePixelRatio || 1);
                canvas.width = Math.ceil(viewport.width * outputScale);
                canvas.height = Math.ceil(viewport.height * outputScale);
                canvas.style.width = `${Math.ceil(viewport.width)}px`;
                canvas.style.height = `${Math.ceil(viewport.height)}px`;
                context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
                const textLayer = document.createElement('div');
                textLayer.className = 'textLayer';
                const sheet = document.createElement('div');
                sheet.className = 'pdf-preview-sheet';
                sheet.style.width = `${Math.ceil(viewport.width)}px`;
                sheet.style.height = `${Math.ceil(viewport.height)}px`;
                sheet.style.setProperty('--user-unit', '1');
                sheet.style.setProperty('--scale-factor', String(scale));
                sheet.style.setProperty(
                    '--total-scale-factor',
                    String(scale)
                );
                sheet.style.setProperty('--scale-round-x', '1px');
                sheet.style.setProperty('--scale-round-y', '1px');
                await page.render({
                    canvasContext: context,
                    viewport
                }).promise;
                if (state.renderToken !== renderToken) {
                    return;
                }
                const textContent = await page.getTextContent();
                if (state.renderToken !== renderToken) {
                    return;
                }
                const textLayerBuilder = new pdfjsLib.TextLayer({
                    textContentSource: textContent,
                    container: textLayer,
                    viewport
                });
                await textLayerBuilder.render();
                if (state.renderToken !== renderToken) {
                    return;
                }
                const wrapper = document.createElement('div');
                wrapper.className = 'pdf-preview-page';
                wrapper.dataset.pageNumber = String(pageNumber);
                sheet.appendChild(canvas);
                sheet.appendChild(textLayer);
                wrapper.appendChild(sheet);
                this.pdfPreviewPages?.appendChild(wrapper);
            }
        } catch (error) {
            console.error('Failed to render PDF preview:', error);
            if (state.renderToken !== renderToken) {
                return;
            }
            this.clearPdfPreview();
            this.hidePdfPreview();
            alert(
                `Failed to load PDF: ${filePath.split('/').pop()}`,
                {
                    type: 'error',
                    title: 'PDF Preview Error'
                }
            );
            this.closeFile(filePath);
        }
    }

    updateEditorPaneVisibility() {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;
        const hasOpenFiles = state.openFiles.length > 0;
        const hasAgentTabs = getAgentTabsForSession(this.currentSession).length > 0;
        const compact = this.hasCompactWorkspaceTabs(this.currentSession);
        const hasTabs = compact || hasOpenFiles || hasAgentTabs;
        const shouldShow = hasTabs;

        this.tabsContainer.style.display = hasTabs ? 'flex' : 'none';
        this.pane.style.display = shouldShow ? 'flex' : 'none';
        this.resizer.style.display = shouldShow && !compact ? 'flex' : 'none';
        this.syncTerminalWorkspacePlacement();
        
        if (shouldShow) {
            this.layout();
        } else {
            if (this.currentSession) {
                requestAnimationFrame(() => {
                    this.currentSession.fitMainTerminalIfVisible();
                });
            }
        }

        this.updateTerminalLayoutButton();
    }

    toggle(session = this.currentSession) {
        if (!session) return;
        const isCurrentSession = this.currentSession?.key === session.key;
        const state = session.editorState;
        state.isVisible = !state.isVisible;
        
        const tab = document.querySelector(
            `.tab-item[data-session-key="${session.key}"]`
        );
        if (tab) {
            if (state.isVisible) tab.classList.add('editor-open');
            else tab.classList.remove('editor-open');
        }
        
        if (state.isVisible) {
            // Only render if empty (first open)
            if (
                session.fileTreeElement
                && session.fileTreeElement.children.length === 0
            ) {
                this.refreshSessionTree(session);
            }
        } else if (session.fileTreeElement) {
            session.fileTreeElement.innerHTML = '';
        }

        if (isCurrentSession) {
            this.renderEditorTabs();
            const activeKey = this.getActiveWorkspaceTabKey(session);
            if (activeKey) {
                this.activateWorkspaceTab(activeKey, true);
            }
            if (this.hasCompactWorkspaceTabs(session)) {
                this.renderEditorTabs();
                const compactActiveKey = this.getActiveWorkspaceTabKey(session);
                if (compactActiveKey) {
                    this.activateWorkspaceTab(compactActiveKey, true);
                }
            }
            this.updateEditorPaneVisibility();
        }

        this.updateTreeAutoRefresh();
        session.updateTabUI();
        session.saveState({ touchWorkspace: true });
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
            this.updateTerminalLayoutButton();
            return;
        }

        const state = session.editorState;

        // Only render tabs and content, file tree is persistent in sidebar
        const shouldShowWorkspace = this.hasVisibleWorkspaceTabs(session);
        if (shouldShowWorkspace) {
            if (state.isVisible) {
                this.refreshSessionTree(session);
            }
            this.renderEditorTabs();
            const activeKey = this.getActiveWorkspaceTabKey(session);
            if (activeKey) {
                this.activateWorkspaceTab(activeKey, true);
            }
        }
        
        this.updateEditorPaneVisibility();
        this.updateTerminalLayoutButton();
        this.updateTreeAutoRefresh();
        
        // Restore layout
        if (session.layoutState) {
            this.pane.style.flex = session.layoutState.editorFlex;
        } else {
            this.pane.style.flex = '2 1 0%';
        }
    }

    layout() {
        // console.log('[Editor] layout called');
        if (!this.currentSession) return;
        this.currentSession.fitMainTerminalIfVisible();
        if (this.editor && this.pane.style.display !== 'none') {
            const width = this.pane.clientWidth;
            const height = this.pane.clientHeight - 35; // Subtract fixed safety margin
            
            if (width > 0 && height > 0) {
                this.editor.layout({ width, height });
            } else {
                this.editor.layout();
            }
        }
        this.schedulePdfPreviewRelayout();
    }

    async renderTree(
        dirPath,
        container,
        session,
        renderToken = session?.fileTreeRenderToken || 0
    ) {
        try {
            const res = await session.server.fetch(
                `/api/fs/list?path=${encodeURIComponent(dirPath)}`
            );
            if (!res.ok) return;
            const payload = await res.json();
            const files = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.items)
                    ? payload.items
                    : [];
            const creatable = Array.isArray(payload)
                ? false
                : !!payload?.creatable;
            if ((session.fileTreeRenderToken || 0) !== renderToken) return;

            const list = this.ensureTreeList(container);
            this.reconcileTreeList(
                list,
                dirPath,
                files,
                creatable,
                session,
                renderToken
            );
            if ((session.fileTreeRenderToken || 0) !== renderToken) return;

            for (const file of files) {
                if (
                    file.isDirectory
                    && this.getTreeItemExpanded(file.path, session)
                ) {
                    const item = Array.from(list.children).find(
                        (child) => child.dataset.path === file.path
                    );
                    if (item) {
                        void this.renderTree(file.path, item, session, renderToken);
                    }
                }
            }
        } catch (err) {
            console.error('Failed to render tree:', err);
        }
    }

    async openFile(
        filePath,
        sessionOrRestore = this.currentSession,
        options = {}
    ) {
        const session = typeof sessionOrRestore === 'boolean'
            ? this.currentSession
            : sessionOrRestore;
        if (!session) return;
        if (this.currentSession?.key !== session.key) {
            await switchToSession(session.key);
        }
        const targetSession = this.currentSession?.key === session.key
            ? this.currentSession
            : session;
        if (!targetSession) return;
        const state = targetSession.editorState;
        const wasOpen = state.openFiles.includes(filePath);
        const isImage = isSupportedImagePath(filePath);
        const isPdf = isSupportedPdfPath(filePath);

        if (!this.getModel(filePath, targetSession)) {
            let model = null;
            let content = null;
            let readonly = false;
            let version = '';
            let size = 0;
            let mtimeMs = 0;

            if (!isImage && !isPdf) {
                try {
                    const data = await this.readTextFileSnapshot(
                        targetSession,
                        filePath
                    );
                    content = data.content;
                    readonly = data.readonly;
                    version = typeof data.version === 'string'
                        ? data.version
                        : '';
                    size = Number.isFinite(data.size) ? data.size : 0;
                    mtimeMs = Number.isFinite(data.mtimeMs)
                        ? data.mtimeMs
                        : 0;
                    
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
                    if (err?.message === 'Unsupported file type') {
                        await showConfirmModal({
                            title: 'Unsupported File Type',
                            message: 'This file type is not supported yet.',
                            note: 'Only text files, supported images, and PDFs can be opened right now.',
                            confirmLabel: 'OK',
                            hideCancel: true,
                            returnFocus: document.activeElement
                        });
                        return;
                    }
                    alert(`Failed to open file: ${err.message}`, { type: 'error', title: 'Error' });
                    this.closeFile(filePath);
                    return;
                }
            }

            this.setModel(filePath, {
                type: isImage ? 'image' : isPdf ? 'pdf' : 'text',
                model: model,
                content: content,
                readonly: readonly,
                version,
                contentVersion: version,
                size,
                mtimeMs,
                lastDismissedRemoteVersion: ''
            }, targetSession);
        }

        let touchedWorkspace = false;
        if (!wasOpen) {
            state.openFiles.push(filePath);
            this.renderEditorTabs();
            touchedWorkspace = true;
        }
        
        this.updateEditorPaneVisibility();

        this.activateFileTab(filePath, false, options);
        if (touchedWorkspace) {
            targetSession.saveState({ touchWorkspace: true });
        }
    }

    closeFile(filePath) {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;

        const index = state.openFiles.indexOf(filePath);
        let touchedWorkspace = false;
        if (index > -1) {
            state.openFiles.splice(index, 1);
            touchedWorkspace = true;
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
                } else if (this.hasCompactWorkspaceTabs(this.currentSession)) {
                    this.activateTerminalTab();
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
        if (touchedWorkspace) {
            this.currentSession.saveState({ touchWorkspace: true });
        }
    }

    renderEditorTabs() {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;
        const activeWorkspaceTabKey = this.getActiveWorkspaceTabKey();

        this.tabsContainer.innerHTML = '';
        if (this.hasCompactWorkspaceTabs(this.currentSession)) {
            const tab = document.createElement('div');
            tab.className = 'editor-tab terminal-editor-tab';
            if (TERMINAL_WORKSPACE_TAB_KEY === activeWorkspaceTabKey) {
                tab.classList.add('active');
            }

            const icon = document.createElement('span');
            icon.className = 'agent-editor-tab-icon';
            applyStatusIconState(
                icon,
                TERMINAL_TAB_ICON_SVG,
                getSessionTerminalIndicatorState(this.currentSession)
            );

            const label = document.createElement('span');
            label.textContent = 'Terminal';

            tab.onclick = () => this.activateTerminalTab();
            bindSingleTapActivation(tab, () => this.activateTerminalTab());
            tab.appendChild(icon);
            tab.appendChild(label);
            this.tabsContainer.appendChild(tab);
        }

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
            const icon = document.createElement('span');
            icon.className = 'file-editor-tab-icon';
            icon.innerHTML = this.getIcon(name, false, false);

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
            bindSingleTapActivation(tab, () => this.activateFileTab(path), {
                ignoreSelector: '.close-btn'
            });
            
            tab.appendChild(icon);
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
            applyStatusIconState(
                icon,
                AGENT_ICON_SVG,
                getAgentTabIndicatorState(agentTab)
            );

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
            bindSingleTapActivation(tab, () => this.activateAgentTab(
                agentTab.key
            ), {
                ignoreSelector: '.close-btn'
            });

            tab.appendChild(icon);
            tab.appendChild(label);
            tab.appendChild(closeBtn);
            this.tabsContainer.appendChild(tab);
        }
    }

    activateWorkspaceTab(workspaceTabKey, isRestore = false) {
        if (isTerminalWorkspaceTabKey(workspaceTabKey)) {
            this.activateTerminalTab(isRestore);
            return;
        }
        if (isAgentWorkspaceTabKey(workspaceTabKey)) {
            this.activateAgentTab(workspaceTabKey, isRestore);
            return;
        }
        this.activateFileTab(workspaceKeyToFilePath(workspaceTabKey), isRestore);
    }

    activateTerminalTab(isRestore = false) {
        if (!this.currentSession) return;

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

        this.currentSession.workspaceState.activeTabKey =
            TERMINAL_WORKSPACE_TAB_KEY;
        this.currentSession.needsAttention = false;
        if (!isRestore) {
            this.currentSession.saveState();
        }
        this.renderEditorTabs();
        this.currentSession.updateTabUI();
        this.monacoContainer.style.display = 'none';
        this.imagePreviewContainer.style.display = 'none';
        this.hidePdfPreview();
        this.agentContainer.style.display = 'none';
        this.emptyState.style.display = 'none';
        this.syncTerminalWorkspacePlacement(TERMINAL_WORKSPACE_TAB_KEY);

        requestAnimationFrame(() => {
            if (this.currentSession.fitMainTerminalIfVisible()) {
                this.currentSession.mainTerm.focus();
            }
            this.currentSession.reportResize();
        });
    }

    activateFileTab(filePath, isRestore = false, options = {}) {
        if (!this.currentSession) return;
        if (!filePath) return;
        const focusEditor = options.focusEditor !== false;
        const state = this.currentSession.editorState;

        if (!isRestore && state.activeFilePath && state.activeFilePath !== filePath) {
            const currentGlobal = this.getModel(state.activeFilePath);
            if (currentGlobal && currentGlobal.type === 'text' && this.editor) {
                state.viewStates.set(state.activeFilePath, this.editor.saveViewState());
            }
        }

        state.activeFilePath = filePath;
        this.currentSession.workspaceState.activeTabKey = makeFileWorkspaceTabKey(filePath);
        this.currentSession.workspaceState.lastNonTerminalTabKey =
            makeFileWorkspaceTabKey(filePath);
        this.currentSession.saveState();
        const file = this.getModel(filePath);
        
        this.renderEditorTabs();
        this.emptyState.style.display = 'none';
        this.syncTerminalWorkspacePlacement();

        if (!file) {
            this.openFile(filePath, true, options);
            return;
        }

        if (file.type === 'image') {
            this.agentContainer.style.display = 'none';
            this.monacoContainer.style.display = 'none';
            this.imagePreviewContainer.style.display = 'flex';
            this.hidePdfPreview();
            
            this.imagePreview.onerror = () => {
                alert(`Failed to load image: ${filePath.split('/').pop()}`, { type: 'error', title: 'Error' });
                this.closeFile(filePath);
                this.imagePreview.onerror = null;
            };
            
            this.imagePreview.src = this.currentSession.server.resolveUrl(
                `/api/fs/raw?path=${encodeURIComponent(filePath)}&token=${this.currentSession.server.token}`
            );
        } else if (file.type === 'pdf') {
            this.agentContainer.style.display = 'none';
            this.monacoContainer.style.display = 'none';
            this.imagePreviewContainer.style.display = 'none';
            this.pdfPreviewContainer.style.display = 'flex';
            void this.renderPdfPreview(filePath);
        } else {
            this.agentContainer.style.display = 'none';
            this.imagePreviewContainer.style.display = 'none';
            this.hidePdfPreview();
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
                if (focusEditor) {
                    this.editor.focus();
                }
                // Force layout to ensure content is visible
                requestAnimationFrame(() => this.editor.layout());
            }
            void this.checkActiveFileVersion();
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
        this.currentSession.workspaceState.lastNonTerminalTabKey = agentTabKey;
        noteRecentAgentTab(this.currentSession, agentTabKey);
        agentTab.needsAttention = false;
        this.currentSession.saveState();
        this.renderEditorTabs();
        this.currentSession.updateTabUI();
        this.syncTerminalWorkspacePlacement(agentTabKey);
        this.monacoContainer.style.display = 'none';
        this.imagePreviewContainer.style.display = 'none';
        this.hidePdfPreview();
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
        this.disposeAgentEmbeddedEditors();
        const previousLayout = this.captureAgentTranscriptLayout();
        const previousScrollTop = previousLayout?.scrollTop || 0;
        const wasNearBottom = this.isAgentTranscriptLayoutNearBottom(
            previousLayout,
            36
        );
        this.agentHeader.textContent = '';
        this.agentMeta.textContent = '';
        this.renderAgentUsageHud(agentTab);
        this.renderAgentPlan(agentTab);

        const modelConfig = getAgentConfigOptionByCategory(agentTab, 'model');
        const thoughtConfig = getAgentConfigOptionByCategory(
            agentTab,
            'thought_level'
        );
        updateAgentConfigSelect(this.agentModelSelect, modelConfig);
        updateAgentConfigSelect(this.agentThoughtSelect, thoughtConfig);

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
                    this.setAgentPromptValue(
                        `/${command.name}${suffix}`,
                        agentTab
                    );
                };
                this.agentCommands.appendChild(button);
            }
            this.agentCommands.style.display = 'flex';
        } else {
            this.agentCommands.style.display = 'none';
        }

        this.renderAgentComposerAttachments(agentTab);

        this.agentTranscript.innerHTML = '';
        const timeline = getAgentTimelineItems(agentTab);
        if (timeline.length === 0) {
            this.agentTranscript.appendChild(
                this.buildAgentEmptyState(agentTab)
            );
        } else {
            for (const [index, entry] of timeline.entries()) {
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
                } else if (entry.type === 'plan') {
                    node = this.buildAgentPlanHistoryNode(
                        agentTab,
                        entry.value
                    );
                }
                if (node) {
                    if (
                        index > 0
                        && entry.type === 'message'
                        && String(entry.value?.role || '').toLowerCase()
                            === 'user'
                    ) {
                        node.classList.add('agent-turn-start');
                    }
                    this.agentTranscript.appendChild(node);
                }
            }
        }
        const shouldPinToBottom = agentTab.scrollToBottomOnNextRender
            || wasNearBottom;
        if (shouldPinToBottom) {
            this.agentTranscript.scrollTop = this.agentTranscript.scrollHeight;
            agentTab.scrollToBottomOnNextRender = false;
        } else {
            this.agentTranscript.scrollTop = previousScrollTop;
        }
        this.updateAgentScrollBottomButton();
        this.rememberAgentTranscriptLayout();
        this.agentTools.innerHTML = '';
        this.agentTools.style.display = 'none';
        this.agentPermissions.innerHTML = '';
        this.agentPermissions.style.display = 'none';

        this.agentPrompt.disabled = false;
        this.setAgentPromptValue(agentTab.promptDraft || '', agentTab);
        this.agentPrompt.placeholder = buildAgentPromptPlaceholder(agentTab);
        this.updateAgentComposerActions(agentTab);
        this.refreshAgentTimelineTimestamps();
        this.refreshAgentUsageHud();
        this.scheduleAgentTranscriptViewportUpdate(shouldPinToBottom);
    }

    refreshAgentTimelineTimestamps() {
        if (!this.agentContainer || this.agentContainer.style.display === 'none') {
            return;
        }
        const timestamps = this.agentContainer.querySelectorAll(
            '.agent-message-time[data-created-at]'
        );
        for (const node of timestamps) {
            const createdAt = String(node.dataset.createdAt || '').trim();
            if (!createdAt) continue;
            node.textContent = getAgentMessageTimeLabel({ createdAt });
        }
    }

    refreshAgentUsageHud() {
        const activeTab = getActiveAgentTab();
        if (!activeTab || !this.agentUsageHud) return;
        if (this.agentContainer.style.display === 'none') return;
        this.renderAgentUsageHud(activeTab);
    }

    clearAgentUsageHudHighlights() {
        if (this.agentUsageHudHighlightTimer) {
            clearTimeout(this.agentUsageHudHighlightTimer);
            this.agentUsageHudHighlightTimer = null;
        }
        this.agentUsageHudHighlightedMetricKeys.clear();
        this.syncAgentUsageHudMetricHighlights();
    }

    highlightAgentUsageMetricsTemporarily(metricKeys, durationMs = 3000) {
        if (!(metricKeys instanceof Set) || metricKeys.size === 0) {
            return;
        }
        this.clearAgentUsageHudHighlights();
        this.agentUsageHudHighlightedMetricKeys = new Set(metricKeys);
        this.syncAgentUsageHudMetricHighlights();
        this.agentUsageHudHighlightTimer = window.setTimeout(() => {
            this.agentUsageHudHighlightTimer = null;
            this.agentUsageHudHighlightedMetricKeys.clear();
            this.syncAgentUsageHudMetricHighlights();
        }, durationMs);
    }

    syncAgentUsageHudMetricHighlights() {
        if (!this.agentUsageHud) return;
        const pills = this.agentUsageHud.querySelectorAll('.agent-usage-pill');
        for (const pill of pills) {
            const key = pill.dataset.metricKey || '';
            const highlighted = this.agentUsageHudHighlightedMetricKeys.has(key);
            pill.classList.toggle('is-highlighted', highlighted);
        }
    }

    renderAgentUsageHud(agentTab) {
        if (!this.agentUsageHud) return;
        this.agentUsageHud.innerHTML = '';
        const usage = normalizeAgentUsageForDisplay(agentTab?.usage || null);
        if (!usage || isCompactWorkspaceMode()) {
            this.agentUsageHud.style.display = 'none';
            this.agentUsageHudHovered = false;
            this.agentUsageHudLastTabId = '';
            this.agentUsageHudMetricSignatures = new Map();
            this.clearAgentUsageHudHighlights();
            return;
        }
        const metrics = buildAgentUsageMetrics(usage);
        if (metrics.length === 0) {
            this.agentUsageHud.style.display = 'none';
            this.agentUsageHudHovered = false;
            this.agentUsageHudLastTabId = '';
            this.agentUsageHudMetricSignatures = new Map();
            this.clearAgentUsageHudHighlights();
            return;
        }

        const nextMetricSignatures = new Map();
        for (const metric of metrics) {
            nextMetricSignatures.set(metric.key, JSON.stringify({
                percentLeft: metric.percentLeft,
                percentUsed: metric.percentUsed,
                used: metric.used,
                size: metric.size,
                resetAt: metric.resetAt
            }));
        }

        const tabId = typeof agentTab?.id === 'string'
            ? agentTab.id
            : '';
        const shouldCheckChanges = this.agentUsageHudLastTabId === tabId;
        if (shouldCheckChanges && !this.agentUsageHudHovered) {
            const changedMetricKeys = new Set();
            for (const [metricKey, signature] of nextMetricSignatures.entries()) {
                if (this.agentUsageHudMetricSignatures.get(metricKey) !== signature) {
                    changedMetricKeys.add(metricKey);
                }
            }
            if (changedMetricKeys.size > 0) {
                this.highlightAgentUsageMetricsTemporarily(changedMetricKeys, 3000);
            }
        } else if (!this.agentUsageHudHovered) {
            this.clearAgentUsageHudHighlights();
        }
        this.agentUsageHudLastTabId = tabId;
        this.agentUsageHudMetricSignatures = nextMetricSignatures;

        const compact = document.createElement('div');
        compact.className = 'agent-usage-compact';
        for (const metric of metrics) {
            compact.appendChild(buildAgentUsageCompactMetric(metric));
        }
        this.agentUsageHud.appendChild(compact);

        const details = document.createElement('div');
        details.className = 'agent-usage-details';

        const sessionRow = buildAgentUsageSessionRow(usage);
        if (sessionRow) {
            details.appendChild(sessionRow);
        }

        for (const metric of metrics) {
            details.appendChild(buildAgentUsageDetailRow(metric));
        }

        const costRow = buildAgentUsageCostRow(usage);
        if (costRow) {
            details.appendChild(costRow);
        }

        const totals = buildAgentUsageTotalsMeta(usage);
        if (totals) {
            const totalsRow = document.createElement('div');
            totalsRow.className = 'agent-usage-details-meta';
            totalsRow.textContent = totals;
            details.appendChild(totalsRow);
        }

        this.agentUsageHud.appendChild(details);

        this.agentUsageHud.style.display = '';
        this.agentUsageHud.style.width = '';
        this.agentUsageHud.classList.remove('is-expanded');
        this.syncAgentUsageHudMetricHighlights();
    }

    renderAgentPlan(agentTab) {
        if (!this.agentPlan) return;
        this.agentPlan.innerHTML = '';
        const plan = Array.isArray(agentTab?.plan) ? agentTab.plan : [];
        const activePlan = isAgentPlanComplete(plan) ? [] : plan;
        const runningTerminals = getAgentRunningTerminalSummaries(agentTab);
        if (activePlan.length === 0 && runningTerminals.length === 0) {
            this.agentPlan.style.display = 'none';
            return;
        }

        if (activePlan.length > 0) {
            const card = this.buildAgentPlanCard(activePlan);
            this.agentPlan.appendChild(card);
        }

        if (runningTerminals.length > 0) {
            const terminalSummary = document.createElement('div');
            terminalSummary.className =
                'agent-plan-terminal-row agent-panel-activity tool';
            const icon = document.createElement('span');
            icon.className = 'agent-panel-activity-icon is-spinning';
            icon.innerHTML = SPINNER_ICON_SVG;
            const label = document.createElement('span');
            label.className = 'agent-panel-activity-label';
            label.textContent = runningTerminals.length === 1
                ? 'Running 1 terminal'
                : `Running ${runningTerminals.length} terminals`;
            terminalSummary.appendChild(icon);
            terminalSummary.appendChild(label);
            this.agentPlan.appendChild(terminalSummary);
            const terminalList = document.createElement('div');
            terminalList.className = 'agent-plan-terminal-list';
            for (const terminal of runningTerminals.slice(0, 3)) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'agent-plan-terminal-entry';
                row.textContent = [
                    terminal.command || 'Terminal',
                    terminal.cwd || '',
                    getAgentTerminalStatusLabel(terminal)
                ].filter(Boolean).join(' · ');
                row.setAttribute('aria-label', 'Jump in to terminal');
                row.onclick = async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    await jumpToTerminalSession(
                        agentTab.server,
                        terminal.terminalSessionId
                    );
                };
                terminalList.appendChild(row);
            }
            this.agentPlan.appendChild(terminalList);
        }

        this.agentPlan.style.display = '';
    }

    buildAgentPlanCard(entries, summary = '') {
        const card = document.createElement('div');
        card.className = 'agent-plan-card';
        const header = document.createElement('div');
        header.className = 'agent-plan-header';
        header.textContent = summary || buildAgentPlanSummary(entries);
        card.appendChild(header);
        card.appendChild(this.buildAgentPlanList(entries));
        return card;
    }

    buildAgentPlanList(entries) {
        const list = document.createElement('div');
        list.className = 'agent-plan-list';
        for (const entry of entries) {
            const row = document.createElement('div');
            row.className = `agent-plan-entry ${normalizePlanStatusClass(
                entry.status
            )}`;
            const marker = document.createElement('span');
            marker.className = 'agent-plan-entry-marker';
            marker.textContent = getAgentPlanStatusMarker(entry.status);
            const body = document.createElement('div');
            body.className = 'agent-plan-entry-body';
            const text = document.createElement('span');
            text.className = 'agent-plan-entry-text';
            text.textContent = entry.content;
            const priority = document.createElement('span');
            priority.className = `agent-plan-entry-priority ${
                normalizePlanPriorityClass(entry.priority)
            }`;
            priority.textContent = getAgentPlanPriorityLabel(
                entry.priority
            );
            row.appendChild(marker);
            body.appendChild(text);
            body.appendChild(priority);
            row.appendChild(body);
            list.appendChild(row);
        }
        return list;
    }

    buildAgentPlanHistoryNode(agentTab, planEntry) {
        const item = document.createElement('div');
        item.className = 'agent-message agent-plan-history';
        item.appendChild(buildAgentTimelineHeader(
            buildAgentTimelineRoleLabel(agentTab, 'plan'),
            getAgentMessageTimeLabel(planEntry),
            planEntry.createdAt || ''
        ));
        const body = document.createElement('div');
        body.className = 'agent-plan-history-body';
        const header = document.createElement('div');
        header.className = 'agent-plan-header';
        header.textContent = planEntry.summary
            || buildAgentPlanSummary(planEntry.entries || []);
        body.appendChild(header);
        body.appendChild(this.buildAgentPlanList(planEntry.entries || []));
        item.appendChild(body);
        return item;
    }

    buildAgentEmptyState(agentTab) {
        return this.buildAgentMessageNode(agentTab, {
            id: 'agent-empty-state',
            role: 'assistant',
            kind: 'message',
            text: 'The Answer? The Answer to what?'
        });
    }

    buildAgentMessageNode(agentTab, message) {
        const item = document.createElement('div');
        item.className = `agent-message ${message.role} ${message.kind}`;

        item.appendChild(buildAgentTimelineHeader(
            getAgentMessageRoleLabel(agentTab, message),
            getAgentMessageTimeLabel(message),
            message.createdAt || ''
        ));
        const attachments = buildAgentMessageAttachmentsNode(
            message.attachments
        );
        if (attachments) {
            item.appendChild(attachments);
        }

        if (message.text) {
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
            item.appendChild(body);
        }
        return item;
    }

    buildAgentToolNode(agentTab, toolCall) {
        const node = document.createElement('div');
        const toolStatusClass = getEffectiveAgentToolStatus(
            toolCall,
            agentTab
        );
        node.className = `agent-tool-call state-${toolStatusClass}`;

        node.appendChild(buildAgentTimelineHeader(
            buildAgentTimelineRoleLabel(agentTab, 'tool'),
            getAgentMessageTimeLabel(toolCall),
            toolCall.createdAt || ''
        ));

        const header = document.createElement('div');
        header.className = 'agent-tool-call-header';

        const title = document.createElement('div');
        title.className = 'agent-tool-call-title';
        title.textContent = getAgentToolTitle(toolCall);

        const status = document.createElement('span');
        status.className = `agent-status-pill ${toolStatusClass}`;
        status.textContent = getAgentStatusLabel(toolStatusClass);

        header.appendChild(title);
        header.appendChild(status);
        node.appendChild(header);

        const meta = document.createElement('div');
        meta.className = 'agent-tool-call-meta';
        meta.textContent = buildAgentToolMeta(toolCall);
        if (meta.textContent) {
            node.appendChild(meta);
        }

        const pathLinks = buildAgentPathLinks(agentTab, toolCall);
        if (pathLinks) {
            node.appendChild(pathLinks);
        }

        const summaryText = buildAgentToolSummary(toolCall, agentTab.terminals);
        if (summaryText) {
            const summary = document.createElement('div');
            summary.className = 'agent-tool-call-summary';
            summary.textContent = summaryText;
            node.appendChild(summary);
        }

        const sections = buildAgentToolSections(
            toolCall,
            summaryText,
            agentTab.terminals
        );
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
                const preview = section.preview || buildAgentSectionSummaryPreview(
                    section.text
                );
                if (preview) {
                    summary.appendChild(
                        buildAgentSectionSummaryPreviewNode(preview)
                    );
                }
                details.open = shouldExpandAgentTimelineSections(
                    toolStatusClass
                );
                details.appendChild(summary);
                details.appendChild(
                    this.buildAgentSectionBody(details, section)
                );
                sectionContainer.appendChild(details);
            }
            node.appendChild(sectionContainer);
        }

        return node;
    }

    buildAgentPermissionNode(agentTab, permission) {
        const card = document.createElement('div');
        const permissionStatusClass = normalizeStatusClass(
            permission.status || 'pending'
        );
        card.className = `agent-permission-card state-${permissionStatusClass}`;

        card.appendChild(buildAgentTimelineHeader(
            buildAgentTimelineRoleLabel(
                agentTab,
                permission.status === 'pending'
                    ? 'permission request'
                    : 'permission'
            ),
            getAgentMessageTimeLabel(permission),
            permission.createdAt || ''
        ));

        const titleRow = document.createElement('div');
        titleRow.className = 'agent-tool-call-header';

        const title = document.createElement('div');
        title.className = 'agent-permission-title';
        title.textContent = getAgentPermissionTitle(permission);

        const status = document.createElement('span');
        status.className = `agent-status-pill ${permissionStatusClass}`;
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

        const pathLinks = buildAgentPathLinks(agentTab, permission?.toolCall);
        if (pathLinks) {
            card.appendChild(pathLinks);
        }

        const summaryText = buildAgentPermissionSummary(
            permission,
            agentTab.terminals
        );
        if (summaryText) {
            const summary = document.createElement('div');
            summary.className = 'agent-tool-call-summary';
            summary.textContent = summaryText;
            card.appendChild(summary);
        }

        const sections = buildAgentPermissionSections(
            permission,
            summaryText,
            agentTab.terminals
        );
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
                const preview = section.preview || buildAgentSectionSummaryPreview(
                    section.text
                );
                if (preview) {
                    summary.appendChild(
                        buildAgentSectionSummaryPreviewNode(preview)
                    );
                }
                details.open = shouldExpandAgentTimelineSections(
                    permission.status || 'pending'
                );
                details.appendChild(summary);
                details.appendChild(
                    this.buildAgentSectionBody(details, section)
                );
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
                button.textContent = getPermissionOptionDisplayLabel(option);
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

    disposeAgentEmbeddedEditors() {
        this.agentEmbeddedTerminals.clear();
        for (const disposable of this.agentEmbeddedEditors) {
            try {
                disposable.dispose();
            } catch {
                // Ignore embedded editor disposal failures.
            }
        }
        this.agentEmbeddedEditors = [];
    }

    buildAgentSectionBody(details, section) {
        if (
            section?.kind === 'diff'
            && this.monacoInstance
            && typeof section.newText === 'string'
        ) {
            return this.buildAgentDiffSectionBody(details, section);
        }
        if (
            section?.kind === 'code'
            && this.monacoInstance
            && typeof section.text === 'string'
        ) {
            return this.buildAgentCodeSectionBody(details, section);
        }
        if (section?.kind === 'terminal') {
            return this.buildAgentTerminalSectionBody(details, section);
        }
        const body = document.createElement('pre');
        body.className = 'agent-tool-call-body';
        body.textContent = section?.text || '';
        return body;
    }

    buildAgentCodeSectionBody(details, section) {
        const host = document.createElement('div');
        host.className = 'agent-tool-call-code-host';
        const editorNode = document.createElement('div');
        editorNode.className = 'agent-tool-call-editor';
        editorNode.style.height = `${estimateAgentCodeEditorHeight(
            section.text
        )}px`;
        host.appendChild(editorNode);

        const uri = this.monacoInstance.Uri.from({
            scheme: 'agent-code',
            path: normalizeAgentEditorPath(section.path || '/snippet.txt')
        });
        const model = this.monacoInstance.editor.createModel(
            section.text || '',
            undefined,
            uri
        );
        const editor = this.monacoInstance.editor.create(
            editorNode,
            {
                model,
                readOnly: true,
                theme: 'solarized-dark',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                lineNumbers: 'on',
                glyphMargin: false,
                folding: false,
                renderWhitespace: 'selection',
                wordWrap: 'off',
                fontSize: IS_MOBILE ? 14 : 12,
                fontFamily: "'Monaspace Neon', \"SF Mono Terminal\", "
                    + '"SFMono-Regular", "SF Mono", '
                    + '"JetBrains Mono", Menlo, Consolas, monospace'
            }
        );
        this.agentEmbeddedEditors.push(editor, model);
        details.addEventListener('toggle', () => {
            if (details.open) {
                requestAnimationFrame(() => {
                    editor.layout();
                });
            }
        });
        return host;
    }

    buildAgentTerminalSectionBody(details, section) {
        const host = document.createElement('div');
        host.className = 'agent-tool-call-terminal-host';

        const terminal = section?.terminal || {};
        const agentTab = getActiveAgentTab();
        const terminalId = String(
            terminal.terminalId || section?.terminalId || ''
        );

        const header = document.createElement('div');
        header.className = 'agent-tool-call-terminal-header';

        const meta = document.createElement('div');
        meta.className = 'agent-tool-call-terminal-meta';
        meta.textContent = buildAgentTerminalMetaText(terminal);
        if (meta.textContent) {
            header.appendChild(meta);
        }

        const openButton = syncAgentTerminalOpenButton(
            header,
            null,
            agentTab,
            terminal
        );

        if (header.childElementCount > 0) {
            host.appendChild(header);
        }

        const terminalNode = document.createElement('div');
        terminalNode.className = 'agent-tool-call-terminal-output';
        terminalNode.dataset.outputPreview = terminal.output || '';
        terminalNode.setAttribute('aria-label', terminal.output || '(no output yet)');
        terminalNode.style.height = `${
            estimateAgentTerminalHeight(terminal.output || '')
        }px`;
        host.appendChild(terminalNode);

        const embeddedTerm = new Terminal({
            disableStdin: true,
            convertEol: true,
            cursorBlink: false,
            cursorStyle: 'bar',
            theme: buildMainTerminalTheme(),
            scrollback: 2000,
            fontSize: getTerminalFontSize(),
            fontFamily: TERMINAL_FONT_FAMILY
        });
        const fitAddon = new FitAddon();
        embeddedTerm.loadAddon(fitAddon);
        embeddedTerm.loadAddon(new CanvasAddon());
        embeddedTerm.open(terminalNode);
        renderEmbeddedAgentTerminal(
            embeddedTerm,
            terminalNode,
            terminal,
            fitAddon
        );
        const layoutTerminal = () => {
            requestAnimationFrame(() => {
                try {
                    fitAddon.fit();
                } catch {
                    // Ignore layout failures for collapsed sections.
                }
            });
        };
        layoutTerminal();
        details.addEventListener('toggle', () => {
            if (details.open) {
                layoutTerminal();
            }
        });
        if (terminalId) {
            if (!this.agentEmbeddedTerminals.has(terminalId)) {
                this.agentEmbeddedTerminals.set(terminalId, []);
            }
                this.agentEmbeddedTerminals.get(terminalId).push({
                    meta,
                    header,
                    openButton,
                    terminalNode,
                    terminal: embeddedTerm,
                    fitAddon,
                layout: layoutTerminal
            });
        }
        this.agentEmbeddedEditors.push(embeddedTerm, fitAddon);

        return host;
    }

    refreshVisibleAgentTerminals(agentTab, terminalId = '') {
        const session = agentTab?.getLinkedSession?.() || null;
        if (
            !agentTab
            || !session
            || state.activeSessionKey !== session.key
            || editorManager.getActiveWorkspaceTabKey(session) !== agentTab.key
        ) {
            return false;
        }
        const updates = terminalId
            ? [[terminalId, this.agentEmbeddedTerminals.get(terminalId) || []]]
            : Array.from(this.agentEmbeddedTerminals.entries());
        if (updates.length === 0) {
            return false;
        }
        const shouldPinToBottom = this.isAgentTranscriptNearBottom(48);
        let refreshed = false;
        for (const [id, entries] of updates) {
            if (!Array.isArray(entries) || entries.length === 0) {
                continue;
            }
            const summary = agentTab.terminals.get(id);
            if (!summary) {
                continue;
            }
            for (const entry of entries) {
                if (!entry) continue;
                if (entry.meta) {
                    entry.meta.textContent = buildAgentTerminalMetaText(summary);
                }
                entry.openButton = syncAgentTerminalOpenButton(
                    entry.header,
                    entry.openButton,
                    agentTab,
                    summary
                );
                renderEmbeddedAgentTerminal(
                    entry.terminal,
                    entry.terminalNode,
                    summary,
                    entry.fitAddon
                );
                entry.layout?.();
                refreshed = true;
            }
        }
        if (refreshed) {
            this.renderAgentPlan(agentTab);
            this.scheduleAgentTranscriptViewportUpdate(shouldPinToBottom);
        }
        return refreshed;
    }

    buildAgentDiffSectionBody(details, section) {
        const host = document.createElement('div');
        host.className = 'agent-tool-call-diff-host';
        const diffNode = document.createElement('div');
        diffNode.className = 'agent-tool-call-editor diff';
        diffNode.style.height = `${estimateAgentDiffEditorHeight(
            section.oldText || '',
            section.newText || ''
        )}px`;
        host.appendChild(diffNode);

        const basePath = normalizeAgentEditorPath(
            section.path || '/snippet.txt'
        );
        const originalModel = this.monacoInstance.editor.createModel(
            section.oldText || '',
            undefined,
            this.monacoInstance.Uri.from({
                scheme: 'agent-diff',
                path: basePath,
                query: 'original'
            })
        );
        const modifiedModel = this.monacoInstance.editor.createModel(
            section.newText || '',
            undefined,
            this.monacoInstance.Uri.from({
                scheme: 'agent-diff',
                path: basePath,
                query: 'modified'
            })
        );
        const diffEditor = this.monacoInstance.editor.createDiffEditor(
            diffNode,
            {
                readOnly: true,
                theme: 'solarized-dark',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                lineNumbers: 'on',
                glyphMargin: false,
                renderSideBySide: false,
                originalEditable: false,
                diffWordWrap: 'off',
                fontSize: IS_MOBILE ? 14 : 12,
                fontFamily: "'Monaspace Neon', \"SF Mono Terminal\", "
                    + '"SFMono-Regular", "SF Mono", '
                    + '"JetBrains Mono", Menlo, Consolas, monospace'
            }
        );
        diffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
        });
        this.agentEmbeddedEditors.push(
            diffEditor,
            originalModel,
            modifiedModel
        );
        details.addEventListener('toggle', () => {
            if (details.open) {
                requestAnimationFrame(() => {
                    diffEditor.layout();
                });
            }
        });
        return host;
    }

    async submitActiveAgentPrompt() {
        const activeTabKey = this.getActiveWorkspaceTabKey();
        if (!isAgentWorkspaceTabKey(activeTabKey)) return;
        const agentTab = state.agentTabs.get(activeTabKey);
        if (!agentTab) return;
        const text = this.agentPrompt.value.trim();
        const attachments = Array.isArray(agentTab.pendingAttachments)
            ? [...agentTab.pendingAttachments]
            : [];
        const promptIntent = getAgentPromptIntent(
            agentTab,
            this.agentPrompt.value || ''
        );
        if (promptIntent.kind === 'resume') {
            alert('Select a previous session from the /resume menu.', {
                type: 'warning',
                title: getAgentBaseName(agentTab)
            });
            return;
        }
        if (!text && attachments.length === 0) {
            if (canAutostartQueuedAgentPrompt(agentTab)) {
                await drainQueuedAgentPrompt(agentTab);
            }
            return;
        }
        if (agentTab.busy) {
            this.queueAgentPrompt(agentTab, text, attachments);
            agentTab.pendingAttachments = [];
            this.setAgentPromptValue('', agentTab);
            this.renderAgentPanel(agentTab);
            return;
        }
        try {
            agentTab.lastSubmittedPrompt = text;
            await agentTab.sendPrompt(text, attachments);
            if (text) {
                this.recordAgentPromptHistory(agentTab, text);
            }
            agentTab.pendingAttachments = [];
            this.setAgentPromptValue('', agentTab);
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

    queueAgentPrompt(agentTab, text, attachments = []) {
        if (!agentTab) return;
        if (!Array.isArray(agentTab.queuedPrompts)) {
            agentTab.queuedPrompts = [];
        }
        agentTab.queueCounter = Number.isFinite(agentTab.queueCounter)
            ? agentTab.queueCounter
            : 0;
        agentTab.queueCounter += 1;
        agentTab.queuedPrompts.push({
            id: `queue-${agentTab.queueCounter}`,
            text,
            attachments: attachments.map((attachment) => ({ ...attachment }))
        });
    }

    removeQueuedAgentPrompt(agentTab, queuedPromptId) {
        if (!agentTab || !Array.isArray(agentTab.queuedPrompts)) return;
        agentTab.queuedPrompts = agentTab.queuedPrompts.filter(
            (queuedPrompt) => queuedPrompt.id !== queuedPromptId
        );
        this.renderAgentQueue(agentTab);
        this.updateAgentComposerActions(agentTab);
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

    async setActiveAgentConfigOption(configId, valueId) {
        const activeTabKey = this.getActiveWorkspaceTabKey();
        const agentTab = isAgentWorkspaceTabKey(activeTabKey)
            ? state.agentTabs.get(activeTabKey) || null
            : null;
        if (!agentTab || !configId || !valueId) return;
        const currentOption = getAgentConfigOptionById(agentTab, configId);
        const currentValue = currentOption?.currentValue || '';
        if (currentValue === valueId) return;
        try {
            await agentTab.setConfigOption(configId, valueId);
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

    openAgentSetupForTab(agentTab) {
        const session = agentTab?.getLinkedSession?.() || null;
        if (!session) return;
        const definition = getAgentDefinition(session.serverId, agentTab.agentId);
        if (!definition) return;
        openAgentSetupModal(definition, session.serverId, {
            sessionKey: session.key,
            agentTabKey: agentTab.key,
            promptText: agentTab.lastSubmittedPrompt || '',
            message: agentTab.errorMessage || ''
        });
    }

    updateAgentComposerActions(agentTab = null) {
        const activeTabKey = this.getActiveWorkspaceTabKey();
        const activeAgentTab = agentTab || (
            isAgentWorkspaceTabKey(activeTabKey)
                ? state.agentTabs.get(activeTabKey) || null
                : null
        );
        const definition = activeAgentTab
            ? getAgentDefinition(activeAgentTab.serverId, activeAgentTab.agentId)
            : null;
        const needsSetup = shouldOpenAgentSetupForError(
            definition,
            activeAgentTab?.errorMessage || ''
        );
        const hasAttachments = Array.isArray(activeAgentTab?.pendingAttachments)
            && activeAgentTab.pendingAttachments.length > 0;
        const hasQueuedPrompts = Array.isArray(activeAgentTab?.queuedPrompts)
            && activeAgentTab.queuedPrompts.length > 0;
        this.agentSendButton.textContent = 'Send ⏎';
        this.agentSendButton.disabled = !this.agentPrompt.value.trim()
            && !hasAttachments;
        if (!this.agentPrompt.value.trim() && !hasAttachments && hasQueuedPrompts) {
            this.agentSendButton.disabled = false;
        }
        this.agentAttachmentButton.disabled = false;
        this.agentSetupButton.style.display = needsSetup ? '' : 'none';
        if (!needsSetup && activeAgentTab) {
            activeAgentTab.lastSetupPromptedErrorMessage = '';
        }
        this.agentPrompt.placeholder = buildAgentPromptPlaceholder(
            activeAgentTab
        );
        this.renderAgentActivity(activeAgentTab);
        this.renderAgentQueue(activeAgentTab);
        this.renderAgentComposerAttachments(activeAgentTab);
        if (this.suppressAgentCommandMenu) {
            this.hideAgentCommandMenu();
        } else {
            const promptValue = this.agentPrompt?.value || '';
            const promptIntent = getAgentPromptIntent(
                activeAgentTab,
                promptValue
            );
            const nextMenuStateKey = [
                activeAgentTab?.key || '',
                promptIntent.kind,
                promptValue
            ].join('::');
            const menuVisible = this.agentCommandMenu
                && this.agentCommandMenu.style.display !== 'none';
            if (!menuVisible || this.agentCommandMenuStateKey !== nextMenuStateKey) {
                this.renderAgentCommandMenu(activeAgentTab);
            }
        }
        if (
            activeAgentTab
            && needsSetup
            && activeAgentTab.errorMessage
            && activeAgentTab.lastSetupPromptedErrorMessage
                !== activeAgentTab.errorMessage
            && agentSetupModal?.style.display !== 'flex'
        ) {
            activeAgentTab.lastSetupPromptedErrorMessage =
                activeAgentTab.errorMessage;
            queueMicrotask(() => {
                this.openAgentSetupForTab(activeAgentTab);
            });
        }
    }

    renderAgentActivity(agentTab = null) {
        const activity = getAgentActivityState(agentTab);
        if (!activity) {
            this.agentActivity.style.display = 'none';
            this.agentActivity.classList.remove(
                'running',
                'pending',
                'error'
            );
            this.agentActivityCancelButton.disabled = true;
            this.agentActivityCancelButton.classList.remove('cancelable');
            this.agentActivityCancelButton.title = 'Current activity';
            this.agentActivityCancelButton.setAttribute(
                'aria-label',
                'Current activity'
            );
            this.agentActivityLabel.textContent = '';
            this.agentActivityPrimaryIcon.innerHTML = '';
            this.agentActivityPrimaryIcon.classList.remove('is-spinning');
            return;
        }

        this.agentActivity.style.display = '';
        this.agentActivity.classList.remove('running', 'pending', 'error');
        this.agentActivity.classList.add(activity.stateClass);
        this.agentActivityCancelButton.disabled = !activity.cancelable;
        this.agentActivityCancelButton.classList.toggle(
            'cancelable',
            !!activity.cancelable
        );
        this.agentActivityCancelButton.title = activity.cancelable
            ? 'Stop current run'
            : 'Current activity';
        this.agentActivityCancelButton.setAttribute(
            'aria-label',
            activity.cancelable ? 'Stop current run' : 'Current activity'
        );
        this.agentActivityLabel.textContent = activity.label;
        this.agentActivityPrimaryIcon.innerHTML = activity.iconSvg;
        this.agentActivityPrimaryIcon.classList.toggle(
            'is-spinning',
            !!activity.spinning
        );
    }

    renderAgentQueue(agentTab = null) {
        if (!this.agentQueue) return;
        const queuedPrompts = Array.isArray(agentTab?.queuedPrompts)
            ? agentTab.queuedPrompts
            : [];
        this.agentQueue.innerHTML = '';
        if (queuedPrompts.length === 0) {
            this.agentQueue.style.display = 'none';
            return;
        }

        for (const [index, queuedPrompt] of queuedPrompts.entries()) {
            const item = document.createElement('div');
            item.className = 'agent-queue-item';

            const header = document.createElement('div');
            header.className = 'agent-message-role';
            header.textContent = `😺 Queued #${index + 1}`;
            item.appendChild(header);

            const attachments = buildAgentMessageAttachmentsNode(
                queuedPrompt.attachments
            );
            if (attachments) {
                item.appendChild(attachments);
            }

            const body = document.createElement('div');
            body.className = 'agent-message-body plain';
            body.textContent = queuedPrompt.text || '(Attachments only)';
            item.appendChild(body);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'agent-panel-button secondary icon-only agent-queue-remove';
            remove.innerHTML = CLOSE_ICON_SVG;
            remove.title = 'Remove queued prompt';
            remove.setAttribute('aria-label', 'Remove queued prompt');
            remove.addEventListener('click', () => {
                this.removeQueuedAgentPrompt(agentTab, queuedPrompt.id);
            });
            item.appendChild(remove);

            this.agentQueue.appendChild(item);
        }
        this.agentQueue.style.display = 'flex';
    }

    captureAgentTranscriptLayout() {
        if (!this.agentTranscript) {
            return null;
        }
        return {
            scrollTop: this.agentTranscript.scrollTop,
            scrollHeight: this.agentTranscript.scrollHeight,
            clientHeight: this.agentTranscript.clientHeight
        };
    }

    rememberAgentTranscriptLayout() {
        this.agentTranscriptLayout = this.captureAgentTranscriptLayout();
    }

    isAgentTranscriptLayoutNearBottom(layout = null, threshold = 24) {
        if (!layout) return true;
        const remaining = layout.scrollHeight
            - layout.clientHeight
            - layout.scrollTop;
        return remaining <= threshold;
    }

    isAgentTranscriptNearBottom(threshold = 24) {
        return this.isAgentTranscriptLayoutNearBottom(
            this.captureAgentTranscriptLayout(),
            threshold
        );
    }

    scrollAgentTranscriptToBottom() {
        if (!this.agentTranscript) return;
        this.agentTranscript.scrollTop = this.agentTranscript.scrollHeight;
        this.updateAgentScrollBottomButton();
        this.rememberAgentTranscriptLayout();
    }

    scheduleAgentTranscriptViewportUpdate(pinToBottom = false) {
        if (!this.agentTranscript) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!this.agentTranscript) return;
                if (pinToBottom) {
                    this.scrollAgentTranscriptToBottom();
                    return;
                }
                this.updateAgentScrollBottomButton();
                this.rememberAgentTranscriptLayout();
            });
        });
    }

    updateAgentScrollBottomButton() {
        if (!this.agentScrollBottomButton || !this.agentTranscript) return;
        const hasOverflow = this.agentTranscript.scrollHeight
            > this.agentTranscript.clientHeight + 8;
        const shouldShow = hasOverflow && !this.isAgentTranscriptNearBottom();
        this.agentScrollBottomButton.style.display = shouldShow ? '' : 'none';
    }

    #renderAgentCommandSuggestions(suggestions) {
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
        let activeButton = null;
        for (const [index, command] of suggestions.entries()) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'agent-command-option';
            if (index === this.agentCommandIndex) {
                button.classList.add('active');
                activeButton = button;
            }
            const name = document.createElement('span');
            name.className = 'agent-command-option-name';
            name.textContent = command.kind === 'resume_session'
                ? command.displayName || command.title || command.sessionId
                : command.kind === 'info'
                    ? command.label || ''
                    : `/${command.name}`;
            button.appendChild(name);
            if (command.description) {
                const meta = document.createElement('span');
                meta.className = 'agent-command-option-meta';
                meta.textContent = command.description;
                button.appendChild(meta);
            }
            if (command.kind === 'info') {
                button.disabled = true;
            }
            button.addEventListener('mousedown', (event) => {
                event.preventDefault();
            });
            button.addEventListener('click', () => {
                if (command.kind === 'info') return;
                this.agentCommandIndex = index;
                void this.applyAgentCommandSuggestion();
            });
            this.agentCommandMenu.appendChild(button);
        }
        this.agentCommandMenu.style.display = 'flex';
        if (activeButton) {
            requestAnimationFrame(() => {
                activeButton.scrollIntoView({
                    block: 'nearest'
                });
            });
        }
    }

    async renderAgentCommandMenu(agentTab = null) {
        if (!this.agentCommandMenu) return;
        const promptValue = this.agentPrompt?.value || '';
        const token = this.agentCommandMenuToken + 1;
        this.agentCommandMenuToken = token;
        const intent = getAgentPromptIntent(agentTab, promptValue);
        const menuStateKey = [
            agentTab?.key || '',
            intent.kind,
            promptValue
        ].join('::');

        if (!agentTab || intent.kind === 'none' || intent.kind === 'other') {
            this.hideAgentCommandMenu();
            return;
        }

        if (Number.isInteger(agentTab.promptHistoryIndex)) {
            this.exitAgentPromptHistoryBrowsing(agentTab);
        }

        if (intent.kind === 'resume') {
            const hasLoadedResumeSuggestions = (
                this.agentCommandMenuStateKey === menuStateKey
                && this.agentCommandSuggestions.length > 0
                && !(
                    this.agentCommandSuggestions.length === 1
                    && this.agentCommandSuggestions[0]?.kind === 'info'
                    && /loading previous sessions/i.test(
                        this.agentCommandSuggestions[0]?.label || ''
                    )
                )
            );
            if (hasLoadedResumeSuggestions) {
                this.#renderAgentCommandSuggestions(
                    this.agentCommandSuggestions
                );
                return;
            }
            this.agentCommandMenuStateKey = menuStateKey;
            this.#renderAgentCommandSuggestions([{
                kind: 'info',
                label: 'Loading previous sessions…',
                description: ''
            }]);
            try {
                const sessions = await agentTab.listResumeSessions();
                if (this.agentCommandMenuToken !== token) {
                    return;
                }
                const suggestions = getAgentResumeSuggestions(
                    agentTab,
                    promptValue,
                    sessions
                );
                if (suggestions.length === 0) {
                    this.#renderAgentCommandSuggestions([{
                        kind: 'info',
                        label: 'No previous sessions found',
                        description: ''
                    }]);
                    return;
                }
                this.#renderAgentCommandSuggestions(suggestions);
            } catch (error) {
                if (this.agentCommandMenuToken !== token) {
                    return;
                }
                this.#renderAgentCommandSuggestions([{
                    kind: 'info',
                    label: 'Unable to load previous sessions',
                    description: error?.message || ''
                }]);
            }
            return;
        }

        this.agentCommandMenuStateKey = menuStateKey;
        this.#renderAgentCommandSuggestions(
            getAgentCommandSuggestions(agentTab, promptValue)
        );
    }

    hideAgentCommandMenu() {
        if (!this.agentCommandMenu) return;
        this.agentCommandMenuToken += 1;
        this.agentCommandSuggestions = [];
        this.agentCommandIndex = 0;
        this.agentCommandMenuStateKey = '';
        this.agentCommandMenu.style.display = 'none';
        this.agentCommandMenu.innerHTML = '';
    }

    moveAgentCommandSelection(delta) {
        if (this.agentCommandSuggestions.length === 0) return;
        const nextIndex = this.agentCommandIndex + delta;
        this.agentCommandIndex = nextIndex < 0
            ? this.agentCommandSuggestions.length - 1
            : nextIndex % this.agentCommandSuggestions.length;
        this.#renderAgentCommandSuggestions(this.agentCommandSuggestions);
    }

    setAgentPromptValue(value, agentTab = null, options = {}) {
        this.isApplyingAgentPromptState = true;
        this.suppressAgentCommandMenu = !!options.suppressCommandMenu;
        this.agentPrompt.value = value;
        if (agentTab && !options.preserveDraft) {
            agentTab.promptDraft = value;
        }
        this.hideAgentCommandMenu();
        this.updateAgentComposerActions(agentTab);
        const cursor = this.agentPrompt.value.length;
        this.agentPrompt.setSelectionRange(cursor, cursor);
        this.suppressAgentCommandMenu = false;
        this.isApplyingAgentPromptState = false;
    }

    recordAgentPromptHistory(agentTab, text) {
        if (!agentTab || !text) return;
        if (!Array.isArray(agentTab.promptHistory)) {
            agentTab.promptHistory = [];
        }
        agentTab.promptHistory.push(text);
        agentTab.promptHistoryIndex = null;
        agentTab.promptDraft = '';
    }

    async addAgentAttachments(files = []) {
        const agentTab = getActiveAgentTab();
        if (!agentTab) return;
        const nextAttachments = normalizeAgentComposerAttachments(files);
        if (nextAttachments.length === 0) return;
        if (!Array.isArray(agentTab.pendingAttachments)) {
            agentTab.pendingAttachments = [];
        }
        for (const attachment of nextAttachments) {
            const duplicate = agentTab.pendingAttachments.some((existing) => (
                existing.name === attachment.name
                && existing.size === attachment.size
                && existing.lastModified === attachment.lastModified
            ));
            if (!duplicate) {
                agentTab.pendingAttachments.push(attachment);
            }
        }
        this.renderAgentComposerAttachments(agentTab);
        this.updateAgentComposerActions(agentTab);
    }

    removeAgentAttachment(agentTab, attachmentId) {
        if (!agentTab || !Array.isArray(agentTab.pendingAttachments)) return;
        agentTab.pendingAttachments = agentTab.pendingAttachments.filter(
            (attachment) => attachment.id !== attachmentId
        );
        this.renderAgentComposerAttachments(agentTab);
        this.updateAgentComposerActions(agentTab);
    }

    renderAgentComposerAttachments(agentTab = null) {
        if (!this.agentAttachmentList) return;
        const attachments = Array.isArray(agentTab?.pendingAttachments)
            ? agentTab.pendingAttachments
            : [];
        this.agentAttachmentList.innerHTML = '';
        if (attachments.length === 0) {
            this.agentAttachmentList.style.display = 'none';
            return;
        }
        for (const attachment of attachments) {
            const chip = document.createElement('div');
            chip.className = 'agent-attachment-chip';

            const meta = document.createElement('div');
            meta.className = 'agent-attachment-chip-meta';

            const name = document.createElement('span');
            name.className = 'agent-attachment-chip-name';
            name.textContent = attachment.name;
            meta.appendChild(name);

            const detail = document.createElement('span');
            detail.className = 'agent-attachment-chip-detail';
            detail.textContent = buildAgentAttachmentMetaLabel(attachment);
            meta.appendChild(detail);

            chip.appendChild(meta);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'agent-attachment-chip-remove';
            remove.textContent = '×';
            remove.disabled = !!agentTab?.busy;
            remove.title = `Remove ${attachment.name}`;
            remove.setAttribute('aria-label', `Remove ${attachment.name}`);
            remove.addEventListener('click', () => {
                this.removeAgentAttachment(agentTab, attachment.id);
            });
            chip.appendChild(remove);

            this.agentAttachmentList.appendChild(chip);
        }
        this.agentAttachmentList.style.display = 'flex';
    }

    handleAgentPromptHistoryKey(event, agentTab) {
        if (!agentTab || !this.agentPrompt) return false;

        const direction = event.key === 'ArrowUp' ? -1 : 1;
        const history = Array.isArray(agentTab.promptHistory)
            ? agentTab.promptHistory
            : [];
        const isBrowsing = Number.isInteger(agentTab.promptHistoryIndex);

        if (!isBrowsing) {
            if (this.agentPrompt.value !== '' || direction > 0) {
                return false;
            }
            if (history.length === 0) {
                return false;
            }

            event.preventDefault();
            agentTab.promptDraft = '';
            agentTab.promptHistoryIndex = history.length - 1;
            this.setAgentPromptValue(
                history[agentTab.promptHistoryIndex] || '',
                agentTab,
                {
                    suppressCommandMenu: true,
                    preserveDraft: true
                }
            );
            return true;
        }

        event.preventDefault();
        if (direction < 0) {
            agentTab.promptHistoryIndex = Math.max(
                0,
                agentTab.promptHistoryIndex - 1
            );
        } else if (agentTab.promptHistoryIndex >= history.length - 1) {
            agentTab.promptHistoryIndex = null;
            this.setAgentPromptValue(agentTab.promptDraft || '', agentTab, {
                suppressCommandMenu: true
            });
            return true;
        } else {
            agentTab.promptHistoryIndex += 1;
        }

        this.setAgentPromptValue(
            history[agentTab.promptHistoryIndex] || '',
            agentTab,
            {
                suppressCommandMenu: true,
                preserveDraft: true
            }
        );
        return true;
    }

    exitAgentPromptHistoryBrowsing(agentTab) {
        if (!agentTab || !Number.isInteger(agentTab.promptHistoryIndex)) {
            return;
        }
        agentTab.promptHistoryIndex = null;
        agentTab.promptDraft = this.agentPrompt?.value || '';
    }

    async applyAgentCommandSuggestion() {
        const command = this.agentCommandSuggestions[this.agentCommandIndex];
        if (!command) return;
        if (command.kind === 'info') {
            return;
        }
        if (command.kind === 'resume_session') {
            const agentTab = getActiveAgentTab();
            if (!agentTab) return;
            const session = agentTab.getLinkedSession();
            if (!session) return;
            try {
                if (command.openTabKey) {
                    const existingTab = state.agentTabs.get(command.openTabKey);
                    const existingSession = existingTab?.getLinkedSession() || null;
                    if (existingTab && existingSession) {
                        await activateAgentTab(existingSession, existingTab, {
                            switchSession: true
                        });
                    } else {
                        await resumeAgentTabFromHistory(session, agentTab, command);
                    }
                } else {
                    await resumeAgentTabFromHistory(session, agentTab, command);
                }
                this.hideAgentCommandMenu();
            } catch (error) {
                alert(error.message, {
                    type: 'error',
                    title: getAgentBaseName(agentTab)
                });
            }
            return;
        }
        const suffix = command.inputHint
            ? ` ${command.inputHint}`
            : ' ';
        this.agentPrompt.focus();
        this.setAgentPromptValue(
            `/${command.name}${suffix}`,
            getActiveAgentTab()
        );
    }

    showEmptyState() {
        this.monacoContainer.style.display = 'none';
        this.imagePreviewContainer.style.display = 'none';
        this.hidePdfPreview();
        this.agentContainer.style.display = 'none';
        this.emptyState.style.display = 'flex';
        this.syncTerminalWorkspacePlacement('');
    }
}

const AGENT_PROMPT_PLACEHOLDER = [
    'Life! The Universe! Everything!',
    '# Host:/path · Mode · Ready',
    '# / for commands, ⇧⏎ or ⌃J inserts a newline.'
];

const editorManager = new EditorManager();
// #endregion

const agentDropdownEl = document.createElement('div');
agentDropdownEl.className = 'agent-dropdown';
agentDropdownEl.style.display = 'none';
agentDropdownEl.setAttribute('role', 'listbox');
document.body.appendChild(agentDropdownEl);

function closeAgentDropdown() {
    agentDropdownEl.style.display = 'none';
    agentDropdownEl.dataset.sessionKey = '';
    agentDropdownEl.dataset.activeIndex = '-1';
    agentDropdownEl.innerHTML = '';
}

function getAgentDropdownItems() {
    return Array.from(
        agentDropdownEl.querySelectorAll('.agent-dropdown-item')
    );
}

function getAgentDropdownActiveIndex() {
    const parsed = Number.parseInt(
        agentDropdownEl.dataset.activeIndex || '-1',
        10
    );
    return Number.isFinite(parsed) ? parsed : -1;
}

function setAgentDropdownActiveIndex(index, options = {}) {
    const items = getAgentDropdownItems();
    if (!items.length) {
        agentDropdownEl.dataset.activeIndex = '-1';
        return;
    }
    const { scroll = true } = options;
    const nextIndex = Math.max(0, Math.min(index, items.length - 1));
    agentDropdownEl.dataset.activeIndex = String(nextIndex);
    items.forEach((item, itemIndex) => {
        const isActive = itemIndex === nextIndex;
        item.classList.toggle('is-active', isActive);
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive && scroll) {
            item.scrollIntoView({ block: 'nearest' });
        }
    });
}

function moveAgentDropdownActiveIndex(delta) {
    const items = getAgentDropdownItems();
    if (!items.length) return;
    const currentIndex = getAgentDropdownActiveIndex();
    const nextIndex = currentIndex < 0
        ? 0
        : (currentIndex + delta + items.length) % items.length;
    setAgentDropdownActiveIndex(nextIndex);
}

function triggerActiveAgentDropdownItem() {
    const items = getAgentDropdownItems();
    if (!items.length) return;
    const activeIndex = getAgentDropdownActiveIndex();
    const target = items[Math.max(0, activeIndex)];
    if (target) target.click();
}

function getSessionAgentToggleButton(session) {
    if (!session) return null;
    const escapedKey = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(session.key)
        : session.key;
    return tabListEl?.querySelector(
        `.tab-item[data-session-key="${escapedKey}"] .toggle-agent-btn`
    ) || null;
}

async function toggleAgentDropdownForSession(session, anchor) {
    if (!session || !anchor) return;
    if (
        agentDropdownEl.style.display !== 'none'
        && agentDropdownEl.dataset.sessionKey === session.key
    ) {
        closeAgentDropdown();
        return;
    }
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
    openAgentDropdown(session, anchor);
}

function updateAgentDefinitions(serverId, definitions) {
    state.agentDefinitions.set(
        serverId,
        Array.isArray(definitions) ? definitions : []
    );
}

function loadRecentAgentUsage() {
    try {
        const raw = localStorage.getItem(RECENT_AGENT_USAGE_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveRecentAgentUsage(value) {
    try {
        localStorage.setItem(
            RECENT_AGENT_USAGE_STORAGE_KEY,
            JSON.stringify(value)
        );
    } catch {
        // Ignore storage failures.
    }
}

function markAgentDefinitionUsed(agentId) {
    if (!agentId) return;
    const usage = loadRecentAgentUsage();
    usage[agentId] = Date.now();
    saveRecentAgentUsage(usage);
}

function sortAgentDefinitions(definitions) {
    const usage = loadRecentAgentUsage();
    return [...definitions].sort((left, right) => {
        const leftAvailable = left.available !== false ? 0 : 1;
        const rightAvailable = right.available !== false ? 0 : 1;
        if (leftAvailable !== rightAvailable) {
            return leftAvailable - rightAvailable;
        }

        const leftRecent = Number(usage[left.id] || 0);
        const rightRecent = Number(usage[right.id] || 0);
        if (leftRecent !== rightRecent) {
            return rightRecent - leftRecent;
        }

        return String(left.label || '').localeCompare(
            String(right.label || '')
        );
    });
}

function getAgentDefinition(serverId, agentId) {
    return getAgentDefinitionsForServer(serverId).find(
        (definition) => definition.id === agentId
    ) || null;
}

function setAgentSetupFeedback(message = '', type = '') {
    if (!agentSetupFeedback) return;
    if (!message) {
        agentSetupFeedback.hidden = true;
        agentSetupFeedback.textContent = '';
        agentSetupFeedback.className = 'agent-setup-feedback';
        return;
    }
    agentSetupFeedback.hidden = false;
    agentSetupFeedback.textContent = message;
    agentSetupFeedback.className = `agent-setup-feedback ${type}`.trim();
}

function closeAgentSetupModal() {
    if (!agentSetupModal) return;
    agentSetupModal.style.display = 'none';
    setAgentSetupFeedback('');
    agentSetupState.serverId = '';
    agentSetupState.agentId = '';
    agentSetupState.retrySessionKey = '';
    agentSetupState.retryAgentTabKey = '';
    agentSetupState.retryPromptText = '';
    agentSetupState.retryAnchor = null;
}

function updateClaudeSetupFields() {
    const useVertex = !!agentSetupClaudeUseVertex?.checked;
    for (const input of [
        agentSetupClaudeProject,
        agentSetupClaudeRegion,
        agentSetupClaudeCredentials
    ]) {
        if (!input) continue;
        input.disabled = !useVertex;
    }
}

function describeConfiguredSecrets(prefix, checks) {
    const enabled = checks.filter(Boolean);
    if (enabled.length === 0) return '';
    return `${prefix}: ${enabled.join(', ')}.`;
}

function openAgentSetupModal(definition, serverId, options = {}) {
    if (!definition || !agentSetupModal) return;
    agentSetupState.serverId = serverId;
    agentSetupState.agentId = definition.id;
    agentSetupState.retrySessionKey = options.sessionKey || '';
    agentSetupState.retryAgentTabKey = options.agentTabKey || '';
    agentSetupState.retryPromptText = options.promptText || '';
    agentSetupState.retryAnchor = options.anchor || null;

    agentSetupTitle.textContent = `${definition.label} setup`;
    agentSetupDescription.textContent = buildAgentSetupMessage(definition);
    setAgentSetupFeedback(options.message || '', options.message ? 'error' : '');

    agentSetupGemini.hidden = true;
    agentSetupClaude.hidden = true;
    agentSetupCopilot.hidden = true;
    agentSetupReset.hidden = false;
    agentSetupSave.hidden = false;
    agentSetupSave.disabled = false;
    agentSetupReset.disabled = false;
    agentSetupSave.textContent = 'Save';
    agentSetupCancel.textContent = 'Close';

    agentSetupGeminiKey.value = '';
    agentSetupGoogleKey.value = '';
    agentSetupClaudeKey.value = '';
    agentSetupClaudeUseVertex.checked = false;
    agentSetupClaudeProject.value = '';
    agentSetupClaudeRegion.value = '';
    agentSetupClaudeCredentials.value = '';
    agentSetupCopilotToken.value = '';

    const config = definition.config || {};

    if (definition.id === 'gemini') {
        agentSetupGemini.hidden = false;
        agentSetupGeminiNote.textContent = describeConfiguredSecrets(
            'Saved keys',
            [
                config.hasGeminiApiKey ? 'GEMINI_API_KEY' : '',
                config.hasGoogleApiKey ? 'GOOGLE_API_KEY' : ''
            ]
        ) || 'Paste one key to save it for this host.';
    } else if (definition.id === 'claude') {
        agentSetupClaude.hidden = false;
        agentSetupClaudeUseVertex.checked = !!config.useVertex;
        agentSetupClaudeProject.value = config.vertexProjectId
            || config.gcloudProject
            || '';
        agentSetupClaudeRegion.value = config.cloudMlRegion || 'global';
        agentSetupClaudeNote.textContent = [
            describeConfiguredSecrets(
                'Saved auth',
                [config.hasAnthropicApiKey ? 'ANTHROPIC_API_KEY' : '']
            ),
            config.hasGoogleCredentials
                ? 'Google credentials file already configured.'
                : '',
            'Existing Claude login on this host will also be used if available.',
            'Vertex works best with region set to global.'
        ].filter(Boolean).join(' ');
        updateClaudeSetupFields();
    } else if (definition.id === 'copilot') {
        agentSetupCopilot.hidden = false;
        agentSetupCopilotNote.textContent = [
            describeConfiguredSecrets(
                'Saved auth',
                [config.hasCopilotToken ? 'COPILOT_GITHUB_TOKEN' : '']
            ),
            'Existing `copilot login` or `gh auth login` on this host may be '
                + 'reused when this backend can see them.',
            'For headless use, `COPILOT_GITHUB_TOKEN` is the most reliable '
                + 'auth path.'
        ].filter(Boolean).join(' ');
    } else {
        agentSetupCopilot.hidden = false;
        agentSetupCopilotNote.textContent =
            'This agent does not expose additional setup in Tabminal yet.';
        agentSetupSave.hidden = true;
        agentSetupReset.hidden = true;
    }

    agentSetupModal.style.display = 'flex';
}

async function saveAgentSetupConfig() {
    const { serverId, agentId } = agentSetupState;
    const server = state.servers.get(serverId);
    if (!server || !agentId) {
        throw new Error('Agent setup context is unavailable');
    }

    const env = {};
    const clearEnvKeys = [];

    if (agentId === 'gemini') {
        if (agentSetupGeminiKey.value.trim()) {
            env.GEMINI_API_KEY = agentSetupGeminiKey.value.trim();
        }
        if (agentSetupGoogleKey.value.trim()) {
            env.GOOGLE_API_KEY = agentSetupGoogleKey.value.trim();
        }
    } else if (agentId === 'claude') {
        if (agentSetupClaudeKey.value.trim()) {
            env.ANTHROPIC_API_KEY = agentSetupClaudeKey.value.trim();
        }
        if (agentSetupClaudeUseVertex.checked) {
            env.CLAUDE_CODE_USE_VERTEX = '1';
            if (agentSetupClaudeProject.value.trim()) {
                const vertexProjectId = agentSetupClaudeProject.value.trim();
                env.ANTHROPIC_VERTEX_PROJECT_ID = vertexProjectId;
                env.GCLOUD_PROJECT = vertexProjectId;
                env.GOOGLE_CLOUD_PROJECT = vertexProjectId;
            }
            if (agentSetupClaudeRegion.value.trim()) {
                env.CLOUD_ML_REGION = agentSetupClaudeRegion.value.trim();
            }
            if (agentSetupClaudeCredentials.value.trim()) {
                env.GOOGLE_APPLICATION_CREDENTIALS =
                    agentSetupClaudeCredentials.value.trim();
            }
        } else {
            clearEnvKeys.push(
                'CLAUDE_CODE_USE_VERTEX',
                'ANTHROPIC_VERTEX_PROJECT_ID',
                'GCLOUD_PROJECT',
                'GOOGLE_CLOUD_PROJECT',
                'CLOUD_ML_REGION',
                'GOOGLE_APPLICATION_CREDENTIALS'
            );
        }
    } else if (agentId === 'copilot') {
        if (agentSetupCopilotToken.value.trim()) {
            env.COPILOT_GITHUB_TOKEN = agentSetupCopilotToken.value.trim();
        }
    }

    const response = await server.fetch(`/api/agents/config/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env, clearEnvKeys })
    });
    if (!response.ok) {
        await throwResponseError(response, 'Failed to save agent setup');
    }
    const data = await response.json();
    updateAgentDefinitions(serverId, data?.definitions);
    server.agentStateLoaded = false;
    await syncAgentsForServer(server, { force: true });
    const retrySession = agentSetupState.retrySessionKey
        ? state.sessions.get(agentSetupState.retrySessionKey) || null
        : null;
    const retryAgentTab = agentSetupState.retryAgentTabKey
        ? state.agentTabs.get(agentSetupState.retryAgentTabKey) || null
        : null;
    const retryPromptText = agentSetupState.retryPromptText || '';
    if (retrySession) {
        try {
            const nextAgentTab = await createAgentTab(retrySession, agentId, {
                cwd: retryAgentTab?.cwd
                    || retrySession.cwd
                    || retrySession.initialCwd
                    || '/',
                modeId: retryAgentTab?.currentModeId || ''
            });
            closeAgentSetupModal();
            if (nextAgentTab && retryPromptText) {
                await nextAgentTab.sendPrompt(retryPromptText);
                nextAgentTab.busy = true;
                nextAgentTab.status = 'running';
                nextAgentTab.notifyUi();
            }
            return;
        } catch (error) {
            const nextDefinition = getAgentDefinition(serverId, agentId);
            if (nextDefinition) {
                openAgentSetupModal(nextDefinition, serverId, {
                    sessionKey: agentSetupState.retrySessionKey,
                    agentTabKey: agentSetupState.retryAgentTabKey,
                    promptText: retryPromptText,
                    anchor: agentSetupState.retryAnchor,
                    message: error.message || 'Saved, but failed to start agent.'
                });
                return;
            }
        }
    }
    const nextDefinition = getAgentDefinition(serverId, agentId);
    if (nextDefinition) {
        openAgentSetupModal(nextDefinition, serverId, {
            sessionKey: agentSetupState.retrySessionKey,
            agentTabKey: agentSetupState.retryAgentTabKey,
            promptText: retryPromptText,
            anchor: agentSetupState.retryAnchor,
            message: 'Saved. You can start the agent now.'
        });
    } else {
        closeAgentSetupModal();
    }
}

async function resetAgentSetupConfig() {
    const { serverId, agentId } = agentSetupState;
    const server = state.servers.get(serverId);
    if (!server || !agentId) {
        throw new Error('Agent setup context is unavailable');
    }
    const response = await server.fetch(`/api/agents/config/${agentId}`, {
        method: 'DELETE'
    });
    if (!response.ok) {
        await throwResponseError(response, 'Failed to reset agent setup');
    }
    const data = await response.json();
    updateAgentDefinitions(serverId, data?.definitions);
    server.agentStateLoaded = false;
    await syncAgentsForServer(server, { force: true });
    const nextDefinition = getAgentDefinition(serverId, agentId);
    if (nextDefinition) {
        openAgentSetupModal(nextDefinition, serverId, {
            message: 'Saved setup removed.'
        });
    } else {
        closeAgentSetupModal();
    }
}

function shouldOpenAgentSetupForError(definition, message = '') {
    if (!definition || !message) return false;
    if (definition.id === 'gemini') {
        return /api key|google_api_key|gemini_api_key/i.test(message);
    }
    if (definition.id === 'claude') {
        return /claude|anthropic|vertex|auth|login|credential|api key/i.test(
            message
        );
    }
    if (definition.id === 'copilot') {
        return /copilot|not installed|auth|login|token|unauthorized|forbidden/i
            .test(message);
    }
    return false;
}

function openAgentDropdown(session, anchor) {
    if (!session || !anchor) return;
    const definitions = sortAgentDefinitions(
        getAgentDefinitionsForServer(session.serverId)
    );
    agentDropdownEl.innerHTML = '';

    definitions.forEach((definition, definitionIndex) => {
        const entry = document.createElement('div');
        entry.className = 'agent-dropdown-entry';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-dropdown-item';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
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
            markAgentDefinitionUsed(definition.id);
            if (definition.available === false) {
                closeAgentDropdown();
                openAgentSetupModal(definition, session.serverId, {
                    sessionKey: session.key,
                    anchor
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
                if (shouldOpenAgentSetupForError(definition, error.message)) {
                    closeAgentDropdown();
                    openAgentSetupModal(definition, session.serverId, {
                        sessionKey: session.key,
                        anchor,
                        message: error.message
                    });
                } else {
                    alert(error.message, {
                        type: 'error',
                        title: 'Agent'
                    });
                }
            } finally {
                button.disabled = definition.available === false;
            }
        };
        button.addEventListener('mouseenter', () => {
            setAgentDropdownActiveIndex(definitionIndex, {
                scroll: false
            });
        });
        entry.appendChild(button);

        if (definition.websiteUrl) {
            const infoButton = document.createElement('button');
            infoButton.type = 'button';
            infoButton.className = 'agent-dropdown-info';
            infoButton.title = `Open ${definition.label}`;
            infoButton.setAttribute(
                'aria-label',
                `Open ${definition.label} website`
            );
            infoButton.innerHTML = '<span aria-hidden="true">i</span>';
            infoButton.onclick = (event) => {
                event.stopPropagation();
                window.open(
                    definition.websiteUrl,
                    '_blank',
                    'noopener,noreferrer'
                );
            };
            entry.appendChild(infoButton);
        }

        agentDropdownEl.appendChild(entry);
    });

    if (definitions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'agent-dropdown-empty';
        empty.textContent = 'No agents available';
        agentDropdownEl.appendChild(empty);
    }

    const footer = document.createElement('div');
    footer.className = 'agent-dropdown-footer';
    footer.appendChild(
        document.createTextNode('Agent features are in beta, ')
    );
    const issuesLink = document.createElement('a');
    issuesLink.className = 'agent-dropdown-footer-link';
    issuesLink.href = 'https://github.com/Leask/Tabminal/issues';
    issuesLink.target = '_blank';
    issuesLink.rel = 'noopener noreferrer';
    issuesLink.textContent = 'report bugs here';
    issuesLink.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    footer.appendChild(issuesLink);
    footer.appendChild(document.createTextNode('.'));
    agentDropdownEl.appendChild(footer);

    const rect = anchor.getBoundingClientRect();
    agentDropdownEl.dataset.sessionKey = session.key;
    agentDropdownEl.style.display = 'flex';
    agentDropdownEl.style.top = `${rect.bottom + window.scrollY + 6}px`;
    agentDropdownEl.style.left = `${rect.left + window.scrollX}px`;
    setAgentDropdownActiveIndex(0, { scroll: false });
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
        this.managed = normalizeManagedSessionMeta(data.managed);
        this.closed = !!data.closed;
        this.exitStatus = data.exitStatus || null;
        
        this.saveStateTimer = null;
        this.runningCommand = '';
        this.runningExecutionId = '';
        this.lastExecutionEntry = null;
        this.needsAttention = false;
        this.lastNotifiedExecutionId = '';
        const legacyEditorState = data.editorState
            && typeof data.editorState === 'object'
            ? data.editorState
            : {};
        const sharedWorkspaceInput = data.workspaceState
            && typeof data.workspaceState === 'object'
            ? data.workspaceState
            : legacyEditorState;
        const hasExplicitExpandedPaths = Array.isArray(
            sharedWorkspaceInput?.expandedPaths
        );
        this.sharedWorkspaceState = normalizeWorkspaceSnapshot(
            {
                ...sharedWorkspaceInput,
                expandedPaths: hasExplicitExpandedPaths
                    ? sharedWorkspaceInput.expandedPaths
                    : Array.from(this.server.expandedPaths)
            }
        );
        const initialActiveFilePath = (
            typeof legacyEditorState.activeFilePath === 'string'
            && this.sharedWorkspaceState.openFiles.includes(
                legacyEditorState.activeFilePath
            )
        )
            ? legacyEditorState.activeFilePath
            : (this.sharedWorkspaceState.openFiles[0] || null);

        this.editorState = {
            isVisible: this.sharedWorkspaceState.isVisible,
            root: this.cwd,
            openFiles: [...this.sharedWorkspaceState.openFiles],
            activeFilePath: initialActiveFilePath,
            viewStates: new Map() // Path -> ViewState
        };
        this.workspaceState = {
            activeTabKey: legacyEditorState.activeWorkspaceTabKey
                || (initialActiveFilePath
                    ? makeFileWorkspaceTabKey(initialActiveFilePath)
                    : ''),
            lastNonTerminalTabKey: legacyEditorState.activeWorkspaceTabKey
                && !isTerminalWorkspaceTabKey(
                    legacyEditorState.activeWorkspaceTabKey
                )
                ? legacyEditorState.activeWorkspaceTabKey
                : (initialActiveFilePath
                    ? makeFileWorkspaceTabKey(initialActiveFilePath)
                    : ''),
            recentAgentTabKeys: Array.isArray(
                legacyEditorState?.recentAgentTabKeys
            )
                ? legacyEditorState.recentAgentTabKeys.filter(
                    (key) => typeof key === 'string' && key.length > 0
                )
                : []
        };
        
        this.layoutState = {
            editorFlex: '2 1 0%'
        };
        this.selectedTreePath = '';
        this.treeEditingPath = '';
        this.treeRenameSubmitting = false;
        this.pendingTreeFocusPath = '';
        this.pendingTreeRenameFocusPath = '';
        this.previewRelayoutScheduled = false;
        this.lastTerminalControlClaimAt = 0;
        this.boundTerminalClaimRoot = null;
        this.boundTerminalClaimTextarea = null;
        this.boundTerminalClaimHandler = null;
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
            fontFamily: TERMINAL_FONT_FAMILY,
            fontSize: getTerminalFontSize(),
            rows: this.rows,
            cols: this.cols,
            theme: buildMainTerminalTheme()
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
            if (!this.isMainTerminalVisible()) {
                return;
            }
            this.previewTerm.resize(size.cols, size.rows);
            this.updatePreviewScale();

            const pending = getPendingSession(this.key);
            pending.resize = { cols: size.cols, rows: size.rows };
        });
    }

    recreateTerminals() {
        const wasActive = state.activeSessionKey === this.key;
        const previewWrapper = this.wrapperElement;

        this.unbindTerminalControlClaim();

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
            this.bindTerminalControlClaim();
            if (this.fitMainTerminalIfVisible()) {
                this.mainTerm.focus();
            }
        }
    }

    applySharedWorkspaceSnapshot(nextWorkspaceState) {
        const normalized = normalizeWorkspaceSnapshot(
            nextWorkspaceState,
            this.sharedWorkspaceState
        );
        const resolveFallbackActiveKey = () => {
            if (this.editorState.activeFilePath) {
                return makeFileWorkspaceTabKey(this.editorState.activeFilePath);
            }
            const agentTab = getAgentTabsForSession(this)[0];
            if (agentTab) {
                return agentTab.key;
            }
            return normalized.terminalDisplayMode === 'tab'
                ? TERMINAL_WORKSPACE_TAB_KEY
                : '';
        };
        this.sharedWorkspaceState = normalized;
        this.editorState.isVisible = normalized.isVisible;
        this.editorState.openFiles = [...normalized.openFiles];

        if (
            this.editorState.activeFilePath
            && !this.editorState.openFiles.includes(
                this.editorState.activeFilePath
            )
        ) {
            this.editorState.activeFilePath = this.editorState.openFiles[0]
                || null;
        }

        const activeKey = this.workspaceState.activeTabKey || '';
        if (isFileWorkspaceTabKey(activeKey)) {
            const filePath = workspaceKeyToFilePath(activeKey);
            if (!this.editorState.openFiles.includes(filePath)) {
                this.workspaceState.activeTabKey = resolveFallbackActiveKey();
            }
        } else if (
            isTerminalWorkspaceTabKey(activeKey)
            && normalized.terminalDisplayMode !== 'tab'
        ) {
            this.workspaceState.activeTabKey = resolveFallbackActiveKey();
        }

        const lastNonTerminalKey =
            this.workspaceState.lastNonTerminalTabKey || '';
        if (isFileWorkspaceTabKey(lastNonTerminalKey)) {
            const filePath = workspaceKeyToFilePath(lastNonTerminalKey);
            if (!this.editorState.openFiles.includes(filePath)) {
                this.workspaceState.lastNonTerminalTabKey = '';
            }
        }
    }

    update(data) {
        let changed = false;
        let workspaceChanged = false;
        const nextManaged = normalizeManagedSessionMeta(data.managed);
        if (
            JSON.stringify(nextManaged) !== JSON.stringify(this.managed || null)
        ) {
            this.managed = nextManaged;
            changed = true;
        }
        if (!!data.closed !== this.closed) {
            this.closed = !!data.closed;
            changed = true;
        }
        if (
            JSON.stringify(data.exitStatus || null)
            !== JSON.stringify(this.exitStatus || null)
        ) {
            this.exitStatus = data.exitStatus || null;
            changed = true;
        }
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

        const nextWorkspaceState = data.workspaceState
            && typeof data.workspaceState === 'object'
            ? data.workspaceState
            : (
                data.editorState
                && typeof data.editorState === 'object'
                    ? data.editorState
                    : null
            );
        if (
            nextWorkspaceState
            && compareWorkspaceSnapshots(
                nextWorkspaceState,
                this.sharedWorkspaceState
            ) > 0
        ) {
            const previousSnapshot = JSON.stringify(this.sharedWorkspaceState);
            this.applySharedWorkspaceSnapshot(nextWorkspaceState);
            const nextSnapshot = JSON.stringify(this.sharedWorkspaceState);
            if (previousSnapshot !== nextSnapshot) {
                changed = true;
                workspaceChanged = true;
            }
        }

        if (
            data.cols
            && data.rows
            && (data.cols !== this.cols || data.rows !== this.rows)
        ) {
            this.cols = data.cols;
            this.rows = data.rows;
            if (this.previewTerm) {
                this.previewTerm.resize(this.cols, this.rows);
                this.updatePreviewScale();
            }
        }

        if (changed) {
            this.updateTabUI();
            if (workspaceChanged) {
                if (this.fileTreeElement) {
                    if (this.editorState.isVisible) {
                        editorManager.requestSessionTreeRefresh(this);
                    } else {
                        this.fileTreeElement.innerHTML = '';
                    }
                }
                editorManager.updateTreeAutoRefresh();
            }
            if (workspaceChanged && state.activeSessionKey === this.key) {
                refreshWorkspaceIfSessionActive(this);
            }
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
            const tabElement = this.wrapperElement.closest('.tab-item');
            const availableWidth = container.clientWidth;
            
            // Calculate scale to fit width
            const scale = availableWidth / termWidth;
            
            this.wrapperElement.style.width = `${termWidth}px`;
            this.wrapperElement.style.height = `${termHeight}px`;
            
            const scaledHeight = termHeight * scale;
            const overlayMinHeight = syncSessionTabMinimumHeight(tabElement);
            const targetHeight = Math.max(scaledHeight, overlayMinHeight);
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

    schedulePreviewRelayout() {
        if (this.previewRelayoutScheduled) return;
        this.previewRelayoutScheduled = true;
        requestAnimationFrame(() => {
            this.previewRelayoutScheduled = false;
            this.updatePreviewScale();
        });
    }

    updateTabUI() {
        const tab = tabListEl.querySelector(`[data-session-key="${this.key}"]`);
        if (!tab) return;

        tab.classList.toggle('editor-open', !!this.editorState?.isVisible);
        tab.classList.toggle('agent-managed-session', isAgentManagedSession(this));
        tab.classList.toggle('agent-open', getAgentTabsForSession(this).length > 0);

        if (this.env) {
            tab.title = this.env;
        }

        const titleEl = tab.querySelector('.title');
        const titleTextEl = tab.querySelector('.tab-title-text');
        if (titleTextEl) {
            titleTextEl.textContent = this.title;
        } else if (titleEl) {
            titleEl.textContent = this.title;
        }

        const titleIconEl = tab.querySelector('.tab-status-icon');
        applyStatusIconState(
            titleIconEl,
            isAgentManagedSession(this)
                ? MANAGED_TERMINAL_ICON_SVG
                : TERMINAL_TAB_ICON_SVG,
            getSessionTerminalIndicatorState(this)
        );

        const agentBtn = tab.querySelector('.toggle-agent-btn');
        applyStatusIconState(
            agentBtn,
            AGENT_ICON_SVG,
            getSessionAgentIndicatorState(this)
        );

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

        const metaTimeEl = tab.querySelector('.meta-time');
        if (metaTimeEl) {
            if (isAgentManagedSession(this)) {
                metaTimeEl.textContent = `MANAGED: ${getManagedSessionLabel(this)}`;
                metaTimeEl.classList.add('meta-managed');
            } else {
                const d = new Date(this.createdAt);
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                let hh = d.getHours();
                const min = String(d.getMinutes()).padStart(2, '0');
                const ampm = hh >= 12 ? 'PM' : 'AM';
                hh = hh % 12;
                hh = hh ? hh : 12;
                const hhStr = String(hh).padStart(2, '0');
                metaTimeEl.textContent = `SINCE: ${mm}-${dd} ${hhStr}:${min} ${ampm}`;
                metaTimeEl.classList.remove('meta-managed');
            }
        }

        syncSessionTabMinimumHeight(tab);
        if (this.wrapperElement && window.innerWidth >= 768) {
            this.schedulePreviewRelayout();
        }
    }

    saveState({ touchWorkspace = false } = {}) {
        if (!touchWorkspace) {
            return;
        }
        const pending = getPendingSession(this.key);
        pending.workspaceState = touchSharedWorkspace(this);
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
                        if (this.fitMainTerminalIfVisible()) {
                            this.mainTerm.focus();
                        }
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
                if (message.status === 'terminated') {
                    this.closed = true;
                    if (isAgentManagedSession(this) && !isTerminalViewVisible(this)) {
                        this.needsAttention = true;
                        alert(
                            `${this.title} finished under ${getManagedSessionLabel(this)}.`,
                            {
                                type: 'success',
                                title: 'Managed Terminal'
                            }
                        );
                    }
                }
                if (
                    !isAgentManagedSession(this)
                    && state.activeSessionKey === this.key
                ) {
                    setStatus(this.server, message.status);
                }
                if (isTerminalViewVisible(this)) {
                    this.needsAttention = false;
                }
                this.updateTabUI();
                break;
            case 'execution':
                this.handleExecutionMessage(message);
                break;
        }
    }

    handleExecutionMessage(message) {
        if (message.phase === 'started') {
            if (isIgnoredTerminalExecutionCommand(message.command || '')) {
                this.runningExecutionId = '';
                this.runningCommand = '';
                return;
            }
            this.runningExecutionId = String(message.executionId || '');
            this.runningCommand = message.command || '';
            this.needsAttention = false;
            this.updateTabUI();
            if (state.activeSessionKey === this.key) {
                editorManager.renderEditorTabs();
            }
            return;
        }

        if (message.phase === 'idle') {
            this.runningExecutionId = '';
            this.runningCommand = '';
            this.needsAttention = false;
            this.updateTabUI();
            if (this.editorState.isVisible) {
                editorManager.requestSessionTreeRefresh(this);
            }
            if (state.activeSessionKey === this.key) {
                editorManager.renderEditorTabs();
            }
            return;
        }

        if (message.phase !== 'completed') {
            return;
        }

        const executionId = String(
            message.executionId
            || this.runningExecutionId
            || `${message.entry?.completedAt || ''}:${message.entry?.command || ''}`
        );
        if (
            isIgnoredTerminalExecutionCommand(message.entry?.command || '')
        ) {
            this.lastExecutionEntry = null;
            this.runningExecutionId = '';
            this.runningCommand = '';
            this.needsAttention = false;
            this.updateTabUI();
            if (state.activeSessionKey === this.key) {
                editorManager.renderEditorTabs();
            }
            return;
        }
        this.lastExecutionEntry = message.entry || null;
        this.runningExecutionId = '';
        this.runningCommand = '';

        if (
            state.activeSessionKey !== this.key
            && !isAgentManagedSession(this)
        ) {
            this.needsAttention = true;
            if (this.lastNotifiedExecutionId !== executionId) {
                this.lastNotifiedExecutionId = executionId;
                const command = this.lastExecutionEntry?.command || 'command';
                const exitCode = Number.isFinite(this.lastExecutionEntry?.exitCode)
                    ? this.lastExecutionEntry.exitCode
                    : null;
                const type = exitCode === 0 ? 'success' : 'warning';
                const statusText = exitCode === 0
                    ? 'completed'
                    : `finished with exit code ${exitCode}`;
                alert(
                    `${command} ${statusText} on ${getDisplayHost(this.server)}.`,
                    {
                        type,
                        title: 'Terminal'
                    }
                );
            }
        } else {
            this.needsAttention = false;
        }

        if (this.editorState.isVisible) {
            editorManager.requestSessionTreeRefresh(this);
        }

        this.updateTabUI();
        if (state.activeSessionKey === this.key) {
            editorManager.renderEditorTabs();
        }
    }

    writeToTerminals(data) {
        if (this.previewTerm) this.previewTerm.write(data);
        this.mainTerm.write(data);
    }

    isMainTerminalVisible() {
        if (state.activeSessionKey !== this.key) {
            return false;
        }
        if (!terminalEl || !this.mainTerm?.element) {
            return false;
        }
        if (!terminalEl.contains(this.mainTerm.element)) {
            return false;
        }
        const viewport = terminalWrapper || terminalEl;
        if (!viewport?.isConnected) {
            return false;
        }
        const style = window.getComputedStyle(viewport);
        if (style.display === 'none' || style.visibility === 'hidden') {
            return false;
        }
        return terminalEl.clientWidth > 0 && terminalEl.clientHeight > 0;
    }

    fitMainTerminalIfVisible() {
        if (!this.isMainTerminalVisible()) {
            return false;
        }
        this.mainFitAddon.fit();
        return true;
    }

    send(payload) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
        }
    }

    claimTerminalControl(force = false) {
        if (state.activeSessionKey !== this.key) {
            return;
        }
        if (this.socket?.readyState !== WebSocket.OPEN) {
            return;
        }

        const now = Date.now();
        if (!force && now - this.lastTerminalControlClaimAt < 250) {
            return;
        }

        this.lastTerminalControlClaimAt = now;
        this.send({ type: 'claim_terminal_control' });
    }

    bindTerminalControlClaim() {
        this.unbindTerminalControlClaim();

        const root = this.mainTerm?.element;
        if (!root) {
            return;
        }

        const textarea = this.mainTerm.textarea
            || root.querySelector('textarea');
        const handler = () => this.claimTerminalControl();

        root.addEventListener('mousedown', handler, true);
        root.addEventListener('touchstart', handler, true);
        if (textarea) {
            textarea.addEventListener('keydown', handler, true);
            textarea.addEventListener('paste', handler, true);
        }

        this.boundTerminalClaimRoot = root;
        this.boundTerminalClaimTextarea = textarea;
        this.boundTerminalClaimHandler = handler;
    }

    unbindTerminalControlClaim() {
        const handler = this.boundTerminalClaimHandler;
        if (!handler) {
            return;
        }

        this.boundTerminalClaimRoot?.removeEventListener(
            'mousedown',
            handler,
            true
        );
        this.boundTerminalClaimRoot?.removeEventListener(
            'touchstart',
            handler,
            true
        );
        this.boundTerminalClaimTextarea?.removeEventListener(
            'keydown',
            handler,
            true
        );
        this.boundTerminalClaimTextarea?.removeEventListener(
            'paste',
            handler,
            true
        );

        this.boundTerminalClaimRoot = null;
        this.boundTerminalClaimTextarea = null;
        this.boundTerminalClaimHandler = null;
    }

    reportResize() {
        if (!this.isMainTerminalVisible()) {
            return;
        }
        if (this.mainTerm.cols && this.mainTerm.rows) {
            this.send({
                type: 'resize',
                cols: this.mainTerm.cols,
                rows: this.mainTerm.rows
            });
        }
    }

    dispose() {
        this.shouldReconnect = false;
        clearTimeout(this.retryTimer);
        this.socket?.close();
        this.unbindTerminalControlClaim();
        
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
        this.needsAttention = false;
        this.runCounter = 0;
        this.lastCompletedRunCounter = 0;
        this.promptDraft = '';
        this.promptHistory = [];
        this.promptHistoryIndex = null;
        this.pendingAttachments = [];
        this.queuedPrompts = [];
        this.queueCounter = 0;
        this.isDrainingQueuedPrompt = false;
        this.scrollToBottomOnNextRender = true;
        this.busySyncTimer = null;
        this.planHistory = [];
        this.resumeSessions = [];
        this.resumeSessionsLoadedAt = 0;
        this.resumeSessionsPromise = null;
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
        session.updateTabUI();
        refreshWorkspaceIfSessionActive(session);
    }

    update(data) {
        const previousResumeCacheKey = `${this.agentId || ''}:${this.cwd || ''}`;
        this.runtimeId = data.runtimeId || '';
        this.runtimeKey = data.runtimeKey || '';
        this.acpSessionId = data.acpSessionId || '';
        this.agentId = data.agentId || '';
        this.agentLabel = data.agentLabel || 'Agent';
        this.title = typeof data.title === 'string' ? data.title : '';
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
        this.sessionCapabilities = normalizeAgentSessionCapabilities(
            data.sessionCapabilities || this.sessionCapabilities
        );
        this.configOptions = Array.isArray(data.configOptions)
            ? data.configOptions
            : [];
        const nextResumeCacheKey = `${this.agentId || ''}:${this.cwd || ''}`;
        if (previousResumeCacheKey !== nextResumeCacheKey) {
            this.resumeSessions = [];
            this.resumeSessionsLoadedAt = 0;
        }
        const nextPlan = Array.isArray(data.plan)
            ? data.plan.map((entry) => this.#normalizePlanEntry(entry))
            : [];
        this.usage = this.#normalizeUsageState(data.usage);
        this.needsAttention = Boolean(this.needsAttention);
        this.runCounter = Number.isFinite(this.runCounter)
            ? this.runCounter
            : (this.busy ? 1 : 0);
        this.lastCompletedRunCounter = Number.isFinite(
            this.lastCompletedRunCounter
        )
            ? this.lastCompletedRunCounter
            : 0;
        this.timelineCounter = 0;
        this.messages = Array.isArray(data.messages)
            ? data.messages.map((message) => this.#normalizeMessage(message))
            : [];
        const transcriptPromptHistory = this.messages
            .filter((message) => (
                String(message?.role || '').toLowerCase() === 'user'
                && String(message?.kind || 'message').toLowerCase()
                    === 'message'
                && String(message?.text || '').trim()
            ))
            .map((message) => String(message.text).trim());
        if (transcriptPromptHistory.length >= this.promptHistory.length) {
            this.promptHistory = transcriptPromptHistory;
        }
        this.toolCalls = new Map();
        for (const toolCall of data.toolCalls || []) {
            if (toolCall?.toolCallId) {
                this.toolCalls.set(
                    toolCall.toolCallId,
                    this.#normalizeTimelineEntry(toolCall)
                );
            }
        }
        this.permissions = new Map();
        for (const permission of data.permissions || []) {
            if (permission?.id) {
                this.permissions.set(
                    permission.id,
                    this.#normalizeTimelineEntry(permission)
                );
            }
        }
        this.terminals = new Map();
        for (const terminal of data.terminals || []) {
            if (terminal?.terminalId) {
                this.terminals.set(
                    terminal.terminalId,
                    this.#normalizeTerminalSummary(terminal)
                );
            }
        }
        for (const summary of this.terminals.values()) {
            if (shouldSyncManagedTerminalSession(this.server, summary)) {
                scheduleManagedTerminalSessionSync(
                    this.server,
                    String(summary.terminalSessionId || '').trim()
                );
            }
        }
        this.#applyPlanState(nextPlan);
        this.#syncBusyWatchdog();
    }

    async listResumeSessions({ force = false } = {}) {
        if (!supportsAgentResumeCommand(this)) {
            return [];
        }
        if (
            !force
            && this.resumeSessionsLoadedAt > 0
            && (Date.now() - this.resumeSessionsLoadedAt) < 30 * 1000
        ) {
            return this.resumeSessions;
        }
        if (this.resumeSessionsPromise) {
            return this.resumeSessionsPromise;
        }

        this.resumeSessionsPromise = (async () => {
            const cwd = this.cwd || this.getLinkedSession()?.cwd || '';
            const params = new URLSearchParams({
                agentId: this.agentId,
                cwd
            });
            const response = await this.server.fetch(
                `/api/agents/sessions?${params.toString()}`
            );
            if (!response.ok) {
                await throwResponseError(
                    response,
                    'Failed to load previous sessions'
                );
            }
            const data = await response.json();
            this.resumeSessions = normalizeListedAgentSessions(data.sessions);
            this.resumeSessionsLoadedAt = Date.now();
            return this.resumeSessions;
        })();

        try {
            return await this.resumeSessionsPromise;
        } finally {
            this.resumeSessionsPromise = null;
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
        const wasBusy = this.busy;
        switch (message.type) {
            case 'snapshot':
                this.update(message.tab || {});
                this.scrollToBottomOnNextRender = true;
                break;
            case 'message_open':
                this.#upsertMessage(message.message);
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
                if (Array.isArray(message.tab?.configOptions)) {
                    this.configOptions = message.tab.configOptions;
                }
                if (typeof message.tab?.title === 'string') {
                    this.title = message.tab.title;
                }
                break;
            case 'permission_request':
                if (message.permission?.id) {
                    const previous = this.permissions.get(message.permission.id);
                    this.permissions.set(message.permission.id, {
                        ...previous,
                        ...this.#normalizeTimelineEntry(
                            message.permission,
                            previous?.order
                        )
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
            case 'terminal_update':
                if (message.terminal?.terminalId) {
                    const previous = this.terminals.get(
                        message.terminal.terminalId
                    ) || {};
                    const nextSummary = this.#normalizeTerminalSummary({
                        ...previous,
                        ...message.terminal
                    });
                    this.terminals.set(
                        message.terminal.terminalId,
                        nextSummary
                    );
                    if (shouldSyncManagedTerminalSession(
                        this.server,
                        nextSummary,
                        previous
                    )) {
                        scheduleManagedTerminalSessionSync(
                            this.server,
                            String(nextSummary.terminalSessionId || '').trim()
                        );
                    }
                    const session = this.getLinkedSession();
                    if (session) {
                        session.updateTabUI();
                    }
                    if (
                        editorManager?.refreshVisibleAgentTerminals?.(
                            this,
                            message.terminal.terminalId
                        )
                    ) {
                        this.#syncBusyWatchdog();
                        return;
                    }
                }
                break;
            case 'usage_state':
                this.usage = this.#normalizeUsageState(message.usage);
                break;
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
        const shouldAutostartQueuedPrompt = (
            wasBusy
            && !this.busy
            && canAutostartQueuedAgentPrompt(this)
        );
        if (!wasBusy && this.busy) {
            this.runCounter += 1;
            this.needsAttention = false;
        } else if (
            wasBusy
            && !this.busy
            && message.type !== 'snapshot'
            && !shouldAutostartQueuedPrompt
            && this.lastCompletedRunCounter !== this.runCounter
        ) {
            this.lastCompletedRunCounter = this.runCounter;
            if (!isAgentTabVisible(this)) {
                this.needsAttention = true;
                const label = getAgentBaseName(this);
                const title = this.errorMessage ? `${label} error` : label;
                const messageText = this.errorMessage
                    || 'Finished responding in this workspace.';
                alert(messageText, {
                    type: this.errorMessage ? 'warning' : 'success',
                    title
                });
            } else {
                this.needsAttention = false;
            }
        } else if (isAgentTabVisible(this)) {
            this.needsAttention = false;
        }
        this.#syncBusyWatchdog();
        this.notifyUi();
        if (shouldAutostartQueuedPrompt) {
            this.lastCompletedRunCounter = this.runCounter;
            void drainQueuedAgentPrompt(this);
        }
    }

    #hasPendingPermission() {
        return getAgentOrderedMapValues(this.permissions).some(
            (permission) => permission.status === 'pending'
        );
    }

    #hasActiveTool() {
        return getAgentOrderedMapValues(this.toolCalls).some((toolCall) => {
            const statusClass = getEffectiveAgentToolStatus(toolCall, this);
            return statusClass === 'pending' || statusClass === 'running';
        });
    }

    #needsBusyStateRefresh() {
        return !!(
            this.busy
            && !this.isDrainingQueuedPrompt
            && !this.errorMessage
            && this.status !== 'restoring'
            && !this.#hasPendingPermission()
            && !this.#hasActiveTool()
        );
    }

    #clearBusyWatchdog() {
        if (this.busySyncTimer) {
            clearTimeout(this.busySyncTimer);
            this.busySyncTimer = null;
        }
    }

    #syncBusyWatchdog() {
        this.#clearBusyWatchdog();
        if (!this.#needsBusyStateRefresh()) {
            return;
        }
        this.busySyncTimer = setTimeout(async () => {
            this.busySyncTimer = null;
            if (!this.#needsBusyStateRefresh()) {
                return;
            }
            try {
                await syncAgentsForServer(this.server, { force: true });
            } catch {
                // Ignore transient refresh failures; the next event or sync
                // will reconcile the state.
            } finally {
                if (this.#needsBusyStateRefresh()) {
                    this.#syncBusyWatchdog();
                }
            }
        }, 2000);
    }

    #normalizeTimelineEntry(entry, fallbackOrder = null) {
        const nextEntry = { ...entry };
        nextEntry.createdAt = typeof nextEntry.createdAt === 'string'
            ? nextEntry.createdAt
            : '';
        if (Number.isFinite(nextEntry.order)) {
            this.timelineCounter = Math.max(this.timelineCounter, nextEntry.order);
            return nextEntry;
        }
        nextEntry.order = Number.isFinite(fallbackOrder)
            ? fallbackOrder
            : this.#nextTimelineOrder();
        return nextEntry;
    }

    #normalizeMessage(message, fallbackOrder = null) {
        const nextMessage = this.#normalizeTimelineEntry(message, fallbackOrder);
        nextMessage.text = typeof nextMessage.text === 'string'
            ? nextMessage.text
            : '';
        nextMessage.createdAt = typeof nextMessage.createdAt === 'string'
            ? nextMessage.createdAt
            : '';
        nextMessage.attachments = normalizeAgentMessageAttachments(
            nextMessage.attachments
        );
        return nextMessage;
    }

    #normalizePlanEntry(entry) {
        return {
            content: typeof entry?.content === 'string' ? entry.content : '',
            priority: typeof entry?.priority === 'string'
                ? entry.priority
                : 'medium',
            status: typeof entry?.status === 'string'
                ? entry.status
                : 'pending'
        };
    }

    #applyPlanState(nextPlan) {
        const previousPlan = Array.isArray(this.plan) ? this.plan : [];
        const previousWasComplete = isAgentPlanComplete(previousPlan);
        const nextIsComplete = isAgentPlanComplete(nextPlan);
        this.plan = nextPlan;
        if (nextIsComplete && !previousWasComplete) {
            this.#archiveCompletedPlan(nextPlan);
        }
    }

    #archiveCompletedPlan(entries) {
        const normalizedEntries = Array.isArray(entries)
            ? entries.map((entry) => this.#normalizePlanEntry(entry))
            : [];
        if (normalizedEntries.length === 0) {
            return;
        }
        const order = Number.isFinite(this.timelineCounter)
            ? this.timelineCounter + 0.5
            : 0.5;
        this.timelineCounter = Math.max(this.timelineCounter || 0, order);
        this.planHistory.push({
            id: `plan-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            order,
            summary: buildAgentPlanSummary(normalizedEntries),
            entries: normalizedEntries
        });
        this.scrollToBottomOnNextRender = true;
    }

    #normalizeUsageState(usage) {
        if (!usage || typeof usage !== 'object') return null;
        return {
            used: Number.isFinite(usage.used) ? usage.used : null,
            size: Number.isFinite(usage.size) ? usage.size : null,
            cost: usage.cost || null,
            totals: usage.totals || null,
            updatedAt: typeof usage.updatedAt === 'string'
                ? usage.updatedAt
                : '',
            resetAt: typeof usage.resetAt === 'string'
                ? usage.resetAt
                : '',
            vendorLabel: typeof usage.vendorLabel === 'string'
                ? usage.vendorLabel
                : '',
            sessionId: typeof usage.sessionId === 'string'
                ? usage.sessionId
                : '',
            summary: typeof usage.summary === 'string'
                ? usage.summary
                : '',
            windows: Array.isArray(usage.windows)
                ? usage.windows.map((item) => ({
                    label: typeof item?.label === 'string'
                        ? item.label
                        : '',
                    used: Number.isFinite(item?.used) ? item.used : null,
                    size: Number.isFinite(item?.size) ? item.size : null,
                    remaining: Number.isFinite(item?.remaining)
                        ? item.remaining
                        : null,
                    resetAt: typeof item?.resetAt === 'string'
                        ? item.resetAt
                        : '',
                    resetDisplay: typeof item?.resetDisplay === 'string'
                        ? item.resetDisplay
                        : '',
                    subtitle: typeof item?.subtitle === 'string'
                        ? item.subtitle
                        : ''
                }))
                : []
        };
    }

    #normalizeTerminalSummary(summary) {
        return {
            terminalId: String(summary?.terminalId || ''),
            terminalSessionId: String(summary?.terminalSessionId || ''),
            command: typeof summary?.command === 'string'
                ? summary.command
                : '',
            cwd: typeof summary?.cwd === 'string' ? summary.cwd : '',
            output: typeof summary?.output === 'string' ? summary.output : '',
            createdAt: typeof summary?.createdAt === 'string'
                ? summary.createdAt
                : '',
            updatedAt: typeof summary?.updatedAt === 'string'
                ? summary.updatedAt
                : '',
            released: !!summary?.released,
            running: !!summary?.running,
            exitStatus: summary?.exitStatus && typeof summary.exitStatus === 'object'
                ? {
                    exitCode: Number.isFinite(summary.exitStatus.exitCode)
                        ? summary.exitStatus.exitCode
                        : null,
                    signal: typeof summary.exitStatus.signal === 'string'
                        ? summary.exitStatus.signal
                        : null
                }
                : null
        };
    }

    #nextTimelineOrder() {
        this.timelineCounter = Math.max(this.timelineCounter || 0, 0) + 1;
        return this.timelineCounter;
    }

    #findMessageIndex(candidate) {
        if (!candidate) return -1;
        if (candidate.id) {
            const byId = this.messages.findIndex(
                (message) => message.id === candidate.id
            );
            if (byId !== -1) return byId;
        }
        if (!candidate.streamKey) return -1;
        for (let index = this.messages.length - 1; index >= 0; index -= 1) {
            const message = this.messages[index];
            if (
                message.streamKey === candidate.streamKey
                && message.role === candidate.role
                && message.kind === candidate.kind
            ) {
                return index;
            }
        }
        return -1;
    }

    #upsertMessage(message) {
        if (!message) return;
        const index = this.#findMessageIndex(message);
        if (index === -1) {
            this.messages.push(this.#normalizeMessage(message));
            return;
        }

        const previous = this.messages[index];
        const nextMessage = this.#normalizeMessage(message, previous.order);
        this.messages[index] = {
            ...previous,
            ...nextMessage,
            createdAt: nextMessage.createdAt || previous.createdAt || '',
            text: selectAgentMessageText(previous.text, nextMessage.text)
        };
    }

    #appendChunk(message) {
        const index = this.#findMessageIndex(message);
        if (index !== -1) {
            const existing = this.messages[index];
            existing.text = mergeAgentMessageText(
                existing.text || '',
                message.text || ''
            );
            return;
        }

        this.messages.push(this.#normalizeMessage({
            id: crypto.randomUUID(),
            streamKey: message.streamKey,
            role: message.role || 'assistant',
            kind: message.kind || 'message',
            text: message.text || '',
            createdAt: new Date().toISOString()
        }));
    }

    #applySessionUpdate(update) {
        switch (update.sessionUpdate) {
            case 'tool_call':
                if (update.toolCallId) {
                    const previous = this.toolCalls.get(update.toolCallId);
                    this.toolCalls.set(
                        update.toolCallId,
                        this.#normalizeTimelineEntry(update, previous?.order)
                    );
                }
                break;
            case 'tool_call_update': {
                const previous = this.toolCalls.get(update.toolCallId) || {};
                this.toolCalls.set(update.toolCallId, {
                    ...previous,
                    ...this.#normalizeTimelineEntry(update, previous.order)
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
            case 'config_option_update':
                this.configOptions = Array.isArray(update.configOptions)
                    ? update.configOptions
                    : [];
                break;
            case 'plan':
                this.#applyPlanState(
                    Array.isArray(update.entries)
                        ? update.entries.map((entry) =>
                            this.#normalizePlanEntry(entry)
                        )
                        : []
                );
                break;
            case 'usage_update':
                this.usage = this.#normalizeUsageState({
                    ...(this.usage || {}),
                    ...update
                });
                break;
            case 'session_info_update':
                if (typeof update.title === 'string') {
                    this.title = update.title;
                } else if (update.title === null) {
                    this.title = '';
                }
                break;
            default:
                break;
        }
    }

    async sendPrompt(text, attachments = []) {
        const baseline = {
            messageCount: this.messages.length,
            toolCount: this.toolCalls.size,
            permissionCount: this.permissions.size
        };
        const hasAttachments = Array.isArray(attachments)
            && attachments.length > 0;
        const request = {
            method: 'POST'
        };
        if (hasAttachments) {
            const formData = new FormData();
            formData.append('text', text);
            for (const attachment of attachments) {
                if (attachment?.file instanceof File) {
                    formData.append(
                        'attachments',
                        attachment.file,
                        attachment.name
                    );
                }
            }
            request.body = formData;
        } else {
            request.headers = { 'Content-Type': 'application/json' };
            request.body = JSON.stringify({ text });
        }
        const response = await this.server.fetch(
            `/api/agents/tabs/${this.id}/prompt`,
            request
        );
        if (!response.ok) {
            await throwResponseError(response, 'Failed to send prompt');
        }
        await syncAgentsForServer(this.server, { force: true });
        void this.#reconcilePromptStart(baseline);
    }

    async #reconcilePromptStart(baseline, timeoutMs = 4000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise((resolve) => {
                setTimeout(resolve, 200);
            });
            await syncAgentsForServer(this.server, { force: true });
            const current = state.agentTabs.get(this.key);
            if (!current) {
                return;
            }
            if (current.errorMessage || !current.busy) {
                return;
            }
            if (
                current.messages.length > baseline.messageCount
                || current.toolCalls.size > baseline.toolCount
                || current.permissions.size > baseline.permissionCount
            ) {
                return;
            }
        }
    }

    applyInventory(data) {
        const previousSession = this.getLinkedSession();
        const previousSnapshot = JSON.stringify({
            runtimeId: this.runtimeId || '',
            runtimeKey: this.runtimeKey || '',
            acpSessionId: this.acpSessionId || '',
            agentId: this.agentId || '',
            agentLabel: this.agentLabel || '',
            title: this.title || '',
            commandLabel: this.commandLabel || '',
            terminalSessionId: this.terminalSessionId || '',
            cwd: this.cwd || '',
            createdAt: this.createdAt || '',
            status: this.status || 'ready',
            busy: !!this.busy,
            errorMessage: this.errorMessage || '',
            currentModeId: this.currentModeId || '',
            sessionCapabilities: this.sessionCapabilities || null
        });
        this.runtimeId = data.runtimeId || this.runtimeId || '';
        this.runtimeKey = data.runtimeKey || this.runtimeKey || '';
        this.acpSessionId = data.acpSessionId || this.acpSessionId || '';
        this.agentId = data.agentId || this.agentId || '';
        this.agentLabel = data.agentLabel || this.agentLabel || 'Agent';
        this.title = typeof data.title === 'string' ? data.title : this.title;
        this.commandLabel = data.commandLabel || this.commandLabel || '';
        this.terminalSessionId = data.terminalSessionId || this.terminalSessionId;
        this.cwd = data.cwd || this.cwd || '';
        this.createdAt = data.createdAt || this.createdAt || new Date().toISOString();
        this.status = data.status || this.status || 'ready';
        this.busy = typeof data.busy === 'boolean' ? data.busy : this.busy;
        this.errorMessage = data.errorMessage || this.errorMessage || '';
        this.currentModeId = data.currentModeId || this.currentModeId || '';
        this.sessionCapabilities = normalizeAgentSessionCapabilities(
            data.sessionCapabilities || this.sessionCapabilities
        );
        const nextSession = this.getLinkedSession();
        const nextSnapshot = JSON.stringify({
            runtimeId: this.runtimeId || '',
            runtimeKey: this.runtimeKey || '',
            acpSessionId: this.acpSessionId || '',
            agentId: this.agentId || '',
            agentLabel: this.agentLabel || '',
            title: this.title || '',
            commandLabel: this.commandLabel || '',
            terminalSessionId: this.terminalSessionId || '',
            cwd: this.cwd || '',
            createdAt: this.createdAt || '',
            status: this.status || 'ready',
            busy: !!this.busy,
            errorMessage: this.errorMessage || '',
            currentModeId: this.currentModeId || '',
            sessionCapabilities: this.sessionCapabilities || null
        });
        const changed = previousSnapshot !== nextSnapshot
            || previousSession?.key !== nextSession?.key;
        if (!changed) {
            return false;
        }
        previousSession?.updateTabUI();
        if (nextSession && nextSession !== previousSession) {
            nextSession.updateTabUI();
        }
        if (nextSession) {
            refreshWorkspaceIfSessionActive(nextSession);
        }
        return true;
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

    async setConfigOption(configId, valueId) {
        const response = await this.server.fetch(
            `/api/agents/tabs/${this.id}/config`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configId, valueId })
            }
        );
        if (!response.ok) {
            await throwResponseError(
                response,
                'Failed to update agent setting'
            );
        }
        const data = await response.json();
        this.update(data);
        this.notifyUi();
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
        this.#clearBusyWatchdog();
        this.socket?.close();
        this.socket = null;
    }
}

function canAutostartQueuedAgentPrompt(agentTab) {
    return !!(
        agentTab
        && !agentTab.busy
        && !agentTab.errorMessage
        && agentTab.status !== 'disconnected'
        && agentTab.status !== 'restoring'
        && Array.isArray(agentTab.queuedPrompts)
        && agentTab.queuedPrompts.length > 0
    );
}

async function drainQueuedAgentPrompt(agentTab) {
    if (!canAutostartQueuedAgentPrompt(agentTab)) return;
    if (agentTab.isDrainingQueuedPrompt) return;

    const nextPrompt = agentTab.queuedPrompts[0];
    if (!nextPrompt) return;

    agentTab.isDrainingQueuedPrompt = true;
    try {
        agentTab.lastSubmittedPrompt = nextPrompt.text;
        await agentTab.sendPrompt(
            nextPrompt.text,
            Array.isArray(nextPrompt.attachments)
                ? nextPrompt.attachments
                : []
        );
        if (nextPrompt.text) {
            editorManager.recordAgentPromptHistory(agentTab, nextPrompt.text);
        }
        agentTab.queuedPrompts.shift();
        agentTab.busy = true;
        agentTab.status = 'running';
    } catch (error) {
        alert(error.message, {
            type: 'error',
            title: 'Agent'
        });
    } finally {
        agentTab.isDrainingQueuedPrompt = false;
        agentTab.notifyUi();
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
    sessions: new Map() // sessionKey -> { resize, workspaceState, fileWrites: Map<path, content> }
};

if (typeof window !== 'undefined') {
    window.__tabminalSmoke = {
        async syncMainServerSessions() {
            const server = getMainServer();
            if (!server) return false;
            const result = await syncServerSessionsNow(server);
            await new Promise((resolve) => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(resolve);
                });
            });
            return result;
        },
        applyMainServerSessions(sessions) {
            const server = getMainServer();
            if (!server) {
                return {
                    ok: false,
                    sessionKeys: [],
                    managedSessionKeys: []
                };
            }
            const remoteSessions = Array.isArray(sessions) ? sessions : [];
            reconcileSessions(server, remoteSessions);
            return {
                ok: true,
                sessionKeys: remoteSessions.map((session) => makeSessionKey(
                    server.id,
                    session.id
                )),
                managedSessionKeys: remoteSessions
                    .filter((session) => (
                        session?.managed?.kind === 'agent-terminal'
                    ))
                    .map((session) => makeSessionKey(
                        server.id,
                        session.id
                    ))
            };
        },
        getManagedSessionKeys() {
            return Array.from(state.sessions.values())
                .filter((session) => isAgentManagedSession(session))
                .map((session) => session.key);
        }
    };
}

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

function getDocumentTitle() {
    const server = getActiveServer();
    if (!server) {
        return 'Tabminal';
    }
    const host = String(getDisplayHost(server) || '').trim();
    if (!host || host.toLowerCase() === 'unknown') {
        return 'Tabminal';
    }
    return `Tabminal: ${host}`;
}

function updateDocumentTitle() {
    const nextTitle = getDocumentTitle();
    if (document.title !== nextTitle) {
        document.title = nextTitle;
    }
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

function shouldSyncManagedTerminalSession(server, nextSummary, _previous = null) {
    if (!server || !nextSummary) return false;
    const nextSessionId = String(nextSummary.terminalSessionId || '').trim();
    if (!nextSessionId) return false;
    if (nextSummary.released) {
        return false;
    }
    return !state.sessions.has(makeSessionKey(server.id, nextSessionId));
}

function requestImmediateServerSync(server, delayMs = 40) {
    if (!server || !server.isAuthenticated) return;
    server.nextSyncAt = 0;
    if (server.syncPromise) {
        server.pendingImmediateSync = true;
        return;
    }
    if (server.immediateSyncTimer) return;
    server.immediateSyncTimer = window.setTimeout(() => {
        server.immediateSyncTimer = null;
        void syncServer(server);
    }, delayMs);
}

const managedSessionSyncRetryTimers = new Map();

function clearManagedSessionSyncRetry(serverId, sessionId) {
    const retryKey = `${serverId}:${sessionId}`;
    const timer = managedSessionSyncRetryTimers.get(retryKey);
    if (timer) {
        clearTimeout(timer);
        managedSessionSyncRetryTimers.delete(retryKey);
    }
}

function scheduleManagedTerminalSessionSync(
    server,
    terminalSessionId,
    attemptsRemaining = 20
) {
    if (!server || !server.isAuthenticated || !terminalSessionId) {
        return;
    }

    const sessionKey = makeSessionKey(server.id, terminalSessionId);
    if (state.sessions.has(sessionKey)) {
        clearManagedSessionSyncRetry(server.id, terminalSessionId);
        return;
    }

    const retryKey = `${server.id}:${terminalSessionId}`;
    if (managedSessionSyncRetryTimers.has(retryKey)) {
        return;
    }

    const runSyncAttempt = async () => {
        try {
            await syncServerSessionsNow(server);
        } catch {
            requestImmediateServerSync(server);
        }

        if (state.sessions.has(sessionKey)) {
            clearManagedSessionSyncRetry(server.id, terminalSessionId);
            return;
        }

        if (attemptsRemaining <= 0) {
            clearManagedSessionSyncRetry(server.id, terminalSessionId);
            return;
        }

        const timer = window.setTimeout(() => {
            managedSessionSyncRetryTimers.delete(retryKey);
            scheduleManagedTerminalSessionSync(
                server,
                terminalSessionId,
                attemptsRemaining - 1
            );
        }, 250);
        managedSessionSyncRetryTimers.set(retryKey, timer);
    };

    void runSyncAttempt();
}

async function syncServerSessionsNow(server) {
    if (!server || !server.isAuthenticated) {
        return {
            ok: false,
            sessionKeys: [],
            managedSessionKeys: []
        };
    }
    const response = await server.fetch('/api/heartbeat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            updates: { sessions: [] }
        })
    });
    if (!response.ok) {
        return {
            ok: false,
            sessionKeys: [],
            managedSessionKeys: []
        };
    }
    const data = await response.json();
    reconcileSessions(server, data.sessions || []);
    const sessionKeys = Array.isArray(data.sessions)
        ? data.sessions.map((session) => makeSessionKey(
            server.id,
            session.id
        ))
        : [];
    const managedSessionKeys = Array.isArray(data.sessions)
        ? data.sessions
            .filter((session) => (
                session?.managed?.kind === 'agent-terminal'
            ))
            .map((session) => makeSessionKey(
                server.id,
                session.id
            ))
        : [];
    return {
        ok: true,
        sessionKeys,
        managedSessionKeys
    };
}

function getAgentTabsForSession(session) {
    if (!session) return [];
    return getAgentTabsForServer(session.serverId).filter(
        (tab) => tab.terminalSessionId === session.id
    );
}

function getWorkspaceTabKeysForSession(session) {
    if (!session) return [];
    const keys = [];
    if (editorManager?.hasCompactWorkspaceTabs?.(session)) {
        keys.push(TERMINAL_WORKSPACE_TAB_KEY);
    }
    for (const path of session.editorState?.openFiles || []) {
        keys.push(makeFileWorkspaceTabKey(path));
    }
    for (const agentTab of getAgentTabsForSession(session)) {
        keys.push(agentTab.key);
    }
    return keys;
}

function getActiveAgentTab() {
    const activeSession = getActiveSession();
    if (!activeSession) return null;
    const activeKey = activeSession.workspaceState?.activeTabKey || '';
    if (!isAgentWorkspaceTabKey(activeKey)) return null;
    return state.agentTabs.get(activeKey) || null;
}

function getStatusIconMarkup(baseIconSvg, state = 'idle') {
    if (state === 'running') return SPINNER_ICON_SVG;
    if (state === 'attention') return BELL_ICON_SVG;
    return baseIconSvg;
}

function applyStatusIconState(element, baseIconSvg, state = 'idle') {
    if (!element) return;
    element.innerHTML = getStatusIconMarkup(baseIconSvg, state);
    element.classList.toggle('is-running', state === 'running');
    element.classList.toggle('is-attention', state === 'attention');
}

function getSessionTerminalIndicatorState(session) {
    if (!session) return 'idle';
    if (session.runningCommand) return 'running';
    if (session.needsAttention) return 'attention';
    return 'idle';
}

function getSessionTabOverlayMinHeight(tabElement) {
    if (!tabElement) return 0;
    const overlay = tabElement.querySelector('.tab-info-overlay');
    if (!overlay) return 0;
    const scrollHeight = Number(overlay.scrollHeight) || 0;
    const offsetHeight = Number(overlay.offsetHeight) || 0;
    return Math.ceil(Math.max(scrollHeight, offsetHeight, 0));
}

function syncSessionTabMinimumHeight(tabElement) {
    if (!tabElement) return 0;
    const previewContainer = tabElement.querySelector('.preview-container');
    const overlayMinHeight = getSessionTabOverlayMinHeight(tabElement);
    if (!previewContainer || !overlayMinHeight) {
        if (tabElement) {
            tabElement.style.minHeight = '';
        }
        return overlayMinHeight;
    }
    previewContainer.style.minHeight = `${overlayMinHeight}px`;
    tabElement.style.minHeight = `${overlayMinHeight}px`;
    return overlayMinHeight;
}

function getAgentTabIndicatorState(agentTab) {
    if (!agentTab) return 'idle';
    if (agentTab.busy) return 'running';
    if (agentTab.needsAttention) return 'attention';
    return 'idle';
}

function getSessionAgentIndicatorState(session) {
    const tabs = getAgentTabsForSession(session);
    if (tabs.some((tab) => tab.busy)) return 'running';
    if (tabs.some((tab) => tab.needsAttention)) return 'attention';
    return 'idle';
}

function isTerminalViewVisible(session) {
    if (!session || state.activeSessionKey !== session.key) return false;
    if (document.visibilityState !== 'visible') return false;
    if (!editorManager.hasCompactWorkspaceTabs(session)) return true;
    return editorManager.getActiveWorkspaceTabKey(session)
        === TERMINAL_WORKSPACE_TAB_KEY;
}

function isAgentTabVisible(agentTab) {
    const session = agentTab?.getLinkedSession?.() || null;
    if (!session || state.activeSessionKey !== session.key) return false;
    if (document.visibilityState !== 'visible') return false;
    return editorManager.getActiveWorkspaceTabKey(session) === agentTab.key;
}

function clearTerminalAttentionIfVisible(session) {
    if (!session?.needsAttention || !isTerminalViewVisible(session)) return;
    session.needsAttention = false;
    session.updateTabUI();
    if (state.activeSessionKey === session.key) {
        editorManager.renderEditorTabs();
    }
}

function clearAgentAttentionIfVisible(agentTab) {
    if (!agentTab?.needsAttention || !isAgentTabVisible(agentTab)) return;
    agentTab.needsAttention = false;
    agentTab.notifyUi();
}

function clearVisibleAttentionState(session = getActiveSession()) {
    if (!session) return;
    clearTerminalAttentionIfVisible(session);
    clearAgentAttentionIfVisible(getActiveAgentTab());
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

function normalizeAgentConfigOptions(configOptions) {
    if (!Array.isArray(configOptions)) return [];
    return configOptions.filter((option) => (
        option
        && option.type === 'select'
        && option.id
        && option.name
        && option.options
    ));
}

function normalizeAgentConfigOptionOptions(options) {
    if (!Array.isArray(options)) return [];
    if (options.every((option) => option && typeof option.value === 'string')) {
        return options.map((option) => ({ ...option, group: '' }));
    }
    const flattened = [];
    for (const group of options) {
        if (!group || !Array.isArray(group.options)) continue;
        for (const option of group.options) {
            if (!option || typeof option.value !== 'string') continue;
            flattened.push({
                ...option,
                group: String(group.name || '')
            });
        }
    }
    return flattened;
}

function normalizeAgentSessionCapabilities(sessionCapabilities) {
    const source = (
        sessionCapabilities && typeof sessionCapabilities === 'object'
    )
        ? sessionCapabilities
        : {};
    return {
        load: !!source.load,
        list: !!source.list,
        resume: !!source.resume,
        fork: !!source.fork
    };
}

function supportsAgentResumeCommand(agentTab) {
    const capabilities = normalizeAgentSessionCapabilities(
        agentTab?.sessionCapabilities
    );
    return !!(capabilities.load && capabilities.list);
}

function getAgentConfigOptionById(agentTab, configId) {
    return normalizeAgentConfigOptions(agentTab?.configOptions).find(
        (option) => option.id === configId
    ) || null;
}

function getAgentConfigOptionByCategory(agentTab, category) {
    const options = normalizeAgentConfigOptions(agentTab?.configOptions);
    const exact = options.find((option) => option.category === category);
    if (exact) return exact;
    if (category === 'model') {
        return options.find((option) => /model/i.test(
            `${option.id} ${option.name}`
        )) || null;
    }
    if (category === 'thought_level') {
        return options.find((option) => /(thought|reason|effort|depth)/i.test(
            `${option.id} ${option.name}`
        )) || null;
    }
    return null;
}

function updateAgentConfigSelect(selectEl, option) {
    if (!selectEl) return;
    const shell = selectEl.closest('.agent-panel-select-shell');
    const label = selectEl.getAttribute('aria-label') || 'Option';
    selectEl.innerHTML = '';
    selectEl.dataset.configId = '';
    selectEl.title = label;
    if (shell) {
        shell.title = label;
    }
    if (!option) {
        selectEl.style.display = 'none';
        if (shell) {
            shell.style.display = 'none';
        }
        return;
    }
    const normalizedOptions = normalizeAgentConfigOptionOptions(option.options);
    if (normalizedOptions.length <= 1) {
        selectEl.style.display = 'none';
        if (shell) {
            shell.style.display = 'none';
        }
        return;
    }
    const groups = new Map();
    for (const item of normalizedOptions) {
        const groupName = item.group || '';
        if (!groups.has(groupName)) {
            groups.set(groupName, []);
        }
        groups.get(groupName).push(item);
    }
    for (const [groupName, groupOptions] of groups) {
        const parent = groupName
            ? (() => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = groupName;
                selectEl.appendChild(optgroup);
                return optgroup;
            })()
            : selectEl;
        for (const item of groupOptions) {
            const optionEl = document.createElement('option');
            optionEl.value = item.value;
            optionEl.textContent = item.name;
            optionEl.title = item.description || item.name;
            optionEl.selected = item.value === option.currentValue;
            parent.appendChild(optionEl);
        }
    }
    selectEl.dataset.configId = option.id;
    selectEl.style.display = '';
    if (shell) {
        shell.style.display = '';
    }
    const selected = normalizedOptions.find((item) => (
        item.value === option.currentValue
    )) || normalizedOptions[0] || null;
    if (selected?.name) {
        const title = `${label}: ${selected.name}`;
        selectEl.title = title;
        if (shell) {
            shell.title = title;
        }
    }
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
                kind: 'command',
                name,
                description: command?.description || '',
                inputHint: command?.input?.hint || ''
            };
        })
        .filter(Boolean);
}

function normalizeListedAgentSessions(sessions) {
    if (!Array.isArray(sessions)) return [];
    const normalized = sessions
        .map((session, index) => {
            const sessionId = String(session?.sessionId || '').trim();
            const cwd = String(session?.cwd || '').trim();
            if (!sessionId || !cwd) return null;
            return {
                kind: 'resume_session',
                sortIndex: index,
                sessionId,
                cwd,
                title: typeof session?.title === 'string'
                    ? session.title
                    : '',
                updatedAt: typeof session?.updatedAt === 'string'
                    ? session.updatedAt
                    : '',
                relativeUpdatedAt: typeof session?.relativeUpdatedAt === 'string'
                    ? session.relativeUpdatedAt
                    : ''
            };
        })
        .filter(Boolean);
    normalized.sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt || '') || 0;
        const rightTime = Date.parse(right.updatedAt || '') || 0;
        if (leftTime !== rightTime) {
            return rightTime - leftTime;
        }
        return left.sortIndex - right.sortIndex;
    });
    return normalized;
}

function getOpenAgentSessionsForServer(serverId, agentId = '') {
    const entries = Array.from(state.agentTabs.values())
        .filter((tab) => (
            tab.serverId === serverId
            && (!agentId || tab.agentId === agentId)
        ))
        .map((tab) => [String(tab.acpSessionId || '').trim(), tab])
        .filter(([sessionId]) => !!sessionId);
    return new Map(entries);
}

function buildAgentResumeSessionMeta(sessionInfo) {
    const parts = [];
    const relativeUpdatedAt = String(
        sessionInfo?.relativeUpdatedAt || ''
    ).trim();
    if (relativeUpdatedAt) {
        parts.push(relativeUpdatedAt);
    }
    const timeLabel = getAgentMessageTimeLabel({
        createdAt: sessionInfo?.updatedAt || ''
    });
    if (timeLabel && !relativeUpdatedAt) {
        parts.push(timeLabel);
    }
    const cwd = String(sessionInfo?.cwd || '').trim();
    if (cwd) {
        parts.push(shortenPath(cwd, 48));
    }
    return parts.join(' · ');
}

function getAgentPromptIntent(agentTab, promptValue) {
    const source = String(promptValue || '').replace(/^\s+/, '');
    const firstLine = source.split('\n', 1)[0] || '';
    if (!firstLine.startsWith('/')) {
        return { kind: 'none', query: '', commandName: '' };
    }
    const body = firstLine.slice(1);
    const [commandNameRaw = '', ...restParts] = body.split(/\s+/);
    const commandName = commandNameRaw.toLowerCase();
    const query = restParts.join(' ').trim();
    if (!commandName) {
        return { kind: 'commands', query: '', commandName: '' };
    }
    if (commandName === 'resume' && supportsAgentResumeCommand(agentTab)) {
        return {
            kind: 'resume',
            query,
            commandName
        };
    }
    if (!/\s/.test(body)) {
        return {
            kind: 'commands',
            query: commandName,
            commandName
        };
    }
    return {
        kind: 'other',
        query,
        commandName
    };
}

function bindSingleTapActivation(element, onActivate, options = {}) {
    if (!element || typeof onActivate !== 'function') {
        return;
    }
    const ignoreSelector = options.ignoreSelector || '';
    let touchStartY = 0;
    let isScrolling = false;

    element.addEventListener('touchstart', (event) => {
        touchStartY = event.touches[0].clientY;
        isScrolling = false;
    }, { passive: true });

    element.addEventListener('touchmove', (event) => {
        if (Math.abs(event.touches[0].clientY - touchStartY) > 5) {
            isScrolling = true;
        }
    }, { passive: true });

    element.addEventListener('touchend', (event) => {
        if (isScrolling) return;
        if (ignoreSelector && event.target.closest(ignoreSelector)) {
            return;
        }
        if (event.cancelable) {
            event.preventDefault();
        }
        onActivate(event);
    });
}

function isIgnoredTerminalExecutionCommand(command) {
    return !!(
        command
        && (
            command.includes('TABMINAL_SHELL_READY=1')
            || command.includes('export PROMPT_COMMAND')
            || command.includes('__bash_prompt')
        )
    );
}

function formatAgentAttachmentSize(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }
    if (value < 1024) {
        return `${value} B`;
    }
    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function normalizeAgentComposerAttachments(files) {
    return Array.from(files || [])
        .filter((file) => file instanceof File && file.name)
        .map((file) => ({
            id: crypto.randomUUID(),
            file,
            name: file.name,
            mimeType: String(file.type || '').trim(),
            size: Number.isFinite(file.size) ? file.size : 0,
            lastModified: Number.isFinite(file.lastModified)
                ? file.lastModified
                : 0
        }));
}

function normalizeAgentMessageAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments
        .map((attachment) => {
            const name = String(attachment?.name || '').trim();
            if (!name) return null;
            return {
                id: String(attachment?.id || crypto.randomUUID()),
                name,
                mimeType: String(attachment?.mimeType || '').trim(),
                size: Number.isFinite(attachment?.size) ? attachment.size : 0
            };
        })
        .filter(Boolean);
}

function buildAgentAttachmentMetaLabel(attachment) {
    const parts = [];
    const mimeType = String(attachment?.mimeType || '').trim();
    if (mimeType) {
        parts.push(mimeType);
    }
    const sizeLabel = formatAgentAttachmentSize(attachment?.size);
    if (sizeLabel) {
        parts.push(sizeLabel);
    }
    return parts.join(' · ');
}

function buildAgentMessageAttachmentsNode(attachments) {
    const normalized = normalizeAgentMessageAttachments(attachments);
    if (normalized.length === 0) return null;

    const container = document.createElement('div');
    container.className = 'agent-message-attachments';

    for (const attachment of normalized) {
        const item = document.createElement('div');
        item.className = 'agent-message-attachment';

        const name = document.createElement('span');
        name.className = 'agent-message-attachment-name';
        name.textContent = attachment.name;
        item.appendChild(name);

        const detailText = buildAgentAttachmentMetaLabel(attachment);
        if (detailText) {
            const detail = document.createElement('span');
            detail.className = 'agent-message-attachment-detail';
            detail.textContent = detailText;
            item.appendChild(detail);
        }

        container.appendChild(item);
    }

    return container;
}

function mergeAgentMessageText(previousText, chunkText) {
    const previous = String(previousText || '');
    const chunk = String(chunkText || '');
    if (!previous) return chunk;
    if (!chunk) return previous;
    if (/\s$/.test(previous) || /^\s/.test(chunk)) {
        return `${previous}${chunk}`;
    }
    const previousLast = previous.slice(-1);
    const chunkFirst = chunk[0] || '';
    if (
        /[.!?`'")\]]/.test(previousLast)
        && /[A-Z`"'[(]/.test(chunkFirst)
    ) {
        return `${previous}\n\n${chunk}`;
    }
    return `${previous}${chunk}`;
}

function selectAgentMessageText(previousText, nextText) {
    const previous = String(previousText || '');
    const next = String(nextText || '');
    if (!previous) return next;
    if (!next) return previous;
    if (previous === next) return previous;
    if (next.startsWith(previous)) return next;
    if (previous.startsWith(next)) return previous;
    return previous;
}

function getAgentCommandSuggestions(agentTab, promptValue) {
    const intent = getAgentPromptIntent(agentTab, promptValue);
    if (intent.kind !== 'commands') return [];

    const commands = normalizeAgentCommands(agentTab?.availableCommands);
    if (supportsAgentResumeCommand(agentTab)) {
        commands.unshift({
            kind: 'command',
            name: 'resume',
            description: 'Continue from a previous session',
            inputHint: ''
        });
    }
    const query = String(intent.query || '').toLowerCase();
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

function getAgentResumeSuggestions(agentTab, promptValue, sessions = []) {
    const intent = getAgentPromptIntent(agentTab, promptValue);
    if (intent.kind !== 'resume') return [];
    const query = String(intent.query || '').toLowerCase();
    const openSessions = getOpenAgentSessionsForServer(
        agentTab?.serverId,
        agentTab?.agentId
    );
    const currentSessionId = String(agentTab?.acpSessionId || '').trim();
    return normalizeListedAgentSessions(sessions)
        .filter((session) => session.sessionId !== currentSessionId)
        .map((session, index) => {
            const displayName = String(
                session.title || shortenPath(session.cwd, 36)
            ).toLowerCase();
            const cwd = String(session.cwd || '').toLowerCase();
            const sessionId = String(session.sessionId || '').toLowerCase();
            const titleMatch = !query || displayName.includes(query);
            const otherMatch = !query || cwd.includes(query) || sessionId.includes(query);
            return {
                session,
                index,
                titleMatch,
                matched: titleMatch || otherMatch
            };
        })
        .filter(({ matched }) => matched)
        .sort((left, right) => {
            if (left.titleMatch !== right.titleMatch) {
                return left.titleMatch ? -1 : 1;
            }
            return left.index - right.index;
        })
        .map(({ session }) => session)
        .slice(0, 12)
        .map((session) => ({
            ...session,
            openTabKey: openSessions.get(session.sessionId)?.key || '',
            displayName: session.title || shortenPath(session.cwd, 36),
            description: [
                buildAgentResumeSessionMeta(session) || session.sessionId,
                openSessions.has(session.sessionId) ? 'Already open' : ''
            ].filter(Boolean).join(' · ')
        }));
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

function normalizeAgentDisplayName(label = 'Agent') {
    const rawLabel = String(label || 'Agent').trim();
    const cleaned = rawLabel.replace(
        /\s+(CLI|Agent|Adapter)$/i,
        ''
    ).trim();
    return cleaned || rawLabel || 'Agent';
}

function normalizeManagedSessionMeta(managed) {
    if (!managed || typeof managed !== 'object') {
        return null;
    }
    if (managed.kind !== 'agent-terminal') {
        return null;
    }
    const agentLabel = normalizeAgentDisplayName(managed.agentLabel || 'Agent');
    const terminalId = String(managed.terminalId || '').trim();
    return {
        kind: 'agent-terminal',
        agentId: String(managed.agentId || '').trim(),
        agentLabel,
        acpSessionId: String(managed.acpSessionId || '').trim(),
        terminalId
    };
}

function isAgentManagedSession(session) {
    return session?.managed?.kind === 'agent-terminal';
}

function getManagedSessionLabel(session) {
    if (!isAgentManagedSession(session)) return '';
    return normalizeAgentDisplayName(session.managed.agentLabel || 'Agent');
}

function buildAgentPromptPlaceholder(agentTab) {
    if (!agentTab) {
        return AGENT_PROMPT_PLACEHOLDER.join('\n');
    }
    const feedback = getAgentComposerFeedback(agentTab);
    const session = agentTab.getLinkedSession();
    const modeLabel = getCurrentAgentModeLabel(agentTab);
    const cwd = agentTab.cwd
        ? shortenPath(
            agentTab.cwd,
            session?.env || ''
        )
        : '';
    const host = getDisplayHost(agentTab.server);
    const location = cwd ? `${host}:${cwd}` : host;
    const statusLabel = feedback?.statusLabel || 'Ready';
    const metaLine = [
        location,
        modeLabel,
        statusLabel
    ].filter(Boolean).join(' · ');
    const helperLine = feedback?.hotkey
        ? `# / for commands, ${feedback.hotkey} ⇧⏎ or ⌃J inserts a newline.`
        : AGENT_PROMPT_PLACEHOLDER[2];
    return [
        AGENT_PROMPT_PLACEHOLDER[0],
        `# ${metaLine}`,
        helperLine
    ].join('\n');
}

function getAgentMessageRoleLabel(agentTab, message) {
    const role = String(message?.role || 'assistant').toLowerCase();
    const kind = String(message?.kind || 'message').toLowerCase();

    const displayRoleLabel = getAgentRoleDisplayLabel(agentTab, role);

    if (kind === 'message') {
        return displayRoleLabel;
    }
    return `${displayRoleLabel} · ${message.kind || kind}`;
}

function getAgentRoleDisplayLabel(agentTab, role = 'assistant') {
    const normalizedRole = String(role || 'assistant').toLowerCase();
    if (normalizedRole === 'user') {
        return `😺 ${getAgentSessionUser(agentTab)}`.trim();
    }
    if (normalizedRole === 'assistant') {
        return `🤖 ${getAgentBaseName(agentTab)}`.trim();
    }
    return role || 'assistant';
}

function syncAgentTerminalOpenButton(
    header,
    existingButton,
    agentTab,
    terminalSummary
) {
    if (!header) {
        return existingButton || null;
    }
    const terminalSessionId = String(
        terminalSummary?.terminalSessionId || ''
    ).trim();
    const linkedSession = (
        agentTab
        && terminalSessionId
    )
        ? state.sessions.get(
            makeSessionKey(agentTab.server.id, terminalSessionId)
        )
        : null;

    if (!linkedSession) {
        if (
            agentTab
            && terminalSessionId
            && !terminalSummary?.released
        ) {
            scheduleManagedTerminalSessionSync(
                agentTab.server,
                terminalSessionId
            );
        }
        existingButton?.remove();
        return null;
    }

    const button = existingButton || document.createElement('button');
    button.type = 'button';
    button.className = 'agent-tool-call-terminal-open';
    button.textContent = 'Jump in';
    button.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!agentTab) return;
        await jumpToTerminalSession(agentTab.server, terminalSessionId);
    };
    if (!button.isConnected) {
        header.appendChild(button);
    }
    return button;
}

function getAgentMessageTimeLabel(message) {
    const raw = String(message?.createdAt || '').trim();
    if (!raw) return '';
    const timestamp = new Date(raw);
    if (Number.isNaN(timestamp.getTime())) return '';
    const deltaMs = Date.now() - timestamp.getTime();
    const absDeltaMs = Math.abs(deltaMs);

    if (absDeltaMs < 24 * 60 * 60 * 1000) {
        const formatter = new Intl.RelativeTimeFormat(undefined, {
            numeric: 'auto'
        });
        if (absDeltaMs < 60 * 1000) {
            if (absDeltaMs < 5 * 1000) {
                return 'just now';
            }
            const seconds = Math.max(
                1,
                Math.round(deltaMs / 1000)
            );
            return formatter.format(-seconds, 'second');
        }
        if (absDeltaMs < 60 * 60 * 1000) {
            const minutes = Math.max(
                1,
                Math.round(deltaMs / (60 * 1000))
            );
            return formatter.format(-minutes, 'minute');
        }
        const hours = Math.max(
            1,
            Math.round(deltaMs / (60 * 60 * 1000))
        );
        return formatter.format(-hours, 'hour');
    }

    return timestamp.toLocaleString();
}

function buildAgentTimelineHeader(
    roleLabel,
    timeLabel = '',
    createdAt = ''
) {
    const header = document.createElement('div');
    header.className = 'agent-message-header';

    const role = document.createElement('div');
    role.className = 'agent-message-role';
    role.textContent = roleLabel;
    header.appendChild(role);

    if (timeLabel) {
        const time = document.createElement('div');
        time.className = 'agent-message-time';
        time.textContent = timeLabel;
        if (createdAt) {
            time.dataset.createdAt = createdAt;
        }
        header.appendChild(time);
    }

    return header;
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

    for (const planEntry of agentTab.planHistory || []) {
        items.push({
            type: 'plan',
            order: Number.isFinite(planEntry?.order) ? planEntry.order : 0,
            value: planEntry
        });
    }

    items.sort((left, right) => {
        if (left.order !== right.order) {
            return left.order - right.order;
        }
        const typeOrder = {
            message: 0,
            tool: 1,
            permission: 2,
            plan: 3
        };
        return (typeOrder[left.type] || 0) - (typeOrder[right.type] || 0);
    });

    return items;
}

function normalizePlanStatusClass(status = '') {
    const value = String(status || '').toLowerCase();
    if (value === 'completed') return 'completed';
    if (value === 'in_progress') return 'in-progress';
    return 'pending';
}

function normalizePlanPriorityClass(priority = '') {
    const value = String(priority || '').toLowerCase();
    if (value === 'high' || value === 'urgent') return 'high';
    if (value === 'low') return 'low';
    return 'medium';
}

function getAgentPlanPriorityLabel(priority = '') {
    const value = normalizePlanPriorityClass(priority);
    if (value === 'high') return 'High';
    if (value === 'low') return 'Low';
    return 'Medium';
}

function getAgentPlanStatusMarker(status = '') {
    const value = String(status || '').toLowerCase();
    if (value === 'completed') return '✓';
    if (value === 'in_progress') return '•';
    return '○';
}

function isAgentPlanComplete(entries = []) {
    return Array.isArray(entries)
        && entries.length > 0
        && entries.every(
            (entry) => String(entry?.status || '').toLowerCase() === 'completed'
        );
}

function buildAgentPlanSummary(entries = []) {
    const total = entries.length;
    const completed = entries.filter(
        (entry) => String(entry?.status || '') === 'completed'
    ).length;
    const inProgress = entries.filter(
        (entry) => String(entry?.status || '') === 'in_progress'
    ).length;
    const pending = Math.max(total - completed - inProgress, 0);
    const extras = [];
    if (inProgress > 0) {
        extras.push(`${inProgress} active`);
    }
    if (pending > 0) {
        extras.push(`${pending} pending`);
    }
    return extras.length > 0
        ? `${completed} of ${total} tasks completed · ${extras.join(' · ')}`
        : `${completed} of ${total} tasks completed`;
}

function normalizeAgentUsageForDisplay(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const hasContext = Number.isFinite(usage.used) && Number.isFinite(usage.size);
    const windows = Array.isArray(usage.windows)
        ? usage.windows.filter((item) =>
            Number.isFinite(item?.used) && Number.isFinite(item?.size)
        )
        : [];
    if (
        !hasContext
        && windows.length === 0
        && !usage.cost
        && !usage.totals
        && !usage.vendorLabel
        && !usage.sessionId
        && !usage.summary
    ) {
        return null;
    }
    return {
        used: hasContext ? usage.used : null,
        size: hasContext ? usage.size : null,
        cost: usage.cost || null,
        totals: usage.totals || null,
        resetAt: typeof usage.resetAt === 'string' ? usage.resetAt : '',
        windows,
        vendorLabel: typeof usage.vendorLabel === 'string'
            ? usage.vendorLabel
            : '',
        sessionId: typeof usage.sessionId === 'string'
            ? usage.sessionId
            : '',
        summary: typeof usage.summary === 'string'
            ? usage.summary
            : ''
    };
}

function formatTokenCompact(value) {
    if (!Number.isFinite(value)) return '';
    if (value >= 1000000) {
        return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
    }
    return String(value);
}

function formatTokenForUsagePair(value, unit = '') {
    if (!Number.isFinite(value)) return '';
    if (unit === 'M') {
        return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`;
    }
    if (unit === 'K') {
        return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`;
    }
    return Number(value).toLocaleString([], {
        maximumFractionDigits: Number.isInteger(value) ? 0 : 1
    });
}

function formatAgentUsagePair(used, size) {
    if (!Number.isFinite(used) || !Number.isFinite(size)) {
        return '';
    }
    const maxValue = Math.max(Math.abs(used), Math.abs(size));
    let unit = '';
    if (maxValue >= 1000000) {
        unit = 'M';
    } else if (maxValue >= 10000) {
        unit = 'K';
    }
    return `${formatTokenForUsagePair(used, unit)} / ${
        formatTokenForUsagePair(size, unit)
    }`;
}

function getAgentUsageRemainingPercent(used, size) {
    if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) {
        return null;
    }
    return Math.max(0, Math.min(100, 100 - Math.round((used / size) * 100)));
}

function buildAgentUsageMetrics(usage) {
    const metrics = [];
    if (Number.isFinite(usage?.used) && Number.isFinite(usage?.size)) {
        metrics.push({
            key: 'context',
            label: 'Context',
            shortLabel: 'Ctx',
            used: usage.used,
            size: usage.size,
            usageText: formatAgentUsagePair(usage.used, usage.size),
            subtitle: '',
            resetAt: typeof usage?.resetAt === 'string' ? usage.resetAt : '',
            percentLeft: getAgentUsageRemainingPercent(usage.used, usage.size),
            percentUsed: Math.max(
                0,
                Math.min(100, Math.round((usage.used / usage.size) * 100))
            )
        });
    }
    for (const [index, windowUsage] of (usage?.windows || []).entries()) {
        if (!Number.isFinite(windowUsage?.used) || !Number.isFinite(windowUsage?.size)) {
            continue;
        }
        metrics.push({
            key: `window:${index}:${windowUsage.label || ''}`,
            label: String(windowUsage.label || `Window ${index + 1}`),
            shortLabel: String(windowUsage.label || `W${index + 1}`),
            used: windowUsage.used,
            size: windowUsage.size,
            usageText: '',
            subtitle: windowUsage.subtitle || '',
            resetAt: typeof windowUsage.resetAt === 'string'
                ? windowUsage.resetAt
                : '',
            resetDisplay: typeof windowUsage.resetDisplay === 'string'
                ? windowUsage.resetDisplay
                : '',
            percentLeft: getAgentUsageRemainingPercent(
                windowUsage.used,
                windowUsage.size
            ),
            percentUsed: Math.max(
                0,
                Math.min(
                    100,
                    Math.round((windowUsage.used / windowUsage.size) * 100)
                )
            )
        });
    }
    return metrics.filter((metric) => Number.isFinite(metric.percentLeft));
}

function getAgentUsageMetricTone(metric) {
    if (!metric || !Number.isFinite(metric.percentUsed)) {
        return 'normal';
    }
    return metric.percentUsed >= 80 ? 'critical' : 'normal';
}

function getAgentUsageMetricDetailLabel(metric) {
    if (!metric) return '';
    if (metric.key === 'context') {
        return 'Context:';
    }
    return `${metric.label} limit:`;
}

function buildAgentUsageCompactMetric(metric) {
    const pill = document.createElement('div');
    pill.className = 'agent-usage-pill';
    pill.dataset.metricKey = metric.key;
    pill.dataset.tone = getAgentUsageMetricTone(metric);
    pill.title = `${metric.label}: ${metric.percentLeft}% left`;
    pill.style.setProperty(
        '--agent-usage-progress',
        `${metric.percentUsed || 0}`
    );

    const value = document.createElement('span');
    value.className = 'agent-usage-pill-value';
    value.textContent = `${metric.percentLeft}%`;

    const label = document.createElement('span');
    label.className = 'agent-usage-pill-label';
    label.textContent = metric.shortLabel || metric.label;

    pill.appendChild(value);
    pill.appendChild(label);
    return pill;
}

function buildAgentUsageProgress(metric) {
    const progress = document.createElement('div');
    progress.className = 'agent-usage-progress';
    progress.dataset.tone = getAgentUsageMetricTone(metric);

    const fill = document.createElement('div');
    fill.className = 'agent-usage-progress-fill';
    fill.style.width = `${metric.percentUsed || 0}%`;
    progress.appendChild(fill);

    return progress;
}

function buildAgentUsageSessionRow(usage) {
    const sessionId = typeof usage?.sessionId === 'string'
        ? usage.sessionId.trim()
        : '';
    if (!sessionId) {
        return null;
    }
    const row = document.createElement('div');
    row.className = 'agent-usage-session-row';

    const label = document.createElement('div');
    label.className = 'agent-usage-session-label';
    label.textContent = 'Session:';

    const value = document.createElement('div');
    value.className = 'agent-usage-session-value';
    value.textContent = sessionId;

    row.appendChild(label);
    row.appendChild(value);
    return row;
}

function buildAgentUsageDetailRow(metric) {
    const row = document.createElement('div');
    row.className = 'agent-usage-detail-row';

    const label = document.createElement('div');
    label.className = 'agent-usage-detail-label';
    label.textContent = getAgentUsageMetricDetailLabel(metric);

    const body = document.createElement('div');
    body.className = 'agent-usage-detail-body';

    const value = document.createElement('span');
    value.className = 'agent-usage-detail-value';
    value.textContent = `${metric.percentLeft}% left`;
    body.appendChild(buildAgentUsageProgress(metric));

    if (metric.usageText && metric.key !== 'context') {
        const usage = document.createElement('div');
        usage.className = 'agent-usage-details-meta';
        usage.textContent = metric.usageText;
        body.appendChild(usage);
    }

    const reset = document.createElement('div');
    reset.className = 'agent-usage-details-reset';
    const resetText = metric.key === 'context'
        ? (metric.usageText || '')
        : (
            typeof metric.resetDisplay === 'string'
                && metric.resetDisplay.trim()
                ? metric.resetDisplay.trim()
                : formatAgentUsageReset(metric.resetAt)
        );
    reset.textContent = resetText;

    if (resetText) {
        reset.dataset.resetAt = metric.resetAt;
    }

    row.appendChild(label);
    row.appendChild(body);
    row.appendChild(value);
    row.appendChild(reset);

    return row;
}

function formatAgentUsageReset(resetAt = '') {
    if (!resetAt) return '';
    const timestamp = new Date(resetAt);
    if (Number.isNaN(timestamp.getTime())) {
        return '';
    }
    const deltaMs = timestamp.getTime() - Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const countdown = formatAgentUsageCountdown(deltaMs);
    if (deltaMs > 0 && deltaMs < oneDayMs) {
        return `resets ${countdown}`;
    }
    const localLabel = timestamp.toLocaleDateString([], {
        month: 'short',
        day: 'numeric'
    });
    return `resets ${localLabel}`;
}

function formatAgentUsageCountdown(deltaMs) {
    if (!Number.isFinite(deltaMs)) return '';
    if (deltaMs <= 0) return 'soon';
    const minutes = Math.floor(deltaMs / (60 * 1000));
    if (minutes < 1) {
        return 'in under a minute';
    }
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.floor((minutes % (24 * 60)) / 60);
    const mins = minutes % 60;
    if (days > 0) {
        return `in ${days}d ${hours}h`;
    }
    if (hours > 0) {
        return `in ${hours}h ${mins}m`;
    }
    return `in ${mins}m`;
}

function buildAgentUsageTotalsMeta(usage) {
    const parts = [];
    if (
        !Number.isFinite(usage.used)
        && Number.isFinite(usage.totals?.totalTokens)
    ) {
        parts.push(
            `${formatTokenCompact(usage.totals.totalTokens)} tokens`
        );
    }
    return parts.join(' · ');
}

function buildAgentUsageCostRow(usage) {
    if (
        !Number.isFinite(usage?.cost?.amount)
        || !usage.cost?.currency
    ) {
        return null;
    }
    const row = document.createElement('div');
    row.className = 'agent-usage-session-row';

    const label = document.createElement('div');
    label.className = 'agent-usage-session-label';
    label.textContent = 'Cost:';

    const value = document.createElement('div');
    value.className = 'agent-usage-session-value';
    value.textContent = `${usage.cost.currency} ${
        Number(usage.cost.amount).toFixed(2)
    }`;

    row.appendChild(label);
    row.appendChild(value);
    return row;
}

function getAgentRunningTerminalSummaries(agentTab) {
    return Array.from(agentTab?.terminals?.values?.() || []).filter(
        (terminal) => terminal?.running
    );
}

function getAgentTerminalStatusLabel(terminal = {}) {
    if (terminal.running) return 'Running';
    if (terminal.released) return 'Released';
    if (terminal.exitStatus?.signal) {
        return `Exited (${terminal.exitStatus.signal})`;
    }
    if (Number.isFinite(terminal.exitStatus?.exitCode)) {
        return terminal.exitStatus.exitCode === 0
            ? 'Completed'
            : `Exit ${terminal.exitStatus.exitCode}`;
    }
    return '';
}

function buildAgentTerminalMetaText(terminal = {}) {
    const parts = [];
    if (terminal.command) parts.push(terminal.command);
    if (terminal.cwd) parts.push(terminal.cwd);
    const status = getAgentTerminalStatusLabel(terminal);
    if (status) parts.push(status);
    return parts.join(' · ');
}

function renderEmbeddedAgentTerminal(
    embeddedTerm,
    terminalNode,
    terminal,
    fitAddon = null
) {
    if (!embeddedTerm || !terminalNode) return;
    const output = terminal?.output || '(no output yet)';
    terminalNode.dataset.outputPreview = output;
    terminalNode.setAttribute('aria-label', output);
    terminalNode.style.height = `${
        estimateAgentTerminalHeight(terminal?.output || '')
    }px`;
    try {
        embeddedTerm.reset();
    } catch {
        // Ignore reset failures on disposed terminals.
    }
    embeddedTerm.write(output);
    embeddedTerm.scrollToBottom();
    if (fitAddon) {
        requestAnimationFrame(() => {
            try {
                fitAddon.fit();
            } catch {
                // Ignore layout failures for hidden sections.
            }
        });
    }
}

function estimateAgentTerminalHeight(output) {
    const lines = countTextLines(output);
    return Math.min(Math.max(lines * 17 + 28, 120), 320);
}

function getAgentDisplayLabel(agentTab) {
    if (!agentTab) return 'Agent';
    const explicitTitle = String(agentTab.title || '').trim();
    const hasMeaningfulTitle = (
        explicitTitle
        && !/^[.\u2026\s]+$/u.test(explicitTitle)
    );
    if (hasMeaningfulTitle) {
        return explicitTitle;
    }
    const baseName = getAgentBaseName(agentTab);
    const session = agentTab.getLinkedSession();
    if (!session) {
        return baseName || 'Agent';
    }

    const siblings = getAgentTabsForSession(session)
        .filter((tab) => getAgentBaseName(tab) === baseName)
        .sort((left, right) => {
            const created = (left.createdAt || '').localeCompare(
                right.createdAt || ''
            );
            if (created !== 0) return created;
            return left.id.localeCompare(right.id);
        });
    if (siblings.length <= 1) {
        return baseName || 'Agent';
    }
    const index = siblings.findIndex((tab) => tab.key === agentTab.key);
    const suffix = index >= 0 ? index + 1 : siblings.length;
    return `${baseName || 'Agent'} #${suffix}`;
}

function buildAgentTimelineRoleLabel(agentTab, kind) {
    return `${getAgentRoleDisplayLabel(agentTab, 'assistant')} · ${kind}`;
}

function normalizeStatusClass(status = '') {
    const value = String(status || 'pending').toLowerCase();
    if (value.includes('ready')) {
        return 'ready';
    }
    if (value.includes('restore')) {
        return 'running';
    }
    if (value.includes('disconnect')) {
        return 'error';
    }
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
    if (value.includes('ready')) return 'Ready';
    if (value.includes('restore')) return 'Restoring';
    if (value.includes('disconnect')) return 'Disconnected';
    if (value.includes('approve')) return 'Allowed';
    if (value.includes('select')) return 'Allowed';
    if (value.includes('abort')) return 'Denied';
    if (value.includes('complete') || value.includes('success')) {
        return 'Completed';
    }
    if (value.includes('cancel')) return 'Cancelled';
    if (value.includes('error') || value.includes('fail')) return 'Error';
    if (value.includes('run') || value.includes('progress')) return 'Running';
    return 'Pending';
}

function getPermissionOptionById(permission, optionId) {
    if (!optionId) return null;
    return Array.isArray(permission?.options)
        ? permission.options.find(
            (option) => (option.optionId || option.id || '') === optionId
        ) || null
        : null;
}

function getPermissionOptionDisplayLabel(option) {
    const kind = String(option?.kind || '').toLowerCase();
    const providedName = String(option?.name || '').trim();
    if (providedName) {
        return providedName;
    }
    switch (kind) {
        case 'allow_once':
            return 'Allow once';
        case 'allow_always':
            return 'Always allow';
        case 'reject_once':
            return 'Deny';
        case 'reject_always':
            return 'Always deny';
        default:
            return option?.optionId || option?.id || 'Select';
    }
}

function getAgentPermissionStatusLabel(permission) {
    const status = String(permission?.status || 'pending').toLowerCase();
    const selected = getPermissionOptionById(
        permission,
        permission?.selectedOptionId || ''
    );
    const kind = String(selected?.kind || '').toLowerCase();

    if (kind === 'allow_always') return 'Allowed Always';
    if (kind === 'allow_once') return 'Allowed Once';
    if (kind === 'reject_always') return 'Denied Always';
    if (kind === 'reject_once') return 'Denied';
    if (status.includes('abort')) return 'Denied';
    return getAgentStatusLabel(status);
}

function getAgentOrderedMapValues(map) {
    return Array.from(map?.values?.() || []).sort((left, right) => {
        const leftOrder = Number.isFinite(left?.order) ? left.order : 0;
        const rightOrder = Number.isFinite(right?.order) ? right.order : 0;
        return rightOrder - leftOrder;
    });
}

function shouldExpandAgentTimelineSections(status = '') {
    const statusClass = normalizeStatusClass(status);
    return (
        statusClass === 'pending'
        || statusClass === 'running'
        || statusClass === 'error'
    );
}

function getAgentComposerFeedback(agentTab) {
    if (!agentTab) return null;

    if (agentTab.errorMessage) {
        return {
            statusClass: 'error',
            statusLabel: 'Error',
            summary: agentTab.errorMessage,
            hotkey: ''
        };
    }

    const pendingPermission = getAgentOrderedMapValues(
        agentTab.permissions
    ).find((permission) => permission.status === 'pending');
    if (pendingPermission) {
        const permissionTitle = getAgentPermissionTitle(pendingPermission);
        const hasOptions = hasResolvablePermissionOptions(pendingPermission);
        return {
            statusClass: 'pending',
            statusLabel: 'Needs approval',
            summary: hasOptions
                ? `Choose an approval option for ${permissionTitle}.`
                : `Waiting for approval outside Tabminal for ${permissionTitle}.`,
            hotkey: 'Esc stops.'
        };
    }

    const activeTool = getAgentOrderedMapValues(agentTab.toolCalls).find(
        (toolCall) => {
            const statusClass = getEffectiveAgentToolStatus(
                toolCall,
                agentTab
            );
            return statusClass === 'pending' || statusClass === 'running';
        }
    );
    if (activeTool) {
        return {
            statusClass: 'running',
            statusLabel: 'Running',
            summary: `Working with ${getAgentToolTitle(activeTool)}.`,
            hotkey: agentTab.busy ? 'Esc stops.' : ''
        };
    }

    if (agentTab.status === 'disconnected') {
        return {
            statusClass: 'error',
            statusLabel: 'Disconnected',
            summary: 'Refresh or reconnect to restore live updates.',
            hotkey: ''
        };
    }

    if (agentTab.status === 'restoring') {
        return {
            statusClass: 'running',
            statusLabel: 'Restoring',
            summary: 'Restoring this agent session from the backend.',
            hotkey: ''
        };
    }

    if (agentTab.busy) {
        const hasAssistantMessage = (agentTab.messages || []).some((message) => (
            String(message?.role || '').toLowerCase() === 'assistant'
        ));
        const latestTool = getAgentOrderedMapValues(agentTab.toolCalls)[0] || null;
        const queuedCount = Array.isArray(agentTab.queuedPrompts)
            ? agentTab.queuedPrompts.length
            : 0;
        const queuedSuffix = queuedCount > 0
            ? ` · ${queuedCount} queued`
            : '';
        if (!hasAssistantMessage && !latestTool) {
            return {
                statusClass: 'running',
                statusLabel: `Starting${queuedSuffix}`,
                summary: `Waiting for ${getAgentBaseName(agentTab)} to respond.`,
                hotkey: 'Esc stops.'
            };
        }
        if (latestTool) {
            return {
                statusClass: 'running',
                statusLabel: `Responding${queuedSuffix}`,
                summary: `Summarizing ${getAgentToolTitle(latestTool)}.`,
                hotkey: 'Esc stops.'
            };
        }
        return {
            statusClass: 'running',
            statusLabel: `Responding${queuedSuffix}`,
            summary: `${getAgentBaseName(agentTab)} is drafting a response.`,
            hotkey: 'Esc stops.'
        };
    }

    if (agentTab.messages.length === 0) {
        const hasCommands = Array.isArray(agentTab.availableCommands)
            && agentTab.availableCommands.length > 0;
        const queuedCount = Array.isArray(agentTab.queuedPrompts)
            ? agentTab.queuedPrompts.length
            : 0;
        return {
            statusClass: 'ready',
            statusLabel: queuedCount > 0 ? `${queuedCount} queued` : 'Ready',
            summary: hasCommands
                ? 'Start a new task or use / for available commands.'
                : 'Start a new task in this workspace.',
            hotkey: ''
        };
    }

    const queuedCount = Array.isArray(agentTab.queuedPrompts)
        ? agentTab.queuedPrompts.length
        : 0;
    if (queuedCount > 0) {
        return {
            statusClass: 'ready',
            statusLabel: `${queuedCount} queued`,
            summary: 'Send to continue the queued prompts.',
            hotkey: ''
        };
    }

    return {
        statusClass: 'ready',
        statusLabel: 'Ready',
        summary: 'Ready for the next turn.',
        hotkey: ''
    };
}

function getAgentActivityState(agentTab) {
    if (!agentTab) return null;
    const queuedCount = Array.isArray(agentTab.queuedPrompts)
        ? agentTab.queuedPrompts.length
        : 0;
    const queuedSuffix = queuedCount > 0
        ? ` · ${queuedCount} queued`
        : '';

    const pendingPermission = getAgentOrderedMapValues(
        agentTab.permissions
    ).find((permission) => permission.status === 'pending');
    if (pendingPermission) {
        return {
            stateClass: 'pending',
            label: `Waiting for approval…${queuedSuffix}`,
            iconSvg: BELL_ICON_SVG,
            spinning: false,
            cancelable: !!agentTab.busy
        };
    }

    const activeTool = getAgentOrderedMapValues(agentTab.toolCalls).find(
        (toolCall) => {
            const statusClass = getEffectiveAgentToolStatus(
                toolCall,
                agentTab
            );
            return statusClass === 'pending' || statusClass === 'running';
        }
    );
    if (activeTool) {
        const toolStatusClass = getEffectiveAgentToolStatus(
            activeTool,
            agentTab
        );
        const toolTitle = getAgentToolTitle(activeTool);
        return {
            stateClass: 'tool',
            label: toolStatusClass === 'pending'
                ? `Starting ${toolTitle}…${queuedSuffix}`
                : `Running ${toolTitle}…${queuedSuffix}`,
            iconSvg: SPINNER_ICON_SVG,
            spinning: true,
            cancelable: true
        };
    }

    if (agentTab.status === 'restoring') {
        return {
            stateClass: 'running',
            label: `Restoring…${queuedSuffix}`,
            iconSvg: SPINNER_ICON_SVG,
            spinning: true,
            cancelable: false
        };
    }

    if (agentTab.busy) {
        return {
            stateClass: 'running',
            label: `Thinking…${queuedSuffix}`,
            iconSvg: SPINNER_ICON_SVG,
            spinning: true,
            cancelable: true
        };
    }

    return null;
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

function compactAgentSummaryText(text, limit = 180) {
    const value = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!value) return '';
    return value.length > limit
        ? `${value.slice(0, limit - 1)}…`
        : value;
}

function normalizeAgentComparableText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function isAgentSectionRedundant(sectionText, summaryText) {
    const normalizedSection = normalizeAgentComparableText(
        compactAgentSummaryText(sectionText)
    );
    const normalizedSummary = normalizeAgentComparableText(summaryText);
    if (!normalizedSection || !normalizedSummary) {
        return false;
    }
    return normalizedSection === normalizedSummary;
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

function extractCommandPaths(command) {
    const source = String(command || '');
    if (!source) return [];
    const paths = [];
    const pattern = /"([^"\n]+)"|'([^'\n]+)'|(\/[^\s"'`]+)/g;
    for (const match of source.matchAll(pattern)) {
        const candidate = match[1] || match[2] || match[3] || '';
        if (!candidate.startsWith('/') || candidate === '/') {
            continue;
        }
        paths.push(candidate);
    }
    return paths;
}

function getAgentTimelinePaths(toolLike) {
    const paths = [
        ...extractToolPaths(toolLike)
    ];
    if (typeof toolLike?.rawInput?.path === 'string' && toolLike.rawInput.path) {
        paths.push(toolLike.rawInput.path);
    }
    if (Array.isArray(toolLike?.rawInput?.paths)) {
        for (const path of toolLike.rawInput.paths) {
            if (typeof path === 'string' && path) {
                paths.push(path);
            }
        }
    }
    const commandText = typeof toolLike?.rawInput?.cmd === 'string'
        ? toolLike.rawInput.cmd
        : Array.isArray(toolLike?.rawInput?.command)
            ? toolLike.rawInput.command.join(' ')
            : typeof toolLike?.rawInput?.command === 'string'
                ? toolLike.rawInput.command
                : '';
    paths.push(...extractCommandPaths(commandText));
    return Array.from(new Set(paths.filter(Boolean)));
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

function buildAgentPathLinks(agentTab, toolLike) {
    const session = agentTab?.getLinkedSession?.() || null;
    const allPaths = getAgentTimelinePaths(toolLike);
    const paths = allPaths.slice(0, 5);
    if (paths.length === 0) return null;

    const container = document.createElement('div');
    container.className = 'agent-path-links';

    for (const path of paths) {
        const link = document.createElement('a');
        link.className = 'agent-path-link';
        link.href = path;
        link.title = path;
        link.textContent = shortenPath(path, session?.env || '');
        container.appendChild(link);
    }

    const extraCount = allPaths.length - paths.length;
    if (extraCount > 0) {
        const more = document.createElement('span');
        more.className = 'agent-path-link more';
        more.textContent = `+${extraCount} more`;
        container.appendChild(more);
    }

    return container;
}

function buildAgentToolSummary(toolCall, terminals = null) {
    const stdout = compactAgentSummaryText(toolCall?.rawOutput?.stdout || '');
    if (stdout) return stdout;

    const stderr = compactAgentSummaryText(toolCall?.rawOutput?.stderr || '');
    if (stderr) return stderr;

    const formatted = compactAgentSummaryText(
        toolCall?.rawOutput?.formatted_output || ''
    );
    if (formatted) return formatted;

    const contentSummary = compactAgentSummaryText(
        summarizeToolCallContent(toolCall, terminals)
    );
    if (contentSummary) return contentSummary;

    const changeSummary = compactAgentSummaryText(
        summarizeToolChanges(toolCall?.rawInput)
    );
    if (changeSummary) return changeSummary;

    return '';
}

function summarizeAgentRawInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') return '';
    if (typeof rawInput.cmd === 'string' && rawInput.cmd) {
        return rawInput.cmd;
    }
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

function extractCommandExecutable(command) {
    const source = String(command || '').trim();
    if (!source) return '';
    const token = source.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    const executable = token?.[1] || token?.[2] || token?.[3] || '';
    if (!executable) return '';
    const parts = executable.split('/').filter(Boolean);
    return parts.at(-1) || executable;
}

function getFirstToolPath(toolCall) {
    const paths = getAgentTimelinePaths(toolCall);
    return paths[0] || '';
}

function summarizeAgentRawOutput(rawOutput) {
    if (typeof rawOutput === 'string' && rawOutput) {
        const outputMatch = rawOutput.match(/Output:\n([\s\S]*)$/);
        return compactAgentSummaryText(outputMatch?.[1] || rawOutput);
    }
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

function resolveAgentTerminalSummary(terminals, terminalId) {
    if (!terminalId) return null;
    if (terminals instanceof Map) {
        return terminals.get(terminalId) || null;
    }
    if (Array.isArray(terminals)) {
        return terminals.find(
            (terminal) => terminal?.terminalId === terminalId
        ) || null;
    }
    return null;
}

function getAgentToolTerminalIds(toolCall) {
    if (!Array.isArray(toolCall?.content)) {
        return [];
    }
    const ids = new Set();
    for (const item of toolCall.content) {
        const terminalId = String(item?.terminalId || '').trim();
        if (item?.type === 'terminal' && terminalId) {
            ids.add(terminalId);
        }
    }
    return Array.from(ids);
}

function toolCallHasRunningTerminal(toolCall, terminals) {
    for (const terminalId of getAgentToolTerminalIds(toolCall)) {
        const terminal = resolveAgentTerminalSummary(terminals, terminalId);
        if (terminal?.running) {
            return true;
        }
    }
    return false;
}

function getEffectiveAgentToolStatus(toolCall, agentTab) {
    const statusClass = normalizeStatusClass(toolCall?.status);
    if (statusClass !== 'pending' && statusClass !== 'running') {
        return statusClass;
    }
    if (!agentTab) {
        return statusClass;
    }
    if (toolCallHasRunningTerminal(toolCall, agentTab.terminals)) {
        return statusClass;
    }
    if (agentTab.status === 'error' || agentTab.errorMessage) {
        return 'error';
    }
    if (
        agentTab.busy
        || agentTab.status === 'restoring'
        || getAgentOrderedMapValues(agentTab.permissions).some(
            (permission) => permission.status === 'pending'
        )
    ) {
        return statusClass;
    }
    return 'completed';
}

function summarizeToolCallContent(toolCall, terminals = null) {
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
            const terminal = resolveAgentTerminalSummary(
                terminals,
                item.terminalId
            );
            if (terminal) {
                const output = compactAgentSummaryText(terminal.output || '');
                const label = terminal.command || `Terminal ${item.terminalId}`;
                lines.push(
                    output ? `${label}\n${output}` : label
                );
            } else {
                lines.push(`Terminal: ${item.terminalId}`);
            }
            continue;
        }
        if (item?.type === 'diff' && item.path) {
            lines.push(`Diff: ${normalizeToolPathLabel(item.path)}`);
        }
    }
    return truncateAgentDetail(lines.join('\n\n'));
}

function getToolCallDiffItems(toolCall) {
    if (!Array.isArray(toolCall?.content)) return [];
    return toolCall.content.filter((item) =>
        item?.type === 'diff'
        && item.path
        && typeof item.newText === 'string'
    );
}

function resourceUriToPath(uri) {
    if (!uri || typeof uri !== 'string') return '';
    if (uri.startsWith('file://')) {
        try {
            return decodeURIComponent(new URL(uri).pathname);
        } catch {
            return uri.slice('file://'.length);
        }
    }
    return '';
}

function getToolCallTextContentBlocks(toolCall) {
    if (!Array.isArray(toolCall?.content)) return [];
    const blocks = [];
    for (const item of toolCall.content) {
        if (item?.type !== 'content' || !item.content) {
            continue;
        }
        if (
            item.content.type === 'text'
            && typeof item.content.text === 'string'
            && item.content.text
        ) {
            blocks.push({
                text: item.content.text,
                path: ''
            });
            continue;
        }
        const resource = item.content.resource;
        if (
            item.content.type === 'resource'
            && resource
            && typeof resource.text === 'string'
            && resource.text
        ) {
            blocks.push({
                text: resource.text,
                path: resourceUriToPath(resource.uri)
            });
        }
    }
    return blocks;
}

function normalizeAgentEditorPath(path) {
    const value = String(path || '').trim();
    if (!value) return '/snippet.txt';
    return value.startsWith('/') ? value : `/${value}`;
}

function countTextLines(text) {
    const value = String(text || '');
    return value ? value.split('\n').length : 1;
}

function estimateAgentCodeEditorHeight(text) {
    const lines = countTextLines(text);
    return Math.min(Math.max(lines * 18 + 20, 120), 420);
}

function estimateAgentDiffEditorHeight(oldText, newText) {
    const lines = Math.max(
        countTextLines(oldText),
        countTextLines(newText)
    );
    return Math.min(Math.max(lines * 18 + 46, 180), 520);
}

function buildAgentStructuredContentSections(
    toolCall,
    summaryText = '',
    terminals = null
) {
    const sections = [];

    if (Array.isArray(toolCall?.content)) {
        for (const item of toolCall.content) {
            if (item?.type === 'terminal' && item.terminalId) {
                const terminal = resolveAgentTerminalSummary(
                    terminals,
                    item.terminalId
                );
                sections.push({
                    label: 'Terminal',
                    preview: terminal?.command || item.terminalId,
                    text: terminal?.output || '',
                    kind: 'terminal',
                    terminal
                });
            }
        }
    }

    for (const item of getToolCallDiffItems(toolCall)) {
        sections.push({
            label: 'Diff',
            preview: normalizeToolPathLabel(item.path),
            text: truncateAgentDetail(item.newText || ''),
            kind: 'diff',
            path: item.path,
            oldText: item.oldText || '',
            newText: item.newText || ''
        });
    }

    const textBlocks = getToolCallTextContentBlocks(toolCall);
    if (textBlocks.length === 0) {
        return sections;
    }

    const combinedText = truncateAgentDetail(
        textBlocks.map((block) => block.text).join('\n\n')
    );
    if (!combinedText || isAgentSectionRedundant(combinedText, summaryText)) {
        return sections;
    }

    const firstPath = getFirstToolPath(toolCall);
    const resourcePath = textBlocks.find((block) => block.path)?.path || '';
    const codePath = resourcePath || (
        ['read', 'edit'].includes(toolCall?.kind)
            ? firstPath
            : ''
    );
    sections.push({
        label: 'Content',
        preview: codePath ? normalizeToolPathLabel(codePath) : '',
        text: combinedText,
        kind: codePath ? 'code' : 'text',
        path: codePath
    });
    return sections;
}

function getAgentToolTitle(toolCall) {
    const rawInputCommand = typeof toolCall?.rawInput?.cmd === 'string'
        ? toolCall.rawInput.cmd
        : '';
    const rawInput = toolCall?.rawInput || {};
    const firstPath = getFirstToolPath(toolCall);
    const firstPathBase = firstPath
        ? firstPath.split('/').filter(Boolean).pop() || firstPath
        : '';
    const genericTitle = String(toolCall?.title || '').trim();
    if (
        genericTitle
        && !/^(exec_command|read|edit|search|fetch|execute)$/i.test(
            genericTitle
        )
    ) {
        return genericTitle;
    }
    if (toolCall?.kind === 'read') {
        return firstPathBase ? `Read ${firstPathBase}` : 'Read file';
    }
    if (toolCall?.kind === 'edit') {
        return firstPathBase ? `Edited ${firstPathBase}` : 'Edited files';
    }
    if (toolCall?.kind === 'search') {
        const query = String(
            rawInput?.query || rawInput?.pattern || rawInput?.search || ''
        ).trim();
        if (query) {
            return `Searched for ${query}`;
        }
        return 'Searched the workspace';
    }
    if (toolCall?.kind === 'fetch') {
        return 'Fetched resource';
    }
    if (rawInputCommand) {
        const executable = extractCommandExecutable(rawInputCommand);
        if (executable) {
            return `Ran ${executable}`;
        }
    }
    const command = Array.isArray(toolCall?.rawInput?.command)
        ? toolCall.rawInput.command.join(' ')
        : '';
    if (command) {
        const executable = extractCommandExecutable(command);
        if (executable) {
            return `Ran ${executable}`;
        }
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
    if (toolCall?.rawInput?.cwd) {
        parts.push(toolCall.rawInput.cwd);
    } else if (toolCall?.rawInput?.workdir) {
        parts.push(toolCall.rawInput.workdir);
    }
    return parts.join(' · ');
}

function buildAgentToolSections(toolCall, summaryText = '', terminals = null) {
    const sections = [];
    const title = getAgentToolTitle(toolCall);
    const rawInput = summarizeAgentRawInput(toolCall?.rawInput);
    const normalizedTitle = normalizeAgentComparableText(title);
    const normalizedInput = normalizeAgentComparableText(rawInput);
    if (
        rawInput
        && normalizedInput
        && normalizedInput !== normalizedTitle
    ) {
        sections.push({
            label: 'Input',
            text: truncateAgentDetail(rawInput),
            kind: 'text'
        });
    }
    sections.push(
        ...buildAgentStructuredContentSections(
            toolCall,
            summaryText,
            terminals
        )
    );
    const hasStructuredContent = sections.some((section) =>
        section.label === 'Content'
        || section.label === 'Diff'
        || section.label === 'Terminal'
    );
    const content = summarizeToolCallContent(toolCall, terminals);
    if (
        !hasStructuredContent
        && content
        && !isAgentSectionRedundant(content, summaryText)
    ) {
        sections.push({
            label: 'Content',
            text: content,
            kind: 'text'
        });
    }
    const rawOutput = summarizeAgentRawOutput(toolCall?.rawOutput);
    if (rawOutput && !isAgentSectionRedundant(rawOutput, summaryText)) {
        const codePath = ['read', 'edit'].includes(toolCall?.kind)
            ? getFirstToolPath(toolCall)
            : '';
        sections.push({
            label: 'Output',
            text: rawOutput,
            kind: codePath
                && !/^STD(?:OUT|ERR)\n/.test(rawOutput)
                ? 'code'
                : 'text',
            path: codePath,
            preview: codePath ? normalizeToolPathLabel(codePath) : ''
        });
    }
    return sections;
}

function buildAgentPermissionMeta(permission) {
    return buildAgentToolMeta(permission?.toolCall || {});
}

function hasResolvablePermissionOptions(permission) {
    return Array.isArray(permission?.options) && permission.options.length > 0;
}

function buildAgentPermissionSummary(permission, terminals = null) {
    const leading = [];
    const statusLabel = getAgentPermissionStatusLabel(permission);
    if (permission?.status === 'pending') {
        if (hasResolvablePermissionOptions(permission)) {
            leading.push('Approval is required to continue.');
        } else {
            leading.push(
                'Approval is required outside Tabminal to continue.'
            );
        }
    } else if (statusLabel) {
        leading.push(
            `${statusLabel.charAt(0).toUpperCase()}${statusLabel.slice(1)}.`
        );
    }

    const content = summarizeToolCallContent(
        permission?.toolCall || {},
        terminals
    );
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
    if (!hasOnlyPathDiffs && content) {
        leading.push(content);
    } else {
        const inputSummary = compactAgentSummaryText(
            summarizeAgentRawInput(permission?.toolCall?.rawInput || {})
        );
        if (inputSummary) {
            leading.push(inputSummary);
        }
    }
    return leading.join('\n\n').trim();
}

function buildAgentPermissionSections(
    permission,
    summaryText = '',
    terminals = null
) {
    const sections = buildAgentToolSections(
        permission?.toolCall || {},
        summaryText,
        terminals
    );
    const selectedOption = getPermissionOptionById(
        permission,
        permission?.selectedOptionId || ''
    );
    if (selectedOption) {
        sections.push({
            label: 'Decision',
            text: getPermissionOptionDisplayLabel(selectedOption),
            kind: 'text'
        });
    }
    const optionLines = permission?.status === 'pending'
        && Array.isArray(permission?.options)
        ? permission.options.map((option) => {
            const label = getPermissionOptionDisplayLabel(option);
            const kind = option?.kind ? ` (${option.kind})` : '';
            return `${label}${kind}`;
        }).filter(Boolean)
        : [];
    if (optionLines.length > 0) {
        sections.push({
            label: 'Options',
            text: optionLines.join('\n'),
            kind: 'text'
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
            return 'Set `GEMINI_API_KEY` or `GOOGLE_API_KEY` on this host';
        }
        if (
            definition.id === 'copilot'
            && /gh copilot/i.test(definition.reason || '')
        ) {
            return 'Run `gh copilot` once on this host to install Copilot CLI';
        }
        if (
            definition.id === 'copilot'
            && /gh-copilot/i.test(definition.reason || '')
        ) {
            return 'Install the `gh-copilot` extension, then run `gh copilot`';
        }
        if (definition.reason === 'not installed') {
            return `Install or expose \`${definition.setupCommandLabel || definition.commandLabel}\``;
        }
        return definition.reason || 'Unavailable';
    }
    return 'I am ready to assist you :)';
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
    if (definition.id === 'copilot') {
        return 'GitHub Copilot can sometimes reuse a local `copilot login` '
            + 'or GitHub CLI auth from `gh auth login`, but '
            + '`COPILOT_GITHUB_TOKEN` is the reliable headless path. If the '
            + 'CLI is not installed yet, run `gh copilot` once or expose a '
            + 'standalone `copilot` binary in PATH, then reopen this '
            + 'dropdown.';
    }
    if (definition.reason === 'not installed') {
        return `Install or expose ${definition.setupCommandLabel || definition.commandLabel} on the current `
            + 'host, then restart Tabminal.';
    }
    if (definition.id === 'claude') {
        return 'Claude Code can run here with an existing Claude login, '
            + 'ANTHROPIC_API_KEY, or Vertex auth. For Vertex, start '
            + 'Tabminal with CLAUDE_CODE_USE_VERTEX=1, '
            + 'ANTHROPIC_VERTEX_PROJECT_ID, CLOUD_ML_REGION=global, and '
            + 'Google Cloud credentials in the host environment.';
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

function isTextEntryControl(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    if (element.disabled || element.readOnly) return false;
    return [
        'email',
        'number',
        'password',
        'search',
        'tel',
        'text',
        'url'
    ].includes(element.type);
}

function insertTextControlText(control, text) {
    if (!isTextEntryControl(control)) return;
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    control.setRangeText(text, start, end, 'end');
    control.dispatchEvent(new Event('input', { bubbles: true }));
}

function moveTextControlCursor(control, direction) {
    if (!isTextEntryControl(control)) return;
    const value = control.value || '';
    const start = control.selectionStart ?? value.length;
    const end = control.selectionEnd ?? value.length;
    let next = start;
    if (direction === 'left') {
        next = Math.max(0, start === end ? start - 1 : start);
    } else if (direction === 'right') {
        next = Math.min(value.length, start === end ? end + 1 : end);
    } else if (
        (direction === 'up' || direction === 'down')
        && control instanceof HTMLTextAreaElement
    ) {
        const cursor = direction === 'up' ? start : end;
        const lineStart = value.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
        const column = cursor - lineStart;
        if (direction === 'up') {
            if (lineStart === 0) {
                next = cursor;
            } else {
                const prevLineEnd = lineStart - 1;
                const prevLineStart = value.lastIndexOf(
                    '\n',
                    Math.max(0, prevLineEnd - 1)
                ) + 1;
                next = Math.min(prevLineStart + column, prevLineEnd);
            }
        } else {
            const lineEnd = value.indexOf('\n', cursor);
            if (lineEnd === -1) {
                next = cursor;
            } else {
                const nextLineStart = lineEnd + 1;
                const nextLineEnd = value.indexOf('\n', nextLineStart);
                const cappedNextLineEnd = (
                    nextLineEnd === -1
                        ? value.length
                        : nextLineEnd
                );
                next = Math.min(nextLineStart + column, cappedNextLineEnd);
            }
        }
    } else {
        return;
    }
    control.focus({ preventScroll: true });
    control.setSelectionRange(next, next);
}

function dispatchSyntheticKey(target, init) {
    if (!(target instanceof EventTarget)) return false;
    const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
}

function isUiElementVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
    }
    return element.getClientRects().length > 0;
}

function getVirtualInputTarget() {
    const activeSession = getActiveSession();
    const activeWorkspaceKey = activeSession
        ? editorManager?.getActiveWorkspaceTabKey(activeSession) || ''
        : '';
    if (
        activeSession
        && isTerminalWorkspaceTabKey(activeWorkspaceKey)
    ) {
        return {
            kind: 'terminal',
            session: activeSession
        };
    }
    if (
        editorManager?.editor
        && isUiElementVisible(editorManager.monacoContainer)
        && typeof editorManager.editor.hasTextFocus === 'function'
        && editorManager.editor.hasTextFocus()
    ) {
        return {
            kind: 'monaco',
            editor: editorManager.editor,
            element: document.activeElement
        };
    }
    const activeElement = document.activeElement;
    if (isTextEntryControl(activeElement) && isUiElementVisible(activeElement)) {
        return { kind: 'text', element: activeElement };
    }
    if (
        activeSession
        && terminalEl
        && activeElement
        && terminalEl.contains(activeElement)
    ) {
        return {
            kind: 'terminal',
            session: activeSession
        };
    }
    if (activeSession) {
        return {
            kind: 'terminal',
            session: activeSession
        };
    }
    return { kind: 'none' };
}

function dispatchTextControlKey(control, key, options = {}) {
    if (!isTextEntryControl(control)) return false;
    const keyMap = {
        ESC: { key: 'Escape', code: 'Escape' },
        TAB: { key: 'Tab', code: 'Tab' },
        UP: { key: 'ArrowUp', code: 'ArrowUp' },
        DOWN: { key: 'ArrowDown', code: 'ArrowDown' },
        LEFT: { key: 'ArrowLeft', code: 'ArrowLeft' },
        RIGHT: { key: 'ArrowRight', code: 'ArrowRight' }
    };
    const mapped = keyMap[key] || {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key
    };
    const prevented = dispatchSyntheticKey(control, {
        key: mapped.key,
        code: mapped.code,
        ctrlKey: !!options.ctrlKey,
        altKey: !!options.altKey,
        shiftKey: !!options.shiftKey,
        metaKey: !!options.metaKey
    });
    if (prevented) return true;
    if (options.ctrlKey || options.altKey || options.metaKey) {
        return true;
    }
    if (key === 'TAB') {
        insertTextControlText(control, '\t');
    } else if (key === 'LEFT') {
        moveTextControlCursor(control, 'left');
    } else if (key === 'RIGHT') {
        moveTextControlCursor(control, 'right');
    } else if (key === 'UP') {
        moveTextControlCursor(control, 'up');
    } else if (key === 'DOWN') {
        moveTextControlCursor(control, 'down');
    } else if (key === 'ESC') {
        control.blur();
    } else if (mapped.key.length === 1) {
        insertTextControlText(control, mapped.key);
    }
    control.focus({ preventScroll: true });
    return true;
}

function dispatchMonacoKey(key, options = {}) {
    const editor = editorManager?.editor;
    if (!editor) return false;
    const target = (
        editorManager.monacoContainer?.contains(document.activeElement)
            ? document.activeElement
            : editorManager.monacoContainer
    );
    const keyMap = {
        ESC: { key: 'Escape', code: 'Escape' },
        TAB: { key: 'Tab', code: 'Tab' },
        UP: { key: 'ArrowUp', code: 'ArrowUp' },
        DOWN: { key: 'ArrowDown', code: 'ArrowDown' },
        LEFT: { key: 'ArrowLeft', code: 'ArrowLeft' },
        RIGHT: { key: 'ArrowRight', code: 'ArrowRight' }
    };
    const mapped = keyMap[key] || {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key
    };
    const prevented = dispatchSyntheticKey(target, {
        key: mapped.key,
        code: mapped.code,
        ctrlKey: !!options.ctrlKey,
        altKey: !!options.altKey,
        shiftKey: !!options.shiftKey,
        metaKey: !!options.metaKey
    });
    if (prevented) return true;
    if (options.ctrlKey || options.altKey || options.metaKey) {
        editor.focus();
        return true;
    }
    if (key === 'TAB') {
        editor.trigger('virtual-keys', 'type', { text: '\t' });
    } else if (key === 'LEFT') {
        editor.trigger('virtual-keys', 'cursorLeft', null);
    } else if (key === 'RIGHT') {
        editor.trigger('virtual-keys', 'cursorRight', null);
    } else if (key === 'UP') {
        editor.trigger('virtual-keys', 'cursorUp', null);
    } else if (key === 'DOWN') {
        editor.trigger('virtual-keys', 'cursorDown', null);
    } else if (key === 'ESC') {
        for (const action of ['hideSuggestWidget', 'closeFindWidget']) {
            try {
                editor.trigger('virtual-keys', action, null);
            } catch {
                // Ignore unsupported editor actions.
            }
        }
    } else if (mapped.key.length === 1) {
        editor.trigger('virtual-keys', 'type', { text: mapped.key });
    }
    editor.focus();
    return true;
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

function restoreWorkspaceForSession(session) {
    if (!session) return;
    if (editorManager.currentSession?.key !== session.key) {
        editorManager.switchTo(session);
    } else {
        editorManager.renderEditorTabs();
    }
    const activeKey = editorManager.getActiveWorkspaceTabKey(session);
    if (activeKey) {
        editorManager.activateWorkspaceTab(activeKey, true);
    } else {
        editorManager.showEmptyState();
    }
    editorManager.updateEditorPaneVisibility();
}

async function jumpToTerminalSession(server, sessionId) {
    const targetId = String(sessionId || '').trim();
    if (!server || !targetId) return false;
    const key = makeSessionKey(server.id, targetId);
    if (!state.sessions.has(key)) {
        await syncServer(server);
    }
    if (!state.sessions.has(key)) {
        alert('Managed terminal session is no longer available.', {
            type: 'warning',
            title: 'Terminal'
        });
        return false;
    }
    await switchToSession(key, { scrollTabIntoView: true });
    return true;
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

function upsertAgentInventoryTab(server, data) {
    const key = makeAgentTabKey(server.id, data.id);
    const existing = state.agentTabs.get(key);
    if (existing) {
        const changed = existing.applyInventory(data);
        existing.connect();
        return {
            agentTab: existing,
            changed
        };
    }
    const agentTab = new AgentTab(data, server);
    state.agentTabs.set(key, agentTab);
    return {
        agentTab,
        changed: true
    };
}

function reconcileAgentInventory(server, inventory) {
    if (!server || !inventory || typeof inventory !== 'object') {
        return;
    }
    const restoring = !!inventory.restoring;
    const seenKeys = new Set();
    const touchedSessions = new Set();

    for (const tabData of Array.isArray(inventory.tabs) ? inventory.tabs : []) {
        const { agentTab, changed } = upsertAgentInventoryTab(server, tabData);
        seenKeys.add(agentTab.key);
        if (!changed) {
            continue;
        }
        const session = agentTab.getLinkedSession();
        if (session) {
            touchedSessions.add(session.key);
        }
    }

    if (!restoring) {
        for (const agentTab of getAgentTabsForServer(server.id)) {
            if (seenKeys.has(agentTab.key)) continue;
            const session = agentTab.getLinkedSession();
            if (session) {
                touchedSessions.add(session.key);
            }
            removeAgentTab(agentTab.key);
        }
    }

    for (const sessionKey of touchedSessions) {
        const session = state.sessions.get(sessionKey);
        if (!session) continue;
        session.updateTabUI();
        if (state.activeSessionKey === session.key) {
            refreshWorkspaceIfSessionActive(session);
        }
    }
}

function noteRecentAgentTab(session, agentTabKey) {
    if (!session || !agentTabKey) return;
    const recent = Array.isArray(session.workspaceState?.recentAgentTabKeys)
        ? session.workspaceState.recentAgentTabKeys
        : [];
    session.workspaceState.recentAgentTabKeys = [
        agentTabKey,
        ...recent.filter((key) => key !== agentTabKey)
    ];
}

function getRecentAgentTabFallback(session, excludedKey = '') {
    if (!session) return '';
    const remainingKeys = new Set(
        getAgentTabsForSession(session)
            .map((tab) => tab.key)
            .filter((key) => key !== excludedKey)
    );
    if (remainingKeys.size === 0) {
        session.workspaceState.recentAgentTabKeys = [];
        return '';
    }
    const recent = Array.isArray(session.workspaceState?.recentAgentTabKeys)
        ? session.workspaceState.recentAgentTabKeys
        : [];
    const filtered = recent.filter((key) => remainingKeys.has(key));
    session.workspaceState.recentAgentTabKeys = filtered;
    return filtered[0] || '';
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
        const recentAgentTabKey = getRecentAgentTabFallback(
            session,
            agentTabKey
        );
        if (recentAgentTabKey) {
            session.workspaceState.activeTabKey = recentAgentTabKey;
        } else {
            const files = session.editorState.openFiles;
            if (files.length > 0) {
                session.workspaceState.activeTabKey = makeFileWorkspaceTabKey(
                    files[files.length - 1]
                );
            } else {
                const remaining = getAgentTabsForSession(session);
                session.workspaceState.activeTabKey = remaining[0]?.key
                    || (editorManager.hasCompactWorkspaceTabs(session)
                        ? TERMINAL_WORKSPACE_TAB_KEY
                        : '');
            }
        }
    } else if (session) {
        getRecentAgentTabFallback(session, agentTabKey);
    }

    if (session && isAgentWorkspaceTabKey(session.workspaceState?.activeTabKey || '')) {
        noteRecentAgentTab(session, session.workspaceState.activeTabKey);
    }

    session?.saveState?.();
    session?.updateTabUI?.();
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
    const restoring = !!data?.restoring;

    const seenKeys = new Set();
    for (const tabData of data?.tabs || []) {
        const key = makeAgentTabKey(server.id, tabData.id);
        seenKeys.add(key);
        upsertAgentTab(server, tabData);
    }

    if (!restoring) {
        for (const agentTab of getAgentTabsForServer(server.id)) {
            if (seenKeys.has(agentTab.key)) continue;
            removeAgentTab(agentTab.key);
        }
    }

    server.agentStateLoaded = !restoring;
    if (restoring) {
        return;
    }

    const activeSession = getActiveSession();
    const sessions = getSessionsForServer(server.id);
    for (const session of sessions) {
        const activeKey = session.workspaceState?.activeTabKey || '';
        if (
            isAgentWorkspaceTabKey(activeKey)
            && state.agentTabs.has(activeKey)
        ) {
            noteRecentAgentTab(session, activeKey);
            session.saveState();
        }
    }

    if (activeSession) {
        if (activeSession.serverId === server.id) {
            const activeKey = editorManager.getActiveWorkspaceTabKey(
                activeSession
            );
            if (activeKey) {
                restoreWorkspaceForSession(activeSession);
            } else if (state.activeSessionKey === activeSession.key) {
                editorManager.updateEditorPaneVisibility();
            }
        }
        return;
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
        preferredSession.saveState();
        if (state.activeSessionKey === preferredSession.key) {
            restoreWorkspaceForSession(preferredSession);
        } else {
            switchToSession(preferredSession.key);
        }
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
    return await activateAgentTab(
        session,
        upsertAgentTab(session.server, data)
    );
}

async function activateAgentTab(session, agentTab, options = {}) {
    if (!session || !agentTab) return null;
    const shouldSwitchSession = !!options.switchSession;
    if (shouldSwitchSession && state.activeSessionKey !== session.key) {
        await switchToSession(session.key, { scrollTabIntoView: true });
    }
    session.workspaceState.activeTabKey = agentTab.key;
    noteRecentAgentTab(session, agentTab.key);
    session.saveState();
    if (state.activeSessionKey === session.key) {
        restoreWorkspaceForSession(session);
        requestAnimationFrame(() => {
            editorManager.agentPrompt?.focus();
        });
    } else {
        refreshWorkspaceIfSessionActive(session);
    }
    return agentTab;
}

async function resumeAgentTabFromHistory(session, agentTab, historySession) {
    if (!session || !agentTab || !historySession?.sessionId) return null;
    const response = await session.server.fetch('/api/agents/tabs/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            agentId: agentTab.agentId,
            cwd: agentTab.cwd || session.cwd || session.initialCwd || '/',
            terminalSessionId: session.id,
            sessionId: historySession.sessionId,
            title: historySession.title || ''
        })
    });
    if (!response.ok) {
        await throwResponseError(response, 'Failed to resume agent session');
    }
    const data = await response.json();
    return await activateAgentTab(
        session,
        upsertAgentTab(session.server, data)
    );
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
        if (!res.ok) return;
        const list = await res.json();
        server.expandedPaths.clear();
        for (const path of Array.isArray(list) ? list : []) {
            if (typeof path === 'string' && path.length > 0) {
                server.expandedPaths.add(path);
            }
        }
    } catch (error) {
        console.error(error);
    }
}

async function syncServer(server) {
    if (!server || !server.isAuthenticated) return;
    if (server.syncPromise) {
        return server.syncPromise;
    }
    const promise = (async () => {
        const now = Date.now();
        const wasReconnecting = server.connectionStatus === 'reconnecting';
        if (
            wasReconnecting
            && server.nextSyncAt
            && now < server.nextSyncAt
        ) {
            return;
        }

        for (const session of getSessionsForServer(server.id)) {
            if (
                !session.socket
                || session.socket.readyState === WebSocket.CLOSED
            ) {
                session.connect();
            }
        }

        const updates = { sessions: [] };
        const sentFileWrites = new Map();
        for (const [sessionKey, pending] of pendingChanges.sessions) {
            const { serverId, sessionId } = splitSessionKey(sessionKey);
            if (serverId !== server.id) continue;

            const sessionUpdate = { id: sessionId };
            let hasUpdate = false;

            if (pending.resize) {
                sessionUpdate.resize = pending.resize;
                hasUpdate = true;
            }
            if (pending.workspaceState) {
                sessionUpdate.workspaceState = pending.workspaceState;
                hasUpdate = true;
            }
            if (pending.fileWrites && pending.fileWrites.size > 0) {
                const fileWrites = Array.from(
                    pending.fileWrites.entries()
                )
                    .map(([path, write]) => ({
                        path,
                        write: editorManager.normalizePendingFileWrite(write)
                    }))
                    .filter(({ write }) => !write.blocked);
                if (fileWrites.length > 0) {
                    sessionUpdate.fileWrites = fileWrites.map(
                        ({ path, write }) => ({
                            path,
                            content: write.content,
                            expectedVersion: write.expectedVersion,
                            force: write.force === true
                        })
                    );
                    sentFileWrites.set(
                        sessionUpdate.id,
                        new Map(
                            fileWrites.map(({ path, write }) => [path, write])
                        )
                    );
                    hasUpdate = true;
                }
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

            for (const update of updates.sessions) {
                const pending = pendingChanges.sessions.get(
                    makeSessionKey(server.id, update.id)
                );
                if (!pending) continue;

                if (update.resize) delete pending.resize;
                if (update.workspaceState) delete pending.workspaceState;
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
            reconcileAgentInventory(server, data.agents);
            await editorManager.applyFileWriteResults(
                server,
                Array.isArray(data?.fileWriteResults)
                    ? data.fileWriteResults
                    : [],
                sentFileWrites
            );

            for (const [sessionId, writes] of sentFileWrites.entries()) {
                const pending = pendingChanges.sessions.get(
                    makeSessionKey(server.id, sessionId)
                );
                if (!pending?.fileWrites) {
                    continue;
                }
                for (const [path] of writes.entries()) {
                    if (!pending.fileWrites.has(path)) {
                        continue;
                    }
                    const current = editorManager.normalizePendingFileWrite(
                        pending.fileWrites.get(path)
                    );
                    if (!current.blocked) {
                        pending.fileWrites.delete(path);
                    }
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
    })();
    server.syncPromise = promise;
    try {
        return await promise;
    } finally {
        if (server.syncPromise === promise) {
            server.syncPromise = null;
        }
        if (server.pendingImmediateSync) {
            server.pendingImmediateSync = false;
            requestImmediateServerSync(server, 0);
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
    const previousManagedSessionKeys = new Set(
        localSessions
            .filter((session) => isAgentManagedSession(session))
            .map((session) => session.key)
    );
    let sessionTopologyChanged = false;

    for (const session of localSessions) {
        if (!remoteIds.has(session.id)) {
            removeSession(session.key);
            sessionTopologyChanged = true;
        }
    }

    for (const data of remoteSessions) {
        const key = makeSessionKey(server.id, data.id);
        if (state.sessions.has(key)) {
            state.sessions.get(key).update(data);
        } else {
            const session = new Session(data, server);
            state.sessions.set(key, session);
            sessionTopologyChanged = true;
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
    const nextManagedSessionKeys = new Set(
        getSessionsForServer(server.id)
            .filter((session) => isAgentManagedSession(session))
            .map((session) => session.key)
    );
    const managedSessionTopologyChanged = (
        sessionTopologyChanged
        || previousManagedSessionKeys.size !== nextManagedSessionKeys.size
        || Array.from(previousManagedSessionKeys).some(
            (key) => !nextManagedSessionKeys.has(key)
        )
    );
    const activeAgentTab = getActiveAgentTab();
    if (activeAgentTab?.serverId === server.id) {
        if (managedSessionTopologyChanged) {
            editorManager?.renderAgentPanel?.(activeAgentTab);
        } else {
            editorManager?.refreshVisibleAgentTerminals?.(activeAgentTab);
        }
    }
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
    updateDocumentTitle();
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
            if (window.innerWidth >= 768) {
                session.schedulePreviewRelayout();
            }
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
    if (getAgentTabsForSession(session).length > 0) {
        tab.classList.add('agent-open');
    }
    if (isAgentManagedSession(session)) {
        tab.classList.add('agent-managed-session');
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
        editorManager.toggle(session);
    };
    tab.appendChild(toggleEditorBtn);

    const agentBtn = document.createElement('button');
    agentBtn.className = 'toggle-agent-btn';
    agentBtn.title = 'Open Agent';
    agentBtn.onclick = async (e) => {
        e.stopPropagation();
        await toggleAgentDropdownForSession(session, agentBtn);
    };
    tab.appendChild(agentBtn);
    
    const fileTree = document.createElement('div');
    fileTree.className = 'tab-file-tree';
    fileTree.tabIndex = 0;
    session.fileTreeElement = fileTree;
    fileTree.addEventListener('mousedown', (event) => {
        if (
            event.target.closest('.file-tree-rename-input')
            || event.target.closest('.file-tree-rename-btn')
        ) {
            return;
        }
        if (event.target.closest('.file-tree-item')) {
            event.preventDefault();
            fileTree.focus({ preventScroll: true });
        }
    });
    fileTree.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && session.treeEditingPath) {
            event.preventDefault();
            event.stopPropagation();
            editorManager.cancelTreeRename(session);
            editorManager.focusTreePath(session, session.selectedTreePath);
            return;
        }
        if (
            !session.treeEditingPath
            && !event.metaKey
            && !event.ctrlKey
            && !event.altKey
            && (
                event.key === 'Delete'
                || event.key === 'Backspace'
            )
        ) {
            event.preventDefault();
            event.stopPropagation();
            void editorManager.deleteSelectedTreeEntry(session);
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            editorManager.moveTreeSelection(session, 1);
            editorManager.keepTreeFocus(session);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            editorManager.moveTreeSelection(session, -1);
            editorManager.keepTreeFocus(session);
            return;
        }
        if (event.key !== 'Enter' || session.treeEditingPath) {
            return;
        }
        if (!editorManager.beginSelectedTreeRename(session)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    });
    
    if (session.editorState && session.editorState.isVisible) {
        editorManager.refreshSessionTree(session);
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
    const titleIcon = document.createElement('span');
    titleIcon.className = 'tab-status-icon';
    title.appendChild(titleIcon);
    const titleText = document.createElement('span');
    titleText.className = 'tab-title-text';
    title.appendChild(titleText);

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
    metaTime.className = 'meta meta-time';
    
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
    requestAnimationFrame(() => {
        syncSessionTabMinimumHeight(tab);
    });
    
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

    session.updateTabUI();
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

const confirmModalState = {
    resolve: null,
    returnFocus: null,
    preferredFocus: 'confirm',
    hideCancel: false,
    allowDismiss: true
};

function isConfirmModalOpen() {
    return !!confirmModal && confirmModal.style.display !== 'none';
}

function getVisibleConfirmModalButtons() {
    const buttons = [];
    if (confirmModalCancel && !confirmModalState.hideCancel) {
        buttons.push(confirmModalCancel);
    }
    if (confirmModalConfirm) {
        buttons.push(confirmModalConfirm);
    }
    return buttons;
}

function getConfirmModalPreferredButton() {
    if (!confirmModalConfirm) {
        return null;
    }
    if (confirmModalState.hideCancel || !confirmModalCancel) {
        return confirmModalConfirm;
    }
    return confirmModalState.preferredFocus === 'cancel'
        ? confirmModalCancel
        : confirmModalConfirm;
}

function settleConfirmModal(result) {
    if (!confirmModal) return;
    confirmModal.style.display = 'none';
    const resolve = confirmModalState.resolve;
    const returnFocus = confirmModalState.returnFocus;
    confirmModalState.resolve = null;
    confirmModalState.returnFocus = null;
    confirmModalState.preferredFocus = 'confirm';
    confirmModalState.hideCancel = false;
    confirmModalState.allowDismiss = true;
    if (returnFocus instanceof HTMLElement) {
        requestAnimationFrame(() => {
            try {
                returnFocus.focus({ preventScroll: true });
            } catch {
                // Ignore focus restoration failures.
            }
        });
    }
    resolve?.(result);
}

function showConfirmModal({
    title = 'Confirm',
    message = '',
    note = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
    hideCancel = false,
    preferredFocus = 'confirm',
    allowDismiss = true,
    returnFocus = null
} = {}) {
    if (
        !confirmModal
        || !confirmModalTitle
        || !confirmModalMessage
        || !confirmModalNote
        || !confirmModalConfirm
        || !confirmModalCancel
    ) {
        return Promise.resolve(false);
    }
    if (confirmModalState.resolve) {
        settleConfirmModal(false);
    }
    confirmModalTitle.textContent = title;
    confirmModalMessage.textContent = message;
    confirmModalNote.textContent = note;
    confirmModalNote.style.display = note ? '' : 'none';
    confirmModalCancel.textContent = cancelLabel;
    confirmModalCancel.style.display = hideCancel ? 'none' : '';
    confirmModalConfirm.textContent = confirmLabel;
    confirmModalConfirm.classList.toggle('danger-button', danger);
    confirmModal.style.display = 'flex';
    confirmModalState.returnFocus = returnFocus;
    confirmModalState.hideCancel = hideCancel;
    confirmModalState.preferredFocus = preferredFocus === 'cancel'
        ? 'cancel'
        : 'confirm';
    confirmModalState.allowDismiss = allowDismiss !== false;
    requestAnimationFrame(() => {
        getConfirmModalPreferredButton()?.focus({ preventScroll: true });
    });
    return new Promise((resolve) => {
        confirmModalState.resolve = resolve;
    });
}

function moveConfirmModalFocus(delta) {
    const buttons = getVisibleConfirmModalButtons();
    if (!buttons.length || !delta) {
        return;
    }
    if (buttons.length === 1) {
        buttons[0].focus({ preventScroll: true });
        return;
    }
    const currentIndex = buttons.findIndex(
        (button) => button === document.activeElement
    );
    const baseIndex = currentIndex === -1
        ? buttons.length - 1
        : currentIndex;
    const nextIndex = Math.max(0, Math.min(
        buttons.length - 1,
        baseIndex + delta
    ));
    confirmModalState.preferredFocus = nextIndex === 0
        ? 'cancel'
        : 'confirm';
    buttons[nextIndex].focus({ preventScroll: true });
}

function renderServerControls() {
    updateDocumentTitle();
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
const APP_NOTIFICATION_QUIET_MS = 30_000;
const APP_NOTIFICATION_IDLE_MS = 3 * 60 * 1000;
let appNotificationQuietUntil = Date.now() + APP_NOTIFICATION_QUIET_MS;
let lastAppInteractionAt = Date.now();

function noteAppInteraction() {
    lastAppInteractionAt = Date.now();
}

function enterAppNotificationQuietPeriod(duration = APP_NOTIFICATION_QUIET_MS) {
    appNotificationQuietUntil = Math.max(
        appNotificationQuietUntil,
        Date.now() + duration
    );
}

function shouldNotifyConnectionStatus() {
    if (Date.now() < appNotificationQuietUntil) {
        return false;
    }
    if (document.visibilityState !== 'visible') {
        return false;
    }
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
        return false;
    }
    if ((Date.now() - lastAppInteractionAt) > APP_NOTIFICATION_IDLE_MS) {
        return false;
    }
    return true;
}

document.addEventListener('pointerdown', noteAppInteraction, {
    capture: true,
    passive: true
});
document.addEventListener('touchstart', noteAppInteraction, {
    capture: true,
    passive: true
});
document.addEventListener('keydown', noteAppInteraction, {
    capture: true
});
window.addEventListener('focus', () => {
    noteAppInteraction();
    enterAppNotificationQuietPeriod();
    editorManager.refreshVisibleSessionTrees();
    editorManager.updateTreeAutoRefresh();
    void editorManager.checkActiveFileVersion();
});
window.addEventListener('pageshow', () => {
    noteAppInteraction();
    enterAppNotificationQuietPeriod();
    editorManager.refreshVisibleSessionTrees();
    editorManager.updateTreeAutoRefresh();
    void editorManager.checkActiveFileVersion();
});

document.addEventListener('click', () => {
    notificationManager.requestPermission();
}, { once: true, capture: true });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        noteAppInteraction();
        enterAppNotificationQuietPeriod();
        clearVisibleAttentionState();
        editorManager.refreshVisibleSessionTrees();
        void editorManager.checkActiveFileVersion();
    }
    editorManager.updateTreeAutoRefresh();
});
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
    const hostName = getDisplayHost(server);
    const target = hostName || 'host';
    const shouldNotify = shouldNotifyConnectionStatus();

    if (status === 'reconnecting' && shouldNotify) {
        alert(`Lost connection to ${target}. Reconnecting...`, {
            type: 'warning',
            title: 'Connection'
        });
    } else if (
        status === 'connected'
        && prevStatus === 'reconnecting'
        && shouldNotify
    ) {
        alert(`Connection to ${target} restored.`, {
            type: 'success',
            title: 'Connection'
        });
    } else if (status === 'terminated') {
        alert(`Session on ${target} has ended.`, {
            type: 'error',
            title: 'Connection'
        });
    } else if (status === 'connected' && !prevStatus && shouldNotify) {
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

    const previousSession = state.activeSessionKey
        ? state.sessions.get(state.activeSessionKey)
        : null;
    previousSession?.unbindTerminalControlClaim();

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
    session.bindTerminalControlClaim();
    session.fitMainTerminalIfVisible();
    if (session.isMainTerminalVisible()) {
        session.mainTerm.focus();
    }
    
    // Double check focus
    requestAnimationFrame(() => {
        if (session.isMainTerminalVisible()) {
            session.mainTerm.focus();
        }
    });
    
    session.reportResize();
    
    // Sync editor state
    editorManager.switchTo(session);
    clearVisibleAttentionState(session);
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
        session.fitMainTerminalIfVisible();
        session.reportResize();
        
        if (
            session.editorState
            && (
                session.editorState.isVisible
                || editorManager.hasCompactWorkspaceTabs(session)
            )
        ) {
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

window.addEventListener('tabminal:layout-modechange', () => {
    const session = getActiveSession();
    if (!session) return;
    const activeElement = document.activeElement;
    const terminalHasFocus = !!(
        terminalEl
        && activeElement
        && terminalEl.contains(activeElement)
    );

    if (isForcedTerminalWorkspaceMode()) {
        if (terminalHasFocus) {
            session.workspaceState.activeTabKey = TERMINAL_WORKSPACE_TAB_KEY;
            session.saveState();
        }
    } else if (
        !editorManager.isTerminalTabPinned(session)
        && isTerminalWorkspaceTabKey(session.workspaceState?.activeTabKey || '')
    ) {
        session.workspaceState.activeTabKey =
            editorManager.getPreferredNonTerminalWorkspaceTabKey(session);
        session.saveState();
    }

    editorManager.switchTo(session);
    editorManager.updateEditorPaneVisibility();
    renderTabs();

    if (terminalHasFocus) {
        requestAnimationFrame(() => {
            if (
                state.activeSessionKey === session.key
                && state.sessions.has(session.key)
            ) {
                session.mainTerm.focus();
            }
        });
    }
});

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

if (
    confirmModal
    && confirmModalCancel
    && confirmModalConfirm
) {
    const focusPreferredConfirmButton = () => {
        requestAnimationFrame(() => {
            if (!isConfirmModalOpen()) return;
            const activeElement = document.activeElement;
            if (activeElement && confirmModal.contains(activeElement)) {
                return;
            }
            getConfirmModalPreferredButton()?.focus({ preventScroll: true });
        });
    };

    confirmModalCancel.addEventListener('focus', () => {
        confirmModalState.preferredFocus = 'cancel';
    });

    confirmModalConfirm.addEventListener('focus', () => {
        confirmModalState.preferredFocus = 'confirm';
    });

    confirmModalCancel.addEventListener('click', () => {
        settleConfirmModal(false);
    });

    confirmModalConfirm.addEventListener('click', () => {
        settleConfirmModal(true);
    });

    confirmModal.addEventListener('click', (event) => {
        if (
            event.target === confirmModal
            && confirmModalState.allowDismiss
        ) {
            settleConfirmModal(false);
        }
    });

    confirmModal.addEventListener('focusout', () => {
        focusPreferredConfirmButton();
    });

    confirmModal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (!confirmModalState.allowDismiss) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            event.preventDefault();
            settleConfirmModal(false);
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            moveConfirmModalFocus(-1);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            moveConfirmModalFocus(1);
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            moveConfirmModalFocus(event.shiftKey ? -1 : 1);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (document.activeElement === confirmModalCancel) {
                settleConfirmModal(false);
                return;
            }
            settleConfirmModal(true);
        }
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

if (
    agentSetupModal
    && agentSetupForm
    && agentSetupCancel
    && agentSetupReset
    && agentSetupClaudeUseVertex
) {
    agentSetupCancel.addEventListener('click', () => {
        closeAgentSetupModal();
    });

    agentSetupModal.addEventListener('click', (event) => {
        if (event.target === agentSetupModal) {
            closeAgentSetupModal();
        }
    });

    agentSetupModal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeAgentSetupModal();
        }
    });

    agentSetupClaudeUseVertex.addEventListener('change', () => {
        updateClaudeSetupFields();
    });

    agentSetupReset.addEventListener('click', async () => {
        agentSetupReset.disabled = true;
        agentSetupSave.disabled = true;
        setAgentSetupFeedback('');
        try {
            await resetAgentSetupConfig();
        } catch (error) {
            setAgentSetupFeedback(
                error.message || 'Failed to reset setup.',
                'error'
            );
        } finally {
            agentSetupReset.disabled = false;
            agentSetupSave.disabled = false;
        }
    });

    agentSetupForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        agentSetupReset.disabled = true;
        agentSetupSave.disabled = true;
        setAgentSetupFeedback('');
        try {
            await saveAgentSetupConfig();
        } catch (error) {
            setAgentSetupFeedback(
                error.message || 'Failed to save setup.',
                'error'
            );
        } finally {
            agentSetupReset.disabled = false;
            agentSetupSave.disabled = false;
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
        if (navigator.vibrate) navigator.vibrate(10);
        const target = getVirtualInputTarget();
        if (target.kind === 'terminal') {
            let data = '';
            if (key === 'ESC') data = '\x1b';
            else if (key === 'TAB') data = '\t';
            else if (key === 'CTRL_C') data = '\x03';
            else if (key === 'UP') data = '\x1b[A';
            else if (key === 'DOWN') data = '\x1b[B';
            else if (key === 'RIGHT') data = '\x1b[C';
            else if (key === 'LEFT') data = '\x1b[D';
            else data = key;
            target.session.send({ type: 'input', data });
            target.session.mainTerm.focus();
            return;
        }
        if (target.kind === 'text') {
            if (key === 'CTRL_C') {
                dispatchTextControlKey(target.element, 'c', { ctrlKey: true });
            } else {
                dispatchTextControlKey(target.element, key);
            }
            return;
        }
        if (target.kind === 'monaco') {
            if (key === 'CTRL_C') {
                dispatchMonacoKey('c', { ctrlKey: true });
            } else {
                dispatchMonacoKey(key);
            }
        }
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
        if (btn?.dataset.key) {
            e.preventDefault(); // Prevent ghost clicks and focus loss
            startRepeat(btn);
        }
    }, { passive: false });

    virtualKeys.addEventListener('touchend', stopRepeat);
    virtualKeys.addEventListener('touchcancel', stopRepeat);

    // Mouse Events (Desktop testing)
    virtualKeys.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('button');
        if (btn?.dataset.key) {
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

    const bindPress = (element, handler) => {
        if (!element) return;
        element.addEventListener('touchstart', (event) => {
            event.preventDefault();
            event.stopPropagation();
            handler(event);
        }, { passive: false });
        element.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            handler(event);
        });
    };
    
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

    bindPress(modCtrl, () => {
        toggleMod('ctrl');
    });
    bindPress(modAlt, () => {
        toggleMod('alt');
    });
    bindPress(modShift, () => {
        toggleMod('shift');
    });

    bindPress(modSym, () => {
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

    const handleSoftKeyPress = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const keyEl = event.target.closest('.soft-key');
        if (!keyEl) return;
        
        keyEl.classList.add('active');
        setTimeout(() => keyEl.classList.remove('active'), 100);
        
        if (navigator.vibrate) navigator.vibrate(10);
        
        const char = keyEl.dataset.char;
        let textData = char;

        if (modifiers.shift) {
            if (textData.length === 1 && /[a-z]/.test(textData)) {
                textData = textData.toUpperCase();
            } else if (shiftMap[textData]) {
                textData = shiftMap[textData];
            }
        }

        let terminalData = textData;
        if (modifiers.ctrl) {
            if (terminalData.length === 1 && /[a-z]/.test(terminalData)) {
                terminalData = String.fromCharCode(
                    terminalData.toLowerCase().charCodeAt(0) - 96
                );
            } else if (terminalData.length === 1 && /[A-Z]/.test(terminalData)) {
                terminalData = String.fromCharCode(
                    terminalData.charCodeAt(0) - 64
                );
            } else if (terminalData === '[') terminalData = '\x1b';
            else if (terminalData === '?') terminalData = '\x7f';
            else if (terminalData === '\\') terminalData = '\x1c';
            else if (terminalData === ']') terminalData = '\x1d';
            else if (terminalData === '^') terminalData = '\x1e';
            else if (terminalData === '_') terminalData = '\x1f';
        }

        if (modifiers.alt) {
            terminalData = '\x1b' + terminalData;
        }

        const target = getVirtualInputTarget();
        if (target.kind === 'terminal') {
            target.session.send({ type: 'input', data: terminalData });
            target.session.mainTerm.focus();
        } else if (target.kind === 'text') {
            if (modifiers.ctrl || modifiers.alt) {
                dispatchTextControlKey(target.element, textData, {
                    ctrlKey: modifiers.ctrl,
                    altKey: modifiers.alt,
                    shiftKey: modifiers.shift
                });
            } else {
                insertTextControlText(target.element, textData);
                target.element.focus({ preventScroll: true });
            }
        } else if (target.kind === 'monaco') {
            dispatchMonacoKey(textData, {
                ctrlKey: modifiers.ctrl,
                altKey: modifiers.alt,
                shiftKey: modifiers.shift
            });
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
    };

    softKeyboard.addEventListener('touchstart', handleSoftKeyPress, {
        passive: false
    });
    softKeyboard.addEventListener('mousedown', handleSoftKeyPress);
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

function handleAgentCommandMenuShortcut(event) {
    const agentCommandMenuOpen = !!(
        editorManager?.agentCommandMenu
        && editorManager.agentCommandMenu.style.display !== 'none'
        && editorManager.agentCommandSuggestions.length > 0
    );
    const eventFromAgentPrompt = editorManager?.agentPrompt
        && event.target === editorManager.agentPrompt;
    if (
        !agentCommandMenuOpen
        || eventFromAgentPrompt
        || event.ctrlKey
        || event.metaKey
        || event.altKey
    ) {
        return false;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        editorManager.hideAgentCommandMenu();
        return true;
    }
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        editorManager.moveAgentCommandSelection(1);
        return true;
    }
    if (event.key === 'ArrowUp') {
        event.preventDefault();
        editorManager.moveAgentCommandSelection(-1);
        return true;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        void editorManager.applyAgentCommandSuggestion();
        return true;
    }
    return false;
}

document.addEventListener('keydown', (e) => {
    if (handleAgentCommandMenuShortcut(e)) {
        e.stopImmediatePropagation();
    }
}, true);

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

    const agentDropdownOpen = agentDropdownEl.style.display !== 'none';
    if (
        agentDropdownOpen
        && !e.ctrlKey
        && !e.metaKey
        && !e.altKey
    ) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeAgentDropdown();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveAgentDropdownActiveIndex(1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveAgentDropdownActiveIndex(-1);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            triggerActiveAgentDropdownItem();
            return;
        }
    }

    const activeAgentTab = getActiveAgentTab();
    const blockingOverlayOpen = !!(
        (searchBar && searchBar.style.display === 'flex')
        || (addServerModal && addServerModal.style.display === 'flex')
        || (agentSetupModal && agentSetupModal.style.display === 'flex')
    );
    if (
        e.key === 'Escape'
        && !e.ctrlKey
        && !e.metaKey
        && !e.altKey
        && activeAgentTab?.busy
        && isAgentTabVisible(activeAgentTab)
        && !blockingOverlayOpen
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

        // Ctrl + Shift + A: Open Agent Menu
        if (key === 'a') {
            e.preventDefault();
            const session = getActiveSession();
            const anchor = getSessionAgentToggleButton(session);
            void toggleAgentDropdownForSession(session, anchor);
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
            const session = getActiveSession();
            if (!editorManager || !session) return;
            const activeKey = editorManager.getActiveWorkspaceTabKey(session);
            const hasWorkspace = getWorkspaceTabKeysForSession(session).length > 0;
            if (
                activeKey === TERMINAL_WORKSPACE_TAB_KEY
                || (
                    hasWorkspace
                    && document.activeElement
                    && terminalEl.contains(document.activeElement)
                )
            ) {
                const targetKey = editorManager.getPreferredNonTerminalWorkspaceTabKey(
                    session
                );
                if (targetKey) {
                    editorManager.activateWorkspaceTab(targetKey);
                    if (isAgentWorkspaceTabKey(targetKey)) {
                        requestAnimationFrame(() => {
                            editorManager.agentPrompt?.focus();
                        });
                    }
                }
            } else if (editorManager.pane.style.display !== 'none') {
                if (isAgentWorkspaceTabKey(activeKey)) {
                    editorManager.agentPrompt?.focus();
                } else {
                    editorManager.editor.focus();
                }
            }
            return;
        }
        if (code === 'ArrowDown') {
            e.preventDefault();
            const session = getActiveSession();
            if (!session) return;
            const activeKey = editorManager?.getActiveWorkspaceTabKey(session) || '';
            if (
                editorManager
                && !isAgentWorkspaceTabKey(activeKey)
                && !isTerminalWorkspaceTabKey(activeKey)
            ) {
                editorManager.saveActiveEditorViewState(session);
            }
            const hasTerminalTab = editorManager?.hasCompactWorkspaceTabs?.(session);
            if (hasTerminalTab && activeKey !== TERMINAL_WORKSPACE_TAB_KEY) {
                editorManager.activateTerminalTab();
            } else {
                session.mainTerm.focus();
            }
            return;
        }
    }
    
    // Ctrl + Option (Alt) Context
    if (e.altKey && !e.shiftKey) {
        // Ctrl + Option + [ / ]: Switch workspace tab (file/agent/terminal)
        if (code === 'BracketLeft' || code === 'BracketRight') {
            e.preventDefault();
            const direction = code === 'BracketLeft' ? -1 : 1;
            
            if (editorManager && editorManager.currentSession) {
                const session = editorManager.currentSession;
                const workspaceKeys = getWorkspaceTabKeysForSession(session);
                if (workspaceKeys.length > 1) {
                    const activeKey = editorManager.getActiveWorkspaceTabKey(session);
                    const currentIdx = Math.max(
                        0,
                        workspaceKeys.indexOf(activeKey)
                    );
                    let newIdx = currentIdx + direction;
                    if (newIdx < 0) newIdx = workspaceKeys.length - 1;
                    if (newIdx >= workspaceKeys.length) newIdx = 0;
                    editorManager.activateWorkspaceTab(workspaceKeys[newIdx]);
                }
            }
        }
    }
}, true); // Use capture phase to override editor/terminal


// Start the app
bootstrapServers();
initApp();
// #endregion
