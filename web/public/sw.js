// nuthatch's service worker, for installing it as an app (PWA). It keeps
// only the interface's own files: the hashed scripts and styles under
// assets/, which never change, and the icons. Pages and everything under
// api/ always go to the server, so no monitoring data is kept on the
// device and a new version shows at the next load.
const CACHE = 'nuthatch-files-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const scope = new URL(self.registration.scope).pathname
  const path = url.pathname.slice(scope.length - 1)
  const keep = path.startsWith('/assets/') || /^\/(favicon\.svg|icon-[a-z0-9-]+\.png|apple-touch-icon\.png)$/.test(path)
  if (!keep) return
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const kept = await cache.match(request)
      if (kept) return kept
      const response = await fetch(request)
      if (response.ok) cache.put(request, response.clone())
      return response
    }),
  )
})
