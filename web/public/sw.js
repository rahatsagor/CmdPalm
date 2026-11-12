// Network first: the page always comes from the Mac when it is reachable, so
// a CmdPalm update on the Mac is picked up immediately. The cached copy only
// opens the app (and its "can't reach your Mac" screen) when the Mac is off
// or slow to answer. Without a complete cached copy, a small offline page
// stands in, so the app never opens to a blank screen.
const STATIC_CACHE = 'cmdpalm-static'
const SHELL_PREFIX = 'cmdpalm-shell-'
const LEGACY_CACHE = 'cmdpalm-shell'
const ORDER_CHANNEL = 'cmdpalm-shell-order'
const MAX_SHELL_CACHES = 3
const OFFLINE = '/offline.html'
const ROOT = '/'
const SHELL_META = '/__cmdpalm_shell_meta__'
// Populated by Vite during production builds with every emitted /assets/* chunk,
// so lazily loaded views and sheets still open if connectivity drops mid-session.
const PRECACHE_ASSETS = []

const assetsOf = (html) => Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g), (m) => m[1])

function fnv1a(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function shellCacheName(html, entryAssets) {
  return `${SHELL_PREFIX}${fnv1a(entryAssets.length ? entryAssets.join('\n') : html)}`
}

async function ensureCached(cache, paths) {
  await Promise.all(
    paths.map(async (path) => {
      if (!(await cache.match(path))) await cache.add(path)
    }),
  )
}

// Lamport clock synchronized across worker instances via BroadcastChannel (and
// hydrated from CacheStorage when a sleeping worker wakes up), so request-start
// order is assigned synchronously before any async cache or network I/O begins.
let latestStartOrder = 0
const orderChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(ORDER_CHANNEL) : null
if (orderChannel) {
  orderChannel.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (typeof data.order === 'number' && Number.isFinite(data.order) && data.order > latestStartOrder) {
      latestStartOrder = data.order
    }
    if (data.sync === true && latestStartOrder > 0) {
      orderChannel.postMessage({ order: latestStartOrder })
    }
  })
  // Ask any already-running worker instance for its latest order immediately on boot.
  orderChannel.postMessage({ sync: true })
}

function wallMicros() {
  if (typeof performance === 'object' && performance && typeof performance.now === 'function' && Number.isFinite(performance.timeOrigin)) {
    return Math.floor((performance.timeOrigin + performance.now()) * 1000)
  }
  return Date.now() * 1000
}

/** Allocate a strictly monotonic request-start order synchronously, before any await. */
function allocateStartOrder() {
  latestStartOrder = Math.max(wallMicros(), latestStartOrder + 1)
  const order = latestStartOrder
  if (orderChannel) orderChannel.postMessage({ order })
  return order
}

let shellEpoch = 0
let latestNavigationOrder = 0
let shellQueue = Promise.resolve()

if (orderChannel) {
  orderChannel.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'navigate' && typeof data.order === 'number' && data.order > latestNavigationOrder) {
      latestNavigationOrder = data.order
    }
  })
}

function enqueueShell(work) {
  const next = shellQueue.then(work, work)
  shellQueue = next.catch(() => {})
  return next
}

async function allCacheNames() {
  return typeof caches.keys === 'function' ? await caches.keys() : []
}

async function shellCaches() {
  return (await allCacheNames()).filter((name) => name.startsWith(SHELL_PREFIX))
}

async function readMeta(cache) {
  const meta = await cache.match(SHELL_META)
  if (!meta) return { startedAt: 0, updatedAt: 0 }
  const raw = await meta.text()
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const startedAt = Number.isFinite(parsed.startedAt) ? parsed.startedAt : 0
      if (startedAt > latestStartOrder) latestStartOrder = startedAt
      return {
        startedAt,
        updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
      }
    }
  } catch {
    // Older numeric metadata format.
  }
  const fallback = Number(raw)
  const scaled = Number.isFinite(fallback) ? fallback * 1000 : 0
  if (scaled > latestStartOrder) latestStartOrder = scaled
  return { startedAt: scaled, updatedAt: Number.isFinite(fallback) ? fallback : 0 }
}

async function hydrateOrderFromStorage() {
  const staticCache = await caches.open(STATIC_CACHE)
  await readMeta(staticCache)
  for (const name of await shellCaches()) {
    const cache = await caches.open(name)
    await readMeta(cache)
  }
}

async function writeMeta(cache, startedAt) {
  const current = await readMeta(cache)
  const next = {
    startedAt: Math.max(startedAt, current.startedAt),
    updatedAt: Math.max(Date.now(), current.updatedAt),
  }
  if (next.startedAt > latestStartOrder) latestStartOrder = next.startedAt
  await cache.put(SHELL_META, new Response(JSON.stringify(next)))
}

// Hydrate `latestStartOrder` on worker startup in case all previous workers had closed.
const hydration = hydrateOrderFromStorage().catch(() => {})

/** Check whether `page` has every entry asset inside `cache`. */
async function completeIn(cache, page) {
  for (const path of assetsOf(await page.clone().text())) {
    if (!(await cache.match(path))) return false
  }
  return true
}

/** Return the newest complete shell across per-build caches, falling back to a complete legacy shell if present. */
async function newestCompleteShell() {
  let bestPage = null
  let bestOrder = -1
  for (const name of await shellCaches()) {
    const cache = await caches.open(name)
    const page = await cache.match(ROOT)
    if (!page || !(await completeIn(cache, page))) continue
    const { startedAt } = await readMeta(cache)
    if (startedAt >= bestOrder) {
      bestOrder = startedAt
      bestPage = page
    }
  }
  if (bestPage) return bestPage
  if ((await allCacheNames()).includes(LEGACY_CACHE)) {
    const legacy = await caches.open(LEGACY_CACHE)
    const page = await legacy.match(ROOT)
    if (page && (await completeIn(legacy, page))) return page
  }
  return null
}

/** Keep at most MAX_SHELL_CACHES complete build caches, deleting LEGACY_CACHE only once a complete replacement exists. */
async function pruneShellCaches(keepName) {
  if (typeof caches.delete !== 'function') return
  const names = await shellCaches()
  const complete = []
  const staleIncomplete = []
  const now = Date.now()
  for (const name of names) {
    const cache = await caches.open(name)
    const { startedAt, updatedAt } = await readMeta(cache)
    const page = await cache.match(ROOT)
    if (page && (await completeIn(cache, page))) {
      complete.push({ name, startedAt })
    } else if (name !== keepName && updatedAt > 0 && now - updatedAt > 60_000) {
      staleIncomplete.push(name)
    }
  }
  // Never discard the pre-upgrade legacy shell until at least one complete per-build shell is ready.
  if (complete.length > 0) {
    await caches.delete(LEGACY_CACHE).catch(() => {})
  }
  for (const name of staleIncomplete) {
    await caches.delete(name).catch(() => {})
  }
  complete.sort((a, b) => b.startedAt - a.startedAt)
  const keep = new Set(complete.slice(0, MAX_SHELL_CACHES).map((c) => c.name))
  if (keepName) keep.add(keepName)
  for (const entry of complete.slice(MAX_SHELL_CACHES)) {
    if (!keep.has(entry.name)) await caches.delete(entry.name).catch(() => {})
  }
  // Prune any loose /assets/* entries in STATIC_CACHE once a complete build owns PRECACHE_ASSETS.
  const newestName = complete[0]?.name
  if (newestName) {
    const newestCache = await caches.open(newestName)
    const newestPage = await newestCache.match(ROOT)
    const newestHtml = newestPage ? await newestPage.text() : ''
    const newestEntries = assetsOf(newestHtml)
    if (PRECACHE_ASSETS.length && newestEntries.every((p) => PRECACHE_ASSETS.includes(p))) {
      const keepStaticAssets = new Set([...newestEntries, ...PRECACHE_ASSETS])
      const staticCache = await caches.open(STATIC_CACHE)
      for (const req of await staticCache.keys()) {
        const path = new URL(req.url).pathname
        if (path.startsWith('/assets/') && !keepStaticAssets.has(path)) await staticCache.delete(req)
      }
    }
  }
}

async function publishShell(response, html, epoch, startedAt) {
  if (epoch !== shellEpoch || startedAt < latestNavigationOrder) return
  const entryAssets = assetsOf(html)
  const name = shellCacheName(html, entryAssets)
  const cache = await caches.open(name)
  // Mark this cache active for stale-incomplete protection only after verifying
  // this navigation has not been superseded.
  await writeMeta(cache, startedAt)
  // Populate all entry assets inside this build's own isolated cache before
  // publishing ROOT, so neither overlapping navigations nor another worker
  // instance can overwrite or delete a sibling build's files.
  await ensureCached(cache, entryAssets)
  if (epoch !== shellEpoch || startedAt < latestNavigationOrder) return
  await writeMeta(cache, startedAt)
  await cache.put(ROOT, response)
  const staticCache = await caches.open(STATIC_CACHE)
  await writeMeta(staticCache, startedAt)
  const matchesBuild = PRECACHE_ASSETS.length && entryAssets.every((p) => PRECACHE_ASSETS.includes(p))
  if (matchesBuild) await ensureCached(cache, PRECACHE_ASSETS).catch(() => {})
  await pruneShellCaches(name)
}

// The page first loads before this worker controls it, so its files were
// never cached. Fetch them now, for the first time the Mac is unreachable.
async function precache() {
  const epoch = shellEpoch
  const staticCache = await caches.open(STATIC_CACHE)
  await staticCache.addAll([OFFLINE, '/icon.svg'])
  await ensureCached(staticCache, ['/manifest.webmanifest', '/voice-worklet.js', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']).catch(() => {})
  await hydration
  const startedAt = allocateStartOrder()
  const response = await fetch(ROOT, { cache: 'no-store' })
  if (!response.ok || epoch !== shellEpoch) return
  const html = await response.clone().text()
  if (epoch !== shellEpoch) return
  await enqueueShell(() => publishShell(response, html, epoch, startedAt))
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(precache().catch(() => {}))
})
self.addEventListener('activate', (event) =>
  event.waitUntil(
    Promise.all([self.clients.claim(), pruneShellCaches()]).catch(() => {}),
  ),
)

async function store(request, response, epoch, startedAt) {
  if (request.mode === 'navigate') {
    if (epoch !== shellEpoch) return
    // Read the body before taking the serial publication lock so a slow-streaming
    // older navigation cannot hold shellQueue and block a newer navigation behind it.
    const html = await response.clone().text()
    if (epoch !== shellEpoch) return
    return enqueueShell(() => publishShell(response, html, epoch, startedAt))
  }
  const staticCache = await caches.open(STATIC_CACHE)
  return staticCache.put(request, response)
}

// A Mac that is asleep or on weak Wi-Fi can leave a request hanging; the
// cached page opens instead and the late response still refreshes the cache.
const NAVIGATION_TIMEOUT_MS = 3000

async function cachedCopy(request) {
  if (request.mode !== 'navigate') return caches.match(request)
  const page = await newestCompleteShell()
  if (page) return page
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
  let startedAt = 0
  if (request.mode === 'navigate') {
    startedAt = allocateStartOrder()
    latestNavigationOrder = Math.max(latestNavigationOrder, startedAt)
    if (orderChannel) orderChannel.postMessage({ kind: 'navigate', order: startedAt })
  }
  const network = fetch(request).then((response) => {
    if (response.ok) event.waitUntil(store(request, response.clone(), epoch, startedAt).catch(() => {}))
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
