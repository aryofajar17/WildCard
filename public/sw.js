// Service worker UNO Chips — cache hanya cadangan offline (network-first)
// Network-first supaya update kode langsung terpakai saat online; kalau offline,
// barulah cache dipakai (mode vs bot tetap jalan tanpa internet).
const CACHE = 'uno-chips-v3';
const ASSETS = [
  '/', '/index.html', '/css/style.css', '/js/app.js',
  '/shared/uno.js', '/shared/bot.js', '/icon.svg', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Coba jaringan dulu; gagal (offline) -> pakai cache
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() =>
      caches.match(e.request).then((hit) => hit || caches.match('/index.html')),
    ),
  );
});
