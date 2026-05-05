#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import { TerminalManager } from './terminal-manager.mjs';
import { AcpManager } from './acp-manager.mjs';
import { AcpBusManager } from './acp-bus-manager.mjs';
import { AcpBusStore } from './acp-bus-store.mjs';
import { SystemMonitor } from './system-monitor.mjs';
import { config } from './config.mjs';
import {
    authMiddleware,
    verifyClient,
    WEBSOCKET_PROTOCOL
} from './auth.mjs';
import * as persistence from './persistence.mjs';
import {
    alan,
    callosum,
    file as webjamFile,
    network,
    web,
    webjam
} from 'webjam';
import {
    setTabminalHttpHandler
} from './controllers/tabminal.mjs';
import {
    createRestApiRouter
} from './controllers/rest/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const controllerDir = path.join(__dirname, 'controllers');

const SERVER_BOOT_ID = `${Date.now()}`;

function debugLog(...args) {
    if (config.debug) {
        console.log(...args);
    }
}

function sendWebSocketJson(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) {
        return false;
    }
    try {
        socket.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

async function publishStaticFiles(webRuntime) {
    const app = webRuntime.app;
    app.middleware = app.middleware.filter((middleware) => {
        return middleware.name !== 'serve';
    });
    const beforePublishCount = app.middleware.length;
    await webjamFile.publish({ publicPath: publicDir });
    const publishedMiddleware = app.middleware.splice(beforePublishCount);
    const insertIndex = Math.max(0, app.middleware.length - 2);
    app.middleware.splice(insertIndex, 0, ...publishedMiddleware);
    webRuntime.server.removeAllListeners('request');
    webRuntime.server.on('request', app.callback());
}

async function initOptionalIntegrations() {
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
            console.error(
                '[Server] Failed to initialize Alan (OpenRouter):',
                e.message
            );
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
            console.error(
                '[Server] Failed to initialize Alan (OpenAI):',
                e.message
            );
        }
    }

    if (config.cloudflareKey) {
        try {
            network.cfTunnel(config.cloudflareKey);
            console.log('[Server] Cloudflare Tunnel initialized');
        } catch (e) {
            console.error(
                '[Server] Failed to initialize Cloudflare Tunnel:',
                e.message
            );
        }
    }
}

function listWorkspaceCwdsForAcpBus(terminalManager) {
    const cwds = [];
    const pushCwd = (value) => {
        const cwd = String(value || '').trim();
        if (cwd) {
            cwds.push(cwd);
        }
    };
    for (const session of terminalManager.listSessions()) {
        if (session.managed || session.closed) {
            continue;
        }
        pushCwd(session.cwd);
        pushCwd(session.initialCwd);
        const openAgentTabs = Array.isArray(
            session.workspaceState?.openAgentTabs
        )
            ? session.workspaceState.openAgentTabs
            : [];
        for (const tab of openAgentTabs) {
            pushCwd(tab?.cwd);
        }
    }
    return cwds;
}

async function createRuntimeManagers() {
    const systemMonitor = new SystemMonitor();
    const terminalManager = new TerminalManager();
    const acpManager = new AcpManager({ terminalManager });
    const acpBusStore = new AcpBusStore({
        dbPath: config.acpBusDbPath || undefined,
        eventLimit: config.acpBusEventLimit
    });
    const acpBusManager = new AcpBusManager({
        acpManager,
        store: acpBusStore,
        loadOpenTabs: () => terminalManager.loadOpenAgentTabsFromWorkspace(),
        saveOpenTabs: (tabs) =>
            terminalManager.saveOpenAgentTabsToWorkspace(tabs),
        listWorkspaceCwds: () => listWorkspaceCwdsForAcpBus(terminalManager),
        pollIntervalMs: config.acpBusPollIntervalMs,
        hotSessionLimit: config.acpBusHotSessionLimit,
        cacheSessionLimit: config.acpBusCacheSessionLimit,
        eventLimit: config.acpBusEventLimit
    });

    const acpBusReadyPromise = (async () => {
        const restoredSessions = await persistence.loadSessions();
        if (restoredSessions.length > 0) {
            console.log(
                `[Server] Restoring ${restoredSessions.length} sessions...`
            );
            for (const data of restoredSessions) {
                terminalManager.createSession(data);
            }
        }
        await acpBusManager.start({
            validTerminalSessionIds: new Set(terminalManager.sessions.keys())
        });
    })();

    return {
        systemMonitor,
        terminalManager,
        acpManager,
        acpBusManager,
        acpBusReadyPromise
    };
}

function installHttpHandler(router) {
    const routeHandler = router.routes();
    const allowedMethodsHandler = router.allowedMethods();

    setTabminalHttpHandler(async (ctx, next) => {
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

        await authMiddleware(ctx, async () => {
            await routeHandler(ctx, async () => {
                await allowedMethodsHandler(ctx, next);
            });
        });
    });
}

function installWebSockets({
    httpServer,
    terminalManager,
    acpBusManager,
    acpBusSockets,
    httpConnections
}) {
    const wss = new WebSocketServer({
        noServer: true,
        verifyClient,
        handleProtocols: (protocols) => {
            if (protocols.has(WEBSOCKET_PROTOCOL)) {
                return WEBSOCKET_PROTOCOL;
            }
            return false;
        }
    });

    function broadcastAcpBusEvent(event) {
        for (const socket of acpBusSockets) {
            sendWebSocketJson(socket, {
                type: 'event',
                event
            });
        }
    }

    acpBusManager.on('event', broadcastAcpBusEvent);

    httpServer.on('connection', (socket) => {
        httpConnections.add(socket);
        socket.on('close', () => {
            httpConnections.delete(socket);
        });
    });

    httpServer.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const pathname = url.pathname;

        if (pathname === '/ws/acp-bus') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, {
                    kind: 'acp-bus'
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
                    console.warn(
                        `[Server] Session not found for ID: ${sessionId}`
                    );
                    ws.close();
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
        if (target.kind === 'acp-bus') {
            debugLog('[Server] WebSocket connected to ACP bus stream');
            acpBusSockets.add(socket);
            socket.on('close', () => {
                acpBusSockets.delete(socket);
            });
            void (async () => {
                const state = await acpBusManager.listState();
                sendWebSocketJson(socket, {
                    type: 'snapshot',
                    state,
                    sessions: await acpBusManager.listSessions({
                        limit: config.acpBusCacheSessionLimit
                    })
                });
            })()
                .catch((error) => {
                    sendWebSocketJson(socket, {
                        type: 'error',
                        error: error?.message || 'ACP bus is not available'
                    });
                    socket.close(1011, 'ACP bus is not available');
                });
        }
    });

    return wss;
}

async function bindConfiguredHost(webRuntime, httpServer, actualPort) {
    if (!config.host || ['0.0.0.0', '::'].includes(config.host)) {
        return;
    }
    await new Promise((resolve) => {
        webRuntime.service.close(() => resolve());
    });
    await new Promise((resolve) => {
        webRuntime.service = httpServer.listen(actualPort, config.host, resolve);
    });
}

function logListenAddress(actualPort) {
    const urlHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    if (actualPort !== config.port) {
        console.warn(
            `[Server] Port ${config.port} is unavailable; using ${actualPort} instead.`
        );
    }
    console.log(`Tabminal listening on http://${urlHost}:${actualPort}`);
}

async function startTabminal(webRuntime, actualPort) {
    if (!webRuntime?.app || !webRuntime?.server) {
        throw new Error('webjam runtime did not return app/server handles');
    }

    const httpServer = webRuntime.server;
    await publishStaticFiles(webRuntime);
    await initOptionalIntegrations();

    const {
        systemMonitor,
        terminalManager,
        acpManager,
        acpBusManager,
        acpBusReadyPromise
    } = await createRuntimeManagers();

    const router = await createRestApiRouter({
        terminalManager,
        acpManager,
        acpBusManager,
        systemMonitor,
        acpBusReadyPromise,
        serverBootId: SERVER_BOOT_ID
    });
    installHttpHandler(router);

    const httpConnections = new Set();
    const acpBusSockets = new Set();
    const wss = installWebSockets({
        httpServer,
        terminalManager,
        acpBusManager,
        acpBusSockets,
        httpConnections
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

    await bindConfiguredHost(webRuntime, httpServer, actualPort);
    logListenAddress(actualPort);

    let isShuttingDown = false;
    async function shutdown(signal) {
        if (isShuttingDown) {
            return;
        }
        isShuttingDown = true;
        console.log(`Shutting down (${signal})...`);
        clearInterval(heartbeatInterval);
        for (const socket of wss.clients) {
            socket.terminate();
        }
        acpBusSockets.clear();
        wss.close();
        terminalManager.dispose();

        const waitForHttpClose = new Promise((resolve) => {
            httpServer.close(() => resolve());
        });
        httpServer.closeIdleConnections?.();
        httpServer.closeAllConnections?.();
        for (const socket of httpConnections) {
            socket.destroy();
        }

        const forceExitTimer = setTimeout(() => {
            console.warn('Forced shutdown after timeout.');
            process.exit(1);
        }, 5000).unref();

        try {
            await Promise.all([
                waitForHttpClose,
                acpBusManager.dispose(),
                acpManager.dispose()
            ]);
            clearTimeout(forceExitTimer);
            process.exit(0);
        } catch (error) {
            clearTimeout(forceExitTimer);
            console.error('Shutdown failed:', error);
            process.exit(0);
        }
    }

    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });
}

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

async function bootstrap() {
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

    try {
        if (!process.env.TABMINAL_PASSWORD && config.password) {
            process.env.TABMINAL_PASSWORD = config.password;
        }
        const port = await findAvailablePort(config.port, config.host);
        const runtime = await webjam.init({
            controllerPath: controllerDir,
            debug: config.debug,
            domain: config.host,
            port,
            workerCount: 1
        });
        if (callosum.isPrimary) {
            return;
        }
        await startTabminal(runtime, port);
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

await bootstrap();
