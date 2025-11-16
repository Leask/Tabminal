import process from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { TerminalSession } from './terminal-session.mjs';

function resolveShell() {
    if (process.platform === 'win32') {
        return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
}

const historyLimit = Number.parseInt(
    process.env.TABMINAL_HISTORY ?? '',
    10
) || 1024 * 1024;
const initialCols = Number.parseInt(
    process.env.TABMINAL_COLS ?? '',
    10
) || 120;
const initialRows = Number.parseInt(
    process.env.TABMINAL_ROWS ?? '',
    10
) || 30;

export class TerminalManager {
    constructor() {
        this.sessions = new Map();
        this.lastCols = initialCols;
        this.lastRows = initialRows;
    }

    createSession() {
        const id = crypto.randomUUID();
        const shell = resolveShell();
        const initialCwd = process.env.TABMINAL_CWD || process.cwd();
        const env = { ...process.env }; // Clone env to modify it safely

        let args = [];
        let initFilePath = null;
        let initDirPath = null;

        try {
            const shellName = path.basename(shell);
            if (shellName === 'bash') {
                initFilePath = path.join(os.tmpdir(), `tabminal-init-${id}.bashrc`);
                const bashScript = `
[ -f ~/.bashrc ] && source ~/.bashrc

_tabminal_bash_preexec() {
  # Prevent capturing any of our own internal or setup commands.
  if [[ "$BASH_COMMAND" == *"_tabminal_"* || "$BASH_COMMAND" == "$PROMPT_COMMAND" ]]; then
    return
  fi
  _tabminal_last_command="$BASH_COMMAND"
}
trap '_tabminal_bash_preexec' DEBUG

_tabminal_bash_postexec() {
  local EC="$?"
  if [[ -n "$_tabminal_last_command" ]]; then
    local CMD=$(echo -n "$_tabminal_last_command" | base64 | tr -d '\\n')
    printf "\\033]1337;ExitCode=%s;CommandB64=%s\\007" "$EC" "$CMD"
    _tabminal_last_command="" # Reset after use
  fi
}
export PROMPT_COMMAND="_tabminal_bash_postexec; $PROMPT_COMMAND"
`;
                fs.writeFileSync(initFilePath, bashScript);
                args = ['--rcfile', initFilePath];
            } else if (shellName === 'zsh') {
                initDirPath = path.join(os.tmpdir(), `tabminal-zsh-${id}`);
                fs.mkdirSync(initDirPath, { recursive: true });
                initFilePath = path.join(initDirPath, '.zshrc');
                
                const zshScript = `
unset ZDOTDIR
[ -f ~/.zshrc ] && source ~/.zshrc

_tabminal_zsh_preexec() {
  _tabminal_last_command="$1"
}
_tabminal_zsh_postexec() {
  local EC="$?"
  if [[ -n "$_tabminal_last_command" ]]; then
    local CMD=$(echo -n "$_tabminal_last_command" | base64 | tr -d '\\n')
    printf "\\03d]1337;ExitCode=%s;CommandB64=%s\\007" "$EC" "$CMD"
  fi
  _tabminal_last_command="" # Reset after use
}
preexec_functions+=(_tabminal_zsh_preexec)
precmd_functions+=(_tabminal_zsh_postexec)
`;
                fs.writeFileSync(initFilePath, zshScript);
                env.ZDOTDIR = initDirPath;
            }
        } catch (err) {
            console.error('[Manager] Failed to create init script:', err);
        }

        const ptyProcess = pty.spawn(shell, args, {
            name: 'xterm-256color',
            cols: this.lastCols,
            rows: this.lastRows,
            cwd: initialCwd,
            env: env,
            encoding: 'utf8'
        });

        const session = new TerminalSession(ptyProcess, {
            id,
            historyLimit,
            createdAt: new Date(),
            manager: this,
            shell,
            initialCwd,
            env: env
        });

        ptyProcess.onExit(() => {
            this.removeSession(id);
            // Cleanup temp files
            try {
                if (initFilePath && fs.existsSync(initFilePath)) fs.unlinkSync(initFilePath);
                if (initDirPath && fs.existsSync(initDirPath)) fs.rmSync(initDirPath, { recursive: true, force: true });
            } catch (e) { /* ignore cleanup errors */ }
        });

        this.sessions.set(id, session);
        console.log(`[Manager] Created session ${id}`);
        return session;
    }

    getSession(id) {
        return this.sessions.get(id);
    }

    resizeAll(cols, rows) {
        console.log(`[Manager] Resizing all sessions to ${cols}x${rows}`);
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

    removeSession(id) {
        const session = this.sessions.get(id);
        if (session) {
            session.dispose();
            this.sessions.delete(id);
            console.log(`[Manager] Removed session ${id}`);
            // If the last session is closed, create a new one automatically
            if (this.sessions.size === 0) {
                console.log('[Manager] No sessions left, creating a new one.');
                this.createSession();
            }
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
            rows: s.pty.rows
        }));
    }

    // Ensure at least one session exists at startup
    ensureOneSession() {
        if (this.sessions.size === 0) {
            console.log('[Manager] No initial sessions, creating one.');
            this.createSession();
        }
    }

    dispose() {
        console.log('[Manager] Disposing all sessions.');
        for (const session of this.sessions.values()) {
            try {
                session.pty.kill('SIGTERM');
            } catch (_err) {
                // ignore
            }
        }
        this.sessions.clear();
    }
}
