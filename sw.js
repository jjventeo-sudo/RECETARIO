/* Service worker: guarda la app para que funcione sin conexión.
   Al publicar cambios, sube el número de CACHE para que los móviles se actualicen. */
const CACHE = 'recetario-v1.0.1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './fflate.js',
  './fraunces.woff2',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Pantallas: siempre la app guardada (funciona sin conexión)
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('./index.html').then((r) => r || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
