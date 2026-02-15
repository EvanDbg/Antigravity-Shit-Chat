const CACHE_NAME = 'shitchat-v1';
const STATIC_ASSETS = ['/', '/login.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

// Install: pre-cache static assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch: network-first, fallback to cache
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        fetch(e.request)
            .then(response => {
                // Cache successful responses for offline use
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(e.request))
    );
});

// Push: show notification when AI finishes
self.addEventListener('push', (e) => {
    const data = e.data?.json() || {};
    e.waitUntil(
        self.registration.showNotification(data.title || '💬 Shit-Chat', {
            body: data.body || 'AI has finished responding',
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: data.cascadeId || 'default',
            renotify: true,
            data: { url: '/', cascadeId: data.cascadeId }
        })
    );
});

// Click notification → open/focus app
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const c of list) {
                if (c.url.includes(self.location.origin)) {
                    c.focus();
                    return;
                }
            }
            return clients.openWindow(e.notification.data?.url || '/');
        })
    );
});
