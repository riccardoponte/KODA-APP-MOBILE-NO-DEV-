const CACHE_NAME = 'koda-ai-cache-v1';
const urlsToCache = [
    '/',
    '/index.html',
    // Aggiungi qui file statici importanti se ne hai
    // Esempio: '/style.css', '/app.js', '/fonts/Inter-Regular.ttf'
    // Per ora, lasciamo solo i file principali.
];

// Evento di installazione: apre la cache e aggiunge i file principali.
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Cache aperta');
                return cache.addAll(urlsToCache);
            })
    );
});

// Evento di fetch: intercetta le richieste di rete.
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Se la risorsa è in cache, la restituisce.
                if (response) {
                    return response;
                }
                // Altrimenti, effettua la richiesta di rete.
                return fetch(event.request);
            })
    );
});

// Evento di attivazione: pulisce le vecchie cache.
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
