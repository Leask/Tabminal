import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import express from 'express';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

import { TerminalSession } from './terminal-session.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.static(publicDir));
app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws'
});

const shell = resolveShell();
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

const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: initialCols,
    rows: initialRows,
    cwd: process.env.TABMINAL_CWD || process.cwd(),
    env: process.env,
    encoding: 'utf8'
});
const session = new TerminalSession(ptyProcess, { historyLimit });

wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
        socket.isAlive = true;
    });
    session.attach(socket);
});

const heartbeatIntervalMs = Number.parseInt(
    process.env.TABMINAL_HEARTBEAT ?? '',
    10
) || 30000;

const heartbeatInterval = setInterval(() => {
    for (const socket of wss.clients) {
        if (socket.isAlive === false) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        socket.ping();
    }
}, heartbeatIntervalMs).unref();

const port = Number.parseInt(process.env.PORT ?? '', 10) || 9846;
const host = process.env.HOST || '0.0.0.0';
httpServer.listen(port, host, () => {
    const urlHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`Tabminal listening on http://${urlHost}:${port}`);
});

let isShuttingDown = false;
function shutdown(signal) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    console.log(`Shutting down (${signal})...`);
    clearInterval(heartbeatInterval);
    wss.close();
    session.dispose();
    try {
        ptyProcess.kill();
    } catch (_err) {
        // ignore
    }
    httpServer.close(() => {
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function resolveShell() {
    if (process.platform === 'win32') {
        return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
}
