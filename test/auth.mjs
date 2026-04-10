import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = '/Users/leask/Documents/Tabminal';
const authModuleUrl = pathToFileURL(
    path.join(projectRoot, 'src', 'auth.mjs')
).href;

const tempHome = await fs.mkdtemp(
    path.join(os.tmpdir(), 'tabminal-auth-test-')
);

process.env.HOME = tempHome;
process.env.TABMINAL_PASSWORD = 'tabminal-auth-test';

function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

async function loadAuthModule() {
    return import(`${authModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

describe('auth token lifecycle', () => {
    it('issues, rotates, and revokes auth tokens', async () => {
        const auth = await loadAuthModule();
        await auth.initAuthStore();

        const failed = await auth.issueAuthTokensFromPassword('invalid');
        assert.equal(failed.ok, false);
        assert.equal(failed.status, 401);

        const login = await auth.issueAuthTokensFromPassword(
            process.env.TABMINAL_PASSWORD
        );
        assert.equal(login.ok, true);
        assert.ok(login.accessToken);
        assert.ok(login.refreshToken);

        const firstAccess = await auth.authenticateAccessToken(
            login.accessToken
        );
        assert.equal(firstAccess.ok, true);

        const refreshed = await auth.refreshAuthTokens(login.refreshToken);
        assert.equal(refreshed.ok, true);
        assert.notEqual(refreshed.accessToken, login.accessToken);
        assert.notEqual(refreshed.refreshToken, login.refreshToken);

        const oldRefresh = await auth.refreshAuthTokens(login.refreshToken);
        assert.equal(oldRefresh.ok, false);
        assert.equal(oldRefresh.status, 401);

        const oldAccess = await auth.authenticateAccessToken(login.accessToken);
        assert.equal(oldAccess.ok, false);
        assert.equal(oldAccess.status, 401);

        const nextAccess = await auth.authenticateAccessToken(
            refreshed.accessToken
        );
        assert.equal(nextAccess.ok, true);

        const revoked = await auth.revokeAuthTokens({
            refreshToken: refreshed.refreshToken
        });
        assert.equal(revoked.ok, true);
        assert.equal(revoked.status, 204);

        const afterLogout = await auth.authenticateAccessToken(
            refreshed.accessToken
        );
        assert.equal(afterLogout.ok, false);
        assert.equal(afterLogout.status, 401);
    });

    it('restores refresh sessions from persistence after reload', async () => {
        const firstAuth = await loadAuthModule();
        await firstAuth.initAuthStore();
        const login = await firstAuth.issueAuthTokensFromPassword(
            process.env.TABMINAL_PASSWORD
        );
        assert.equal(login.ok, true);

        const secondAuth = await loadAuthModule();
        await secondAuth.initAuthStore();
        const refreshed = await secondAuth.refreshAuthTokens(login.refreshToken);
        assert.equal(refreshed.ok, true);
        assert.ok(refreshed.accessToken);
    });

    it('lists and revokes refresh sessions by id', async () => {
        const auth = await loadAuthModule();
        await auth.initAuthStore();

        const first = await auth.issueAuthTokensFromPassword(
            process.env.TABMINAL_PASSWORD,
            { userAgent: 'First Test Browser' }
        );
        const second = await auth.issueAuthTokensFromPassword(
            process.env.TABMINAL_PASSWORD,
            { userAgent: 'Second Test Browser' }
        );
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);

        const firstAccess = await auth.authenticateAccessToken(
            first.accessToken
        );
        assert.equal(firstAccess.ok, true);

        const sessions = await auth.listAuthSessions(
            firstAccess.auth.sessionId
        );
        const firstSession = sessions.find(
            (session) => session.id === firstAccess.auth.sessionId
        );
        const secondSession = sessions.find(
            (session) => session.userAgent === 'Second Test Browser'
        );
        assert.equal(firstSession?.current, true);
        assert.ok(secondSession?.id);

        const revoked = await auth.revokeAuthSessionById(secondSession.id);
        assert.equal(revoked.ok, true);
        assert.equal(revoked.status, 204);

        const secondRefresh = await auth.refreshAuthTokens(
            second.refreshToken
        );
        assert.equal(secondRefresh.ok, false);
        assert.equal(secondRefresh.status, 401);

        const logoutOthers = await auth.revokeOtherAuthSessions(
            firstAccess.auth.sessionId
        );
        assert.equal(logoutOthers.ok, true);

        const remaining = await auth.listAuthSessions(
            firstAccess.auth.sessionId
        );
        assert.ok(remaining.every((session) => session.current));
    });

    it('does not restore legacy credential-hash refresh sessions', async () => {
        const baseDir = path.join(tempHome, '.tabminal');
        await fs.mkdir(baseDir, { recursive: true });
        await fs.writeFile(
            path.join(baseDir, 'auth-sessions.json'),
            JSON.stringify([
                {
                    id: 'legacy-session',
                    ['credential' + 'Hash']: sha256(
                        process.env.TABMINAL_PASSWORD
                    ),
                    refreshTokenHash: sha256('tr_legacy_refresh'),
                    createdAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                    refreshExpiresAt: new Date(
                        Date.now() + 60_000
                    ).toISOString(),
                    rotatedAt: new Date().toISOString(),
                    revokedAt: '',
                    userAgent: 'Legacy Browser'
                }
            ])
        );

        const auth = await loadAuthModule();
        await auth.initAuthStore();
        const refreshed = await auth.refreshAuthTokens('tr_legacy_refresh');
        assert.equal(refreshed.ok, false);
        assert.equal(refreshed.status, 401);

        const sessions = await auth.listAuthSessions();
        assert.deepEqual(sessions, []);
    });
});
