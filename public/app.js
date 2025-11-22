import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/+esm';
import { CanvasAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-canvas@0.5.0/+esm';

// Detect Mobile/Tablet (focus on touch capability for font sizing)
// Logic: If the device supports touch, we assume it needs larger fonts (14px)
const IS_MOBILE = navigator.maxTouchPoints > 0;

// #region DOM Elements
const terminalEl = document.getElementById('terminal');
const tabListEl = document.getElementById('tab-list');
const newTabButton = document.getElementById('new-tab-button');
const systemStatusBarEl = document.getElementById('system-status-bar');
const loginModal = document.getElementById('login-modal');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const terminalWrapper = document.getElementById('terminal-wrapper');
const editorPane = document.getElementById('editor-pane');
// #endregion

// #region Configuration
const HEARTBEAT_INTERVAL_MS = 1000;
// #endregion

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

// #region Auth Manager
class AuthManager {
    constructor() {
        this.token = localStorage.getItem('tabminal_auth_token');
        this.isAuthenticated = !!this.token;
        this.heartbeatTimer = null;
    }

    async hashPassword(password) {
        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async login(password) {
        const hash = await this.hashPassword(password);
        this.token = hash;
        localStorage.setItem('tabminal_auth_token', hash);
        this.isAuthenticated = true;
        this.hideLoginModal();
        this.startHeartbeat();
        // Retry initial sync
        await initApp();
    }

    logout() {
        this.isAuthenticated = false;
        this.stopHeartbeat();
        this.showLoginModal();
    }

    showLoginModal(errorMsg = '') {
        loginModal.style.display = 'flex';
        passwordInput.value = '';
        passwordInput.focus();
        if (errorMsg) {
            loginError.textContent = errorMsg;
        } else {
            loginError.textContent = '';
        }
    }

    hideLoginModal() {
        loginModal.style.display = 'none';
        loginError.textContent = '';
    }

    getHeaders() {
        return this.token ? { 'Authorization': this.token } : {};
    }

    async fetch(url, options = {}) {
        if (!this.isAuthenticated && !url.includes('/healthz')) {
            // If not authenticated, don't even try, unless it's a public endpoint (none currently)
            // But we might be in the process of logging in.
            // Actually, we should try if we have a token.
        }

        const headers = {
            ...options.headers,
            ...this.getHeaders()
        };

        try {
            const response = await fetch(url, { ...options, headers });
            
            if (response.status === 401) {
                this.logout();
                throw new Error('Unauthorized');
            }
            
            if (response.status === 403) {
                const data = await response.json().catch(() => ({}));
                this.stopHeartbeat();
                this.showLoginModal(data.error || 'Service locked. Please restart server.');
                throw new Error('Service locked');
            }

            return response;
        } catch (error) {
            throw error;
        }
    }

    startHeartbeat() {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(syncSessions, HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

const auth = new AuthManager();
// #endregion

// #region Editor Manager
class EditorManager {
    constructor() {
        this.currentSession = null;
        this.globalModels = new Map(); // path -> { model, type: 'text'|'image' }
        this.iconMap = null;
        
        // DOM Elements
        this.pane = document.getElementById('editor-pane');
        this.resizer = document.getElementById('editor-resizer');
        this.tabsContainer = document.getElementById('editor-tabs');
        this.monacoContainer = document.getElementById('monaco-container');
        this.imagePreviewContainer = document.getElementById('image-preview-container');
        this.imagePreview = document.getElementById('image-preview');
        this.emptyState = document.getElementById('empty-editor-state');
        
        this.initResizer();
        this.initMonaco();
        this.loadIconMap();
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
                
                const pending = getPendingSession(this.currentSession.id);
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
            for (const [path, file] of this.globalModels) {
                if (file.type === 'text' && !file.model && file.content !== null) {
                    file.model = monaco.editor.createModel(file.content, undefined, monaco.Uri.file(path));
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
        const shouldShow = state.isVisible && hasOpenFiles;
        
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
        
        const tab = document.querySelector(`.tab-item[data-session-id="${this.currentSession.id}"]`);
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
            if (state.activeFilePath) {
                this.activateTab(state.activeFilePath, true);
            }
        }
        
        this.updateEditorPaneVisibility();
        this.currentSession.saveState();
    }

    switchTo(session) {
        if (this.currentSession && this.editor && this.currentSession.editorState.activeFilePath) {
            const prevState = this.currentSession.editorState;
            const prevFile = this.globalModels.get(prevState.activeFilePath);
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
            if (state.activeFilePath) {
                this.activateTab(state.activeFilePath, true);
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
            const res = await auth.fetch(`/api/fs/list?path=${encodeURIComponent(dirPath)}`);
            if (!res.ok) return;
            const files = await res.json();

            const ul = document.createElement('ul');
            
            for (const file of files) {
                const li = document.createElement('li');
                const div = document.createElement('div');
                div.className = 'file-tree-item';
                if (file.isDirectory) div.classList.add('is-dir');
                
                let isExpanded = false;
                if (file.isDirectory && globalExpandedPaths.has(file.path)) {
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
                            globalExpandedPaths.delete(file.path);
                            auth.fetch('/api/memory/expand', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ path: file.path, expanded: false }) });
                            
                            icon.innerHTML = this.getIcon(file.name, true, false);
                            const childUl = li.querySelector('ul');
                            if (childUl) childUl.remove();
                        } else {
                            li.classList.add('expanded');
                            globalExpandedPaths.add(file.path);
                            auth.fetch('/api/memory/expand', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ path: file.path, expanded: true }) });
                            
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

    async openFile(filePath, restoreOnly = false) {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;

        if (!state.openFiles.includes(filePath)) {
            state.openFiles.push(filePath);
            this.renderEditorTabs();
        }
        
        this.updateEditorPaneVisibility();

        if (!this.globalModels.has(filePath)) {
            const ext = filePath.split('.').pop().toLowerCase();
            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext);
            
            let model = null;
            let content = null;
            let readonly = false;

            if (!isImage) {
                try {
                    const res = await auth.fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
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

            this.globalModels.set(filePath, {
                type: isImage ? 'image' : 'text',
                model: model,
                content: content,
                readonly: readonly
            });
        }

        this.activateTab(filePath);
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
        this.currentSession.saveState();
        
        if (state.activeFilePath === filePath) {
            if (state.openFiles.length > 0) {
                this.activateTab(state.openFiles[state.openFiles.length - 1]);
            } else {
                state.activeFilePath = null;
                this.showEmptyState();
            }
        }
    }

    renderEditorTabs() {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;

        this.tabsContainer.innerHTML = '';
        for (const path of state.openFiles) {
            const tab = document.createElement('div');
            tab.className = 'editor-tab';
            if (path === state.activeFilePath) tab.classList.add('active');
            
            const fileModel = this.globalModels.get(path);
            if (fileModel && fileModel.readonly) {
                tab.classList.add('readonly');
            }
            
            const name = path.split('/').pop();
            const span = document.createElement('span');
            span.textContent = name;
            
                        const closeBtn = document.createElement('span');
                closeBtn.className = 'close-btn';
                closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
                closeBtn.onclick = (e) => {
                            e.stopPropagation();
                            this.closeFile(path);            };
            
            tab.onclick = () => this.activateTab(path);
            
            tab.appendChild(span);
            tab.appendChild(closeBtn);
            this.tabsContainer.appendChild(tab);
        }
    }

    activateTab(filePath, isRestore = false) {
        if (!this.currentSession) return;
        const state = this.currentSession.editorState;

        if (!isRestore && state.activeFilePath && state.activeFilePath !== filePath) {
            const currentGlobal = this.globalModels.get(state.activeFilePath);
            if (currentGlobal && currentGlobal.type === 'text' && this.editor) {
                state.viewStates.set(state.activeFilePath, this.editor.saveViewState());
            }
        }

        state.activeFilePath = filePath;
        this.currentSession.saveState();
        const file = this.globalModels.get(filePath);
        
        this.renderEditorTabs();
        this.emptyState.style.display = 'none';

        if (!file) {
            this.openFile(filePath, true);
            return;
        }

        if (file.type === 'image') {
            this.monacoContainer.style.display = 'none';
            this.imagePreviewContainer.style.display = 'flex';
            
            this.imagePreview.onerror = () => {
                alert(`Failed to load image: ${filePath.split('/').pop()}`, { type: 'error', title: 'Error' });
                this.closeFile(filePath);
                this.imagePreview.onerror = null;
            };
            
            this.imagePreview.src = `/api/fs/raw?path=${encodeURIComponent(filePath)}&token=${auth.token}`;
        } else {
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

    showEmptyState() {
        this.monacoContainer.style.display = 'none';
        this.imagePreviewContainer.style.display = 'none';
        this.emptyState.style.display = 'flex';
    }
}

const editorManager = new EditorManager();
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
        
        this.saveStateTimer = null;

        this.editorState = {
            isVisible: data.editorState?.isVisible || false,
            root: this.cwd,
            openFiles: data.editorState?.openFiles || [],
            activeFilePath: data.editorState?.activeFilePath || null,
            viewStates: new Map() // Path -> ViewState
        };
        
        this.layoutState = {
            editorFlex: '2 1 0%'
        };

        // Preview Terminal (Always create instance to maintain logic consistency)
        this.previewTerm = new Terminal({
            disableStdin: true,
            cursorBlink: false,
            allowTransparency: true,
            fontSize: 10,
            rows: this.rows,
            cols: this.cols,
            theme: { background: '#002b36', foreground: '#839496', cursor: 'transparent', selectionBackground: 'transparent' }
        });
        
        // Only load CanvasAddon on Desktop to save GPU memory
        if (window.innerWidth >= 768) {
            this.previewTerm.loadAddon(new CanvasAddon());
        }
        
        this.wrapperElement = null;

        // Main Terminal
        this.mainTerm = new Terminal({
            allowTransparency: true,
            convertEol: true,
            cursorBlink: true,
            fontFamily: "'Monaspace Neon', \"SF Mono Terminal\", \"SFMono-Regular\", \"SF Mono\", \"JetBrains Mono\", Menlo, Consolas, monospace",
            fontSize: IS_MOBILE ? 14 : 12,
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
            
            const pending = getPendingSession(this.id);
            pending.resize = { cols: size.cols, rows: size.rows };
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

    saveState() {
        const pending = getPendingSession(this.id);
        pending.editorState = {
            isVisible: this.editorState.isVisible,
            root: this.editorState.root,
            openFiles: this.editorState.openFiles,
            activeFilePath: this.editorState.activeFilePath
        };
    }

    connect() {
        if (!auth.isAuthenticated) return;

        // Prevent duplicate connection attempts
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const endpoint = `${protocol}://${window.location.host}/ws/${this.id}`;
        
        // Using query param for auth token
        this.socket = new WebSocket(`${endpoint}?token=${auth.token}`);

        this.socket.addEventListener('open', () => {
            this.reconnectAttempts = 0;
            if (state.activeSessionId === this.id) this.reportResize();
        });

        this.socket.addEventListener('message', (event) => {
            try {
                this.handleMessage(JSON.parse(event.data));
            } catch (_err) { /* ignore */ }
        });

        this.socket.addEventListener('close', (event) => {
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
                if (this.previewTerm) this.previewTerm.reset();
                this.mainTerm.reset();
                this.history = message.data || '';
                this.isRestoring = true;
                if (this.previewTerm) this.previewTerm.write(this.history);
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

// #region State Management
const state = {
    sessions: new Map(), // id -> Session
    activeSessionId: null
};

const pendingChanges = {
    sessions: new Map() // id -> { resize, editorState, fileWrites: Map<path, content> }
};

function getPendingSession(id) {
    if (!pendingChanges.sessions.has(id)) {
        pendingChanges.sessions.set(id, { fileWrites: new Map() });
    }
    return pendingChanges.sessions.get(id);
}

const globalExpandedPaths = new Set();

async function fetchExpandedPaths() {
    try {
        const res = await auth.fetch('/api/memory/expanded');
        if (res.ok) {
            const list = await res.json();
            // console.log('[Memory] Fetched expanded paths:', list);
            globalExpandedPaths.clear();
            list.forEach(p => globalExpandedPaths.add(p));
        }
    } catch (e) { console.error(e); }
}

async function syncSessions() {
    if (!auth.isAuthenticated) return;

    // Check WebSocket health for all active sessions
    for (const session of state.sessions.values()) {
        if (!session.socket || session.socket.readyState === WebSocket.CLOSED) {
            // console.log(`[Heartbeat] Session ${session.id} disconnected. Reconnecting...`);
            session.connect();
        }
    }

    const updates = { sessions: [] };
    for (const [id, pending] of pendingChanges.sessions) {
        const sessionUpdate = { id };
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
        const response = await auth.fetch('/api/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates })
        });
        
        const latency = Date.now() - startTime;

        if (!response.ok) {
            console.warn('Heartbeat server error:', response.status);
            setStatus('reconnecting');
            updateSystemStatus(null, -1); // Record missing data
            return;
        }
        
        // Clear sent updates
        for (const update of updates.sessions) {
            const pending = pendingChanges.sessions.get(update.id);
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
        
        setStatus('connected');
        if (data.system) {
            updateSystemStatus(data.system, latency);
        }

        const sessions = Array.isArray(data) ? data : data.sessions;
        reconcileSessions(sessions);
    } catch (error) {
        console.error('Heartbeat failed:', error);
        setStatus('reconnecting');
        updateSystemStatus(null, -1); // Record missing data
    }
}

let lastSystemData = null;
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
const heartbeatCtx = heartbeatCanvas ? heartbeatCanvas.getContext('2d') : null;

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
}
animateHeartbeat();

function updateSystemStatus(system, latency) {
    const textGroup = document.getElementById('status-text-group');
    if (!textGroup) return; // Should exist in HTML now

    if (system) lastSystemData = system;
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
        lastUpdateTime = performance.now();
        latencyHistory.push(latency);
        // Keep enough history to fill screen + buffer
        // We need DISPLAY_POINTS + 1 to scroll smoothly
        if (latencyHistory.length > TOTAL_POINTS) latencyHistory.shift();
    }
    
    const data = system || lastSystemData;
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

    const isHealthy = currentConnectionStatus === 'connected' || currentConnectionStatus === 'ready';
    const heartbeatColor = isHealthy ? '#859900' : '#dc322f';
    const statusSuffix = isHealthy ? '' : ` (${currentConnectionStatus || 'unknown'})`;
    const timeText = isHealthy ? `${lastLatency}ms` : 'Offline';
    const heartbeatValue = `<span style="color: ${heartbeatColor}"><span class="heartbeat-dot"></span>${timeText}${statusSuffix}</span>`;

    const items = [
        { label: 'Host', value: data.hostname },
        { label: 'Kernel', value: data.osName },
        { label: 'IP', value: data.ip },
        { label: 'CPU', value: `${data.cpu.count}x ${data.cpu.speed} ${data.cpu.usagePercent}% ${renderProgressBar(data.cpu.usagePercent)}` },
        { label: 'Mem', value: `${formatBytesPair(data.memory.used, data.memory.total)} ${memPercent.toFixed(0)}% ${renderProgressBar(memPercent)}` },
        { label: 'Up', value: formatUptime(data.uptime) },
        { label: 'Tabminal', value: `${state.sessions.size}> ${formatUptime(data.processUptime)}` },
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
        const options = {};
        if (state.activeSessionId && state.sessions.has(state.activeSessionId)) {
            const active = state.sessions.get(state.activeSessionId);
            if (active.cwd) {
                options.cwd = active.cwd;
            }
        }

        const response = await auth.fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options)
        });
        
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
    if (session.editorState && session.editorState.isVisible) {
        tab.classList.add('editor-open');
    }
    tab.dataset.sessionId = session.id;
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-tab-button';
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    closeBtn.title = 'Close Terminal';
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        auth.fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
    };
    tab.appendChild(closeBtn);

    const toggleEditorBtn = document.createElement('button');
    toggleEditorBtn.className = 'toggle-editor-btn';
    toggleEditorBtn.innerHTML = '<img src="/icons/folder-src.svg" style="width: 16px; height: 16px; vertical-align: middle;">';
    toggleEditorBtn.title = 'Toggle File Editor';
    toggleEditorBtn.onclick = (e) => {
        e.stopPropagation();
        if (state.activeSessionId !== session.id) {
            switchToSession(session.id).then(() => editorManager.toggle());
        } else {
            editorManager.toggle();
        }
    };
    tab.appendChild(toggleEditorBtn);
    
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
    
    tab.onclick = () => switchToSession(session.id);

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
        switchToSession(session.id);
    });
    
    return tab;
}

document.addEventListener('click', () => {
    notificationManager.requestPermission();
}, { once: true });
// #endregion

// #region Notification Manager
class NotificationManager {
    constructor() {
        this.hasPermission = false;
        if ('Notification' in window) {
            this.hasPermission = Notification.permission === 'granted';
        }
    }

    requestPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                this.hasPermission = permission === 'granted';
            });
        }
    }

    send(title, body) {
        if (!('Notification' in window)) return false;
        
        // Check permission status directly
        if (Notification.permission === 'granted') {
            try {
                new Notification(title, {
                    body: body,
                    icon: '/apple-touch-icon.png',
                    tag: 'tabminal-status'
                });
                return true;
            } catch (e) {
                console.error('Notification error:', e);
                return false;
            }
        }
        return false;
    }
}
const notificationManager = new NotificationManager();

document.addEventListener('click', () => {
    notificationManager.requestPermission();
}, { once: true, capture: true });
// #endregion

// #region Toast Manager
class ToastManager {
    constructor() {
        this.container = document.getElementById('notification-container');
    }

    show(title, message, type = 'info') {
        if (!this.container) return;
        
        if (message === undefined || (typeof message === 'string' && ['info', 'warning', 'error', 'success'].includes(message))) {
            type = message || 'info';
            message = title;
            title = 'Tabminal';
        }

        const existingToasts = Array.from(this.container.children);
        for (const toast of existingToasts) {
            if (toast.dataset.title === title && toast.dataset.message === message && !toast.classList.contains('hiding')) {
                this.extendLife(toast);
                return;
            }
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.dataset.title = title;
        toast.dataset.message = message;
        
        const content = document.createElement('div');
        content.className = 'toast-content';
        
        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;
        
        const msgEl = document.createElement('div');
        msgEl.className = 'toast-message';
        msgEl.textContent = message;
        
        content.appendChild(titleEl);
        content.appendChild(msgEl);
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        closeBtn.onclick = () => this.dismiss(toast);
        
        toast.appendChild(content);
        toast.appendChild(closeBtn);
        
        this.container.insertBefore(toast, this.container.firstChild);
        
        requestAnimationFrame(() => this.prune());

        this.startTimer(toast);
    }

    startTimer(toast) {
        if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
        toast.dismissTimer = setTimeout(() => this.dismiss(toast), 5000);
    }

    extendLife(toast) {
        if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
        toast.classList.remove('hiding'); // Ensure it's visible if it was fading out
        toast.style.animation = 'none';
        toast.offsetHeight; /* trigger reflow */
        toast.style.animation = null; 
        toast.dismissTimer = setTimeout(() => this.dismiss(toast), 3000);
    }

    prune() {
        const viewportHeight = window.innerHeight;
        const bottomLimit = viewportHeight - 20;
        const toasts = Array.from(this.container.children);
        
        for (const toast of toasts) {
            const rect = toast.getBoundingClientRect();
            if (rect.bottom > bottomLimit) {
                this.dismiss(toast);
            }
        }
    }

    dismiss(toast) {
        if (!toast || toast.classList.contains('hiding')) return;
        if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
        
        toast.classList.add('hiding');
        
        const remove = () => {
            if (toast.parentElement) toast.remove();
        };
        
        toast.addEventListener('transitionend', remove, { once: true });
        setTimeout(remove, 550);
    }
}
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

let currentConnectionStatus = null;

function setStatus(status) {
    if (status === currentConnectionStatus) return;
    
    const prevStatus = currentConnectionStatus;
    currentConnectionStatus = status;

    if (status === 'reconnecting') {
        alert('Lost connection. Reconnecting...', { type: 'warning', title: 'Connection' });
    } else if (status === 'connected' && prevStatus === 'reconnecting') {
        alert('Connection restored.', { type: 'success', title: 'Connection' });
    } else if (status === 'terminated') {
        alert('Session has ended.', { type: 'error', title: 'Connection' });
    } else if (status === 'connected' && !prevStatus) {
        alert('Connected to server.', { type: 'success', title: 'Connection' });
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
    
    // Sync editor state
    editorManager.switchTo(session);
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
        await auth.fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        
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
                state.activeSessionId = null;
                terminalEl.innerHTML = '';
            }
        }
        
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
        
        if (session.editorState && session.editorState.isVisible) {
            editorManager.layout();
        }
    }
});
resizeObserver.observe(terminalWrapper);
resizeObserver.observe(editorPane);

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

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = passwordInput.value;
    try {
        await auth.login(password);
    } catch (err) {
        console.error(err);
    }
});

window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    for (const session of state.sessions.values()) {
        session.dispose();
    }
});

async function initApp() {
    if (!auth.isAuthenticated) {
        auth.showLoginModal();
        return;
    }
    
    auth.startHeartbeat();
    await syncSessions();
    // If no sessions, create one
    if (state.sessions.size === 0) {
        await createNewSession();
    }
}

// Virtual Keyboard Logic
const virtualKeys = document.getElementById('virtual-keys');

if (virtualKeys) {
    const handleKey = (key, btn) => {
        if (!state.activeSessionId || !state.sessions.has(state.activeSessionId)) return;
        const session = state.sessions.get(state.activeSessionId);
        
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

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
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
            if (state.activeSessionId) {
                closeSession(state.activeSessionId);
            }
            return;
        }
        
        // Ctrl + Shift + [ / ]: Switch Tab
        if (code === 'BracketLeft' || code === 'BracketRight') {
            e.preventDefault();
            const direction = code === 'BracketLeft' ? -1 : 1;
            
            const sessionIds = Array.from(state.sessions.keys());
            if (sessionIds.length > 1) {
                const currentIdx = sessionIds.indexOf(state.activeSessionId);
                let newIdx = currentIdx + direction;
                if (newIdx < 0) newIdx = sessionIds.length - 1;
                if (newIdx >= sessionIds.length) newIdx = 0;
                switchToSession(sessionIds[newIdx]);
            }
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
});

// Start the app
initApp();
// #endregion
