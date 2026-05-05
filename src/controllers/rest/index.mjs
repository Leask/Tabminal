import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsPromises from 'node:fs/promises';

import Router from '@koa/router';
import multer from '@koa/multer';

import {
    createAuthChallenge,
    initAuthStore,
    issueAuthTokensFromChallenge,
    listAuthSessions,
    refreshAuthTokens,
    revokeAuthSessionById,
    revokeOtherAuthSessions,
    revokeAuthTokens
} from '../../auth.mjs';
import {
    setupFsRoutes,
    writeTextFileSnapshot
} from '../../fs-routes.mjs';
import { config } from '../../config.mjs';
import * as persistence from '../../persistence.mjs';

const AGENT_ATTACHMENT_FIELD = 'attachments';
const MAX_AGENT_ATTACHMENTS = 8;
const MAX_AGENT_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_AGENT_ATTACHMENTS_TOTAL_SIZE = 25 * 1024 * 1024;
const uploadTempDir = path.join(os.tmpdir(), 'tabminal-agent-uploads');
const uploadAgentAttachments = multer({
    dest: uploadTempDir,
    limits: {
        files: MAX_AGENT_ATTACHMENTS,
        fileSize: MAX_AGENT_ATTACHMENT_SIZE,
        fieldSize: MAX_AGENT_ATTACHMENTS_TOTAL_SIZE
    }
}).any();

function debugLog(...args) {
    if (config.debug) {
        console.log(...args);
    }
}

async function parseMultipartForm(ctx) {
    await fsPromises.mkdir(uploadTempDir, { recursive: true });
    await uploadAgentAttachments(ctx, async () => {});
    return {
        fields: ctx.request.body || {},
        files: Array.isArray(ctx.request.files) ? ctx.request.files : []
    };
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

function normalizePromptAttachments(files) {
    const rawList = Array.isArray(files)
        ? files
        : (files ? [files] : []);
    return rawList
        .filter((file) => file && typeof file === 'object')
        .map((file) => ({
            id: crypto.randomUUID(),
            name: String(
                file.originalFilename
                || file.originalname
                || 'attachment'
            ).trim()
                || 'attachment',
            mimeType: String(file.mimetype || '').trim(),
            size: Number.isFinite(file.size) ? file.size : 0,
            tempPath: String(file.filepath || file.path || '').trim()
        }))
        .filter((file) => file.tempPath);
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

async function buildBusBackedAgentTab(
    acpBusManager,
    tabId,
    { attach = false } = {}
) {
    if (attach) {
        const result = await acpBusManager.attachOpenTab(tabId);
        return result?.tab || null;
    }
    return await acpBusManager.getOpenTab(tabId);
}

async function buildBusTimelinePage(acpBusManager, tabId, query = {}) {
    return await acpBusManager.getTimelinePageForTab(tabId, query);
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
        const { fields, files } = await parseMultipartForm(ctx);
        return {
            type: firstFormFieldValue(fields?.type),
            tabId: firstFormFieldValue(fields?.tabId),
            text: firstFormFieldValue(fields?.text),
            requestId: firstFormFieldValue(fields?.requestId),
            attachments: normalizePromptAttachments(
                files.filter((file) => file?.fieldname === AGENT_ATTACHMENT_FIELD)
            )
        };
    }
    const body = ctx.request.body || {};
    return {
        ...body,
        type: typeof body.type === 'string' ? body.type : ''
    };
}

function registerAuthRoutes(router, serverBootId) {
    router.get('/api/version', (ctx) => {
        ctx.set(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate'
        );
        ctx.set('Pragma', 'no-cache');
        ctx.set('Expires', '0');
        ctx.body = {
            bootId: serverBootId
        };
    });

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
}

function registerSessionRoutes(
    router,
    {
        terminalManager,
        acpBusManager,
        systemMonitor,
        serverBootId
    }
) {
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
                            if (cols && rows) {
                                session.resize(cols, rows);
                            }
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
                bootId: serverBootId
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
            await acpBusManager.releaseManagedTerminalSession(id, {
                destroy: true
            });
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
}

function registerPersistenceRoutes(router) {
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

    router.post('/api/memory/expand', async (ctx) => {
        const { path: folderPath, expanded } = ctx.request.body;
        debugLog('[API] Expand:', folderPath, expanded);
        if (!folderPath) {
            ctx.status = 400;
            return;
        }
        const list = await persistence.updateExpandedFolder(
            folderPath,
            expanded
        );
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
}

function registerAcpBusRoutes(
    router,
    {
        acpManager,
        acpBusManager,
        acpBusReadyPromise
    }
) {
    router.get('/api/acp-bus/state', async (ctx) => {
        ctx.body = await acpBusManager.listState();
    });

    router.get('/api/acp-bus/sessions', async (ctx) => {
        const limit = Number.parseInt(String(ctx.query.limit || ''), 10);
        ctx.body = {
            sessions: await acpBusManager.listSessions({
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
        const includeSnapshot = parseQueryBoolean(
            String(ctx.query.snapshot || '')
        );
        const session = await acpBusManager.getSession(
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
            const result = await acpBusManager.listResumeSessions({
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
        const tab = await buildBusBackedAgentTab(
            acpBusManager,
            ctx.params.tabId,
            { attach: false }
        );
        if (!tab) {
            ctx.status = 404;
            ctx.body = { error: 'Agent tab not found' };
            return;
        }
        ctx.body = tab;
    });

    router.get('/api/acp-bus/tabs/:tabId/timeline', async (ctx) => {
        const page = await buildBusTimelinePage(
            acpBusManager,
            ctx.params.tabId,
            ctx.query || {}
        );
        if (!page) {
            ctx.status = 404;
            ctx.body = { error: 'Agent tab not found' };
            return;
        }
        ctx.body = page;
    });

    router.get('/api/acp-bus/events', async (ctx) => {
        const limit = Number.parseInt(String(ctx.query.limit || ''), 10);
        ctx.body = {
            events: await acpBusManager.listEvents(
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
                        ...(buildAgentTabAttachAck(
                            result.tab,
                            result.session
                        ) || {
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
                    const permissionId = String(
                        command?.permissionId || ''
                    ).trim();
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
                    const tab = await acpBusManager.setModeForTab(
                        tabId,
                        modeId
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
                    const released = await acpBusManager
                        .releaseManagedTerminalSession(
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
}

export async function createRestApiRouter({
    terminalManager,
    acpManager,
    acpBusManager,
    systemMonitor,
    acpBusReadyPromise,
    serverBootId
}) {
    await initAuthStore();

    const router = new Router();
    registerAuthRoutes(router, serverBootId);
    setupFsRoutes(router);
    registerSessionRoutes(router, {
        terminalManager,
        acpBusManager,
        systemMonitor,
        serverBootId
    });
    registerPersistenceRoutes(router);
    registerAcpBusRoutes(router, {
        acpManager,
        acpBusManager,
        acpBusReadyPromise
    });
    return router;
}
