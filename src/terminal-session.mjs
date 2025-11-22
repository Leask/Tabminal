import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import AnsiParser from 'node-ansiparser';
import { alan } from 'utilitas';

const execAsync = promisify(exec);
const WS_STATE_OPEN = 1;
const DEFAULT_HISTORY_LIMIT = 512 * 1024; // chars
const PROMPT_MARKER = '\u001b]1337;TabminalPrompt\u0007';
const OSC_SEQUENCE_REGEX =
    /\u001b\]1337;(ExitCode=(\d+);CommandB64=([a-zA-Z0-9+/=]+)|TabminalPrompt)\u0007/g;
const CSI_SEQUENCE_REGEX = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC_STRIP_REGEX = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const DCS_SEQUENCE_REGEX = /\u001bP[\s\S]*?(?:\u0007|\u001b\\)/g;
const SOS_PM_APC_SEQUENCE_REGEX = /\u001b[\^_][\s\S]*?\u001b\\/g;
const TWO_CHAR_ESCAPE_REGEX = /\u001b[@-Z\\-_]/g;
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const IGNORED_COMMANDS = [
    'export PROMPT_COMMAND',
    '__bash_prompt'
];

export class TerminalSession {
    constructor(pty, options = {}) {
        this.pty = pty;
        this.id = options.id;
        this.manager = options.manager;
        this.createdAt = options.createdAt ?? new Date();
        this.shell = options.shell;
        this.initialCwd = options.initialCwd;
        
        this.title = this.shell ? this.shell.split('/').pop() : 'Terminal';
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
        this.closed = false;
        this.pollingInterval = null;
        this.captureBuffer = '';
        this.captureStartedAt = null;
        this.lastExecution = null;
        this.skipNextShellLog = false;

        this.ansiParser = new AnsiParser({
            inst_o: (s) => {
                if (s.startsWith('0;') || s.startsWith('2;')) {
                    const newTitle = s.substring(2);
                    if (newTitle && newTitle !== this.title) {
                        this.title = newTitle;
                        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                    }
                } else if (s.startsWith('7;')) {
                    try {
                        const url = new URL(s.substring(2));
                        if (url.pathname) {
                            const newCwd = decodeURIComponent(url.pathname);
                            if (newCwd !== this.cwd) {
                                this.cwd = newCwd;
                                this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                            }
                        }
                    } catch (_e) { /* ignore */ }
                }
            },
        });

        this._handleData = (chunk) => {
            if (this.suppressPtyOutput) return;

            if (typeof chunk !== 'string') chunk = chunk.toString('utf8');

            if (this.manager) {
                this.manager.appendLog(this.id, chunk);
            }

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

            this._appendHistory(cleaned);
            this.ansiParser.parse(cleaned);
            this._broadcast({ type: 'output', data: cleaned });
        };

        this._handleExit = (details) => {
            this.closed = true;
            this.stopTitlePolling();
            this._broadcast({
                type: 'status',
                status: 'terminated',
                code: details?.exitCode ?? 0,
                signal: details?.signal ?? null
            });
        };

        this.dataSubscription = this.pty.onData(this._handleData);
        this.exitSubscription = this.pty.onExit(this._handleExit);
        
        this.startTitlePolling();
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
                    } catch (e) { break; }
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
                        
                        const regex = /([A-Z_][A-Z0-9_]*=)/g;
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
                } catch (e) { /* ignore */ }

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
                } catch (e) { /* ignore */ }

                const titleChanged = newTitle && newTitle !== this.title;
                const envChanged = newEnv !== null && newEnv !== this.env;
                const cwdChanged = newCwd && newCwd !== this.cwd;

                if (titleChanged || envChanged || cwdChanged) {
                    if (titleChanged) this.title = newTitle;
                    if (envChanged) this.env = newEnv;
                    if (cwdChanged) this.cwd = newCwd;
                    this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                }
            } catch (_err) { /* ignore */ }
        };

        poll(); // Run immediately
        this.pollingInterval = setInterval(poll, 2000);
    }

    stopTitlePolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    attach(ws) {
        if (!ws) throw new Error('WebSocket instance required');
        this.clients.add(ws);
        ws.once('close', () => this.clients.delete(ws));
        ws.on('message', (raw) => this._routeIncoming(raw, ws));
        ws.on('error', () => ws.close());

        this._send(ws, { type: 'snapshot', data: this.history });
        this._send(ws, { type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
        if (this.closed) {
            this._send(ws, { type: 'status', status: 'terminated' });
        } else {
            this._send(ws, { type: 'status', status: 'ready' });
        }
    }

    dispose() {
        this.stopTitlePolling();
        this.clients.clear();
        this.dataSubscription?.dispose?.();
        this.exitSubscription?.dispose?.();
    }

    resize(cols, rows) {
        if (this.closed) return;
        this.pty.resize(cols, rows);
        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols, rows });
        if (this.manager && this.manager.saveSessionState) {
            this.manager.saveSessionState(this);
        }
    }

    _routeIncoming(raw, ws) {
        let payload;
        try {
            payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        } catch (_err) { return; }

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

    write(data) {
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
        for (let i = 0; i < data.length; i++) {
            const char = data[i];

            // Handle Enter (\r)
            if (char === '\r') {
                // Smart detection for AI command (#)
                // Ignore prefix if it only contains whitespace or terminal control artifacts (CPR)
                const idx = this.inputBuffer.indexOf('#');
                let line = null;
                
                if (idx !== -1) {
                    const prefix = this.inputBuffer.substring(0, idx);
                    // Allow whitespace, ESC, [, digits, ;, R (typical CPR response)
                    if (/^[\s\x1b\[\d;R]*$/.test(prefix)) {
                        line = this.inputBuffer.substring(idx);
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
                    this._handleAiCommand(prompt);

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

        async _handleAiCommand(prompt, options = {}) {

            // Prevent duplicate logging from shell integration

            this.skipNextShellLog = true;

    

            // Ensure clean line start and set Cyan color (No prefix yet)

            this._writeToLogAndBroadcast('\r\x1b[K\x1b[36m');

            

            // Gather Context (Current Session Only)

            const cleanHistory = (this.executions && this.executions.length > 0) ? this.executions : [];

            

            // Build Context

            const { conversationHistory, pendingShellHistory } = this._buildAiContext(cleanHistory);

            

            // Construct Current Prompt

            const currentContext = `Recent Shell History:\n${pendingShellHistory}\nEnvironment:\n${this.env}\nCurrent Path: ${this.cwd}`;

            const finalPrompt = `${currentContext}\n\nQuestion: ${prompt}`;

            

            const startTime = new Date();

            let fullResponse = '';

            let isFirstChunk = true;

            

            try {

                const streamCallback = (chunk) => {

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

            const result = await alan.prompt(finalPrompt, { 
                stream: streamCallback,
                delta: true,
                messages: conversationHistory,
                trimBeginning: true
            });
            
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
            this._writeToLogAndBroadcast(`\x1b[31mAI Error: ${e.message}\x1b[0m\r\n`);
            
            this._logCommandExecution({
                command: 'ai',
                exitCode: 1,
                input: prompt,
                output: `AI Error: ${e.message}`,
                startedAt: startTime,
                completedAt: new Date()
            });
        }
        
        // Resume PTY output
        this.suppressPtyOutput = false;
        
        // Restore prompt by sending \r to pty (empty command)
        this.pty.write('\r');
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
        this.captureBuffer = '';
        this.captureStartedAt = null;
    }

    _handleExitCodeSequence(exitCodeStr, cmdB64) {
        if (this.skipNextShellLog) {
            this.skipNextShellLog = false;
            this.captureBuffer = '';
            this.captureStartedAt = null;
            return;
        }

        const exitCode = Number.parseInt(exitCodeStr, 10);
        const command = this._decodeCommandSafe(cmdB64);

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
        this._logCommandExecution(entry);
        this.captureBuffer = '';
        this.captureStartedAt = null;

        // Auto-Fix: If command failed, ask AI for help
        if (exitCode !== 0 && entry.command) {
            // Don't trigger on simple interruptions (SIGINT=130) or common non-errors?
            // 130 = Ctrl+C. Usually user intention.
            if (exitCode !== 130) {
                this._handleAiCommand('The previous command failed. Please analyze the error in the history and provide a fix.', { isAutoFix: true });
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
            const newlineSeq = match[0];
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

        console.log('[Terminal Execution]', record);

        this.executions.push(record);
        if (this.executions.length > 100) {
            this.executions.shift();
        }

        if (this.manager) {
            this.manager.saveSessionState(this);
        }
    }

    _broadcast(message) {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            this._send(client, message, data);
        }
    }

    _send(ws, message, preEncoded) {
        if (!ws || ws.readyState !== WS_STATE_OPEN) return;
        ws.send(preEncoded ?? JSON.stringify(message));
    }

    _writeToLogAndBroadcast(text) {
        if (!text) return;
        if (this.manager) {
            this.manager.appendLog(this.id, text);
        }
        this._appendHistory(text);
        this._broadcast({ type: 'output', data: text });
    }
}

function clampDimension(value) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num <= 0) return null;
    return Math.min(500, num);
}
