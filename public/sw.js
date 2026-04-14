const WORKER_VERSION = new URL(self.location.href).searchParams.get('rt') || 'stable';
const CACHE_NAME = `tabminal-cache-${WORKER_VERSION}`;
const versioned = (path) => `${path}?v=${encodeURIComponent(WORKER_VERSION)}`;
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/favicon.svg',
    '/favicon_adaptive.svg',
    '/manifest.json',
    '/apple-touch-icon.png',
    '/android-chrome-192x192.png',
    '/android-chrome-192x192-any.png',
    '/android-chrome-512x512.png',
    '/android-chrome-512x512-any.png',
    '/fonts/MonaspaceNeon-Regular.woff2',
    '/fonts/MonaspaceNeon-Bold.woff2',
    '/icons/map.json'
];
const VERSIONED_APP_ASSETS = [
    versioned('/styles.css'),
    versioned('/app.js'),
    versioned('/modules/notifications.js'),
    versioned('/modules/session-meta.js'),
    versioned('/modules/url-auth.js')
];

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (_err) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw _err;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
        cache.put(request, response.clone());
    }
    return response;
}

async function addAllSettled(cache, assets) {
    await Promise.allSettled(
        assets.map((asset) => cache.add(asset))
    );
}

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await addAllSettled(cache, [
            ...STATIC_ASSETS,
            ...VERSIONED_APP_ASSETS
        ]);
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names
                .filter(name => name !== CACHE_NAME)
                .map(name => caches.delete(name))
        );
        const cache = await caches.open(CACHE_NAME);
        const keys = await cache.keys();
        await Promise.all(
            keys
                .filter((request) => {
                    try {
                        const url = new URL(request.url);
                        return url.pathname.startsWith('/api/');
                    } catch (_err) {
                        return false;
                    }
                })
                .map((request) => cache.delete(request))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    const isDocument = (
        request.mode === 'navigate'
        || request.destination === 'document'
        || url.pathname === '/'
        || url.pathname === '/index.html'
    );
    const isAppShell = (
        url.pathname === '/app.js'
        || url.pathname === '/styles.css'
        || url.pathname === '/sw.js'
        || url.pathname.startsWith('/modules/')
    );
    const isVersionedAppShell = (
        isAppShell
        && (
            url.searchParams.get('v') === WORKER_VERSION
            || url.searchParams.get('rt') === WORKER_VERSION
        )
    );

    if (isDocument) {
        event.respondWith(networkFirst(request));
        return;
    }
    if (isVersionedAppShell) {
        event.respondWith(cacheFirst(request));
        return;
    }
    if (isAppShell) {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(cacheFirst(request));
});
