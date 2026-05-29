const VERSION = 'shuku-pwa-v0.4.0';
const SHELL_CACHE = `${VERSION}-app-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const PRIVATE_COVER_CACHE = `${VERSION}-private-cover`;
const PRIVATE_API_CACHE = `${VERSION}-private-api`;
const SHELL_URLS = ['/offline', '/mobile', '/manifest.webmanifest', '/icons/icon-192.svg', '/icons/icon-512.svg', '/icons/maskable-512.svg'];
const PRIVATE_CACHES = [PRIVATE_COVER_CACHE, PRIVATE_API_CACHE];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isSensitiveApi(pathname) {
  return pathname.startsWith('/api/auth/')
    || pathname === '/api/auth/me'
    || pathname.includes('/permissions')
    || pathname.includes('/token');
}

function isLargeReaderPayload(pathname) {
  return /\/api\/books\/[^/]+\/file$/.test(pathname)
    || /\/api\/books\/[^/]+\/pages\/[^/]+$/.test(pathname)
    || /\.(cbz|zip|epub|pdf)$/i.test(pathname);
}

function isStaticAsset(pathname) {
  return pathname.startsWith('/_next/static/')
    || pathname.startsWith('/icons/')
    || pathname === '/manifest.webmanifest'
    || /\.(css|js|woff2?|ttf|otf|svg)$/i.test(pathname);
}

function isCoverRequest(pathname) {
  return /\/api\/books\/[^/]+\/cover(\/|$)/.test(pathname);
}

function shouldBypass(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return true;
  if (!isSameOrigin(url)) return true;
  if (isSensitiveApi(url.pathname)) return true;
  if (isLargeReaderPayload(url.pathname)) return true;
  if (/\.(cbz|zip|epub|pdf)$/i.test(url.pathname)) return true;
  return false;
}

function offlineApiResponse() {
  return new Response(JSON.stringify({ ok: false, error: { code: 'OFFLINE', message: '当前离线，稍后重试' } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirstPage(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    return await fetch(request);
  } catch {
    return (await cache.match(request)) || (await cache.match('/offline')) || Response.error();
  }
}

async function networkFirstApi(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const url = new URL(request.url);
      if (!isSensitiveApi(url.pathname) && !isLargeReaderPayload(url.pathname)) {
        const cache = await caches.open(PRIVATE_API_CACHE);
        cache.put(request, response.clone());
      }
    }
    return response;
  } catch {
    return offlineApiResponse();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  return cached || refresh;
}

async function clearPrivateCaches() {
  await Promise.all(PRIVATE_CACHES.map((cacheName) => caches.delete(cacheName)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (shouldBypass(event.request)) return;

  const url = new URL(event.request.url);
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }
  if (isCoverRequest(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event.request, PRIVATE_COVER_CACHE));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(event.request));
    return;
  }
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstPage(event.request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_PRIVATE_CACHES') {
    event.waitUntil(clearPrivateCaches());
  }
});
