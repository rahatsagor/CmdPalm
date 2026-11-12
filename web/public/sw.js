// Network first: the page always comes from the Mac when it is reachable, so
// a CmdPalm update on the Mac is picked up immediately. The cached copy only
// opens the app (and its "can't reach your Mac" screen) when the Mac is off
// or slow to answer. Without a complete cached copy, a small offline page
// stands in, so the app never opens to a blank screen.
const CACHE = 'cmdpalm-shell'
const OFFLINE = '/offline.html'
const ROOT = '/'
// Populated by Vite during production builds with every emitted /assets/* chunk,
// so lazily loaded views and sheets still open if connectivity drops mid-session.
const PRECACHE_ASSETS = []

const assetsOf = (html) => Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g), (m) => m[1])

async function ensureCached(cache, paths) {
  await Promise.all(
    paths.map(async (path) => {
      if (!(await cache.match(path))) await cache.add(path)
    }),
  )
}

// Serialize shell publications and asset pruning across install and concurrent
// navigations, and drop navigations superseded by a newer one.
let shellEpoch = 0
let shellQueue = Promise.resolve()

function enqueueShell(work) {
  const next = shellQueue.then(work, work)
  shellQueue = next.catch(() => {})
  return next
}

async function publishShell(cache, response, epoch) {
  if (epoch !== shellEpoch) return
  const html = await response.clone().text()
  const previous = await cache.match(ROOT)
  const entryAssets = assetsOf(html)
  // Cache the new page's entry assets before replacing ROOT or pruning old
  // assets, so a dropped connection mid-update leaves the previous complete
  // shell intact instead of falling back to offline.html.
  await ensureCached(cache, entryAssets)
  if (epoch !== shellEpoch) return
  await cache.put(ROOT, response)
  const matchesBuild = PRECACHE_ASSETS.length && entryAssets.every((p) => PRECACHE_ASSETS.includes(p))
  if (matchesBuild) await ensureCached(cache, PRECACHE_ASSETS).catch(() => {})
  if (epoch !== shellEpoch) return
  const keep = new Set(matchesBuild ? [...entryAssets, ...PRECACHE_ASSETS] : entryAssets)
  if (previous && (await previous.text()) !== html) {
    for (const key of await cache.keys()) {
      const path = new URL(key.url).pathname
      if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(key)
    }
  }
}

// The page first loads before this worker controls it, so its files were
// never cached. Fetch them now, for the first time the Mac is unreachable.
async function precache() {
  const cache = await caches.open(CACHE)
  await cache.addAll([OFFLINE, '/icon.svg'])
  await ensureCached(cache, ['/manifest.webmanifest', '/voice-worklet.js', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']).catch(() => {})
  const epoch = shellEpoch
  const response = await fetch(ROOT, { cache: 'no-store' })
  if (!response.ok) return
  await enqueueShell(() => publishShell(cache, response, epoch))
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(precache().catch(() => {}))
})
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Every build has new hashed asset names. Navigation responses are stored under
// the single canonical `/` key so query strings or client-side paths never leave
// stale HTML entries pointing at pruned assets.
async function store(request, response, epoch) {
  const cache = await caches.open(CACHE)
  if (request.mode !== 'navigate') return cache.put(request, response)
  return enqueueShell(() => publishShell(cache, response, epoch))
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
  if (request.mode !== 'navigate') return caches.match(request)
  const page = await caches.match(ROOT)
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
  const epoch = request.mode === 'navigate' ? ++shellEpoch : shellEpoch
  const network = fetch(request).then((response) => {
    if (response.ok) event.waitUntil(store(request, response.clone(), epoch).catch(() => {}))
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
