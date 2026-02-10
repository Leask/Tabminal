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

export function buildReloadUrlWithRuntimeBootId(bootId) {
    const current = new URL(window.location.href);
    current.searchParams.set('rt', bootId);
    return current.toString();
}

export function buildTokenStorageKey(serverId) {
    return `tabminal_auth_token:${serverId}`;
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

export async function hashPassword(password) {
    if (window.crypto && window.crypto.subtle) {
        try {
            const msgBuffer = new TextEncoder().encode(password);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn('Web Crypto API failed, falling back to JS implementation', e);
        }
    }
    return sha256Fallback(password);
}

function sha256Fallback(ascii) {
    function rightRotate(value, amount) {
        return (value >>> amount) | (value << (32 - amount));
    }

    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    const lengthProperty = 'length';
    let i, j;
    let result = '';
    const words = [];
    const asciiBitLength = ascii[lengthProperty] * 8;
    let hash = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ].slice(0);
    const k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    ascii += '\x80';
    while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';

    for (i = 0; i < ascii[lengthProperty]; i++) {
        j = ascii.charCodeAt(i);
        words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
    words[words[lengthProperty]] = (asciiBitLength);

    for (j = 0; j < words[lengthProperty];) {
        const w = words.slice(j, j += 16);
        const oldHash = hash;
        hash = hash.slice(0, 8);

        for (i = 0; i < 64; i++) {
            const w15 = w[i - 15], w2 = w[i - 2];
            const a = hash[0], e = hash[4];
            const temp1 = hash[7]
                + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
                + ((e & hash[5]) ^ ((~e) & hash[6]))
                + k[i]
                + (w[i] = (i < 16) ? w[i] : (
                    w[i - 16]
                    + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
                    + w[i - 7]
                    + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
                ) | 0
                );
            const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
                + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
            hash = [(temp1 + temp2) | 0].concat(hash);
            hash[4] = (hash[4] + temp1) | 0;
        }

        for (i = 0; i < 8; i++) {
            hash[i] = (hash[i] + oldHash[i]) | 0;
        }
    }

    for (i = 0; i < 8; i++) {
        for (j = 3; j + 1; j--) {
            const b = (hash[i] >> (j * 8)) & 255;
            result += ((b < 16) ? 0 : '') + b.toString(16);
        }
    }
    return result;
}
