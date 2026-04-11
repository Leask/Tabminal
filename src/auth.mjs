import crypto from 'node:crypto';

import { config } from './config.mjs';
import {
    loadAuthSessions,
    saveAuthSessions
} from './persistence.mjs';

const MAX_ATTEMPTS = 30;
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_REPLAY_LEEWAY_MS = 30 * 1000;
const AUTH_CHALLENGE_TTL_MS = 30 * 1000;
const AUTH_CHALLENGE_CLEANUP_MS = 15 * 1000;
const AUTH_CHALLENGE_MAX = 1000;
export const AUTH_CHALLENGE_ALGORITHM = 'tabminal-hmac-sha256-login-v1';
export const AUTH_CHALLENGE_MESSAGE_PREFIX = 'tabminal-login-v1';
export const WEBSOCKET_PROTOCOL = 'tabminal.v1';
export const WEBSOCKET_AUTH_PROTOCOL_PREFIX = 'tabminal.auth.';

let failedAttempts = 0;
let isLocked = false;
let authStoreInitialized = false;
let authStoreInitPromise = null;
const refreshSessions = new Map();
const accessTokens = new Map();
const authChallenges = new Map();
let authChallengeCleanupTimer = null;

function nowTimestamp() {
    return Date.now();
}

function nowIso() {
    return new Date().toISOString();
}

function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function safeEqualHex(left, right) {
    if (left.length !== right.length) {
        return false;
    }
    return crypto.timingSafeEqual(
        Buffer.from(left, 'hex'),
        Buffer.from(right, 'hex')
    );
}

function getPasswordFingerprint() {
    return sha256(`tabminal-auth-password:${config.passwordHash}`);
}

function generateOpaqueToken(prefix) {
    return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function generateAuthChallengeSalt() {
    return crypto.randomBytes(32).toString('base64url');
}

function normalizeAuthHeader(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
        return '';
    }
    if (/^bearer\s+/i.test(raw)) {
        return raw.replace(/^bearer\s+/i, '').trim();
    }
    return raw;
}

function parseWebSocketProtocols(value) {
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function extractWebSocketAuthToken(req) {
    const authHeader = req?.headers?.authorization || '';
    if (authHeader) {
        return normalizeAuthHeader(authHeader);
    }

    const protocols = parseWebSocketProtocols(
        req?.headers?.['sec-websocket-protocol']
    );
    const authProtocol = protocols.find((protocol) => (
        protocol.startsWith(WEBSOCKET_AUTH_PROTOCOL_PREFIX)
    ));
    if (authProtocol) {
        return authProtocol.slice(WEBSOCKET_AUTH_PROTOCOL_PREFIX.length);
    }

    if (req?.url) {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            return normalizeAuthHeader(url.searchParams.get('token'));
        } catch {
            // Ignore malformed URL.
        }
    }

    return '';
}

function normalizeUserAgent(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    return raw.length > 500 ? raw.slice(0, 500) : raw;
}

function isIsoExpired(value, now = nowTimestamp()) {
    if (!value) {
        return true;
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return true;
    }
    return timestamp <= now;
}

function toIsoOffset(baseMs, deltaMs) {
    return new Date(baseMs + deltaMs).toISOString();
}

function buildAuthChallengeMessage(challenge) {
    return [
        AUTH_CHALLENGE_MESSAGE_PREFIX,
        challenge.id,
        challenge.salt,
        challenge.expiresAt
    ].join(':');
}

function hmacSha256Hex(keyHex, message) {
    return crypto
        .createHmac('sha256', Buffer.from(keyHex, 'hex'))
        .update(message)
        .digest('hex');
}

export function buildAuthChallengeResponse(passwordHash, challenge) {
    const normalizedPasswordHash = typeof passwordHash === 'string'
        ? passwordHash.trim().toLowerCase()
        : '';
    return hmacSha256Hex(
        normalizedPasswordHash,
        buildAuthChallengeMessage({
            id: challenge?.challengeId || challenge?.id || '',
            salt: challenge?.salt || '',
            expiresAt: challenge?.expiresAt || ''
        })
    );
}

function serializeRefreshSessions() {
    return Array.from(refreshSessions.values())
        .sort((left, right) => {
            return String(left.createdAt || '').localeCompare(
                String(right.createdAt || '')
            );
        });
}

async function persistRefreshSessions() {
    await saveAuthSessions(serializeRefreshSessions());
}

function removeAccessTokensForSession(sessionId) {
    for (const [tokenHash, entry] of accessTokens.entries()) {
        if (entry?.sessionId === sessionId) {
            accessTokens.delete(tokenHash);
        }
    }
}

function pruneExpiredAccessTokens(now = nowTimestamp()) {
    for (const [tokenHash, entry] of accessTokens.entries()) {
        if (!entry || isIsoExpired(entry.expiresAt, now)) {
            accessTokens.delete(tokenHash);
        }
    }
}

export function pruneExpiredAuthChallenges(now = nowTimestamp()) {
    let removed = 0;
    for (const [challengeId, challenge] of authChallenges.entries()) {
        if (!challenge || isIsoExpired(challenge.expiresAt, now)) {
            authChallenges.delete(challengeId);
            removed += 1;
        }
    }
    while (authChallenges.size > AUTH_CHALLENGE_MAX) {
        const oldestKey = authChallenges.keys().next().value;
        if (!oldestKey) {
            break;
        }
        authChallenges.delete(oldestKey);
        removed += 1;
    }
    return removed;
}

function startAuthChallengeCleanup() {
    if (authChallengeCleanupTimer) {
        return;
    }
    authChallengeCleanupTimer = setInterval(() => {
        pruneExpiredAuthChallenges();
    }, AUTH_CHALLENGE_CLEANUP_MS);
    if (typeof authChallengeCleanupTimer.unref === 'function') {
        authChallengeCleanupTimer.unref();
    }
}

function pruneExpiredRefreshSessions(now = nowTimestamp()) {
    let changed = false;
    for (const [sessionId, session] of refreshSessions.entries()) {
        if (
            !session
            || session.passwordFingerprint !== getPasswordFingerprint()
            || session.revokedAt
            || isIsoExpired(session.refreshExpiresAt, now)
        ) {
            refreshSessions.delete(sessionId);
            removeAccessTokensForSession(sessionId);
            changed = true;
        }
    }
    return changed;
}

async function ensureAuthStoreInitialized() {
    if (authStoreInitialized) {
        return;
    }
    if (!authStoreInitPromise) {
        authStoreInitPromise = (async () => {
            const sessions = await loadAuthSessions();
            refreshSessions.clear();
            for (const session of sessions) {
                refreshSessions.set(session.id, session);
            }
            const changed = pruneExpiredRefreshSessions();
            if (changed) {
                await persistRefreshSessions();
            }
            startAuthChallengeCleanup();
            authStoreInitialized = true;
        })().finally(() => {
            authStoreInitPromise = null;
        });
    }
    await authStoreInitPromise;
}

function verifyAuthChallengeResponse(challenge, response) {
    if (isLocked) {
        return { success: false, locked: true };
    }
    const normalized = typeof response === 'string'
        ? response.trim().toLowerCase()
        : '';
    const expected = hmacSha256Hex(
        config.passwordHash,
        buildAuthChallengeMessage(challenge)
    );
    if (
        !/^[0-9a-f]{64}$/.test(normalized)
        || !safeEqualHex(normalized, expected)
    ) {
        failedAttempts += 1;
        if (failedAttempts >= MAX_ATTEMPTS) {
            isLocked = true;
            console.error(
                '[Auth] Maximum failed attempts reached. Service locked.'
            );
        }
        return { success: false, locked: isLocked };
    }
    failedAttempts = 0;
    return { success: true, locked: false };
}

function buildAuthPayload(rawAccessToken, rawRefreshToken, now = nowTimestamp()) {
    return {
        accessToken: rawAccessToken,
        accessTokenExpiresAt: toIsoOffset(now, ACCESS_TOKEN_TTL_MS),
        refreshToken: rawRefreshToken,
        refreshTokenExpiresAt: toIsoOffset(now, REFRESH_TOKEN_TTL_MS)
    };
}

async function issueAuthTokensForVerifiedPassword({
    userAgent = ''
} = {}) {
    const now = nowTimestamp();
    const sessionId = crypto.randomUUID();
    const rawRefreshToken = generateOpaqueToken('tr');
    const refreshTokenHash = sha256(rawRefreshToken);
    const createdAt = nowIso();
    const session = {
        id: sessionId,
        passwordFingerprint: getPasswordFingerprint(),
        refreshTokenHash,
        createdAt,
        lastSeenAt: createdAt,
        refreshExpiresAt: toIsoOffset(now, REFRESH_TOKEN_TTL_MS),
        rotatedAt: createdAt,
        revokedAt: '',
        userAgent: normalizeUserAgent(userAgent)
    };
    refreshSessions.set(sessionId, session);
    await persistRefreshSessions();

    const rawAccessToken = issueAccessToken(sessionId, now);
    return {
        ok: true,
        status: 200,
        sessionId,
        ...buildAuthPayload(rawAccessToken, rawRefreshToken, now)
    };
}

function issueAccessToken(sessionId, now = nowTimestamp()) {
    removeAccessTokensForSession(sessionId);
    const rawAccessToken = generateOpaqueToken('ta');
    const accessTokenHash = sha256(rawAccessToken);
    accessTokens.set(accessTokenHash, {
        sessionId,
        expiresAt: toIsoOffset(now, ACCESS_TOKEN_TTL_MS)
    });
    return rawAccessToken;
}

function findRefreshSessionByToken(refreshToken) {
    const tokenHash = sha256(refreshToken);
    for (const session of refreshSessions.values()) {
        if (session.refreshTokenHash === tokenHash) {
            return session;
        }
    }
    return null;
}

function buildSessionSummary(session, currentSessionId = '') {
    return {
        id: session.id,
        createdAt: session.createdAt || '',
        lastSeenAt: session.lastSeenAt || '',
        refreshExpiresAt: session.refreshExpiresAt || '',
        userAgent: session.userAgent || '',
        current: session.id === currentSessionId
    };
}

export async function initAuthStore() {
    await ensureAuthStoreInitialized();
}

export async function createAuthChallenge() {
    await ensureAuthStoreInitialized();
    const now = nowTimestamp();
    pruneExpiredAuthChallenges(now);
    while (authChallenges.size >= AUTH_CHALLENGE_MAX) {
        const oldestKey = authChallenges.keys().next().value;
        if (!oldestKey) {
            break;
        }
        authChallenges.delete(oldestKey);
    }
    const id = crypto.randomUUID();
    const salt = generateAuthChallengeSalt();
    const createdAt = new Date(now).toISOString();
    const expiresAt = toIsoOffset(now, AUTH_CHALLENGE_TTL_MS);
    authChallenges.set(id, {
        id,
        salt,
        createdAt,
        expiresAt
    });
    return {
        challengeId: id,
        salt,
        expiresAt,
        algorithm: AUTH_CHALLENGE_ALGORITHM
    };
}

function consumeAuthChallenge(challengeId) {
    const normalizedChallengeId = typeof challengeId === 'string'
        ? challengeId.trim()
        : '';
    if (!normalizedChallengeId) {
        return null;
    }
    const challenge = authChallenges.get(normalizedChallengeId) || null;
    if (challenge) {
        authChallenges.delete(normalizedChallengeId);
    }
    return challenge;
}

export async function issueAuthTokensFromChallenge(
    { challengeId = '', response = '' } = {},
    { userAgent = '' } = {}
) {
    await ensureAuthStoreInitialized();
    if (typeof challengeId !== 'string' || !challengeId.trim()) {
        return {
            ok: false,
            status: 400,
            error: 'Invalid login challenge.'
        };
    }

    const challenge = consumeAuthChallenge(challengeId);
    if (!challenge || isIsoExpired(challenge.expiresAt)) {
        return {
            ok: false,
            status: 401,
            error: 'Login challenge expired. Please try again.'
        };
    }

    const normalizedResponse = typeof response === 'string'
        ? response.trim().toLowerCase()
        : '';
    if (!/^[0-9a-f]{64}$/.test(normalizedResponse)) {
        return {
            ok: false,
            status: 400,
            error: 'Invalid login challenge.'
        };
    }

    const { success, locked } = verifyAuthChallengeResponse(
        challenge,
        normalizedResponse
    );
    if (locked) {
        return {
            ok: false,
            status: 403,
            error: 'Service locked due to too many failed attempts. Please restart the service.'
        };
    }
    if (!success) {
        return {
            ok: false,
            status: 401,
            error: 'Unauthorized'
        };
    }

    return issueAuthTokensForVerifiedPassword({ userAgent });
}

export async function refreshAuthTokens(
    refreshToken,
    { userAgent = '' } = {}
) {
    await ensureAuthStoreInitialized();
    const normalized = typeof refreshToken === 'string'
        ? refreshToken.trim()
        : '';
    if (!normalized) {
        return {
            ok: false,
            status: 401,
            error: 'Unauthorized'
        };
    }

    const session = findRefreshSessionByToken(normalized);
    if (!session) {
        return {
            ok: false,
            status: 401,
            error: 'Unauthorized'
        };
    }

    const now = nowTimestamp();
    if (
        session.passwordFingerprint !== getPasswordFingerprint()
        || session.revokedAt
        || isIsoExpired(session.refreshExpiresAt, now)
    ) {
        refreshSessions.delete(session.id);
        removeAccessTokensForSession(session.id);
        await persistRefreshSessions();
        return {
            ok: false,
            status: 401,
            error: 'Unauthorized'
        };
    }

    const nextRefreshToken = generateOpaqueToken('tr');
    session.refreshTokenHash = sha256(nextRefreshToken);
    session.lastSeenAt = nowIso();
    session.rotatedAt = session.lastSeenAt;
    session.refreshExpiresAt = toIsoOffset(now, REFRESH_TOKEN_TTL_MS);
    const normalizedUserAgent = normalizeUserAgent(userAgent);
    if (normalizedUserAgent) {
        session.userAgent = normalizedUserAgent;
    }
    refreshSessions.set(session.id, session);
    await persistRefreshSessions();

    const rawAccessToken = issueAccessToken(session.id, now);
    return {
        ok: true,
        status: 200,
        sessionId: session.id,
        ...buildAuthPayload(rawAccessToken, nextRefreshToken, now)
    };
}

export async function listAuthSessions(currentSessionId = '') {
    await ensureAuthStoreInitialized();
    const changed = pruneExpiredRefreshSessions();
    if (changed) {
        await persistRefreshSessions();
    }
    return serializeRefreshSessions()
        .map((session) => buildSessionSummary(session, currentSessionId))
        .sort((left, right) => {
            if (left.current !== right.current) {
                return left.current ? -1 : 1;
            }
            return String(right.lastSeenAt || right.createdAt || '')
                .localeCompare(String(left.lastSeenAt || left.createdAt || ''));
        });
}

export async function revokeAuthSessionById(sessionId) {
    await ensureAuthStoreInitialized();
    const normalizedSessionId = typeof sessionId === 'string'
        ? sessionId.trim()
        : '';
    if (!normalizedSessionId || !refreshSessions.has(normalizedSessionId)) {
        return { ok: false, status: 404, error: 'Not found' };
    }
    refreshSessions.delete(normalizedSessionId);
    removeAccessTokensForSession(normalizedSessionId);
    await persistRefreshSessions();
    return { ok: true, status: 204 };
}

export async function revokeOtherAuthSessions(currentSessionId = '') {
    await ensureAuthStoreInitialized();
    const normalizedCurrentId = typeof currentSessionId === 'string'
        ? currentSessionId.trim()
        : '';
    let changed = false;
    for (const sessionId of refreshSessions.keys()) {
        if (sessionId === normalizedCurrentId) {
            continue;
        }
        refreshSessions.delete(sessionId);
        removeAccessTokensForSession(sessionId);
        changed = true;
    }
    if (changed) {
        await persistRefreshSessions();
    }
    return { ok: true, status: 204 };
}

export async function revokeAuthTokens({
    refreshToken = '',
    accessToken = ''
} = {}) {
    await ensureAuthStoreInitialized();
    const normalizedRefreshToken = typeof refreshToken === 'string'
        ? refreshToken.trim()
        : '';
    const normalizedAccessToken = normalizeAuthHeader(accessToken);
    let sessionId = '';

    if (normalizedRefreshToken) {
        const session = findRefreshSessionByToken(normalizedRefreshToken);
        sessionId = session?.id || '';
    }

    if (!sessionId && normalizedAccessToken) {
        pruneExpiredAccessTokens();
        const accessEntry = accessTokens.get(sha256(normalizedAccessToken));
        sessionId = accessEntry?.sessionId || '';
    }

    if (!sessionId) {
        return { ok: true, status: 204 };
    }

    refreshSessions.delete(sessionId);
    removeAccessTokensForSession(sessionId);
    await persistRefreshSessions();
    return { ok: true, status: 204 };
}

export async function authenticateAccessToken(rawToken) {
    await ensureAuthStoreInitialized();
    const normalizedToken = normalizeAuthHeader(rawToken);
    if (!normalizedToken) {
        return { ok: false, status: 401, error: 'Unauthorized' };
    }

    pruneExpiredAccessTokens();

    const accessEntry = accessTokens.get(sha256(normalizedToken));
    if (!accessEntry || isIsoExpired(accessEntry.expiresAt)) {
        if (accessEntry) {
            accessTokens.delete(sha256(normalizedToken));
        }
        return { ok: false, status: 401, error: 'Unauthorized' };
    }

    const session = refreshSessions.get(accessEntry.sessionId);
    if (
        !session
        || session.passwordFingerprint !== getPasswordFingerprint()
        || session.revokedAt
        || isIsoExpired(session.refreshExpiresAt)
    ) {
        accessTokens.delete(sha256(normalizedToken));
        if (session) {
            refreshSessions.delete(session.id);
            removeAccessTokensForSession(session.id);
            await persistRefreshSessions();
        }
        return { ok: false, status: 401, error: 'Unauthorized' };
    }

    session.lastSeenAt = nowIso();
    refreshSessions.set(session.id, session);
    return {
        ok: true,
        status: 200,
        auth: {
            sessionId: session.id,
            accessTokenExpiresAt: accessEntry.expiresAt,
            refreshTokenExpiresAt: session.refreshExpiresAt
        }
    };
}

export async function authMiddleware(ctx, next) {
    if (ctx.method === 'OPTIONS') {
        ctx.status = 204;
        return;
    }

    if (
        ctx.path === '/healthz'
        || ctx.path === '/api/version'
        || ctx.path === '/api/auth/challenge'
        || ctx.path === '/api/auth/login'
        || ctx.path === '/api/auth/refresh'
        || ctx.path === '/api/auth/logout'
    ) {
        return next();
    }

    const authHeader = ctx.get('Authorization') || ctx.query.token;
    const result = await authenticateAccessToken(authHeader);
    if (!result.ok) {
        ctx.status = result.status;
        ctx.body = { error: result.error };
        return;
    }

    ctx.state.auth = result.auth;
    await next();
}

export function verifyClient(info, cb) {
    const { req } = info;
    const normalizedToken = extractWebSocketAuthToken(req);
    if (!normalizedToken) {
        cb(false, 401, 'Unauthorized');
        return;
    }

    pruneExpiredAccessTokens(nowTimestamp() + ACCESS_TOKEN_REPLAY_LEEWAY_MS);
    const accessEntry = accessTokens.get(sha256(normalizedToken));
    if (!accessEntry || isIsoExpired(accessEntry.expiresAt)) {
        cb(false, 401, 'Unauthorized');
        return;
    }

    const session = refreshSessions.get(accessEntry.sessionId);
    if (
        !session
        || session.passwordFingerprint !== getPasswordFingerprint()
        || session.revokedAt
        || isIsoExpired(session.refreshExpiresAt)
    ) {
        cb(false, 401, 'Unauthorized');
        return;
    }

    cb(true);
}
