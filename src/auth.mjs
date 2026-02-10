import { config } from './config.mjs';

let failedAttempts = 0;
let isLocked = false;
const MAX_ATTEMPTS = 30;

export function checkAuth(providedHash) {
    if (isLocked) {
        return { success: false, locked: true };
    }

    if (!providedHash || providedHash !== config.passwordHash) {
        failedAttempts++;
        if (failedAttempts >= MAX_ATTEMPTS) {
            isLocked = true;
            console.error('[Auth] Maximum failed attempts reached. Service locked.');
        }
        return { success: false, locked: isLocked };
    }

    // Reset attempts on success? 
    // Requirement says "already wrong 30 times, service locked". 
    // Usually success resets counter, but strict interpretation might mean cumulative.
    // Assuming standard behavior: success resets counter to avoid accidental lockout over long periods.
    failedAttempts = 0;
    return { success: true, locked: false };
}

export async function authMiddleware(ctx, next) {
    if (ctx.method === 'OPTIONS') {
        ctx.status = 204;
        return;
    }

    // Allow health check without auth
    if (ctx.path === '/healthz') {
        return next();
    }

    // Check for Authorization header
    const authHeader = ctx.get('Authorization') || ctx.query.token;
    // Expecting "Authorization: <sha256-hash>"
    // Some clients might send "Bearer <hash>", let's handle raw hash for simplicity as per prompt
    // "header中攜帶這個編碼過的密碼" -> implies the value is the hash.
    
    const { success, locked } = checkAuth(authHeader);

    if (locked) {
        ctx.status = 403;
        ctx.body = { error: 'Service locked due to too many failed attempts. Please restart the service.' };
        return;
    }

    if (!success) {
        ctx.status = 401;
        ctx.body = { error: 'Unauthorized' };
        return;
    }

    await next();
}

export function verifyClient(info, cb) {
    const { req } = info;
    // WebSocket headers are in req.headers
    let authHeader = req.headers['authorization'];

    // If no header, check query parameter
    if (!authHeader && req.url) {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            authHeader = url.searchParams.get('token');
        } catch {
            // ignore invalid url
        }
    }
    
    const { success, locked } = checkAuth(authHeader);

    if (locked) {
        cb(false, 403, 'Service locked');
        return;
    }

    if (!success) {
        cb(false, 401, 'Unauthorized');
        return;
    }

    cb(true);
}
