// Network first: the page always comes from the Mac when it is reachable, so
// a CmdPalm update on the Mac is picked up immediately. The cached copy only
// opens the app (and its "can't reach your Mac" screen) when the Mac is off
// or slow to answer. Without a complete cached copy, a small offline page
// stands in, so the app never opens to a blank screen.
const STATIC_CACHE = 'cmdpalm-static'
const SHELL_PREFIX = 'cmdpalm-shell-'
const LEGACY_CACHE = 'cmdpalm-shell'
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

let shellEpoch = 0
let shellQueue = Promise.resolve()

function enqueueShell(work) {
  const next = shellQueue.then(work, work)
  shellQueue = next.catch(() => {})
  return next
}

async function shellCaches() {
  if (typeof caches.keys !== 'function') return []
  return (await caches.keys()).filter((name) => name.startsWith(SHELL_PREFIX))
}

async function shellTimestamp(cache) {
  const meta = await cache.match(SHELL_META)
  if (!meta) return 0
  const parsed = Number(await meta.text())
  return Number.isFinite(parsed) ? parsed : 0
}

/** Check whether `page` has every entry asset inside its own isolated build cache. */
async function completeIn(cache, page) {
  for (const path of assetsOf(await page.clone().text())) {
    if (!(await cache.match(path))) return false
  }
  return true
}

/** Return the newest complete shell across all per-build caches. */
async function newestCompleteShell() {
  let bestPage = null
  let bestStamp = -1
  for (const name of await shellCaches()) {
    const cache = await caches.open(name)
    const page = await cache.match(ROOT)
    if (!page || !(await completeIn(cache, page))) continue
    const stamp = await shellTimestamp(cache)
    if (stamp >= bestStamp) {
      bestStamp = stamp
      bestPage = page
    }
  }
  return bestPage
}

/** Keep at most MAX_SHELL_CACHES complete build caches so concurrent workers never delete each other's active build. */
async function pruneShellCaches(keepName) {
  if (typeof caches.delete !== 'function') return
  await caches.delete(LEGACY_CACHE).catch(() => {})
  const names = await shellCaches()
  if (names.length <= MAX_SHELL_CACHES) return
  const complete = []
  const staleIncomplete = []
  const now = Date.now()
  for (const name of names) {
    const cache = await caches.open(name)
    const stamp = await shellTimestamp(cache)
    const page = await cache.match(ROOT)
    if (page && (await completeIn(cache, page))) {
      complete.push({ name, stamp })
    } else if (name !== keepName && now - stamp > 60_000) {
      staleIncomplete.push(name)
    }
  }
  for (const name of staleIncomplete) {
    await caches.delete(name).catch(() => {})
  }
  complete.sort((a, b) => b.stamp - a.stamp)
  const keep = new Set(complete.slice(0, MAX_SHELL_CACHES).map((c) => c.name))
  if (keepName) keep.add(keepName)
  for (const entry of complete.slice(MAX_SHELL_CACHES)) {
    if (!keep.has(entry.name)) await caches.delete(entry.name).catch(() => {})
  }
}

async function maxShellTimestamp() {
  let highest = 0
  for (const name of await shellCaches()) {
    const cache = await caches.open(name)
    highest = Math.max(highest, await shellTimestamp(cache))
  }
  return highest
}

async function publishShell(response, epoch, observedAt) {
  if (epoch !== null && epoch !== shellEpoch) return
  const html = await response.clone().text()
  const entryAssets = assetsOf(html)
  const name = shellCacheName(html, entryAssets)
  const cache = await caches.open(name)
  // Populate all entry assets inside this build's own isolated cache before
  // publishing ROOT, so neither overlapping navigations nor another worker
  // instance can overwrite or delete a sibling build's files.
  await ensureCached(cache, entryAssets)
  if (epoch !== null && epoch !== shellEpoch) return
  const existing = await shellTimestamp(cache)
  await cache.put(SHELL_META, new Response(String(Math.max(observedAt, existing))))
  await cache.put(ROOT, response)
  const matchesBuild = PRECACHE_ASSETS.length && entryAssets.every((p) => PRECACHE_ASSETS.includes(p))
  if (matchesBuild) await ensureCached(cache, PRECACHE_ASSETS).catch(() => {})
  await pruneShellCaches(name)
}

// The page first loads before this worker controls it, so its files were
// never cached. Fetch them now, for the first time the Mac is unreachable.
async function precache() {
  const staticCache = await caches.open(STATIC_CACHE)
  await staticCache.addAll([OFFLINE, '/icon.svg'])
  await ensureCached(staticCache, ['/manifest.webmanifest', '/voice-worklet.js', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']).catch(() => {})
  const response = await fetch(ROOT, { cache: 'no-store' })
  if (!response.ok) return
  const html = await response.clone().text()
  const observedAt = Math.max(Date.now(), (await maxShellTimestamp()) + 1)
  const cache = await caches.open(shellCacheName(html, assetsOf(html)))
  const existing = await shellTimestamp(cache)
  await cache.put(SHELL_META, new Response(String(Math.max(observedAt, existing))))
  await enqueueShell(() => publishShell(response, null, observedAt))
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

async function store(request, response, epoch, observedAt) {
  if (request.mode === 'navigate') {
    const html = await response.clone().text()
    const stamp = Math.max(observedAt, (await maxShellTimestamp()) + 1)
    const cache = await caches.open(shellCacheName(html, assetsOf(html)))
    const existing = await shellTimestamp(cache)
    await cache.put(SHELL_META, new Response(String(Math.max(stamp, existing))))
    return enqueueShell(() => publishShell(response, epoch, stamp))
  }
  const path = new URL(request.url).pathname
  if (path.startsWith('/assets/')) {
    const names = await shellCaches()
    const target = names.at(-1) ?? STATIC_CACHE
    const cache = await caches.open(target)
    return cache.put(request, response)
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
  const network = fetch(request).then((response) => {
    if (response.ok) event.waitUntil(store(request, response.clone(), epoch, Date.now()).catch(() => {}))
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
