const CACHE_NAME = 'tabminal-cache-v2';
const STATIC_ASSETS = [
    '/favicon.svg',
    '/manifest.json',
    '/apple-touch-icon.png'
];

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        cache.put(request, response.clone());
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
    cache.put(request, response.clone());
    return response;
}

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
    );
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
    );

    if (isDocument || isAppShell) {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(cacheFirst(request));
});
