import {
    createAuthChallenge,
    issueAuthTokensFromChallenge,
    listAuthSessions,
    refreshAuthTokens,
    revokeAuthSessionById,
    revokeOtherAuthSessions,
    revokeAuthTokens
} from '../../auth.mjs';

export function registerAuthRoutes(router, serverBootId) {
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
