import {
    buildBusBackedAgentTab,
    buildBusTimelinePage
} from './acp-bus-format.mjs';
import { registerAcpBusCommandRoute } from './acp-bus-commands.mjs';
import { parseQueryBoolean } from './utils.mjs';

export function registerAcpBusRoutes(
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

    registerAcpBusCommandRoute(router, { acpBusManager });
}
