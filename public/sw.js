const CACHE_VERSION = 'utilitarios-dc-v2'
const CORE_CACHE = `${CACHE_VERSION}-core`
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`
const BASE_PATH = new URL('./', self.location.href).pathname
const appAsset = (path = '') => `${BASE_PATH}${path.replace(/^\/+/, '')}`
const CORE_ASSETS = [
  appAsset(),
  appAsset('index.html'),
  appAsset('manifest.webmanifest'),
  appAsset('drogaria-center-logo.png'),
  appAsset('oferta-background.png'),
  appAsset('pwa/icon-192.png'),
  appAsset('pwa/icon-512.png'),
  appAsset('pwa/maskable-512.png'),
  appAsset('pwa/apple-touch-icon.png'),
  appAsset('pwa/favicon-32.png'),
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
    }).catch(async () => (await caches.match(request)) || (await caches.match(appAsset('index.html'))) || (await caches.match(appAsset()))))
    return
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response || response.status !== 200 || response.type === 'opaque') return response
    const copy = response.clone()
    caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy))
    return response
  })))
})
