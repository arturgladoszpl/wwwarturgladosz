// Licznik punktów i Płytki bez internetu: pliki zapisane w telefonie.
// Najpierw sieć (żeby zawsze była najnowsza wersja), a gdy jej nie ma – kopia z telefonu.
// Zapytania do /api/ (gry online) zawsze idą do sieci.

const CACHE = 'punkty-v1';
const FILES = [
  '/punkty/', '/punkty/ekran.js', '/punkty/nosleep.min.js', '/punkty/manifest.webmanifest',
  '/punkty/icon-192.png', '/punkty/icon-512.png', '/punkty/apple-touch-icon.png',
  '/punkty/vendor/qrcode.min.js', '/punkty/vendor/jsqr.min.js',
  '/punkty/plytki/', '/punkty/plytki/rules.js', '/punkty/plytki/engine.js', '/punkty/plytki/bot.js', '/punkty/plytki/wifi.js',
];
// Czcionki i biblioteki z zewnątrz: zapisujemy przy pierwszym użyciu.
const EXTERNAL = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Sieć z limitem czasu: w hotspocie bez internetu zapytanie potrafi długo wisieć.
function fromNetwork(req, ms) {
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('timeout')), ms);
    fetch(req).then(r => { clearTimeout(t); ok(r); }, err => { clearTimeout(t); no(err); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (EXTERNAL.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    })));
    return;
  }
  if (url.origin !== location.origin || !url.pathname.startsWith('/punkty/') || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fromNetwork(req, 4000).then(r => {
      if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? url.pathname : req, copy)); }
      return r;
    }).catch(async () => {
      // Strony z parametrami (?solo=1, ?wifi=join, ?g=…) to ten sam plik.
      const hit = await caches.match(req.mode === 'navigate' ? url.pathname : req, { ignoreSearch: req.mode === 'navigate' });
      return hit || (await caches.match(url.pathname, { ignoreSearch: true })) || Response.error();
    })
  );
});
