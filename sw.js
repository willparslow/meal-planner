// Service worker: keeps the app itself available with no signal.
// Your data's offline storage is handled separately by Firebase.
// Bump VERSION whenever you change the app files so phones pick up the update.
const VERSION = 'meal-planner-v1';
const SHELL = [
  './', './index.html', './app.js', './styles.css', './seed.js', './firebase-config.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Pre-fetch the Firebase libraries so the very first offline open works
    try {
      // (service workers can't import modules, so read the version out of the config file's text)
      const text = await (await fetch('./firebase-config.js')).text();
      const version = text.match(/FIREBASE_VERSION\s*=\s*['"]([^'"]+)/)?.[1];
      const configured = !/firebaseConfig\s*=\s*null/.test(text);
      if (version && configured) {
        await cache.addAll(['firebase-app.js', 'firebase-firestore.js', 'firebase-auth.js'].map((f) => `${FIREBASE_CDN}${version}/${f}`));
      }
    } catch { /* fetched and cached on first use instead */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Stale-while-revalidate: answer instantly from the cache (no waiting on weak signal),
// then refresh the cache in the background when there is signal.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !req.url.startsWith(FIREBASE_CDN)) return; // leave Firestore/Auth traffic alone

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
