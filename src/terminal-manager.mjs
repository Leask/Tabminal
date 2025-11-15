import process from 'node:process';
import crypto from 'node:crypto';
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
    }

    createSession() {
        const id = crypto.randomUUID();
        const ptyProcess = pty.spawn(resolveShell(), [], {
            name: 'xterm-256color',
            cols: initialCols,
            rows: initialRows,
            cwd: process.env.TABMINAL_CWD || process.cwd(),
            env: process.env,
            encoding: 'utf8'
        });

        const session = new TerminalSession(ptyProcess, {
            id,
            historyLimit,
            createdAt: new Date(),
            manager: this // Pass manager reference to session
        });

        // When a pty process exits, automatically remove it from the manager
        ptyProcess.onExit(() => {
            this.removeSession(id);
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
        for (const session of this.sessions.values()) {
            session.resize(cols, rows);
        }
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
            // In the future, we can add more metadata here, like CWD or process name
        }));
    }

    getAllSnapshots() {
        return Array.from(this.sessions.values()).map(s => s.getSnapshot());
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
