import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import net from 'node:net';

import Koa from 'koa';
import serve from 'koa-static';
import Router from '@koa/router';
import { WebSocketServer } from 'ws';

import { TerminalManager } from './terminal-manager.mjs';
import { SystemMonitor } from './system-monitor.mjs';
import { config } from './config.mjs';
import { authMiddleware, verifyClient } from './auth.mjs';
import { setupFsRoutes } from './fs-routes.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = new Koa();
const router = new Router();

if (!config.acceptTerms) {
    console.error(`
[SECURITY WARNING]
Please confirm you are running this service in a trusted environment.
You should use a secure tunnel like Cloudflare Zero Trust or Tailscale for remote access.
Do NOT expose this service's port directly to the public internet.

You acknowledge and understand these risks.
To start the service, use the '-y' flag or set 'acceptTerms: true' in your config.
    `);
    process.exit(1);
}

// Health check
router.get('/healthz', (ctx) => {
    ctx.body = { status: 'ok' };
});

// Serve static files (public) BEFORE auth middleware
app.use(serve(publicDir));

// Auth Middleware for API routes
app.use(authMiddleware);

const systemMonitor = new SystemMonitor();
const terminalManager = new TerminalManager();
terminalManager.ensureOneSession();

// Setup FS Routes
setupFsRoutes(router);

// API routes for session management
router.get('/api/heartbeat', (ctx) => {
    ctx.body = {
        sessions: terminalManager.listSessions(),
        system: systemMonitor.getStats()
    };
});

router.post('/api/sessions', (ctx) => {
    const session = terminalManager.createSession();
    ctx.status = 201;
    ctx.body = {
        id: session.id,
        createdAt: session.createdAt,
        shell: session.shell,
        initialCwd: session.initialCwd,
        title: session.title,
        cwd: session.cwd,
        cols: session.pty.cols,
        rows: session.pty.rows
    };
});

router.delete('/api/sessions/:id', (ctx) => {
    const { id } = ctx.params;
    terminalManager.removeSession(id);
    ctx.status = 204;
});

// Middleware
app.use(router.routes());
app.use(router.allowedMethods());

const httpServer = createServer(app.callback());
const wss = new WebSocketServer({ noServer: true, verifyClient });

httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/ws/')) {
        const match = pathname.match(/^\/ws\/([a-zA-Z0-9-]+)$/);
        if (!match) {
            socket.destroy();
            return;
        }

        const sessionId = match[1];

        wss.handleUpgrade(request, socket, head, (ws) => {
            const session = terminalManager.getSession(sessionId);
            if (!session) {
                console.warn(`[Server] Session not found for ID: ${sessionId}`);
                ws.close(); // Close the WebSocket connection
                return;
            }
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

const heartbeatInterval = setInterval(() => {
    for (const socket of wss.clients) {
        if (socket.isAlive === false) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        socket.ping();
    }
}, config.heartbeatInterval).unref();

// Port hunting logic
function findAvailablePort(startPort, host) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(findAvailablePort(startPort + 1, host));
            } else {
                reject(err);
            }
        });
        server.listen(startPort, host, () => {
            server.close(() => {
                resolve(startPort);
            });
        });
    });
}

(async () => {
    try {
        const port = await findAvailablePort(config.port, config.host);
        httpServer.listen(port, config.host, () => {
            const urlHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
            console.log(`Tabminal listening on http://${urlHost}:${port}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
})();

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