import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import AnsiParser from 'node-ansiparser';

const execAsync = promisify(exec);
const WS_STATE_OPEN = 1;
const DEFAULT_HISTORY_LIMIT = 512 * 1024; // chars
const PROMPT_MARKER = '\u001b]1337;TabminalPrompt\u0007';
const OSC_SEQUENCE_REGEX =
    /\u001b\]1337;(ExitCode=(\d+);CommandB64=([a-zA-Z0-9+/=]+)|TabminalPrompt)\u0007/g;

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
        
        // Format the initial environment object into a static string
        this.env = Object.entries(options.env || {})
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        
        this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
        this.history = '';
        this.clients = new Set();
        this.closed = false;
        this.pollingInterval = null;
        this.captureBuffer = '';
        this.captureStartedAt = null;
        this.lastExecution = null;

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
            if (typeof chunk !== 'string') chunk = chunk.toString('utf8');

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

                const titleChanged = newTitle && newTitle !== this.title;
                const envChanged = newEnv !== null && newEnv !== this.env;

                if (titleChanged || envChanged) {
                    if (titleChanged) this.title = newTitle;
                    if (envChanged) this.env = newEnv;
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
        this.pty.write(data);
    }

    _handleResize(cols, rows) {
        if (this.closed) return;
        const safeCols = clampDimension(cols);
        const safeRows = clampDimension(rows);
        if (safeCols && safeRows) {
            if (this.manager) {
                this.manager.resizeAll(safeCols, safeRows);
            } else {
                this.resize(safeCols, safeRows);
            }
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
        const exitCode = Number.parseInt(exitCodeStr, 10);
        const command = this._decodeCommandSafe(cmdB64);

        if (!Number.isNaN(exitCode) && exitCode !== 0) {
            const printable = command ?? '<unknown>';
            console.log(
                `[Terminal Error] Exit Code: ${exitCode} | Command: "${printable}"`
            );
        }

        const completedAt = new Date();
        const entry = {
            command,
            exitCode: Number.isNaN(exitCode) ? null : exitCode,
            output: this._sanitizeCapturedOutput(this.captureBuffer, command),
            startedAt: this.captureStartedAt ?? completedAt,
            completedAt,
        };

        this.lastExecution = entry;
        this._logCommandExecution(entry);
        this.captureBuffer = '';
        this.captureStartedAt = null;
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
        const durationMs =
            entry.startedAt && entry.completedAt
                ? entry.completedAt.getTime() - entry.startedAt.getTime()
                : null;
        const hadError = entry.exitCode !== null && entry.exitCode !== 0;
        console.log('[Terminal Execution]', {
            command: entry.command ?? null,
            exitCode: entry.exitCode ?? null,
            output: entry.output,
            error: [hadError, hadError ? `exit code ${entry.exitCode}` : null],
            startedAt: entry.startedAt?.toISOString() ?? null,
            completedAt: entry.completedAt?.toISOString() ?? null,
            durationMs,
        });
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
}

function clampDimension(value) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num <= 0) return null;
    return Math.min(500, num);
}
