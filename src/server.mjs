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
import { WebSocket, WebSocketServer } from 'ws';

import { TerminalManager } from './terminal-manager.mjs';
import { AcpManager } from './acp-manager.mjs';
import { AcpBusManager } from './acp-bus-manager.mjs';
import { AcpBusStore } from './acp-bus-store.mjs';
import { SystemMonitor } from './system-monitor.mjs';
import { config } from './config.mjs';
import {
    authMiddleware,
    createAuthChallenge,
    initAuthStore,
    issueAuthTokensFromChallenge,
    listAuthSessions,
    refreshAuthTokens,
    revokeAuthSessionById,
    revokeOtherAuthSessions,
    revokeAuthTokens,
    verifyClient,
    WEBSOCKET_PROTOCOL
} from './auth.mjs';
import {
    setupFsRoutes,
    writeTextFileSnapshot
} from './fs-routes.mjs';
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

function parseQueryBoolean(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '1'
        || normalized === 'true'
        || normalized === 'yes';
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

function mergeBusControllerTab(controllerTab, busSession) {
    if (!controllerTab) {
        return null;
    }
    const snapshot = busSession?.snapshot && typeof busSession.snapshot === 'object'
        ? busSession.snapshot
        : null;
    return {
        ...(snapshot || {}),
        id: controllerTab.id,
        runtimeId: controllerTab.runtimeId,
        runtimeKey: controllerTab.runtimeKey,
        acpSessionId: controllerTab.acpSessionId,
        agentId: controllerTab.agentId,
        agentLabel: controllerTab.agentLabel,
        commandLabel: controllerTab.commandLabel,
        title: controllerTab.title || snapshot?.title || '',
        terminalSessionId: controllerTab.terminalSessionId || '',
        cwd: controllerTab.cwd || snapshot?.cwd || '',
        createdAt: controllerTab.createdAt || snapshot?.createdAt || '',
        status: snapshot?.status || controllerTab.status || 'ready',
        busy: typeof snapshot?.busy === 'boolean'
            ? snapshot.busy
            : !!controllerTab.busy,
        errorMessage: snapshot?.errorMessage || controllerTab.errorMessage || '',
        currentModeId: controllerTab.currentModeId || snapshot?.currentModeId || '',
        availableModes: Array.isArray(controllerTab.availableModes)
            ? controllerTab.availableModes
            : (snapshot?.availableModes || []),
        availableCommands: Array.isArray(controllerTab.availableCommands)
            ? controllerTab.availableCommands
            : (snapshot?.availableCommands || []),
        sessionCapabilities: controllerTab.sessionCapabilities
            || snapshot?.sessionCapabilities
            || {},
        configOptions: Array.isArray(controllerTab.configOptions)
            ? controllerTab.configOptions
            : (snapshot?.configOptions || []),
        messages: Array.isArray(snapshot?.messages)
            ? snapshot.messages
            : (controllerTab.messages || []),
        toolCalls: Array.isArray(snapshot?.toolCalls)
            ? snapshot.toolCalls
            : (controllerTab.toolCalls || []),
        permissions: Array.isArray(snapshot?.permissions)
            ? snapshot.permissions
            : (controllerTab.permissions || []),
        plan: Array.isArray(snapshot?.plan)
            ? snapshot.plan
            : (controllerTab.plan || []),
        usage: snapshot?.usage || controllerTab.usage || null,
        terminals: Array.isArray(snapshot?.terminals)
            ? snapshot.terminals
            : (controllerTab.terminals || []),
        busConnectionKind: 'shared',
        busContinuityState: busSession?.continuityState || 'cold',
        busHotRank: busSession?.hotRank ?? null
    };
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

router.post('/api/auth/challenge', async (ctx) => {
    ctx.body = await createAuthChallenge();
});

router.post('/api/auth/login', async (ctx) => {
    const body = ctx.request.body || {};
    const challengeId = typeof body.challengeId === 'string'
        ? body.challengeId
        : '';
    const response = typeof body.response === 'string'
        ? body.response
        : '';
    const result = await issueAuthTokensFromChallenge({
        challengeId,
        response
    }, {
        userAgent: ctx.get('user-agent')
    });
    ctx.status = result.status;
    if (result.ok) {
        ctx.body = {
            accessToken: result.accessToken,
            accessTokenExpiresAt: result.accessTokenExpiresAt,
            refreshToken: result.refreshToken,
            refreshTokenExpiresAt: result.refreshTokenExpiresAt
        };
        return;
    }
    ctx.body = { error: result.error };
});

router.post('/api/auth/refresh', async (ctx) => {
    const body = ctx.request.body || {};
    const refreshToken = typeof body.refreshToken === 'string'
        ? body.refreshToken
        : '';
    const result = await refreshAuthTokens(refreshToken, {
        userAgent: ctx.get('user-agent')
    });
    ctx.status = result.status;
    if (result.ok) {
        ctx.body = {
            accessToken: result.accessToken,
            accessTokenExpiresAt: result.accessTokenExpiresAt,
            refreshToken: result.refreshToken,
            refreshTokenExpiresAt: result.refreshTokenExpiresAt
        };
        return;
    }
    ctx.body = { error: result.error };
});

router.post('/api/auth/logout', async (ctx) => {
    const body = ctx.request.body || {};
    const refreshToken = typeof body.refreshToken === 'string'
        ? body.refreshToken
        : '';
    const accessToken = ctx.get('Authorization') || ctx.query.token || '';
    const result = await revokeAuthTokens({
        refreshToken,
        accessToken
    });
    ctx.status = result.status;
});

app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && ctx.path === '/api/version') {
        ctx.set(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate'
        );
        ctx.set('Pragma', 'no-cache');
        ctx.set('Expires', '0');
        ctx.body = {
            bootId: SERVER_BOOT_ID
        };
        return;
    }
    await next();
});

// Serve static files (public) BEFORE auth middleware
app.use(serve(publicDir));

// Body Parser
app.use(bodyParser());

// Auth Middleware for API routes
app.use(authMiddleware);

await initAuthStore();

router.get('/api/auth/session', async (ctx) => {
    const auth = ctx.state.auth || {};
    ctx.body = {
        authenticated: true,
        sessionId: auth.sessionId || '',
        accessTokenExpiresAt: auth.accessTokenExpiresAt || '',
        refreshTokenExpiresAt: auth.refreshTokenExpiresAt || ''
    };
});

router.get('/api/auth/sessions', async (ctx) => {
    const auth = ctx.state.auth || {};
    ctx.body = {
        sessions: await listAuthSessions(auth.sessionId || '')
    };
});

router.delete('/api/auth/sessions/:id', async (ctx) => {
    const result = await revokeAuthSessionById(ctx.params.id);
    ctx.status = result.status;
    if (!result.ok) {
        ctx.body = { error: result.error };
    }
});

router.post('/api/auth/logout-others', async (ctx) => {
    const auth = ctx.state.auth || {};
    const result = await revokeOtherAuthSessions(auth.sessionId || '');
    ctx.status = result.status;
});

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
    controllerSnapshotProvider: (agentId, sessionId) => {
        const serialized = acpManager.getSerializedTabBySessionId(sessionId);
        return serialized?.agentId === agentId ? serialized : null;
    },
    pollIntervalMs: config.acpBusPollIntervalMs,
    hotSessionLimit: config.acpBusHotSessionLimit,
    cacheSessionLimit: config.acpBusCacheSessionLimit,
    eventLimit: config.acpBusEventLimit
});

function recordAcpBusInterest(serialized, reason) {
    const agentId = String(serialized?.agentId || '').trim();
    const sessionId = String(serialized?.acpSessionId || '').trim();
    if (!agentId || !sessionId) {
        return;
    }
    void acpBusReadyPromise
        .then(() => acpBusManager.markSessionInterest({
            agentId,
            sessionId,
            cwd: serialized.cwd,
            title: serialized.title
        }))
        .catch((error) => {
            console.warn(
                `[ACP Bus] Failed to record session interest (${reason}):`,
                error?.message || error
            );
        });
}

function syncAcpBusControllerSnapshot(
    serialized,
    reason,
    { markInterest = false } = {}
) {
    const agentId = String(serialized?.agentId || '').trim();
    const sessionId = String(serialized?.acpSessionId || '').trim();
    if (!agentId || !sessionId) {
        return;
    }
    void acpBusReadyPromise
        .then(async () => {
            if (markInterest) {
                await acpBusManager.markSessionInterest({
                    agentId,
                    sessionId,
                    cwd: serialized.cwd,
                    title: serialized.title
                });
            }
            acpBusManager.ingestControllerTab(serialized, reason);
        })
        .catch((error) => {
            console.warn(
                `[ACP Bus] Failed to sync controller snapshot (${reason}):`,
                error?.message || error
            );
        });
}

acpManager.on('tab_dirty', ({ tab } = {}) => {
    if (!tab) {
        return;
    }
    syncAcpBusControllerSnapshot(tab, 'controller_tab_dirty');
});

async function buildBusBackedAgentTab(tabId, { attach = false } = {}) {
    const controllerTab = acpManager.getSerializedTab(tabId);
    if (!controllerTab) {
        return null;
    }
    await acpBusReadyPromise;
    let busSession = null;
    if (attach) {
        busSession = await acpBusManager.pinSession(
            `agent-tab:${tabId}`,
            {
                agentId: controllerTab.agentId,
                sessionId: controllerTab.acpSessionId,
                cwd: controllerTab.cwd,
                title: controllerTab.title
            },
            'agent_tab_attach'
        );
    } else {
        busSession = acpBusManager.getSession(
            controllerTab.agentId,
            controllerTab.acpSessionId,
            { includeSnapshot: true }
        );
    }
    return mergeBusControllerTab(controllerTab, busSession);
}

// Restore sessions
const acpBusReadyPromise = (async () => {
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
        await acpBusManager.start();
    } finally {
        acpManager.restoring = false;
    }
})();

// Setup FS Routes
setupFsRoutes(router);

// API routes for session management
router.all('/api/heartbeat', async (ctx) => {
    const fileWriteResults = [];
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
                        const sessionResults = [];
                        for (const file of update.fileWrites) {
                            try {
                                const snapshot = await writeTextFileSnapshot(
                                    file.path,
                                    file.content,
                                    file.expectedVersion,
                                    file.force === true
                                );
                                sessionResults.push({
                                    path: file.path,
                                    status: 'ok',
                                    version: snapshot.version,
                                    readonly: snapshot.readonly
                                });
                            } catch (e) {
                                if (e?.status === 409) {
                                    sessionResults.push({
                                        path: file.path,
                                        status: 'conflict',
                                        version: e.snapshot?.version || '',
                                        content: e.snapshot?.content || '',
                                        readonly: !!e.snapshot?.readonly,
                                        error: e.message
                                    });
                                    continue;
                                }
                                console.error(
                                    `[Heartbeat] Write failed: ${file.path}`,
                                    e
                                );
                                sessionResults.push({
                                    path: file.path,
                                    status: 'error',
                                    error: e?.message || 'Write failed'
                                });
                            }
                        }
                        if (sessionResults.length > 0) {
                            fileWriteResults.push({
                                id: update.id,
                                fileWrites: sessionResults
                            });
                        }
                    }
                }
            }
        }
    }

    ctx.body = {
        sessions: terminalManager.listSessions(),
        agents: await acpManager.listInventory(),
        fileWriteResults,
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

router.get('/api/acp-bus/state', async (ctx) => {
    await acpBusReadyPromise;
    ctx.body = acpBusManager.getState();
});

router.get('/api/acp-bus/sessions', async (ctx) => {
    await acpBusReadyPromise;
    const limit = Number.parseInt(String(ctx.query.limit || ''), 10);
    ctx.body = {
        sessions: acpBusManager.listSessions({
            agentId: typeof ctx.query.agentId === 'string'
                ? ctx.query.agentId
                : '',
            presentOnly: parseQueryBoolean(String(ctx.query.present || '')),
            hotOnly: parseQueryBoolean(String(ctx.query.hot || '')),
            includeSnapshot: parseQueryBoolean(
                String(ctx.query.snapshot || '')
            ),
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
        })
    };
});

router.get('/api/acp-bus/sessions/:agentId/:sessionId', async (ctx) => {
    await acpBusReadyPromise;
    const includeSnapshot = parseQueryBoolean(
        String(ctx.query.snapshot || '')
    );
    const session = acpBusManager.getSession(
        ctx.params.agentId,
        ctx.params.sessionId,
        { includeSnapshot }
    );
    if (!session) {
        ctx.status = 404;
        ctx.body = { error: 'ACP bus session not found' };
        return;
    }
    ctx.body = session;
});

router.get('/api/acp-bus/tabs/:tabId', async (ctx) => {
    const tab = await buildBusBackedAgentTab(ctx.params.tabId, {
        attach: false
    });
    if (!tab) {
        ctx.status = 404;
        ctx.body = { error: 'Agent tab not found' };
        return;
    }
    ctx.body = tab;
});

router.post('/api/acp-bus/tabs/:tabId/attach', async (ctx) => {
    const tab = await buildBusBackedAgentTab(ctx.params.tabId, {
        attach: true
    });
    if (!tab) {
        ctx.status = 404;
        ctx.body = { error: 'Agent tab not found' };
        return;
    }
    ctx.body = tab;
});

router.delete('/api/acp-bus/tabs/:tabId/attach', async (ctx) => {
    await acpBusReadyPromise;
    await acpBusManager.unpinSession(
        `agent-tab:${ctx.params.tabId}`,
        'agent_tab_detach'
    );
    ctx.status = 204;
});

router.get('/api/acp-bus/events', async (ctx) => {
    await acpBusReadyPromise;
    const limit = Number.parseInt(String(ctx.query.limit || ''), 10);
    ctx.body = {
        events: acpBusManager.listEvents(
            Number.isFinite(limit) && limit > 0 ? limit : 100
        )
    };
});

router.post('/api/acp-bus/sync', async (ctx) => {
    await acpBusReadyPromise;
    ctx.body = await acpBusManager.syncNow('api');
});

router.get('/api/agents/sessions', async (ctx) => {
    const { agentId = '', cwd = '' } = ctx.query || {};
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
        const result = await acpManager.listResumeSessions({
            agentId,
            cwd
        });
        ctx.body = {
            sessions: Array.isArray(result?.sessions) ? result.sessions : [],
            nextCursor: '',
            scope: typeof result?.scope === 'string' ? result.scope : 'cwd'
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
        const serialized = await acpManager.createTab({
            agentId,
            cwd,
            terminalSessionId: typeof terminalSessionId === 'string'
                ? terminalSessionId
                : '',
            modeId: typeof modeId === 'string' ? modeId : ''
        });
        ctx.body = serialized;
        recordAcpBusInterest(serialized, 'create_tab');
        syncAcpBusControllerSnapshot(serialized, 'create_tab');
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to create agent tab' };
    }
});

router.post('/api/agents/tabs/resume', async (ctx) => {
    const { agentId, cwd, terminalSessionId, sessionId, targetTabId, title } =
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
        const serialized = await acpManager.resumeTab({
            agentId,
            cwd,
            sessionId,
            targetTabId: typeof targetTabId === 'string' ? targetTabId : '',
            title: typeof title === 'string' ? title : '',
            terminalSessionId: typeof terminalSessionId === 'string'
                ? terminalSessionId
                : ''
        });
        ctx.body = serialized;
        recordAcpBusInterest(serialized, 'resume_tab');
        syncAcpBusControllerSnapshot(serialized, 'resume_tab');
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
        const serialized = acpManager.getSerializedTab(tabId);
        recordAcpBusInterest(serialized, 'send_prompt');
        syncAcpBusControllerSnapshot(serialized, 'send_prompt');
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
    await acpBusReadyPromise;
    await acpBusManager.unpinSession(`agent-tab:${tabId}`, 'agent_tab_close');
    await acpManager.closeTab(tabId);
    ctx.status = 204;
});

// Middleware
app.use(router.routes());
app.use(router.allowedMethods());

const httpServer = createServer(app.callback());
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
const httpConnections = new Set();
const acpBusSockets = new Set();

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
    } else if (pathname.startsWith('/ws/agents/')) {
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
        return;
    }
    if (target.kind === 'acp-bus') {
        debugLog('[Server] WebSocket connected to ACP bus stream');
        acpBusSockets.add(socket);
        socket.on('close', () => {
            acpBusSockets.delete(socket);
        });
        void acpBusReadyPromise
            .then(() => {
                sendWebSocketJson(socket, {
                    type: 'snapshot',
                    state: acpBusManager.getState(),
                    sessions: acpBusManager.listSessions({
                        limit: config.acpBusCacheSessionLimit
                    })
                });
            })
            .catch((error) => {
                sendWebSocketJson(socket, {
                    type: 'error',
                    error: error?.message || 'ACP bus is not available'
                });
                socket.close(1011, 'ACP bus is not available');
            });
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
