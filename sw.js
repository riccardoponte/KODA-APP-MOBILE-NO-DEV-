/* =====================================================================
   Koda AI — Service Worker
   - Offline (app shell + runtime cache)
   - Notifiche sopra l'icona dell'app quando i cataloghi (video / AI /
     notizie) vengono aggiornati (Notification + Badging API)
   - Periodic Background Sync per controllare gli aggiornamenti anche ad
     app chiusa (best-effort, supportato principalmente su Chrome/Android)
   ===================================================================== */

const CACHE_VERSION = 'koda-v2';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const PREFS_CACHE = 'koda-prefs'; // non versionato: conserva preferenze/stato tra gli aggiornamenti

// File principali dell'app (percorsi relativi allo scope del SW)
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json'
];

// ------------------------- INSTALL -------------------------
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(APP_SHELL_CACHE);
        // Non far fallire l'installazione se qualche file non è raggiungibile
        await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
        await self.skipWaiting();
    })());
});

// ------------------------- ACTIVATE -------------------------
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Abilita la navigation preload se disponibile
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.enable(); } catch (e) { /* noop */ }
        }
        // Pulisci le vecchie cache versionate (mantieni PREFS_CACHE)
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => {
            if (key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE && key !== PREFS_CACHE) {
                return caches.delete(key);
            }
        }));
        await self.clients.claim();
    })());
});

// ------------------------- FETCH -------------------------
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Non intercettare le chiamate API dinamiche (Firestore, Gemini, auth, ecc.)
    const isApi = /firestore\.googleapis\.com|generativelanguage|identitytoolkit|firebaseinstallations|google-analytics|firebaselogging|firebasedatabase/.test(url.href);
    if (isApi) return; // lascia gestire alla rete

    // Richieste di navigazione: network-first con fallback alla shell offline
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const preload = await event.preloadResponse;
                if (preload) {
                    caches.open(APP_SHELL_CACHE).then((c) => c.put('./', preload.clone())).catch(() => {});
                    return preload;
                }
                const net = await fetch(req);
                // Salva una copia della pagina per la navigazione offline (qualsiasi nome file)
                caches.open(APP_SHELL_CACHE).then((c) => c.put('./', net.clone())).catch(() => {});
                return net;
            } catch (e) {
                const cache = await caches.open(APP_SHELL_CACHE);
                return (await cache.match('./')) || (await cache.match(req)) || (await cache.match('./index.html')) || Response.error();
            }
        })());
        return;
    }

    // Asset statici / CDN: cache-first con aggiornamento in background (stale-while-revalidate)
    event.respondWith((async () => {
        const cached = await caches.match(req);
        const network = fetch(req).then((res) => {
            if (res && (res.ok || res.type === 'opaque')) {
                caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, res.clone())).catch(() => {});
            }
            return res;
        }).catch(() => null);
        return cached || (await network) || Response.error();
    })());
});

// ------------------------- PREFERENZE (storage nel SW) -------------------------
async function prefsGet(key, fallback) {
    try {
        const cache = await caches.open(PREFS_CACHE);
        const res = await cache.match('https://koda.local/' + key);
        if (!res) return fallback;
        return await res.json();
    } catch (e) { return fallback; }
}
async function prefsSet(key, value) {
    try {
        const cache = await caches.open(PREFS_CACHE);
        await cache.put('https://koda.local/' + key, new Response(JSON.stringify(value), {
            headers: { 'Content-Type': 'application/json' }
        }));
    } catch (e) { /* noop */ }
}

// ------------------------- MESSAGGI DALLA PAGINA -------------------------
self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'koda-notif-prefs') {
        event.waitUntil(prefsSet('prefs', data.prefs || {}));
    } else if (data.type === 'koda-check-now') {
        event.waitUntil(checkForContentUpdates());
    } else if (data.type === 'koda-skip-waiting') {
        self.skipWaiting();
    }
});

// ------------------------- PERIODIC BACKGROUND SYNC -------------------------
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'koda-content-check') {
        event.waitUntil(checkForContentUpdates());
    }
});

// Fallback: Background Sync una tantum
self.addEventListener('sync', (event) => {
    if (event.tag === 'koda-content-check-once') {
        event.waitUntil(checkForContentUpdates());
    }
});

// ------------------------- CONTROLLO AGGIORNAMENTI CATALOGHI -------------------------
async function fetchCollectionLatest(projectId, apiKey, collection, tsFields) {
    try {
        const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}`;
        const url = `${base}?pageSize=300${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
        const res = await fetch(url);
        if (!res.ok) return { count: 0, max: 0 };
        const data = await res.json();
        const docs = data.documents || [];
        let max = 0;
        for (const d of docs) {
            const f = d.fields || {};
            for (const field of tsFields) {
                const v = f[field];
                if (v && v.timestampValue) {
                    const ms = Date.parse(v.timestampValue);
                    if (ms > max) max = ms;
                }
            }
        }
        return { count: docs.length, max };
    } catch (e) {
        return { count: 0, max: 0 };
    }
}

async function setBadgeSafe(total) {
    try {
        if (total > 0 && self.navigator && self.navigator.setAppBadge) {
            await self.navigator.setAppBadge(total);
        } else if (self.navigator && self.navigator.clearAppBadge) {
            await self.navigator.clearAppBadge();
        }
    } catch (e) { /* noop */ }
}

async function checkForContentUpdates() {
    const prefs = await prefsGet('prefs', null);
    if (!prefs || !prefs.enabled) return;

    const projectId = prefs.projectId;
    const apiKey = prefs.apiKey;
    if (!projectId) return;

    const categories = [
        { on: prefs.video, collection: 'videos', tsFields: ['createdAt'], key: 'last-videos', titleIt: 'Nuovi video 🎬', titleEn: 'New videos 🎬', bodyIt: (n) => `${n} nuovi contenuti nel catalogo video`, bodyEn: (n) => `${n} new items in the video catalog`, tag: 'koda-video', url: '#cinema' },
        { on: prefs.ai, collection: 'tools', tsFields: ['createdAt', 'timestamp'], key: 'last-tools', titleIt: 'Nuovi strumenti AI 🤖', titleEn: 'New AI tools 🤖', bodyIt: (n) => `${n} nuovi strumenti AI disponibili`, bodyEn: (n) => `${n} new AI tools available`, tag: 'koda-ai', url: '#explore' },
        { on: prefs.news, collection: 'news', tsFields: ['timestamp'], key: 'last-news', titleIt: 'Nuove notizie 📰', titleEn: 'Fresh news 📰', bodyIt: (n) => `${n} nuove notizie da leggere`, bodyEn: (n) => `${n} new stories to read`, tag: 'koda-news', url: '#news' }
    ];

    const isIT = (prefs.lang || 'it') === 'it';
    let badgeTotal = 0;

    for (const cat of categories) {
        if (!cat.on) continue;
        const { count, max } = await fetchCollectionLatest(projectId, apiKey, cat.collection, cat.tsFields);
        const stored = await prefsGet(cat.key, null); // { max, count }
        if (max <= 0) continue;

        if (!stored || !stored.max) {
            // Prima esecuzione: salva il riferimento senza notificare
            await prefsSet(cat.key, { max, count });
            continue;
        }

        if (max > stored.max) {
            const newCount = Math.max(1, count - (stored.count || 0));
            badgeTotal += newCount;
            await self.registration.showNotification(isIT ? cat.titleIt : cat.titleEn, {
                body: isIT ? cat.bodyIt(newCount) : cat.bodyEn(newCount),
                tag: cat.tag,
                renotify: true,
                icon: 'icons/icon-192x192.png',
                badge: 'icons/icon-96x96.png',
                data: { url: cat.url }
            });
            await prefsSet(cat.key, { max, count });
        }
    }

    if (badgeTotal > 0) await setBadgeSafe(badgeTotal);
}

// ------------------------- PUSH (predisposizione futura) -------------------------
self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { body: event.data && event.data.text() }; }
    const title = payload.title || 'Koda AI';
    const options = {
        body: payload.body || '',
        tag: payload.tag || 'koda-push',
        renotify: true,
        icon: 'icons/icon-192x192.png',
        badge: 'icons/icon-96x96.png',
        data: { url: payload.url || '#' }
    };
    event.waitUntil((async () => {
        await self.registration.showNotification(title, options);
        if (payload.badge != null) await setBadgeSafe(payload.badge);
    })());
});

// ------------------------- CLICK SULLA NOTIFICA -------------------------
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetHash = (event.notification.data && event.notification.data.url) || '#';
    event.waitUntil((async () => {
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of allClients) {
            if ('focus' in client) {
                client.postMessage({ type: 'koda-open', url: targetHash });
                return client.focus();
            }
        }
        if (self.clients.openWindow) {
            return self.clients.openWindow('./' + (targetHash.startsWith('#') ? targetHash : ''));
        }
    })());
});
