import { normalizeHostAlias } from './url-auth.js';

export function shortenPath(path, envText = '') {
    return shortenPathFishStyle(path, envText);
}

export function getEnvValue(envText, key) {
    if (!envText || !key) return '';
    const prefix = `${key}=`;
    const lines = String(envText).split('\n');
    for (const line of lines) {
        if (line.startsWith(prefix)) {
            return line.slice(prefix.length);
        }
    }
    return '';
}

export function getHostFromBaseUrl(baseUrl) {
    if (!baseUrl) return '';
    try {
        return new URL(baseUrl).hostname;
    } catch {
        return '';
    }
}

export function getDisplayHost(server) {
    if (!server) return 'unknown';
    return normalizeHostAlias(server.host)
        || server.lastSystemData?.hostname
        || getHostFromBaseUrl(server.baseUrl)
        || 'unknown';
}

export function getSessionHostParts(session) {
    if (!session) {
        return { user: '', host: 'unknown' };
    }
    const user = getEnvValue(session.env, 'USER')
        || getEnvValue(session.env, 'LOGNAME')
        || getEnvValue(session.env, 'USERNAME');
    const host = getDisplayHost(session.server);
    return { user, host };
}

export function renderSessionHostMeta(metaServerEl, session) {
    if (!metaServerEl) return;
    const { user, host } = getSessionHostParts(session);
    const hostText = host || 'unknown';

    metaServerEl.textContent = '';
    metaServerEl.appendChild(document.createTextNode('HOST: '));

    if (user) {
        metaServerEl.appendChild(document.createTextNode(`${user}@`));
    }

    const hostEl = document.createElement('span');
    hostEl.className = 'host-emphasis';
    hostEl.textContent = hostText;
    metaServerEl.appendChild(hostEl);
}

export function shortenPathFishStyle(path, envText = '') {
    if (!path) return '';
    const rawPath = String(path);
    const normalizedPath = rawPath.replace(/\\/g, '/');
    const home = getEnvValue(envText, 'HOME');

    let displayPath = normalizedPath;
    if (home && (normalizedPath === home || normalizedPath.startsWith(`${home}/`))) {
        displayPath = `~${normalizedPath.slice(home.length)}`;
    }

    if (displayPath === '/') return '/';
    if (displayPath === '~') return '~';

    const hasRoot = displayPath.startsWith('/');
    const hasHome = displayPath.startsWith('~');
    const prefix = hasHome ? '~' : (hasRoot ? '/' : '');
    const remainder = displayPath.slice(prefix.length);
    const parts = remainder.split('/').filter(Boolean);

    if (parts.length === 0) return prefix || '/';
    if (parts.length === 1) {
        if (prefix === '~') return `~/${parts[0]}`;
        if (prefix === '/') return `/${parts[0]}`;
        return parts[0];
    }

    const leaf = parts.pop();
    const compactParents = parts.map((part) => part[0]).join('/');
    let shortened;

    if (prefix === '~') {
        shortened = compactParents ? `~/${compactParents}/${leaf}` : `~/${leaf}`;
    } else if (prefix === '/') {
        shortened = compactParents ? `/${compactParents}/${leaf}` : `/${leaf}`;
    } else {
        shortened = compactParents ? `${compactParents}/${leaf}` : leaf;
    }

    if (shortened.length > 40) {
        return `.../${leaf}`;
    }
    return shortened;
}
