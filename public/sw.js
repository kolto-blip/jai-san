// Сервис-воркер: приложение открывается быстро и без интернета показывает понятный экран.
// Материалы, файлы, фото и ответы НЕ кешируются — они всегда идут через сервер с проверкой доступа.
const CACHE = 'matematika-v1';
const SHELL = [
  '/offline.html', '/style.css', '/common.js', '/app.js', '/favicon.svg', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/apple-touch-icon.png',
  '/fonts/nunito-latin-wght-normal.woff2', '/fonts/nunito-cyrillic-wght-normal.woff2', '/fonts/nunito-cyrillic-ext-wght-normal.woff2',
];
const PRIVATE = /^\/(api|f|hw|print|k)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || PRIVATE.test(url.pathname)) return;

  // страницы: всегда свежие с сервера, без интернета — экран «нет связи»
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // шрифты и иконки не меняются — из кеша
  if (/^\/(fonts|icons)\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => put(req, res))));
    return;
  }
  // стили и скрипты: сначала сервер (чтобы обновления приходили сразу), без интернета — кеш
  e.respondWith(fetch(req).then((res) => put(req, res)).catch(() => caches.match(req)));
});

function put(req, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}
