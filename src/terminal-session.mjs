import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import AnsiParser from 'node-ansiparser';
import { alan } from 'utilitas';
import { config } from './config.mjs';

const execAsync = promisify(exec);
const {
    HeadlessTerminal,
    SerializeAddon
} = await loadHeadlessXtermPackages();
const WS_STATE_OPEN = 1;
const DEFAULT_HISTORY_LIMIT = 512 * 1024; // chars
const OSC_SEQUENCE_REGEX =
    /\u001b\]1337;(ExitCode=(\d+);CommandB64=([a-zA-Z0-9+/=]+)|CommandStartB64=([a-zA-Z0-9+/=]+)|TabminalPrompt)\u0007/g;
const EXTRA_PRIVATE_MODE_REGEX = /\u001b\[\?(1005|1006|1015)([hl])/g;
const CSI_SEQUENCE_REGEX = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC_STRIP_REGEX = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const DCS_SEQUENCE_REGEX = /\u001bP[\s\S]*?(?:\u0007|\u001b\\)/g;
const SOS_PM_APC_SEQUENCE_REGEX = /\u001b[\^_][\s\S]*?\u001b\\/g;
const TWO_CHAR_ESCAPE_REGEX = /\u001b[@-Z\\-_]/g;
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const TITLE_POLL_INTERVAL_MS = 3000;

const IGNORED_COMMANDS = [
    'export PROMPT_COMMAND',
    '__bash_prompt',
    'TABMINAL_SHELL_READY=1'
];

const PROMPT_PREFIX = "You are now operating as an AI terminal assistant. Your name is `Tabminal`. You will assist users in resolving terminal or coding issues and answering other inquiries. When troubleshooting terminal errors, you will be provided with the execution history to understand the context. However, please focus primarily on the most recent runtime errors and the user's latest questions. Keep your answers concise and accurate. Resolve the issue clearly and provide the reasoning while avoiding lengthy elaborations. Most user terminal variable keys are normal under typical circumstances and do not need to be treated as security risks.\n\n";

async function loadHeadlessXtermPackages() {
    const hadNavigator = Object.prototype.hasOwnProperty.call(
        globalThis,
        'navigator'
    );
    const navigatorDescriptor = hadNavigator
        ? Object.getOwnPropertyDescriptor(globalThis, 'navigator')
        : null;

    if (hadNavigator) {
        delete globalThis.navigator;
    }

    try {
        const headlessPackage = await import('xterm-headless');
        const serializePackage = await import('xterm-addon-serialize');
        const { Terminal } = headlessPackage.default ?? headlessPackage;
        const { SerializeAddon } = serializePackage.default ?? serializePackage;
        return {
            HeadlessTerminal: Terminal,
            SerializeAddon
        };
    } finally {
        if (hadNavigator && navigatorDescriptor) {
            Object.defineProperty(
                globalThis,
                'navigator',
                navigatorDescriptor
            );
        }
    }
}

function splitTrailingPartialSequence(chunk) {
    if (!chunk) {
        return { complete: '', partial: '' };
    }

    const oscStart = chunk.lastIndexOf('\u001b]1337;');
    if (oscStart >= 0) {
        const oscTail = chunk.slice(oscStart);
        if (!oscTail.includes('\u0007')) {
            return {
                complete: chunk.slice(0, oscStart),
                partial: oscTail
            };
        }
    }

    return { complete: chunk, partial: '' };
}

function estimateSnapshotScrollback(cols, rows, historyLimit) {
    const safeCols = Math.max(1, cols || 80);
    const safeRows = Math.max(24, rows || 24);
    const estimatedRows = Math.ceil(historyLimit / safeCols);
    return Math.max(safeRows, Math.min(50000, estimatedRows));
}

export class TerminalSession {
    constructor(pty, options = {}) {
        this.pty = pty;
        this.id = options.id;
        this.manager = options.manager;
        this.createdAt = options.createdAt ?? new Date();
        this.updatedAt = this.createdAt;
        this.shell = options.shell;
        this.initialCwd = options.initialCwd;
        this.managed = options.managed || null;
        this.persistent = options.persistent !== false;
        this.removeOnExit = options.removeOnExit !== false;
        this.enableAiHijack = options.enableAiHijack !== false;
        this.enableTitlePolling = options.enableTitlePolling !== false;

        this.title = options.title
            || (this.shell ? this.shell.split('/').pop() : 'Terminal');
        this.cwd = this.initialCwd;
        this.inputBuffer = '';

        // Format the initial environment object into a static string
        this.env = Object.entries(options.env || {})
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        this.editorState = options.editorState || {};
        this.executions = options.executions || [];

        this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
        this.history = '';
        this.clients = new Set();
        this.pendingClients = new Map();
        this.closed = false;
        this.exitStatus = null;
        this.exitWaiters = [];
        this.stateListeners = new Set();
        this.pollingInterval = null;
        this.captureBuffer = '';
        this.captureStartedAt = null;
        this.lastExecution = null;
        this.executionCounter = 0;
        this.currentExecutionId = '';
        this.skipNextShellLog = false;
        this.skipNextShellLogResetTimer = null;
        this.partialSequenceBuffer = '';
        this.activeAiRun = null;
        this.snapshotScrollback = estimateSnapshotScrollback(
            this.pty.cols,
            this.pty.rows,
            this.historyLimit
        );
        this.snapshotTerminal = new HeadlessTerminal({
            cols: this.pty.cols,
            rows: this.pty.rows,
            scrollback: this.snapshotScrollback,
            allowProposedApi: true,
            convertEol: true,
            logLevel: 'off'
        });
        this.snapshotSerializeAddon = new SerializeAddon();
        this.snapshotTerminal.loadAddon(this.snapshotSerializeAddon);
        this.snapshotWritePromise = Promise.resolve();
        this.extraPrivateModes = {
            1005: false,
            1006: false,
            1015: false
        };

        this.ansiParser = new AnsiParser({
            inst_o: (s) => {
                if (s.startsWith('0;') || s.startsWith('2;')) {
                    const newTitle = s.substring(2);
                    if (newTitle && newTitle !== this.title) {
                        this.title = newTitle;
                        this.updatedAt = new Date();
                        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                        this._emitStateChange();
                    }
                } else if (s.startsWith('7;')) {
                    try {
                        const url = new URL(s.substring(2));
                        if (url.pathname) {
                            const newCwd = decodeURIComponent(url.pathname);
                            if (newCwd !== this.cwd) {
                                this.cwd = newCwd;
                                this.updatedAt = new Date();
                                this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                                this._emitStateChange();
                            }
                        }
                    } catch { /* ignore */ }
                }
            },
        });

        this._handleData = (chunk) => {
            if (this.suppressPtyOutput) return;

            if (typeof chunk !== 'string') chunk = chunk.toString('utf8');
            if (this.partialSequenceBuffer) {
                chunk = this.partialSequenceBuffer + chunk;
                this.partialSequenceBuffer = '';
            }
            const split = splitTrailingPartialSequence(chunk);
            chunk = split.complete;
            this.partialSequenceBuffer = split.partial;

            let cleaned = '';
            let lastIndex = 0;
            OSC_SEQUENCE_REGEX.lastIndex = 0;

            let match;
            while ((match = OSC_SEQUENCE_REGEX.exec(chunk)) !== null) {
                const plain = chunk.slice(lastIndex, match.index);
                if (plain) {
                    cleaned += plain;
                    this._appendCapturedOutput(plain);
                }

                const sequence = match[1];
                if (sequence.startsWith('ExitCode=')) {
                    const exitCodeStr = match[2];
                    const cmdB64 = match[3];
                    this._handleExitCodeSequence(exitCodeStr, cmdB64);
                } else if (sequence.startsWith('CommandStartB64=')) {
                    this._handleCommandStartSequence(match[4]);
                } else {
                    this._handlePromptMarker();
                }

                lastIndex = OSC_SEQUENCE_REGEX.lastIndex;
            }

            const tail = chunk.slice(lastIndex);
            if (tail) {
                cleaned += tail;
                this._appendCapturedOutput(tail);
            }

            if (!cleaned) return;

            this._appendSnapshotData(cleaned);
            this._appendHistory(cleaned);
            this.updatedAt = new Date();
            this.ansiParser.parse(cleaned);
            if (this.manager?.scheduleSnapshotPersist) {
                this.manager.scheduleSnapshotPersist(this.id);
            }
            this._broadcast({ type: 'output', data: cleaned });
            this._emitStateChange();
        };

        this._handleExit = (details) => {
            this.closed = true;
            this.exitStatus = {
                exitCode: Number.isFinite(details?.exitCode)
                    ? details.exitCode
                    : null,
                signal: details?.signal ?? null
            };
            this.updatedAt = new Date();
            this.stopTitlePolling();
            this._broadcast({
                type: 'status',
                status: 'terminated',
                code: this.exitStatus.exitCode ?? 0,
                signal: this.exitStatus.signal
            });
            this._emitStateChange();
            for (const waiter of this.exitWaiters) {
                waiter(this.exitStatus);
            }
            this.exitWaiters.length = 0;
        };

        this.dataSubscription = this.pty.onData(this._handleData);
        this.exitSubscription = this.pty.onExit(this._handleExit);
        if (this.enableTitlePolling) {
            this.startTitlePolling();
        }
    }

    startTitlePolling() {
        if (this.pollingInterval) return;

        const poll = async () => {
            if (this.closed) return;
            try {
                let currentPid = this.pty.pid;
                while (true) {
                    try {
                        const { stdout } = await execAsync(`pgrep -P ${currentPid}`);
                        const pids = stdout.trim().split('\n').filter(Boolean).map(p => parseInt(p, 10));
                        if (pids.length === 0) break;
                        currentPid = Math.max(...pids);
                    } catch { break; }
                }

                let newTitle;
                if (currentPid !== this.pty.pid) {
                    const { stdout: argsOut } = await execAsync(`ps -o args= -p ${currentPid}`);
                    newTitle = argsOut.trim();
                    const firstSpace = newTitle.indexOf(' ');
                    const cmd = firstSpace > 0 ? newTitle.substring(0, firstSpace) : newTitle;
                    if (cmd.includes('/')) {
                        newTitle = cmd.split('/').pop() + (firstSpace > 0 ? newTitle.substring(firstSpace) : '');
                    }
                } else {
                    newTitle = this.shell ? this.shell.split('/').pop() : 'Terminal';
                }

                let newEnv = null;
                try {
                    const { stdout: envOut } = await execAsync(`ps -p ${currentPid} -wwE`);
                    const lines = envOut.trim().split('\n');
                    if (lines.length > 1) {
                        const rawLine = lines.slice(1).join(' ');
                        const cmdAndArgs = (await execAsync(`ps -o args= -p ${currentPid}`)).stdout.trim();
                        const envBlock = rawLine.substring(rawLine.indexOf(cmdAndArgs) + cmdAndArgs.length).trim();

                        // Keep lowercase env keys (e.g. npm_config_*) as
                        // standalone entries instead of appending to USER.
                        const regex = /([A-Za-z_][A-Za-z0-9_]*=)/g;
                        const indices = [];
                        let match;
                        while ((match = regex.exec(envBlock)) !== null) {
                            indices.push(match.index);
                        }

                        if (indices.length > 0) {
                            const envs = [];
                            for (let i = 0; i < indices.length; i++) {
                                const start = indices[i];
                                const end = (i + 1 < indices.length) ? indices[i + 1] : envBlock.length;
                                envs.push(envBlock.substring(start, end).trim());
                            }
                            newEnv = envs.join('\n');
                        }
                    }
                } catch { /* ignore */ }

                // Poll CWD
                let newCwd = this.cwd;
                try {
                    if (process.platform === 'linux') {
                        const { stdout } = await execAsync(`readlink /proc/${currentPid}/cwd`);
                        newCwd = stdout.trim();
                    } else if (process.platform === 'darwin') {
                        const { stdout } = await execAsync(`lsof -a -p ${currentPid} -d cwd -F n`);
                        const lines = stdout.trim().split('\n');
                        for (const line of lines) {
                            if (line.startsWith('n')) {
                                newCwd = line.substring(1);
                                break;
                            }
                        }
                    }
                } catch { /* ignore */ }

                const titleChanged = newTitle && newTitle !== this.title;
                const envChanged = newEnv !== null && newEnv !== this.env;
                const cwdChanged = newCwd && newCwd !== this.cwd;

                if (titleChanged || envChanged || cwdChanged) {
                    if (titleChanged) this.title = newTitle;
                    if (envChanged) this.env = newEnv;
                    if (cwdChanged) this.cwd = newCwd;
                    this.updatedAt = new Date();
                    this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                    this._emitStateChange();
                }
            } catch { /* ignore */ }
        };

        poll(); // Run immediately
        this.pollingInterval = setInterval(poll, TITLE_POLL_INTERVAL_MS);
    }

    stopTitlePolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    attach(ws) {
        if (!ws) throw new Error('WebSocket instance required');
        this.pendingClients.set(ws, []);
        ws.once('close', () => {
            this.clients.delete(ws);
            this.pendingClients.delete(ws);
        });
        ws.on('message', (raw) => this._routeIncoming(raw, ws));
        ws.on('error', () => ws.close());

        void this._sendInitialState(ws);
    }

    dispose() {
        this.stopTitlePolling();
        this._clearSkipNextShellLogResetTimer();
        this.clients.clear();
        this.pendingClients.clear();
        this.dataSubscription?.dispose?.();
        this.exitSubscription?.dispose?.();
        this.snapshotTerminal?.dispose?.();
    }

    resize(cols, rows) {
        if (this.closed) return;
        this.pty.resize(cols, rows);
        this._queueSnapshotMutation(() => {
            this.snapshotTerminal.resize(cols, rows);
        });
        if (this.manager?.scheduleSnapshotPersist) {
            this.manager.scheduleSnapshotPersist(this.id);
        }
        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols, rows });
        this.updatedAt = new Date();
        this._emitStateChange();
        if (this.manager && this.manager.saveSessionState) {
            this.manager.saveSessionState(this);
        }
    }

    waitForExit() {
        if (this.exitStatus) {
            return Promise.resolve(this.exitStatus);
        }
        return new Promise((resolve) => {
            this.exitWaiters.push(resolve);
        });
    }

    onStateChange(listener) {
        if (typeof listener !== 'function') return () => {};
        this.stateListeners.add(listener);
        return () => {
            this.stateListeners.delete(listener);
        };
    }

    _emitStateChange() {
        for (const listener of this.stateListeners) {
            try {
                listener(this);
            } catch {
                // Ignore state listener failures.
            }
        }
    }

    async restoreSnapshot(snapshot) {
        if (typeof snapshot !== 'string' || !snapshot) return;
        this.history = snapshot;
        this._appendSnapshotData(snapshot);
        await this.snapshotWritePromise;
    }

    async serializeSnapshot() {
        await this.snapshotWritePromise;
        let snapshot = this.snapshotSerializeAddon.serialize({
            scrollback: this.snapshotScrollback
        });
        snapshot += this._serializeExtraPrivateModes();
        return snapshot;
    }

    _routeIncoming(raw, ws) {
        let payload;
        try {
            payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        } catch { return; }

        switch (payload.type) {
            case 'input': this._handleInput(payload.data); break;
            case 'resize': this._handleResize(payload.cols, payload.rows); break;
            case 'ping': this._send(ws, { type: 'pong' }); break;
        }
    }

    _handleInput(data) {
        if (this.closed || typeof data !== 'string') return;
        this.write(data);
    }

    _isAiEnabled() {
        return Boolean(
            (config.openrouterKey && String(config.openrouterKey).trim()) ||
            (config.openaiKey && String(config.openaiKey).trim())
        );
    }

    write(data) {
        if (this.activeAiRun && typeof data === 'string') {
            this._handleInputDuringAi(data);
            return;
        }

        if (typeof data === 'string' && data.startsWith('\x1b')) {
            this.pty.write(data);
            this.inputBuffer = '';
            return;
        }

        if (typeof data !== 'string') {
            this.pty.write(data);
            return;
        }

        let startIndex = 0;
        const aiEnabled = this.enableAiHijack && this._isAiEnabled();
        for (let i = 0; i < data.length; i++) {
            const char = data[i];

            // Handle Enter (\r)
            if (char === '\r') {
                // Smart detection for AI command (#)
                // Ignore prefix if it only contains whitespace or terminal control artifacts (CPR)
                let line = null;
                if (aiEnabled) {
                    const idx = this.inputBuffer.indexOf('#');

                    if (idx !== -1) {
                        const prefix = this.inputBuffer.substring(0, idx);
                        // Allow whitespace, ESC, [, digits, ;, R (typical CPR response)
                        if (/^[\s\x1b\[\d;R]*$/.test(prefix)) {
                            line = this.inputBuffer.substring(idx);
                        }
                    }
                }

                if (line) {
                    // --- HIJACK DETECTED ---

                    // 1. Write pending data BEFORE this char to pty
                    if (i > startIndex) {
                        this.pty.write(data.substring(startIndex, i));
                    }

                    // 2. Execute Hijack Logic
                    const prompt = line.substring(1).trim();
                    this.inputBuffer = ''; // Reset buffer

                    // Send Ctrl+U to pty to clear the visual line (since user typed it)
                    this.pty.write('\x15');

                    // Suppress PTY echo (like the Ctrl+U echo) to prevent race conditions with AI stream
                    this.suppressPtyOutput = true;

                    // Send newline and reset cursor to User (visual only)
                    this._writeToLogAndBroadcast('\r\n\r\x1b[K');

                    // Process AI
                    this._handleAiCommand(PROMPT_PREFIX + prompt);

                    // 3. Skip the \r in the input data (don't send to pty)
                    startIndex = i + 1;
                    continue;
                } else {
                    // Normal Enter, reset buffer
                    this.inputBuffer = '';
                }
            }
            // Handle Backspace
            else if (char === '\x7f' || char === '\x08') {
                if (this.inputBuffer.length > 0) {
                    this.inputBuffer = this.inputBuffer.slice(0, -1);
                }
            }
            // Handle Control Chars (Reset buffer to be safe, except Tab)
            else if (char < ' ' && char !== '\t') {
                this.inputBuffer = '';
            }
            // Normal Text
            else {
                this.inputBuffer += char;
            }
        }

        // Write remaining data to PTY
        if (startIndex < data.length) {
            this.pty.write(data.substring(startIndex));
        }
    }

    _handleInputDuringAi(data) {
        for (const char of data) {
            if (char === '\x03') {
                this._cancelActiveAiRun('ctrl_c');
                return;
            }
            if (char === '\x04') {
                this._cancelActiveAiRun('ctrl_d');
                return;
            }
        }
    }

    _buildAiContext(history) {
        let pendingShellHistory = '';
        const conversationHistory = [];

        for (const entry of history) {
            if (entry.command === 'ai' && entry.exitCode === 0 && entry.output) {
                // Case A: Successful AI Interaction -> Flush pending history into this turn
                const userContent = (pendingShellHistory ? pendingShellHistory.trim() + '\n\n' : '') + entry.input;

                conversationHistory.push({ request: userContent, response: entry.output });

                pendingShellHistory = ''; // Reset buffer
            } else {
                // Case B: Shell Command or Failed AI -> Accumulate history
                const output = entry.output ? entry.output : 'null';
                const record = `Input: ${entry.input}\nCommand: ${entry.command}\nOutput: ${output}\nExit Code: ${entry.exitCode}\nDuration: ${entry.duration}ms\nTime: ${entry.completedAt}\n`;
                pendingShellHistory += record + '\n';
            }
        }

        return { conversationHistory, pendingShellHistory };
    }

    _promptAi(prompt, options) {
        return alan.prompt(prompt, options);
    }

    _clearSkipNextShellLogResetTimer() {
        if (this.skipNextShellLogResetTimer) {
            clearTimeout(this.skipNextShellLogResetTimer);
            this.skipNextShellLogResetTimer = null;
        }
    }

    _scheduleSkipNextShellLogReset() {
        this._clearSkipNextShellLogResetTimer();
        this.skipNextShellLogResetTimer = setTimeout(() => {
            this.skipNextShellLog = false;
            this.skipNextShellLogResetTimer = null;
        }, 500);
        this.skipNextShellLogResetTimer.unref?.();
    }

    _finishAiInteraction(mode = 'normal') {
        this.suppressPtyOutput = false;
        this._scheduleSkipNextShellLogReset();

        if (mode === 'ctrl_c') {
            this._writeToLogAndBroadcast('\x1b[0m');
            this.pty.write('\x03');
            return;
        }

        this._writeToLogAndBroadcast('\x1b[0m\r\n');
        if (mode === 'ctrl_d') {
            this.pty.write('\x15');
        }
        this.pty.write('\r');
    }

    _cancelActiveAiRun(reason) {
        const run = this.activeAiRun;
        if (!run || run.cancelled) {
            return false;
        }

        run.cancelled = true;
        this.activeAiRun = null;
        this._logCommandExecution({
            command: 'ai',
            exitCode: 130,
            input: run.prompt,
            output: 'AI generation cancelled.',
            startedAt: run.startedAt,
            completedAt: new Date()
        });
        this._finishAiInteraction(reason);
        return true;
    }

    async _handleAiCommand(prompt) {
        // Prevent duplicate logging from shell integration
        this.skipNextShellLog = true;
        this._clearSkipNextShellLogResetTimer();
        // Ensure clean line start and set Cyan color (No prefix yet)
        this._writeToLogAndBroadcast('\r\x1b[K\x1b[36m');
        // Gather Context (Current Session Only)
        const cleanHistory = (this.executions && this.executions.length > 0) ? this.executions : [];
        // Build Context
        const { conversationHistory, pendingShellHistory } = this._buildAiContext(cleanHistory);
        // Construct Current Prompt
        const currentContext = `Recent Shell History:\n${pendingShellHistory}\nEnvironment:\n${this.env}\nCurrent Path: ${this.cwd}`;
        const finalPrompt = `${currentContext}\n\nQuestion: ${prompt}`;
        if (config.debug) {
            console.log('[AI Context Build]');
            console.log('History:', JSON.stringify(conversationHistory, null, 2));
            console.log('Current Prompt Preview:', JSON.stringify(finalPrompt, null, 2));
        }
        const startTime = new Date();
        let fullResponse = '';
        let isFirstChunk = true;
        const run = {
            prompt,
            startedAt: startTime,
            cancelled: false
        };
        this.activeAiRun = run;
        try {
            const streamCallback = (chunk) => {
                if (this.activeAiRun !== run || run.cancelled) {
                    return;
                }
                // console.log('Chunk Received:');
                // console.log(chunk);
                if (chunk && chunk.text) {
                    let text = chunk.text;
                    // Normalize newlines for terminal
                    text = text.replace(/\n/g, '\r\n');
                    if (isFirstChunk) {
                        const prefix = '\n\nTabminal:\n\n';
                        text = prefix + text;
                        isFirstChunk = false;
                    }
                    this._writeToLogAndBroadcast(text);
                }
            };
            // console.log('Start AI Prompt...');
            const result = await this._promptAi(finalPrompt, {
                stream: streamCallback,
                delta: true,
                messages: conversationHistory,
                trimBeginning: true
            });

            if (this.activeAiRun !== run || run.cancelled) {
                return;
            }

            if (result && result.text) {
                fullResponse = result.text;
            }

            // End color and new line
            this._writeToLogAndBroadcast('\x1b[0m\r\n');

            // Log Execution
            this._logCommandExecution({
                command: 'ai',
                exitCode: 0,
                input: prompt,
                output: fullResponse,
                startedAt: startTime,
                completedAt: new Date()
            });

        } catch (e) {
            if (this.activeAiRun !== run || run.cancelled) {
                return;
            }
            this._writeToLogAndBroadcast(`\x1b[31mAI Error: ${e.message}\x1b[0m\r\n`);

            this._logCommandExecution({
                command: 'ai',
                exitCode: 1,
                input: prompt,
                output: `AI Error: ${e.message}`,
                startedAt: startTime,
                completedAt: new Date()
            });
        } finally {
            if (this.activeAiRun === run) {
                this.activeAiRun = null;
                this._finishAiInteraction('normal');
            }
        }
    }

    _handleResize(cols, rows) {
        if (this.closed) return;
        const safeCols = clampDimension(cols);
        const safeRows = clampDimension(rows);
        if (safeCols && safeRows) {
            this.resize(safeCols, safeRows);
        }
    }

    _appendHistory(chunk) {
        this.history += chunk;
        if (this.history.length > this.historyLimit) {
            this.history = this.history.slice(this.history.length - this.historyLimit);
        }
    }

    _appendCapturedOutput(text) {
        if (!text) return;
        this.captureBuffer += text;
        if (!this.captureStartedAt) {
            this.captureStartedAt = new Date();
        }
    }

    _handlePromptMarker() {
        if (this.currentExecutionId) {
            this._broadcast({
                type: 'execution',
                phase: 'idle',
                executionId: this.currentExecutionId
            });
            this.currentExecutionId = '';
        }
        this.captureBuffer = '';
        this.captureStartedAt = null;
    }

    _handleCommandStartSequence(cmdB64) {
        const command = this._decodeCommandSafe(cmdB64);
        const startedAt = new Date();
        this.captureStartedAt = startedAt;
        this.executionCounter += 1;
        this.currentExecutionId = `exec-${this.executionCounter}`;
        this._broadcast({
            type: 'execution',
            phase: 'started',
            executionId: this.currentExecutionId,
            command,
            startedAt
        });
    }

    _handleExitCodeSequence(exitCodeStr, cmdB64) {
        if (this.skipNextShellLog) {
            this.skipNextShellLog = false;
            this._clearSkipNextShellLogResetTimer();
            this.captureBuffer = '';
            this.captureStartedAt = null;
            return;
        }

        const exitCode = Number.parseInt(exitCodeStr, 10);
        const command = this._decodeCommandSafe(cmdB64);
        const executionId = this.currentExecutionId
            || `exec-${++this.executionCounter}`;

        const completedAt = new Date();
        const entry = this._postProcessExecutionEntry({
            command,
            exitCode: Number.isNaN(exitCode) ? null : exitCode,
            ...this._splitInputOutput(
                this._sanitizeCapturedOutput(this.captureBuffer, command)
            ),
            startedAt: this.captureStartedAt ?? completedAt,
            completedAt,
        });

        this.lastExecution = entry;
        this.currentExecutionId = '';
        this._logCommandExecution(entry);
        this.captureBuffer = '';
        this.captureStartedAt = null;
        this._broadcast({
            type: 'execution',
            phase: 'completed',
            executionId,
            entry
        });

        // Auto-Fix: If command failed, ask AI for help
        if (exitCode !== 0 && entry.command && this._isAiEnabled()) {
            // Don't trigger on simple interruptions (SIGINT=130) or common non-errors?
            // 130 = Ctrl+C. Usually user intention.
            if (exitCode !== 130) {
                this._handleAiCommand(PROMPT_PREFIX + 'The previous command failed. Help me fix it. Focus on the recent commands and provide concise, clear answers. Avoid long explanations unless explicitly requested by the user.', { isAutoFix: true });
            }
        }
    }

    _postProcessExecutionEntry(entry) {
        if (!entry) return entry;
        return {
            ...entry,
            input: this._cleanCapturedText(entry.input),
            output: this._cleanCapturedText(entry.output)
        };
    }

    _decodeCommandSafe(encoded) {
        if (!encoded) return null;
        try {
            const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
            return decoded || null;
        } catch (err) {
            console.error('[Terminal Error] Failed to decode command:', err);
            return null;
        }
    }

    _sanitizeCapturedOutput(buffer, command) {
        if (!buffer) return '';
        let cleaned = buffer;
        const idx = this._findCommandEchoIndex(cleaned, command);
        if (idx >= 0) {
            cleaned = cleaned.slice(idx);
        }
        cleaned = this._normalizeCommandEcho(cleaned, command);
        return cleaned.replace(/^[\r\n]+/, '');
    }

    _findCommandEchoIndex(text, command) {
        if (!text || !command) return -1;
        const target = command.trim();
        if (!target) return -1;

        let searchIndex = 0;
        let bestIdx = -1;
        while (searchIndex <= text.length) {
            const idx = text.indexOf(target, searchIndex);
            if (idx === -1) break;

            const next = text[idx + target.length];
            const nextTwo = text.slice(idx + target.length, idx + target.length + 2);
            const followedByNewline =
                next === '\r' ||
                next === '\n' ||
                nextTwo === '\r\n';
            if (followedByNewline) {
                const prev = idx > 0 ? text[idx - 1] : null;
                const prevOk =
                    prev === null ||
                    prev === ' ' ||
                    prev === '\t' ||
                    prev === '\r' ||
                    prev === '\n' ||
                    prev === '$' ||
                    prev === '>' ||
                    prev === '❯' ||
                    prev === ':' ||
                    prev === '\x1b';
                if (prevOk) bestIdx = idx;
            }
            searchIndex = idx + 1;
        }
        if (bestIdx >= 0) return bestIdx;

        const fallbackIdx = text.lastIndexOf(target);
        if (fallbackIdx >= 0) {
            const tailLength = text.length - fallbackIdx;
            if (tailLength <= 4096) {
                return fallbackIdx;
            }
        }
        return this._findCommandIndexBySimulation(text, target);
    }

    _normalizeCommandEcho(text, command) {
        if (!text) return text;
        const newlineIdx = text.search(/[\r\n]/);
        if (newlineIdx < 0) {
            return this._trimLineToCommand(this._normalizeSingleLine(text), command);
        }
        const normalizedLine = this._trimLineToCommand(
            this._normalizeSingleLine(text.slice(0, newlineIdx)),
            command
        );
        return normalizedLine + text.slice(newlineIdx);
    }

    _normalizeSingleLine(line) {
        if (!line) return line;
        let out = '';
        for (let i = 0; i < line.length;) {
            const ch = line[i];
            if (ch === '\x08' || ch === '\b' || ch === '\x7f') {
                out = out.slice(0, -1);
                i += 1;
                continue;
            }
            if (ch === '\x1b') {
                i = this._skipAnsiSequence(line, i);
                continue;
            }
            if (ch === '\r') {
                i += 1;
                continue;
            }
            out += ch;
            i += 1;
        }
        return out;
    }

    _skipAnsiSequence(text, start) {
        if (start + 1 >= text.length) return start + 1;
        const code = text[start + 1];
        if (code === '[') {
            let idx = start + 2;
            while (idx < text.length) {
                const ch = text[idx];
                if (ch >= '@' && ch <= '~') {
                    return idx + 1;
                }
                idx += 1;
            }
            return text.length;
        }
        if (code === ']') {
            let idx = start + 2;
            while (idx < text.length) {
                const ch = text[idx];
                if (ch === '\x07') {
                    return idx + 1;
                }
                if (ch === '\x1b' && text[idx + 1] === '\\') {
                    return idx + 2;
                }
                idx += 1;
            }
            return text.length;
        }
        return start + 2;
    }

    _trimLineToCommand(line, command) {
        if (!command) return line;
        const target = command.trim();
        if (!target) return line;
        const idx = line.indexOf(target);
        if (idx >= 0) {
            return line.slice(idx);
        }
        return line;
    }

    _splitInputOutput(text) {
        if (!text) {
            return { input: '', output: '' };
        }
        const segments = [];
        const newlineRegex = /\r\n|\r|\n/g;
        let lastIndex = 0;
        let match;
        while ((match = newlineRegex.exec(text)) !== null) {
            const lineEnd = match.index;
            segments.push({
                raw: text.slice(lastIndex, newlineRegex.lastIndex),
                plain: text.slice(lastIndex, lineEnd)
            });
            lastIndex = newlineRegex.lastIndex;
        }
        if (lastIndex < text.length) {
            segments.push({
                raw: text.slice(lastIndex),
                plain: text.slice(lastIndex)
            });
        }

        if (segments.length === 0) {
            return { input: text, output: '' };
        }

        let inputLength = segments[0].raw.length;
        for (let i = 1; i < segments.length; i++) {
            const plain = this._stripAnsi(segments[i].plain);
            const trimmed = plain.trimStart();
            if (trimmed === '') {
                inputLength += segments[i].raw.length;
                break;
            }
            if (this._looksLikeContinuationLine(trimmed)) {
                inputLength += segments[i].raw.length;
                continue;
            }
            break;
        }

        return {
            input: text.slice(0, inputLength),
            output: text.slice(inputLength)
        };
    }

    _looksLikeContinuationLine(value) {
        if (!value) return false;
        const lower = value.toLowerCase();
        return (
            lower.startsWith('>') ||
            lower.startsWith('+') ||
            lower.startsWith('quote>') ||
            lower.startsWith('heredoc>') ||
            lower.startsWith('ps2>') ||
            lower.startsWith('?')
        );
    }

    _stripAnsi(value) {
        if (!value) return value;
        return value.replace(CSI_SEQUENCE_REGEX, '');
    }

    _stripTerminalSequences(value) {
        if (!value) return '';
        let result = value;
        result = result.replace(OSC_STRIP_REGEX, '');
        result = result.replace(DCS_SEQUENCE_REGEX, '');
        result = result.replace(SOS_PM_APC_SEQUENCE_REGEX, '');
        result = result.replace(CSI_SEQUENCE_REGEX, '');
        result = result.replace(TWO_CHAR_ESCAPE_REGEX, '');
        result = result.replace(CONTROL_CHAR_REGEX, '');
        return result;
    }

    _cleanCapturedText(value) {
        if (!value) return '';
        let result = this._stripTerminalSequences(value ?? '');
        result = result.replace(/\r\n/g, '\n');
        result = result.replace(/\r/g, '');
        result = result.replace(/\s+$/, '');
        return result;
    }

    _findCommandIndexBySimulation(text, target) {
        if (!target) return -1;
        let line = '';
        let indices = [];
        let i = 0;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '\x1b') {
                i = this._skipAnsiSequence(text, i);
                continue;
            }
            if (ch === '\b' || ch === '\x08' || ch === '\x7f') {
                if (line.length > 0) {
                    line = line.slice(0, -1);
                    indices.pop();
                }
                i += 1;
                continue;
            }
            if (ch === '\r' || ch === '\n') {
                const idx = this._matchTargetAtLineEnd(line, target);
                if (idx >= 0) {
                    return indices[idx];
                }
                line = '';
                indices = [];
                i += 1;
                continue;
            }
            line += ch;
            indices.push(i);
            i += 1;
        }
        const idx = this._matchTargetAtLineEnd(line, target);
        if (idx >= 0) {
            return indices[idx];
        }
        return -1;
    }

    _matchTargetAtLineEnd(line, target) {
        if (!line) return -1;
        const idx = line.lastIndexOf(target);
        if (idx >= 0) {
            const suffix = line.slice(idx + target.length).trim();
            if (suffix === '') {
                return idx;
            }
        }
        return -1;
    }

    _logCommandExecution(entry) {
        // Filter out internal shell integration commands
        if (entry.command && IGNORED_COMMANDS.some(ignored => entry.command.includes(ignored))) {
            return;
        }

        const duration =
            entry.startedAt && entry.completedAt
                ? entry.completedAt.getTime() - entry.startedAt.getTime()
                : null;

        const record = {
            command: entry.command ?? null,
            exitCode: entry.exitCode ?? null,
            input: entry.input,
            output: entry.output,
            startedAt: entry.startedAt?.toISOString() ?? null,
            completedAt: entry.completedAt?.toISOString() ?? null,
            duration: duration ?? null,
        };

        if (config.debug) {
            console.log('[Terminal Execution]', record);
        }

        this.executions.push(record);
        if (this.executions.length > 100) {
            this.executions.shift();
        }

        if (this.manager) {
            this.manager.saveSessionState(this);
        }
        this.updatedAt = new Date();
        this._emitStateChange();
    }

    _broadcast(message) {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            this._send(client, message, data);
        }
        for (const pending of this.pendingClients.values()) {
            pending.push(data);
        }
    }

    _send(ws, message, preEncoded) {
        if (!ws || ws.readyState !== WS_STATE_OPEN) return;
        ws.send(preEncoded ?? JSON.stringify(message));
    }

    _writeToLogAndBroadcast(text) {
        if (!text) return;
        this._appendSnapshotData(text);
        this._appendHistory(text);
        this.updatedAt = new Date();
        if (this.manager?.scheduleSnapshotPersist) {
            this.manager.scheduleSnapshotPersist(this.id);
        }
        this._broadcast({ type: 'output', data: text });
        this._emitStateChange();
    }

    _queueSnapshotMutation(mutate) {
        const next = this.snapshotWritePromise.then(() => mutate());
        this.snapshotWritePromise = next.catch(() => {});
        return next;
    }

    _appendSnapshotData(text) {
        if (!text) return;
        this._trackExtraPrivateModes(text);
        this._queueSnapshotMutation(() => new Promise((resolve) => {
            this.snapshotTerminal.write(text, resolve);
        }));
    }

    _trackExtraPrivateModes(text) {
        EXTRA_PRIVATE_MODE_REGEX.lastIndex = 0;
        let match;
        while ((match = EXTRA_PRIVATE_MODE_REGEX.exec(text)) !== null) {
            this.extraPrivateModes[match[1]] = match[2] === 'h';
        }
    }

    _serializeExtraPrivateModes() {
        let output = '';
        for (const mode of ['1005', '1006', '1015']) {
            if (this.extraPrivateModes[mode]) {
                output += `\u001b[?${mode}h`;
            }
        }
        return output;
    }

    async _sendInitialState(ws) {
        const pending = this.pendingClients.get(ws);
        if (!pending) return;

        await this._queueSnapshotMutation(() => undefined);
        if (ws.readyState !== WS_STATE_OPEN) {
            this.pendingClients.delete(ws);
            return;
        }

        const snapshot = await this.serializeSnapshot();
        this._send(ws, { type: 'snapshot', data: snapshot });
        this._send(ws, {
            type: 'meta',
            title: this.title,
            cwd: this.cwd,
            env: this.env,
            cols: this.pty.cols,
            rows: this.pty.rows
        });
        if (this.closed) {
            this._send(ws, { type: 'status', status: 'terminated' });
        } else {
            this._send(ws, { type: 'status', status: 'ready' });
        }

        for (const payload of pending) {
            if (ws.readyState !== WS_STATE_OPEN) break;
            ws.send(payload);
        }

        this.pendingClients.delete(ws);
        if (ws.readyState === WS_STATE_OPEN) {
            this.clients.add(ws);
        }
    }
}

function clampDimension(value) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num <= 0) return null;
    return Math.min(500, num);
}
