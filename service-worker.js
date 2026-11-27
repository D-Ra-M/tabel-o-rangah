/*
 * Service worker «Табеля о рангах».
 * ВАЖНО: при изменении любого файла из APP_SHELL увеличивайте VERSION —
 * старый кэш удаляется при активации новой версии.
 */
const VERSION = 'v14';
const CACHE_BASE = 'tabel-o-rangah';       // прежние версии использовали имя без суффикса
const CACHE_NAME = CACHE_BASE + '-' + VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/logic.js',
  './js/storage.js',
  './js/ui.js',
  './js/photo.js',
  './js/xlsx.js',
  './js/app.js',
  './js/pwa.js',
  './vendor/sortable.min.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => (key === CACHE_BASE || key.startsWith(CACHE_BASE + '-')) && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isAppPage(url) {
  const scope = new URL(self.registration.scope);
  return url.origin === scope.origin && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html');
}

async function putInCache(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}

// Страницы: сначала сеть (свежая версия), без сети — копия из кэша.
async function handleNavigation(request) {
  const url = new URL(request.url);
  try {
    const response = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (isAppPage(url) && response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put('./index.html', copy);
    } else if (response.ok) {
      putInCache(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request.url);
    if (cached) return cached;
    if (isAppPage(url)) {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}

// Код и стили приложения: сначала сеть с проверкой актуальности, без сети — кэш.
async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    putInCache(request, response.clone());
    return response;
  } catch (error) {
    return (await caches.match(request)) || Response.error();
  }
}

// Библиотеки и иконки меняются только вместе с VERSION: сначала кэш.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    putInCache(request, response.clone());
    return response;
  } catch (error) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (/\/(vendor|icons)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
