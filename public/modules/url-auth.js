export function normalizeBaseUrl(input) {
    const raw = String(input || '').trim();
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(candidate);
    parsed.hash = '';
    parsed.search = '';
    let normalized = parsed.toString();
    if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

export function getServerEndpointKeyFromUrl(input) {
    const parsed = new URL(normalizeBaseUrl(input));
    const host = parsed.hostname.toLowerCase();
    return parsed.port ? `${host}:${parsed.port}` : host;
}

export function getUrlHostname(input) {
    try {
        return new URL(normalizeBaseUrl(input)).hostname.toLowerCase();
    } catch {
        return '';
    }
}

export function normalizeHostAlias(input) {
    return String(input || '').trim();
}

export function isAccessRedirectResponse(response) {
    if (!response) return false;
    if (response.type === 'opaqueredirect') return true;
    return response.status === 302;
}

export function buildAccessLoginUrl(server) {
    return normalizeBaseUrl(server?.baseUrl || '');
}

export function isLikelyAccessLoginResponse(response) {
    if (!response) return false;
    if (isAccessRedirectResponse(response)) return true;
    const responseUrl = String(response.url || '');
    if (responseUrl.includes('/cdn-cgi/access/login')) return true;
    const location = response.headers?.get?.('location') || '';
    if (location.includes('/cdn-cgi/access/login')) return true;
    return false;
}

export function buildAuthStateStorageKey(serverId) {
    return `tabminal_auth_state:${serverId}`;
}

export function makeSessionKey(serverId, sessionId) {
    return `${serverId}:${sessionId}`;
}

export function splitSessionKey(sessionKey) {
    const index = sessionKey.indexOf(':');
    if (index < 0) {
        return { serverId: '', sessionId: sessionKey };
    }
    return {
        serverId: sessionKey.slice(0, index),
        sessionId: sessionKey.slice(index + 1)
    };
}
