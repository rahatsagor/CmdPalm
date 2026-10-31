// Network first: the page always comes from the Mac when it is reachable, so
// a CmdPalm update on the Mac is picked up immediately. The cached copy only
// opens the app (and its "can't reach your Mac" screen) when the Mac is off
// or slow to answer. Without a complete cached copy, a small offline page
// stands in, so the app never opens to a blank screen.
const CACHE = 'cmdpalm-shell'
const OFFLINE = '/offline.html'

const assetsOf = (html) => Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g), (m) => m[1])

// The page first loads before this worker controls it, so its files were
// never cached. Fetch them now, for the first time the Mac is unreachable.
async function precache() {
  const cache = await caches.open(CACHE)
  await cache.addAll([OFFLINE, '/icon.svg'])
  const response = await fetch('/', { cache: 'no-store' })
  if (!response.ok) return
  const html = await response.clone().text()
  await Promise.all(assetsOf(html).map(async (path) => (await cache.match(path)) || cache.add(path)))
  await cache.put('/', response)
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(precache().catch(() => {}))
})
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Every build has new hashed asset names. When the page itself changes, drop
// the previous build's assets; this build's lazy chunks are cached again as
// they load.
async function store(request, response) {
  const cache = await caches.open(CACHE)
  if (request.mode !== 'navigate') return cache.put(request, response)
  const html = await response.clone().text()
  const previous = await cache.match(request)
  await cache.put(request, response)
  if (!previous || (await previous.text()) === html) return
  const keep = new Set(assetsOf(html))
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname
    if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(key)
  }
}

// A Mac that is asleep or on weak Wi-Fi can leave a request hanging; the
// cached page opens instead and the late response still refreshes the cache.
const NAVIGATION_TIMEOUT_MS = 3000

/** A cached page is only useful with every file it loads. */
async function complete(page) {
  for (const path of assetsOf(await page.clone().text())) if (!(await caches.match(path))) return false
  return true
}

async function cachedCopy(request) {
  const cached = await caches.match(request)
  if (request.mode !== 'navigate') return cached
  const page = cached ?? (await caches.match('/'))
  if (page && (await complete(page))) return page
  return caches.match(OFFLINE)
}

async function respond(event) {
  const request = event.request
  // Built files have hashed names and never change, and a cached page opened
  // while the Mac is unreachable would otherwise wait on each of them.
  if (new URL(request.url).pathname.startsWith('/assets/')) {
    const cached = await caches.match(request)
    if (cached) return cached
  }
  const network = fetch(request).then((response) => {
    if (response.ok) event.waitUntil(store(request, response.clone()).catch(() => {}))
    return response
  })
  try {
    if (request.mode === 'navigate') {
      const timedOut = Symbol('timeout')
      const first = await Promise.race([network, new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, timedOut))])
      if (first !== timedOut) return first
      const cached = await cachedCopy(request)
      if (!cached) return await network
      event.waitUntil(network.catch(() => {}))
      return cached
    }
    const response = await network
    // A page from before a Mac update asks for files the new build doesn't have.
    if (!response.ok && new URL(request.url).pathname.startsWith('/assets/')) return (await caches.match(request)) ?? response
    return response
  } catch {
    return (await cachedCopy(request)) ?? Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/cmdpalm.crt') return
  event.respondWith(respond(event))
})
