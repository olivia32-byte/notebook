// Keeps the app shell available offline; notebook data syncs through Firebase's own offline cache.
const CACHE = 'dn-v31';
const SHELL = ['./', './index.html', './app.js', './backend.js', './config.js', './manifest.webmanifest', './icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(x => new Request(x, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // network first so updates arrive at once; fall back to the cached copy when offline.
  // 'no-cache' asks the server every time: GitHub Pages lets browsers keep files for 10 minutes, which
  // could pair a new page with an old app.js right after an update (buttons that show but do nothing).
  e.respondWith(fetch(u.href, { cache: 'no-cache', credentials: 'same-origin' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
