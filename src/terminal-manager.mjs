import process from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { TerminalSession } from './terminal-session.mjs';
import * as persistence from './persistence.mjs';
import { config } from './config.mjs';

function resolveShell() {
    if (config.shell) {
        return config.shell;
    }
    if (process.platform === 'win32') {
        return process.env.COMSPEC || 'cmd.exe';
    }
    // Try to use Homebrew installed bash if available (newer version)
    if (fs.existsSync('/opt/homebrew/bin/bash')) {
        return '/opt/homebrew/bin/bash';
    }
    return '/bin/bash';
}

const historyLimit = config.historyLimit;
function debugLog(...args) {
    if (config.debug) {
        console.log(...args);
    }
}
const initialCols = Number.parseInt(
    process.env.TABMINAL_COLS ?? '',
    10
) || 120;
const initialRows = Number.parseInt(
    process.env.TABMINAL_ROWS ?? '',
    10
) || 30;

function buildBashBootstrap({
    env,
    shell,
    shellToolsPath,
    sessionId
}) {
    const hookPath = path.join(shellToolsPath, 'tabminal-hooks.bash');
    const rcfilePath = path.join(shellToolsPath, 'tabminal-bashrc');

    env.TABMINAL_SESSION_ID = sessionId;
    env.TABMINAL_SHELL_TOOLS_PATH = shellToolsPath;
    env.TABMINAL_HOOKS_PATH = hookPath;

    return {
        shell,
        args: ['--rcfile', rcfilePath, '-i']
    };
}

function clearBashPromptEnv(env) {
    for (const key of [
        'PROMPT_COMMAND',
        'PS0',
        'PS1',
        'PS2',
        'PS4'
    ]) {
        delete env[key];
    }
}

export class TerminalManager {
    constructor() {
        this.sessions = new Map();
        this.snapshotPersistTimers = new Map();
        this.sessionPersistenceChains = new Map();
        this.lastCols = initialCols;
        this.lastRows = initialRows;
        this.disposing = false;
    }

    queueSessionPersistence(id, operation) {
        const previous = this.sessionPersistenceChains.get(id)
            || Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(operation);

        this.sessionPersistenceChains.set(id, next);
        next.finally(() => {
            if (this.sessionPersistenceChains.get(id) === next) {
                this.sessionPersistenceChains.delete(id);
            }
        }).catch(() => {});

        return next;
    }

    _createPtySession(options = {}) {
        const id = options.id || crypto.randomUUID();
        const shell = options.shell || resolveShell();
        const initialCwd = options.cwd
            || process.env.TABMINAL_CWD
            || os.homedir();
        const env = {
            ...process.env,
            ...(options.env || {})
        };
        let spawnShell = options.spawnCommand || shell;
        let args = Array.isArray(options.spawnArgs) ? options.spawnArgs : [];
        let initDirPath = null;

        if (!options.directSpawn) {
            const shellToolsPath = path.join(process.cwd(), 'shell');
            const pathDelimiter = path.delimiter;
            const pathKey = Object.keys(env).find(
                (key) => key.toLowerCase() === 'path'
            ) || 'PATH';
            const existingPath = env[pathKey];
            env[pathKey] = existingPath
                ? `${shellToolsPath}${pathDelimiter}${existingPath}`
                : shellToolsPath;

            try {
                const shellName = path.basename(shell);
                if (shellName === 'bash') {
                    clearBashPromptEnv(env);
                    const bootstrap = buildBashBootstrap({
                        env,
                        shell,
                        shellToolsPath,
                        sessionId: id
                    });
                    spawnShell = bootstrap.shell;
                    args = bootstrap.args;
                } else if (shellName === 'zsh') {
                    initDirPath = path.join(os.tmpdir(), `tabminal-zsh-${id}`);
                    fs.mkdirSync(initDirPath, { recursive: true });
                    const initFilePath = path.join(initDirPath, '.zshrc');

                    const zshScript = `
unset ZDOTDIR
[ -f ~/.zshrc ] && source ~/.zshrc
export PATH="${shellToolsPath}:$PATH"

_tabminal_zsh_preexec() {
  _tabminal_last_command="$1"
}
_tabminal_zsh_postexec() {
  local EC="$?"
  if [[ -n "$_tabminal_last_command" ]]; then
    local CMD=$(echo -n "$_tabminal_last_command" | base64 | tr -d '\\n')
    printf "\\x1b]1337;ExitCode=%s;CommandB64=%s\\x07" "$EC" "$CMD"
  fi
  _tabminal_last_command="" # Reset after use
}
_tabminal_zsh_apply_prompt_marker() {
  local marker=$'%{\\033]1337;TabminalPrompt\\a%}'
  if [[ "$PROMPT" != *"TabminalPrompt"* ]]; then
    PROMPT="$PROMPT$marker"
  fi
}
preexec_functions+=(_tabminal_zsh_preexec)
precmd_functions+=(_tabminal_zsh_postexec)
precmd_functions+=(_tabminal_zsh_apply_prompt_marker)
`;
                    fs.writeFileSync(initFilePath, zshScript);
                    env.ZDOTDIR = initDirPath;
                    args = ['-i'];
                }
            } catch (err) {
                console.error('[Manager] Failed to create init script:', err);
            }
        }

        const cols = Number.isFinite(options.cols) ? options.cols : this.lastCols;
        const rows = Number.isFinite(options.rows) ? options.rows : this.lastRows;

        let ptyProcess;
        try {
            const ptyOptions = {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: initialCwd,
                env
            };
            if (process.platform !== 'win32') {
                ptyOptions.encoding = 'utf8';
            }
            ptyProcess = pty.spawn(spawnShell, args, ptyOptions);
        } catch (err) {
            const spawnInfo = {
                shell: spawnShell,
                requestedShell: shell,
                args,
                cwd: initialCwd,
                cols,
                rows,
                env: {
                    SHELL: env.SHELL,
                    TERM: env.TERM,
                    PATH: env.PATH,
                    HOME: env.HOME
                },
                error: {
                    message: err?.message,
                    code: err?.code,
                    errno: err?.errno
                }
            };
            console.error('[Manager] Failed to spawn PTY', spawnInfo);
            throw err;
        }

        const session = new TerminalSession(ptyProcess, {
            id,
            historyLimit: options.historyLimit ?? historyLimit,
            createdAt: options.createdAt
                ? new Date(options.createdAt)
                : new Date(),
            manager: this,
            shell,
            initialCwd,
            env,
            title: options.title || '',
            managed: options.managed || null,
            persistent: options.persistent !== false,
            removeOnExit: options.removeOnExit !== false,
            enableAiHijack: options.enableAiHijack !== false,
            enableTitlePolling: options.enableTitlePolling !== false,
            editorState: options.editorState,
            executions: options.executions
        });

        if (options.restoreSnapshot) {
            persistence.loadSessionSnapshot(id).then(async (snapshot) => {
                if (!snapshot) return;
                await session.restoreSnapshot(snapshot);
                this.scheduleSnapshotPersist(id);
            });
        }

        this.sessions.set(id, session);

        if (session.persistent) {
            void this.saveSessionState(session);
        }

        ptyProcess.onExit(() => {
            if (session.removeOnExit) {
                void this.removeSession(id);
            }
            try {
                if (initDirPath && fs.existsSync(initDirPath)) {
                    fs.rmSync(initDirPath, { recursive: true, force: true });
                }
            } catch {
                // ignore cleanup errors
            }
        });
        debugLog(`[Manager] Created session ${id}`);
        return session;
    }

    createSession(restoredData = null) {
        return this._createPtySession({
            id: restoredData?.id,
            shell: resolveShell(),
            cwd: restoredData?.cwd,
            cols: restoredData?.cols,
            rows: restoredData?.rows,
            createdAt: restoredData?.createdAt,
            title: restoredData?.title,
            editorState: restoredData?.editorState,
            executions: restoredData?.executions,
            restoreSnapshot: Boolean(restoredData),
            persistent: true,
            removeOnExit: true,
            enableAiHijack: true,
            enableTitlePolling: true
        });
    }

    createManagedSession(options = {}) {
        const spawnRequest = options.spawnRequest || {};
        const shell = spawnRequest.command || resolveShell();
        return this._createPtySession({
            shell,
            cwd: options.cwd,
            env: options.env,
            cols: options.cols,
            rows: options.rows,
            title: options.title || path.basename(shell) || 'Terminal',
            directSpawn: true,
            spawnCommand: spawnRequest.command,
            spawnArgs: spawnRequest.args,
            persistent: false,
            removeOnExit: false,
            enableAiHijack: false,
            enableTitlePolling: false,
            managed: options.managed || null
        });
    }

    saveSessionState(session) {
        if (!session?.persistent) {
            return Promise.resolve();
        }
        if (this.sessions.get(session.id) !== session) {
            return Promise.resolve();
        }

        return this.queueSessionPersistence(session.id, () => persistence.saveSession(session.id, {
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            env: session.env,
            cols: session.pty.cols,
            rows: session.pty.rows,
            createdAt: session.createdAt,
            editorState: session.editorState,
            executions: session.executions
        }));
    }

    updateSessionState(id, data) {
        const session = this.sessions.get(id);
        if (session) {
            // console.log(`[Manager] Updating session ${id} state:`, JSON.stringify(data));
            if (data.editorState) {
                session.editorState = { ...session.editorState, ...data.editorState };
            }
            if (session.persistent) {
                this.saveSessionState(session);
            }
        }
    }

    scheduleSnapshotPersist(id) {
        const session = this.sessions.get(id);
        if (!session || !session.persistent) return;

        const existing = this.snapshotPersistTimers.get(id);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.snapshotPersistTimers.delete(id);
            const currentSession = this.sessions.get(id);
            if (!currentSession) return;

            void this.queueSessionPersistence(id, async () => {
                if (this.sessions.get(id) !== currentSession) return;
                const snapshot = await currentSession.serializeSnapshot();
                if (this.sessions.get(id) !== currentSession) return;
                await persistence.saveSessionSnapshot(id, snapshot);
            });
        }, 250);

        this.snapshotPersistTimers.set(id, timer);
    }

    getSession(id) {
        return this.sessions.get(id);
    }

    resizeAll(cols, rows) {
        debugLog(`[Manager] Resizing all sessions to ${cols}x${rows}`);
        this.lastCols = cols;
        this.lastRows = rows;
        for (const session of this.sessions.values()) {
            session.resize(cols, rows);
        }
    }

    updateDefaultSize(cols, rows) {
        this.lastCols = cols;
        this.lastRows = rows;
    }

    async removeSession(id) {
        const session = this.sessions.get(id);
        if (session) {
            const timer = this.snapshotPersistTimers.get(id);
            if (timer) {
                clearTimeout(timer);
                this.snapshotPersistTimers.delete(id);
            }
            try {
                if (process.platform === 'win32') {
                    session.pty.kill();
                } else {
                    session.pty.kill('SIGHUP');
                }
            } catch {
                // ignore
            }
            session.dispose();
            this.sessions.delete(id);
            await this.queueSessionPersistence(id, () => persistence.deleteSession(id));
            debugLog(`[Manager] Removed session ${id}`);
        }
    }

    listSessions() {
        return Array.from(this.sessions.values()).map(s => ({
            id: s.id,
            createdAt: s.createdAt,
            shell: s.shell,
            initialCwd: s.initialCwd,
            title: s.title,
            cwd: s.cwd,
            env: s.env,
            cols: s.pty.cols,
            rows: s.pty.rows,
            closed: !!s.closed,
            exitStatus: s.exitStatus || null,
            managed: s.managed || null,
            editorState: s.editorState,
            executions: s.executions
        }));
    }

    dispose() {
        debugLog('[Manager] Disposing all sessions.');
        this.disposing = true;
        for (const timer of this.snapshotPersistTimers.values()) {
            clearTimeout(timer);
        }
        this.snapshotPersistTimers.clear();
        for (const session of this.sessions.values()) {
            try {
                if (process.platform === 'win32') {
                    session.pty.kill();
                } else {
                    session.pty.kill('SIGHUP');
                }
            } catch {
                // ignore
            }
        }
        this.sessions.clear();
    }
}
