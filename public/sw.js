const CACHE_VERSION = 'utilitarios-dc-v1'
const CORE_CACHE = `${CACHE_VERSION}-core`
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/drogaria-center-logo.png',
  '/oferta-background.png',
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
  '/pwa/maskable-512.png',
  '/pwa/apple-touch-icon.png',
  '/pwa/favicon-32.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CORE_CACHE).then((cache) => Promise.all(CORE_ASSETS.map((asset) => cache.add(asset).catch(() => null)))).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => ![CORE_CACHE, RUNTIME_CACHE].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone()
      caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy))
      return response
    }).catch(async () => (await caches.match(request)) || (await caches.match('/index.html')) || (await caches.match('/'))))
    return
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response || response.status !== 200 || response.type === 'opaque') return response
    const copy = response.clone()
    caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy))
    return response
  })))
})
