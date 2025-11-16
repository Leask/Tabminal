import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import express from 'express';
import { WebSocketServer } from 'ws';

import { TerminalManager } from './terminal-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.static(publicDir));
app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
});

// API routes for session management
app.get('/api/sessions', (_req, res) => {
    res.json(terminalManager.listSessions());
});

app.post('/api/sessions', (_req, res) => {
    const session = terminalManager.createSession();
    res.status(201).json({
        id: session.id,
        createdAt: session.createdAt,
        shell: session.shell,
        initialCwd: session.initialCwd,
        title: session.title,
        cwd: session.cwd,
        cols: session.pty.cols,
        rows: session.pty.rows
    });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const terminalManager = new TerminalManager();
terminalManager.ensureOneSession();

httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url;

    if (pathname.startsWith('/ws/')) {
        // Use regex to extract session ID from URL, e.g., /ws/ca76660e-f5f3-4813-a340-3f334378d16f
        const match = pathname.match(/^\/ws\/([a-zA-Z0-9-]+)$/);
        if (!match) {
            socket.destroy();
            return;
        }

        const sessionId = match[1];
        const session = terminalManager.getSession(sessionId);
        if (!session) {
            console.warn(`[Server] Session not found for ID: ${sessionId}`);
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, session);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (socket, session) => {
    socket.isAlive = true;
    socket.on('pong', () => {
        socket.isAlive = true;
    });
    console.log(`[Server] WebSocket connected to session ${session.id}`);
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
    terminalManager.dispose();

    const forceExitTimer = setTimeout(() => {
        console.warn('Forced shutdown after timeout.');
        process.exit(1);
    }, 5000).unref();

    httpServer.close(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));