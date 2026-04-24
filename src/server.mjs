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

function buildAgentTabAttachAck(
    agentTab,
    busSession,
    { attachSource = '' } = {}
) {
    if (!agentTab) {
        return null;
    }
    const continuityState = typeof busSession?.continuityState === 'string'
        ? busSession.continuityState
        : 'cold';
    const normalizedAttachSource = attachSource || (
        continuityState === 'live'
            ? 'hot'
            : continuityState === 'cached'
                ? 'cache'
                : 'cold'
    );
    return {
        ok: true,
        attach: {
            ok: true,
            source: normalizedAttachSource,
            continuityState
        },
        tab: {
            id: agentTab.id,
            runtimeId: agentTab.runtimeId,
            runtimeKey: agentTab.runtimeKey,
            acpSessionId: agentTab.acpSessionId,
            agentId: agentTab.agentId,
            agentLabel: agentTab.agentLabel,
            commandLabel: agentTab.commandLabel,
            title: agentTab.title || '',
            terminalSessionId: agentTab.terminalSessionId || '',
            cwd: agentTab.cwd || '',
            createdAt: agentTab.createdAt || '',
            status: agentTab.status || 'ready',
            busy: !!agentTab.busy,
            errorMessage: agentTab.errorMessage || '',
            currentModeId: agentTab.currentModeId || '',
            availableModes: Array.isArray(agentTab.availableModes)
                ? agentTab.availableModes
                : [],
            availableCommands: Array.isArray(agentTab.availableCommands)
                ? agentTab.availableCommands
                : [],
            sessionCapabilities: agentTab.sessionCapabilities || {},
            configOptions: Array.isArray(agentTab.configOptions)
                ? agentTab.configOptions
                : [],
            toolCalls: Array.isArray(agentTab.toolCalls)
                ? agentTab.toolCalls
                : [],
            permissions: Array.isArray(agentTab.permissions)
                ? agentTab.permissions
                : [],
            plan: Array.isArray(agentTab.plan) ? agentTab.plan : [],
            terminals: Array.isArray(agentTab.terminals)
                ? agentTab.terminals
                : [],
            usage: agentTab.usage || null,
            busConnectionKind: 'shared',
            busContinuityState: continuityState,
            busHotRank: busSession?.hotRank ?? null
        }
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
    loadOpenTabs: () => terminalManager.loadOpenAgentTabsFromWorkspace(),
    saveOpenTabs: (tabs) =>
        terminalManager.saveOpenAgentTabsToWorkspace(tabs),
    pollIntervalMs: config.acpBusPollIntervalMs,
    hotSessionLimit: config.acpBusHotSessionLimit,
    cacheSessionLimit: config.acpBusCacheSessionLimit,
    eventLimit: config.acpBusEventLimit
});

async function buildBusBackedAgentTab(
    tabId,
    { attach = false } = {}
) {
    await acpBusReadyPromise;
    if (attach) {
        const result = await acpBusManager.attachOpenTab(tabId);
        return result?.tab || null;
    }
    return acpBusManager.getOpenTab(tabId);
}

async function buildBusTimelinePage(tabId, query = {}) {
    await acpBusReadyPromise;
    return acpBusManager.getTimelinePageForTab(tabId, query);
}

function buildBusCommandMeta(
    type,
    {
        requestId = '',
        deduped = false,
        idempotency = 'none'
    } = {}
) {
    return {
        type,
        requestId: String(requestId || '').trim(),
        deduped: deduped === true,
        idempotency
    };
}

function buildBusCommandError(
    code,
    message,
    {
        retryable = false,
        details = null
    } = {}
) {
    const error = {
        code,
        message,
        retryable: retryable === true
    };
    if (details && typeof details === 'object') {
        error.details = details;
    }
    return {
        ok: false,
        error
    };
}

function classifyBusCommandFailure(error, fallbackMessage) {
    const message = String(
        error?.message
        || fallbackMessage
        || 'ACP bus command failed'
    );
    const details = error?.details && typeof error.details === 'object'
        ? error.details
        : null;
    if (error?.code === 'idempotency_conflict') {
        return {
            status: 409,
            body: buildBusCommandError(
                'idempotency_conflict',
                message,
                { details }
            )
        };
    }
    if (/permission request not found/i.test(message)) {
        return {
            status: 409,
            body: buildBusCommandError(
                'permission_stale',
                message,
                { details }
            )
        };
    }
    if (/continuity required|authoritative reload/i.test(message)) {
        return {
            status: 409,
            body: buildBusCommandError(
                'continuity_required',
                message,
                { details }
            )
        };
    }
    if (/session .*not found|acp bus session not found/i.test(message)) {
        return {
            status: 404,
            body: buildBusCommandError(
                'session_missing',
                message,
                { details }
            )
        };
    }
    if (/agent tab not found/i.test(message)) {
        return {
            status: 404,
            body: buildBusCommandError(
                'tab_missing',
                message,
                { details }
            )
        };
    }
    if (/session is already open|already open/i.test(message)) {
        return {
            status: 409,
            body: buildBusCommandError(
                'session_already_open',
                message,
                { details }
            )
        };
    }
    if (/unknown agent/i.test(message)) {
        return {
            status: 404,
            body: buildBusCommandError(
                'unknown_agent',
                message,
                { details }
            )
        };
    }
    if (/agent unavailable|not ready on the current host/i.test(message)) {
        return {
            status: 503,
            body: buildBusCommandError(
                'runtime_unavailable',
                message,
                {
                    retryable: true,
                    details
                }
            )
        };
    }
    if (/does not support/i.test(message)) {
        return {
            status: 501,
            body: buildBusCommandError(
                'not_supported',
                message,
                { details }
            )
        };
    }
    if (/is required|invalid|missing/i.test(message)) {
        return {
            status: 400,
            body: buildBusCommandError(
                'invalid_request',
                message,
                { details }
            )
        };
    }
    return {
        status: 500,
        body: buildBusCommandError(
            'internal_error',
            message,
            { details }
        )
    };
}

async function parseAcpBusCommand(ctx) {
    if (ctx.is('multipart')) {
        const { fields, files } = await parseMultipartForm(ctx.req);
        return {
            type: firstFormFieldValue(fields?.type),
            tabId: firstFormFieldValue(fields?.tabId),
            text: firstFormFieldValue(fields?.text),
            requestId: firstFormFieldValue(fields?.requestId),
            attachments: normalizePromptAttachments(
                files?.[AGENT_ATTACHMENT_FIELD]
            )
        };
    }
    const body = ctx.request.body || {};
    return {
        ...body,
        type: typeof body.type === 'string' ? body.type : ''
    };
}

// Restore sessions
const acpBusReadyPromise = (async () => {
    const restoredSessions = await persistence.loadSessions();
    if (restoredSessions.length > 0) {
        console.log(`[Server] Restoring ${restoredSessions.length} sessions...`);
        for (const data of restoredSessions) {
            terminalManager.createSession(data);
        }
    }
    await acpBusManager.start({
        validTerminalSessionIds: new Set(terminalManager.sessions.keys())
    });
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
        agents: await acpBusManager.listInventory(),
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
        await acpBusManager.releaseManagedTerminalSession(id, { destroy: true });
        ctx.status = 204;
        return;
    }
    await acpBusManager.closeTabsForTerminalSession(id);
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

router.get('/api/acp-bus/state', async (ctx) => {
    await acpBusReadyPromise;
    ctx.body = await acpBusManager.listState();
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

router.get('/api/acp-bus/resume-sessions', async (ctx) => {
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

router.get('/api/acp-bus/config', async (ctx) => {
    ctx.body = {
        configs: await acpManager.listAgentConfigs()
    };
});

router.put('/api/acp-bus/config/:agentId', async (ctx) => {
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

router.delete('/api/acp-bus/config/:agentId', async (ctx) => {
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

router.get('/api/acp-bus/tabs/:tabId/timeline', async (ctx) => {
    const page = await buildBusTimelinePage(ctx.params.tabId, ctx.query || {});
    if (!page) {
        ctx.status = 404;
        ctx.body = { error: 'Agent tab not found' };
        return;
    }
    ctx.body = page;
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

router.post('/api/acp-bus/command', async (ctx) => {
    let command = null;
    try {
        command = await parseAcpBusCommand(ctx);
    } catch (error) {
        ctx.status = 400;
        ctx.body = classifyBusCommandFailure(
            error,
            'Failed to parse ACP bus command'
        ).body;
        return;
    }

    const type = String(command?.type || '').trim();
    const requestId = String(command?.requestId || '').trim();
    await acpBusReadyPromise;

    try {
        switch (type) {
            case 'tab.create': {
                const { agentId, cwd, terminalSessionId, modeId } = command;
                if (!agentId || typeof agentId !== 'string') {
                    throw new Error('agentId is required');
                }
                if (!cwd || typeof cwd !== 'string') {
                    throw new Error('cwd is required');
                }
                const tab = await acpBusManager.createTabForUi({
                    agentId,
                    cwd,
                    terminalSessionId: typeof terminalSessionId === 'string'
                        ? terminalSessionId
                        : '',
                    modeId: typeof modeId === 'string' ? modeId : ''
                });
                ctx.status = 201;
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'none'
                    }),
                    tab
                };
                return;
            }
            case 'tab.resume': {
                const {
                    agentId,
                    cwd,
                    terminalSessionId,
                    sessionId,
                    targetTabId,
                    title
                } = command;
                if (!agentId || typeof agentId !== 'string') {
                    throw new Error('agentId is required');
                }
                if (!cwd || typeof cwd !== 'string') {
                    throw new Error('cwd is required');
                }
                if (!sessionId || typeof sessionId !== 'string') {
                    throw new Error('sessionId is required');
                }
                const {
                    serialized,
                    busSession,
                    attachSource
                } = await acpBusManager.resumeTabForUi({
                    agentId,
                    cwd,
                    sessionId,
                    targetTabId: typeof targetTabId === 'string'
                        ? targetTabId
                        : '',
                    title: typeof title === 'string' ? title : '',
                    terminalSessionId: typeof terminalSessionId === 'string'
                        ? terminalSessionId
                        : ''
                });
                ctx.body = {
                    command: buildBusCommandMeta(type, {
                        idempotency: 'natural'
                    }),
                    ...(buildAgentTabAttachAck(serialized, busSession, {
                        attachSource
                    }) || {
                        ok: true,
                        attach: {
                            ok: true,
                            source: attachSource,
                            continuityState: 'cold'
                        },
                        tab: serialized
                    })
                };
                return;
            }
            case 'tab.attach': {
                const tabId = String(command?.tabId || '').trim();
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                const result = await acpBusManager.attachOpenTab(tabId);
                if (!result?.tab) {
                    throw new Error('Agent tab not found');
                }
                ctx.body = {
                    command: buildBusCommandMeta(type, {
                        idempotency: 'natural'
                    }),
                    ...(buildAgentTabAttachAck(result.tab, result.session) || {
                        ok: true,
                        attach: {
                            ok: true,
                            source: 'cold',
                            continuityState: 'cold'
                        },
                        tab: result.tab
                    })
                };
                return;
            }
            case 'tab.detach': {
                const tabId = String(command?.tabId || '').trim();
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                await acpBusManager.unpinSession(
                    `agent-tab:${tabId}`,
                    'agent_tab_detach'
                );
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'natural'
                    })
                };
                return;
            }
            case 'tab.prompt': {
                const tabId = String(command?.tabId || '').trim();
                const text = typeof command?.text === 'string'
                    ? command.text
                    : '';
                const attachments = Array.isArray(command?.attachments)
                    ? command.attachments
                    : [];
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                if (!text.trim() && attachments.length === 0) {
                    throw new Error('text or attachments are required');
                }
                const result = await acpBusManager.sendPromptForTab(
                    tabId,
                    text,
                    attachments,
                    { requestId }
                );
                ctx.status = 202;
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        requestId: result.requestId,
                        deduped: result.deduped,
                        idempotency: 'request'
                    })
                };
                return;
            }
            case 'tab.cancel': {
                const tabId = String(command?.tabId || '').trim();
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                await acpBusManager.cancelForTab(tabId);
                ctx.status = 202;
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'natural'
                    })
                };
                return;
            }
            case 'tab.resolve_permission': {
                const tabId = String(command?.tabId || '').trim();
                const permissionId = String(command?.permissionId || '').trim();
                const optionId = typeof command?.optionId === 'string'
                    ? command.optionId
                    : '';
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                if (!permissionId) {
                    throw new Error('permissionId is required');
                }
                await acpBusManager.resolvePermissionForTab(
                    tabId,
                    permissionId,
                    optionId
                );
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'none'
                    })
                };
                return;
            }
            case 'tab.set_mode': {
                const tabId = String(command?.tabId || '').trim();
                const modeId = typeof command?.modeId === 'string'
                    ? command.modeId
                    : '';
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                if (!modeId) {
                    throw new Error('modeId is required');
                }
                const tab = await acpBusManager.setModeForTab(tabId, modeId);
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'none'
                    }),
                    tab
                };
                return;
            }
            case 'tab.set_config': {
                const tabId = String(command?.tabId || '').trim();
                const configId = typeof command?.configId === 'string'
                    ? command.configId
                    : '';
                const valueId = typeof command?.valueId === 'string'
                    ? command.valueId
                    : '';
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                if (!configId) {
                    throw new Error('configId is required');
                }
                if (!valueId) {
                    throw new Error('valueId is required');
                }
                const tab = await acpBusManager.setConfigOptionForTab(
                    tabId,
                    configId,
                    valueId
                );
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'none'
                    }),
                    tab
                };
                return;
            }
            case 'tab.close': {
                const tabId = String(command?.tabId || '').trim();
                if (!tabId) {
                    throw new Error('tabId is required');
                }
                await acpBusManager.closeTabForUi(tabId);
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'natural'
                    })
                };
                return;
            }
            case 'terminal.release': {
                const terminalSessionId = String(
                    command?.terminalSessionId || ''
                ).trim();
                if (!terminalSessionId) {
                    throw new Error('terminalSessionId is required');
                }
                const released = await acpBusManager.releaseManagedTerminalSession(
                    terminalSessionId,
                    {
                        destroy: command?.destroy === true
                    }
                );
                ctx.body = {
                    ok: true,
                    command: buildBusCommandMeta(type, {
                        idempotency: 'natural'
                    }),
                    released
                };
                return;
            }
            default:
                throw new Error(
                    type
                        ? `Unknown ACP bus command type: ${type}`
                        : 'type is required'
                );
        }
    } catch (error) {
        const classified = classifyBusCommandFailure(
            error,
            `Failed to execute ACP bus command ${type || '(unknown)'}`
        );
        ctx.status = classified.status;
        ctx.body = classified.body;
    }
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
    if (target.kind === 'acp-bus') {
        debugLog('[Server] WebSocket connected to ACP bus stream');
        acpBusSockets.add(socket);
        socket.on('close', () => {
            acpBusSockets.delete(socket);
        });
        void acpBusReadyPromise
            .then(async () => {
                sendWebSocketJson(socket, {
                    type: 'snapshot',
                    state: await acpBusManager.listState(),
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
