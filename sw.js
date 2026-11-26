const SHELL_CACHE = 'reviso-shell-v13';
const CDN_CACHE = 'reviso-cdn-v13';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './reviso-icon.svg'];
const CDN_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'tessdata.projectnaptha.com'
]);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('reviso-') && ![SHELL_CACHE, CDN_CACHE].includes(key))
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin === self.location.origin
    && (url.pathname === '/api/supabase' || url.pathname.startsWith('/api/supabase/'))) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (url.hostname === 'supabase.co' || url.hostname.endsWith('.supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (request.method !== 'GET') return;

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(
        fetch(request).catch(() => caches.match('./index.html'))
      );
      return;
    }
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  if (!CDN_HOSTS.has(url.hostname)) return;
  event.respondWith(
    caches.open(CDN_CACHE).then(async cache => {
      try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
    })
  );
});
