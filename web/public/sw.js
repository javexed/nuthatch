// nuthatch's service worker, for installing it as an app (PWA). It keeps
// only the interface's own files: the hashed scripts and styles under
// assets/, which never change, and the icons. Pages and everything under
// api/ always go to the server, so no monitoring data is kept on the
// device and a new version shows at the next load.
// v2: v1 may hold index.html kept as a script that was gone.
const CACHE = 'nuthatch-files-v2'

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
  const keep = path.startsWith('/assets/') || /^\/(favicon\.svg|logo\.svg|icon-[a-z0-9-]+\.png|apple-touch-icon\.png)$/.test(path)
  if (!keep) return
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const kept = await cache.match(request)
      if (kept) return kept
      const response = await fetch(request)
      // Only the file itself: never an error, nor a page in its place.
      const type = response.headers.get('content-type') ?? ''
      if (response.ok && response.status === 200 && !type.startsWith('text/html')) cache.put(request, response.clone())
      return response
    }),
  )
})

// A notification pushed by the server (server/src/push.ts): shown, and a
// tap opens the host or service it is about.
self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    // Not ours.
  }
  const title = typeof message.title === 'string' ? message.title : 'nuthatch'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === 'string' ? message.body : '',
      tag: typeof message.tag === 'string' ? message.tag : undefined,
      renotify: typeof message.tag === 'string',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: typeof message.url === 'string' ? message.url : '' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // Only ever a page of this interface.
  const target = new URL(String(event.notification.data?.url ?? '').replace(/^\/+/, ''), self.registration.scope)
  if (target.origin !== self.location.origin) return
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.registration.scope))
      if (open) return open.focus().then((w) => (w && 'navigate' in w ? w.navigate(target.href) : undefined))
      return self.clients.openWindow(target.href)
    }),
  )
})
