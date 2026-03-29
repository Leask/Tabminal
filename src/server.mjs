#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import net from 'node:net';
import fsPromises from 'node:fs/promises';

import Koa from 'koa';
import serve from 'koa-static';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { formidable } from 'formidable';
import { WebSocketServer } from 'ws';

import { TerminalManager } from './terminal-manager.mjs';
import { AcpManager } from './acp-manager.mjs';
import { SystemMonitor } from './system-monitor.mjs';
import { config } from './config.mjs';
import { authMiddleware, verifyClient } from './auth.mjs';
import { setupFsRoutes } from './fs-routes.mjs';
import * as persistence from './persistence.mjs';
import { alan, network, web } from 'utilitas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = new Koa();
const router = new Router();
const SERVER_BOOT_ID = `${Date.now()}`;
const AGENT_ATTACHMENT_FIELD = 'attachments';
const MAX_AGENT_ATTACHMENTS = 8;
const MAX_AGENT_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_AGENT_ATTACHMENTS_TOTAL_SIZE = 25 * 1024 * 1024;

function debugLog(...args) {
    if (config.debug) {
        console.log(...args);
    }
}

function parseMultipartForm(req, options = {}) {
    return new Promise((resolve, reject) => {
        const form = formidable({
            multiples: true,
            allowEmptyFiles: false,
            maxFiles: MAX_AGENT_ATTACHMENTS,
            maxFileSize: MAX_AGENT_ATTACHMENT_SIZE,
            maxTotalFileSize: MAX_AGENT_ATTACHMENTS_TOTAL_SIZE,
            ...options
        });
        form.parse(req, (error, fields, files) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ fields, files });
        });
    });
}

function firstFormFieldValue(value) {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : '';
    }
    return typeof value === 'string' ? value : '';
}

function normalizePromptAttachments(files) {
    const rawList = Array.isArray(files)
        ? files
        : (files ? [files] : []);
    return rawList
        .filter((file) => file && typeof file === 'object')
        .map((file) => ({
            id: crypto.randomUUID(),
            name: String(file.originalFilename || 'attachment').trim()
                || 'attachment',
            mimeType: String(file.mimetype || '').trim(),
            size: Number.isFinite(file.size) ? file.size : 0,
            tempPath: String(file.filepath || '').trim()
        }))
        .filter((file) => file.tempPath);
}

app.use(async (ctx, next) => {
    const origin = ctx.get('Origin');
    if (origin) {
        ctx.set('Access-Control-Allow-Origin', origin);
        ctx.set('Vary', 'Origin');
        ctx.set('Access-Control-Allow-Credentials', 'true');
    } else {
        ctx.set('Access-Control-Allow-Origin', '*');
    }
    ctx.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');

    if (ctx.method === 'OPTIONS') {
        ctx.status = 204;
        return;
    }
    await next();
});

if (config.googleKey && config.googleCx) {
    try {
        await web.initSearch({
            provider: 'google',
            apiKey: config.googleKey,
            cx: config.googleCx
        });
        console.log('[Server] Web Search initialized (Google)');
    } catch (e) {
        console.error('[Server] Failed to initialize Web Search:', e.message);
    }
}

if (config.openrouterKey) {
    try {
        await alan.init({
            apiKey: config.openrouterKey,
            model: config.model
        });
        console.log(`[Server] Alan initialized with model: ${config.model}`);
    } catch (e) {
        console.error('[Server] Failed to initialize Alan (OpenRouter):', e.message);
    }
} else if (config.openaiKey) {
    try {
        await alan.init({
            provider: 'OpenAI',
            apiKey: config.openaiKey,
            apiBase: config.openaiApi,
            model: config.model
        });
        console.log(`[Server] Alan initialized with model: ${config.model}`);
    } catch (e) {
        console.error('[Server] Failed to initialize Alan (OpenAI):', e.message);
    }
}

if (config.cloudflareKey) {
    try {
        network.cfTunnel(config.cloudflareKey);
        console.log('[Server] Cloudflare Tunnel initialized');
    } catch (e) {
        console.error('[Server] Failed to initialize Cloudflare Tunnel:', e.message);
    }
}

if (!config.acceptTerms) {
    console.error(`
[SECURITY WARNING]
Please confirm you are running this service in a trusted environment.
You should use a secure tunnel like Cloudflare Zero Trust or Tailscale for remote access.
Do NOT expose this service's port directly to the public internet.
If you enable AI features, prompts may include terminal history, environment variables,
and file context that are sent to your chosen model provider. You assume this risk.
Choose a trusted model/provider and use least-privilege credentials.

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

// Body Parser
app.use(bodyParser());

// Auth Middleware for API routes
app.use(authMiddleware);

const systemMonitor = new SystemMonitor();
const terminalManager = new TerminalManager();
const acpManager = new AcpManager({ terminalManager });

// Restore sessions
(async () => {
    acpManager.restoring = true;
    try {
        const restoredSessions = await persistence.loadSessions();
        if (restoredSessions.length > 0) {
            console.log(`[Server] Restoring ${restoredSessions.length} sessions...`);
            for (const data of restoredSessions) {
                terminalManager.createSession(data);
            }
        }
        await acpManager.restoreTabs(new Set(terminalManager.sessions.keys()));
    } finally {
        acpManager.restoring = false;
    }
})();

// Setup FS Routes
setupFsRoutes(router);

// API routes for session management
router.all('/api/heartbeat', async (ctx) => {
    if (ctx.method === 'POST') {
        const { updates } = ctx.request.body;
        if (updates && updates.sessions) {
            for (const update of updates.sessions) {
                const session = terminalManager.getSession(update.id);
                if (session) {
                    if (update.resize) {
                        const { cols, rows } = update.resize;
                        if (cols && rows) session.resize(cols, rows);
                    }
                    if (update.workspaceState || update.editorState) {
                        terminalManager.updateSessionState(session.id, {
                            workspaceState: update.workspaceState,
                            editorState: update.editorState
                        });
                    }
                    if (update.fileWrites) {
                        for (const file of update.fileWrites) {
                            try {
                                await fsPromises.writeFile(file.path, file.content);
                            } catch (e) {
                                console.error(`[Heartbeat] Write failed: ${file.path}`, e);
                            }
                        }
                    }
                }
            }
        }
    }

    ctx.body = {
        sessions: terminalManager.listSessions(),
        agents: await acpManager.listInventory(),
        system: systemMonitor.getStats(),
        runtime: {
            bootId: SERVER_BOOT_ID
        }
    };
});

router.post('/api/sessions', (ctx) => {
    const options = ctx.request.body || {};
    const session = terminalManager.createSession(options);
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

router.delete('/api/sessions/:id', async (ctx) => {
    const { id } = ctx.params;
    const session = terminalManager.getSession(id);
    if (session?.managed?.kind === 'agent-terminal') {
        await acpManager.releaseManagedTerminalSession(id, { destroy: true });
        ctx.status = 204;
        return;
    }
    await acpManager.closeTabsForTerminalSession(id);
    await terminalManager.removeSession(id);
    ctx.status = 204;
});

router.post('/api/sessions/:id/state', async (ctx) => {
    const { id } = ctx.params;
    const data = ctx.request.body;
    terminalManager.updateSessionState(id, data);
    ctx.status = 200;
});

// File Save
router.post('/api/fs/write', async (ctx) => {
    const { path: filePath, content } = ctx.request.body;
    if (!filePath || content === undefined) {
        ctx.status = 400;
        return;
    }
    try {
        await fsPromises.writeFile(filePath, content, 'utf-8');
        ctx.status = 200;
    } catch (err) {
        console.error('FS Write Error:', err);
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// Memory: Expand/Collapse
router.post('/api/memory/expand', async (ctx) => {
    const { path: folderPath, expanded } = ctx.request.body;
    debugLog('[API] Expand:', folderPath, expanded);
    if (!folderPath) {
        ctx.status = 400;
        return;
    }
    const list = await persistence.updateExpandedFolder(folderPath, expanded);
    ctx.body = list;
});

router.get('/api/memory/expanded', async (ctx) => {
    const list = await persistence.getExpandedFolders();
    ctx.body = list;
});

router.get('/api/cluster', async (ctx) => {
    const servers = await persistence.loadCluster();
    ctx.body = { servers };
});

router.put('/api/cluster', async (ctx) => {
    const body = ctx.request.body;
    const servers = Array.isArray(body) ? body : body?.servers;
    if (!Array.isArray(servers)) {
        ctx.status = 400;
        ctx.body = { error: 'servers must be an array' };
        return;
    }
    try {
        await persistence.saveCluster(servers);
        ctx.body = { servers: await persistence.loadCluster() };
    } catch (err) {
        console.error('[API] Failed to save cluster:', err);
        ctx.status = 500;
        ctx.body = { error: 'Failed to save cluster config' };
    }
});

router.get('/api/agents', async (ctx) => {
    ctx.body = await acpManager.listState();
});

router.get('/api/agents/sessions', async (ctx) => {
    const { agentId = '', cwd = '', cursor = '' } = ctx.query || {};
    if (!agentId || typeof agentId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'agentId is required' };
        return;
    }
    if (!cwd || typeof cwd !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'cwd is required' };
        return;
    }

    try {
        let nextCursor = typeof cursor === 'string' ? cursor : '';
        const sessions = [];
        const paginate = !!nextCursor;
        for (let page = 0; page < 5; page += 1) {
            const result = await acpManager.listSessions({
                agentId,
                cwd,
                cursor: nextCursor
            });
            sessions.push(...(Array.isArray(result?.sessions)
                ? result.sessions
                : []));
            nextCursor = typeof result?.nextCursor === 'string'
                ? result.nextCursor
                : '';
            if (paginate || !nextCursor || sessions.length >= 50) {
                break;
            }
        }
        ctx.body = {
            sessions: sessions.slice(0, 50),
            nextCursor
        };
    } catch (error) {
        const message = error?.message || 'Failed to list agent sessions';
        ctx.status = /does not support session history/i.test(message)
            ? 501
            : 500;
        ctx.body = { error: message };
    }
});

router.get('/api/agents/config', async (ctx) => {
    ctx.body = {
        configs: await acpManager.listAgentConfigs()
    };
});

router.put('/api/agents/config/:agentId', async (ctx) => {
    const { agentId } = ctx.params;
    const { env, clearEnvKeys } = ctx.request.body || {};
    try {
        const configState = await acpManager.updateAgentConfig(agentId, {
            env: typeof env === 'object' && env ? env : {},
            clearEnvKeys: Array.isArray(clearEnvKeys) ? clearEnvKeys : []
        });
        ctx.body = {
            config: configState,
            definitions: await acpManager.listDefinitions()
        };
    } catch (error) {
        ctx.status = 400;
        ctx.body = {
            error: error?.message || 'Failed to save agent config'
        };
    }
});

router.delete('/api/agents/config/:agentId', async (ctx) => {
    const { agentId } = ctx.params;
    try {
        const configState = await acpManager.clearAgentConfig(agentId);
        ctx.body = {
            config: configState,
            definitions: await acpManager.listDefinitions()
        };
    } catch (error) {
        ctx.status = 400;
        ctx.body = {
            error: error?.message || 'Failed to clear agent config'
        };
    }
});

router.post('/api/agents/tabs', async (ctx) => {
    const { agentId, cwd, terminalSessionId, modeId } = ctx.request.body || {};
    if (!agentId || typeof agentId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'agentId is required' };
        return;
    }
    if (!cwd || typeof cwd !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'cwd is required' };
        return;
    }

    try {
        ctx.status = 201;
        ctx.body = await acpManager.createTab({
            agentId,
            cwd,
            terminalSessionId: typeof terminalSessionId === 'string'
                ? terminalSessionId
                : '',
            modeId: typeof modeId === 'string' ? modeId : ''
        });
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to create agent tab' };
    }
});

router.post('/api/agents/tabs/resume', async (ctx) => {
    const { agentId, cwd, terminalSessionId, sessionId, title } =
        ctx.request.body || {};
    if (!agentId || typeof agentId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'agentId is required' };
        return;
    }
    if (!cwd || typeof cwd !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'cwd is required' };
        return;
    }
    if (!sessionId || typeof sessionId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'sessionId is required' };
        return;
    }

    try {
        ctx.status = 201;
        ctx.body = await acpManager.resumeTab({
            agentId,
            cwd,
            sessionId,
            title: typeof title === 'string' ? title : '',
            terminalSessionId: typeof terminalSessionId === 'string'
                ? terminalSessionId
                : ''
        });
    } catch (error) {
        const message = error?.message || 'Failed to resume agent tab';
        ctx.status = /already open/i.test(message)
            ? 409
            : /does not support session restore/i.test(message)
                ? 501
                : 500;
        ctx.body = { error: message };
    }
});

router.post('/api/agents/tabs/:tabId/prompt', async (ctx) => {
    const { tabId } = ctx.params;
    let text = '';
    let attachments = [];

    if (ctx.is('multipart')) {
        try {
            const { fields, files } = await parseMultipartForm(ctx.req);
            text = firstFormFieldValue(fields?.text);
            attachments = normalizePromptAttachments(
                files?.[AGENT_ATTACHMENT_FIELD]
            );
        } catch (error) {
            ctx.status = 400;
            ctx.body = {
                error: error?.message || 'Failed to parse prompt attachments'
            };
            return;
        }
    } else {
        const body = ctx.request.body || {};
        text = typeof body.text === 'string' ? body.text : '';
    }

    if (!text.trim() && attachments.length === 0) {
        ctx.status = 400;
        ctx.body = { error: 'text or attachments are required' };
        return;
    }
    try {
        await acpManager.sendPrompt(tabId, text, attachments);
        ctx.status = 202;
        ctx.body = { ok: true };
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to send prompt' };
    }
});

router.post('/api/agents/tabs/:tabId/cancel', async (ctx) => {
    const { tabId } = ctx.params;
    try {
        await acpManager.cancel(tabId);
        ctx.status = 202;
        ctx.body = { ok: true };
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to cancel prompt' };
    }
});

router.post(
    '/api/agents/tabs/:tabId/permissions/:permissionId',
    async (ctx) => {
        const { tabId, permissionId } = ctx.params;
        const { optionId } = ctx.request.body || {};
        try {
            await acpManager.resolvePermission(
                tabId,
                permissionId,
                typeof optionId === 'string' ? optionId : ''
            );
            ctx.status = 200;
            ctx.body = { ok: true };
        } catch (error) {
            ctx.status = 500;
            ctx.body = {
                error: error?.message || 'Failed to resolve permission'
            };
        }
    }
);

router.post('/api/agents/tabs/:tabId/mode', async (ctx) => {
    const { tabId } = ctx.params;
    const { modeId } = ctx.request.body || {};
    if (!modeId || typeof modeId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'modeId is required' };
        return;
    }
    try {
        ctx.body = await acpManager.setMode(tabId, modeId);
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to switch mode' };
    }
});

router.post('/api/agents/tabs/:tabId/config', async (ctx) => {
    const { tabId } = ctx.params;
    const { configId, valueId } = ctx.request.body || {};
    if (!configId || typeof configId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'configId is required' };
        return;
    }
    if (!valueId || typeof valueId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'valueId is required' };
        return;
    }
    try {
        ctx.body = await acpManager.setConfigOption(tabId, configId, valueId);
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to update agent setting' };
    }
});

router.delete('/api/agents/tabs/:tabId', async (ctx) => {
    const { tabId } = ctx.params;
    await acpManager.closeTab(tabId);
    ctx.status = 204;
});

// Middleware
app.use(router.routes());
app.use(router.allowedMethods());

const httpServer = createServer(app.callback());
const wss = new WebSocketServer({ noServer: true, verifyClient });
const httpConnections = new Set();

httpServer.on('connection', (socket) => {
    httpConnections.add(socket);
    socket.on('close', () => {
        httpConnections.delete(socket);
    });
});

httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/ws/agents/')) {
        const match = pathname.match(/^\/ws\/agents\/([a-zA-Z0-9-]+)$/);
        if (!match) {
            socket.destroy();
            return;
        }

        const tabId = match[1];
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, {
                kind: 'agent',
                tabId
            });
        });
    } else if (pathname.startsWith('/ws/')) {
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
            const ua = request.headers['user-agent'] || 'Unknown';
            wss.emit('connection', ws, {
                kind: 'terminal',
                session,
                ua
            });
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (socket, target) => {
    socket.isAlive = true;
    socket.on('pong', () => {
        socket.isAlive = true;
    });
    if (target.kind === 'terminal') {
        debugLog(
            `[Server] WebSocket connected to session `
            + `${target.session.id} [${target.ua}]`
        );
        target.session.attach(socket);
        return;
    }
    if (target.kind === 'agent') {
        debugLog(
            `[Server] WebSocket connected to agent tab ${target.tabId}`
        );
        acpManager.attachSocket(target.tabId, socket);
    }
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
            if (port !== config.port) {
                console.warn(
                    `[Server] Port ${config.port} is unavailable; using ${port} instead.`
                );
            }
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
    for (const socket of wss.clients) {
        socket.terminate();
    }
    wss.close();
    terminalManager.dispose();
    void acpManager.dispose();

    const forceExitTimer = setTimeout(() => {
        console.warn('Forced shutdown after timeout.');
        process.exit(1);
    }, 5000).unref();

    httpServer.close(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
    });
    httpServer.closeIdleConnections?.();
    httpServer.closeAllConnections?.();
    for (const socket of httpConnections) {
        socket.destroy();
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
