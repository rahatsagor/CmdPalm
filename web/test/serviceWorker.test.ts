import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SW_SOURCE = readFileSync(resolve(import.meta.dirname, '../public/sw.js'), 'utf8')

interface StoredEntry {
  url: string
  response: Response
}

class MemoryCache {
  entries: StoredEntry[] = []

  private keyUrl(request: RequestInfo | URL): string {
    if (typeof request === 'string') return new URL(request, 'https://mac.local:8790').href
    if (request instanceof URL) return request.href
    return request.url
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = this.keyUrl(request)
    return this.entries.find((e) => e.url === url)?.response.clone()
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const url = this.keyUrl(request)
    const idx = this.entries.findIndex((e) => e.url === url)
    const stored = { url, response: response.clone() }
    if (idx >= 0) this.entries[idx] = stored
    else this.entries.push(stored)
  }

  async add(request: RequestInfo | URL): Promise<void> {
    const response = await fetch(request)
    if (!response.ok) throw new Error(`Failed to fetch ${String(request)}: ${response.status}`)
    await this.put(request, response)
  }

  async addAll(requests: (RequestInfo | URL)[]): Promise<void> {
    await Promise.all(requests.map((r) => this.add(r)))
  }

  async keys(): Promise<Request[]> {
    return this.entries.map((e) => new Request(e.url))
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const url = this.keyUrl(request)
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.url !== url)
    return this.entries.length !== before
  }
}

class MemoryCacheStorage {
  stores = new Map<string, MemoryCache>()

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name)
    if (!cache) {
      cache = new MemoryCache()
      this.stores.set(name, cache)
    }
    return cache
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(request)
      if (hit) return hit
    }
    return undefined
  }
}

function bootWorker(precacheAssets: string[] = []) {
  const caches = new MemoryCacheStorage()
  const listeners = new Map<string, (event: unknown) => void>()
  const selfObj = {
    location: new URL('https://mac.local:8790/sw.js'),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(() => Promise.resolve()) },
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, handler)
    },
  }
  const code = SW_SOURCE.replace('const PRECACHE_ASSETS = []', `const PRECACHE_ASSETS = ${JSON.stringify(precacheAssets)}`)
  const runner = new Function('self', 'caches', 'location', 'fetch', 'URL', 'Response', 'Request', 'Promise', 'Set', 'Symbol', 'setTimeout', code)
  runner(
    selfObj,
    caches,
    selfObj.location,
    (...args: Parameters<typeof fetch>) => fetch(...args),
    URL,
    Response,
    Request,
    Promise,
    Set,
    Symbol,
    setTimeout,
  )

  async function install() {
    const pending: Promise<unknown>[] = []
    listeners.get('install')?.({ waitUntil: (p: Promise<unknown>) => pending.push(p) })
    await Promise.all(pending)
  }

  async function dispatchFetch(path: string, mode: RequestMode = 'cors'): Promise<{ response: Response; settled: Promise<void> }> {
    const url = new URL(path, 'https://mac.local:8790').href
    const req = new Request(url, mode === 'navigate' ? undefined : { mode })
    if (mode === 'navigate') Object.defineProperty(req, 'mode', { value: 'navigate' })
    let result: Promise<Response> | undefined
    const pending: Promise<unknown>[] = []
    listeners.get('fetch')?.({
      request: req,
      respondWith: (r: Promise<Response> | Response) => {
        result = Promise.resolve(r)
      },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    })
    if (!result) throw new Error(`fetch not handled for ${path}`)
    const response = await result
    return { response, settled: Promise.all(pending).then(() => undefined) }
  }

  return { caches, install, dispatchFetch }
}

beforeEach(() => {
  vi.resetModules()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('service worker offline and update caching', () => {
  it('precaches build-injected lazy chunks and canonicalizes navigation cache keys to /', async () => {
    const v1Html = '<!doctype html><script type="module" src="/assets/index-v1.js"></script><link rel="stylesheet" href="/assets/index-v1.css">'
    const v2Html = '<!doctype html><script type="module" src="/assets/index-v2.js"></script><link rel="stylesheet" href="/assets/index-v2.css">'
    let online = true
    let currentVersion: 'v1' | 'v2' = 'v1'

    const files: Record<string, string> = {
      '/offline.html': '<!doctype html><h1>Offline</h1>',
      '/icon.svg': '<svg></svg>',
      '/manifest.webmanifest': '{}',
      '/voice-worklet.js': '// worklet',
      '/assets/index-v1.js': 'console.log("v1")',
      '/assets/index-v1.css': 'body{}',
      '/assets/DeckView-v1.js': 'export default "deck-v1"',
      '/assets/KeyboardView-v1.js': 'export default "kbd-v1"',
      '/assets/index-v2.js': 'console.log("v2")',
      '/assets/index-v2.css': 'body{}',
      '/assets/DeckView-v2.js': 'export default "deck-v2"',
    }

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!online) throw new TypeError('Failed to fetch')
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://mac.local:8790')
      if (url.pathname === '/' || url.pathname === '/deck') {
        return new Response(currentVersion === 'v1' ? v1Html : v2Html, { status: 200 })
      }
      const body = files[url.pathname]
      return body !== undefined ? new Response(body, { status: 200 }) : new Response('not found', { status: 404 })
    })

    const sw = bootWorker(['/assets/index-v1.js', '/assets/index-v1.css', '/assets/DeckView-v1.js', '/assets/KeyboardView-v1.js'])
    await sw.install()

    // While reconnecting offline, unvisited lazy tabs (DeckView, KeyboardView)
    // resolve from precache instead of failing!
    online = false
    const lazyDeck = await sw.dispatchFetch('/assets/DeckView-v1.js')
    expect(await lazyDeck.response.text()).toBe('export default "deck-v1"')

    // Offline navigation to any subpath or query string opens the cached '/' app shell.
    const offlineSubpath = await sw.dispatchFetch('/deck?from=pwa', 'navigate')
    expect(await offlineSubpath.response.text()).toBe(v1Html)

    // When the Mac updates to v2 and the user navigates via a subpath/query URL,
    // canonical '/' and its v2 entry assets are cached atomically and v1 assets are pruned.
    online = true
    currentVersion = 'v2'
    const updatedNav = await sw.dispatchFetch('/deck?from=pwa', 'navigate')
    await updatedNav.settled
    expect(await updatedNav.response.text()).toBe(v2Html)

    // Go offline immediately after navigation settles: both '/' and '/deck?from=pwa'
    // serve v2Html cleanly rather than degrading to /offline.html.
    online = false
    const rootOffline = await sw.dispatchFetch('/', 'navigate')
    expect(await rootOffline.response.text()).toBe(v2Html)
    const subpathOffline = await sw.dispatchFetch('/deck?from=pwa', 'navigate')
    expect(await subpathOffline.response.text()).toBe(v2Html)
  })

  it('preserves the newest complete shell when navigation cache writes overlap across an update', async () => {
    const html = (version: number) =>
      `<!doctype html><script src="/assets/index-v${version}.js"></script><link href="/assets/index-v${version}.css" rel="stylesheet">`
    let online = true
    let version = 0
    let entered!: () => void
    const cssRequested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const cssResponse = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!online) throw new TypeError('offline')
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'https://mac.local:8790',
      ).pathname
      if (path === '/') return new Response(html(version))
      if (path === '/offline.html') return new Response('OFFLINE FALLBACK')
      if (path === '/assets/index-v1.css') {
        entered()
        await cssResponse
      }
      return new Response('asset')
    })

    const sw = bootWorker(['/assets/index-v0.js', '/assets/index-v0.css'])
    await sw.install()
    version = 1
    const oldNavigation = await sw.dispatchFetch('/?old', 'navigate')
    await cssRequested
    await new Promise((resolve) => setTimeout(resolve, 0))

    version = 2
    const newNavigation = await sw.dispatchFetch('/?new', 'navigate')
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await Promise.all([oldNavigation.settled, newNavigation.settled])

    online = false
    const offlineNavigation = await sw.dispatchFetch('/', 'navigate')
    expect(await offlineNavigation.response.text()).toBe(html(2))
  })
})

describe('stale build reload guard', () => {
  it('reloads only when the Mac is reachable and running a different version or missing the chunk, never when offline', async () => {
    let fetchImpl: (input: RequestInfo | URL) => Promise<Response> = () => Promise.reject(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => fetchImpl(input))

    const reloadSpy = vi.fn()
    vi.stubGlobal('location', { ...location, reload: reloadSpy })

    const reload = await import('../src/lib/reload')

    // Offline / unreachable Mac: chunk load failure must NOT reload the page
    // (which would drop a reconnecting session out of its control shell).
    expect(await reload.reloadIfBuildChanged()).toBe(false)
    expect(reloadSpy).not.toHaveBeenCalled()

    // Reachable Mac on the SAME version (transient Wi-Fi blip): still must NOT reload.
    fetchImpl = async () => new Response(JSON.stringify({ version: __APP_VERSION__ }), { status: 200 })
    expect(await reload.reloadIfBuildChanged()).toBe(false)
    expect(reloadSpy).not.toHaveBeenCalled()

    // Reachable Mac running a NEW version: reloads once to pick up the updated build!
    fetchImpl = async () => new Response(JSON.stringify({ version: '99.0.0' }), { status: 200 })
    expect(await reload.reloadIfBuildChanged()).toBe(true)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps vite:preloadError cancelable untouched so lazy() can retry when offline', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    const reloadSpy = vi.fn()
    vi.stubGlobal('location', { ...location, reload: reloadSpy })

    const reload = await import('../src/lib/reload')
    reload.installReloadOnStaleBuild()

    const event = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    await Promise.resolve()
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('recovers a selected lazy view when the Mac reconnects or when the person taps Try again', async () => {
    const { mount, flushPromises } = await import('@vue/test-utils')
    const { h, nextTick } = await import('vue')
    const { state } = await import('@/lib/connection')
    const { lazy } = await import('@/lib/reload')
    vi.useFakeTimers()
    let online = false
    let attempts = 0
    vi.stubGlobal('fetch', async () => {
      if (!online) throw new TypeError('offline')
      return new Response(JSON.stringify({ version: __APP_VERSION__ }))
    })
    state.status = 'reconnecting'
    const component = lazy(async () => {
      attempts++
      if (!online) throw new TypeError('offline chunk')
      return { render: () => h('p', 'Recovered view') }
    })
    const view = mount({ render: () => h(component) }, { global: { config: { errorHandler: () => {} } } })
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(4000)
      await flushPromises()
      expect(attempts).toBe(3)
      // Fallback UI shows a visible Try again action while still disconnected.
      expect(view.find('button').text()).toBe('Try again')

      // Even if state.status never left 'connected' during a brief Wi-Fi drop,
      // tapping Try again once connectivity returns loads the view immediately.
      const manualComponent = lazy(async () => {
        if (!online) throw new TypeError('offline chunk')
        return { render: () => h('p', 'Manually retried view') }
      })
      state.status = 'connected'
      const manualView = mount({ render: () => h(manualComponent) }, { global: { config: { errorHandler: () => {} } } })
      await flushPromises()
      await vi.advanceTimersByTimeAsync(4000)
      await flushPromises()
      expect(manualView.find('button').text()).toBe('Try again')

      online = true
      await manualView.find('button').trigger('click')
      await flushPromises()
      expect(manualView.text()).toContain('Manually retried view')
      manualView.unmount()

      // And a view waiting while 'reconnecting' recovers automatically on reconnect.
      state.status = 'reconnecting'
      await nextTick()
      state.status = 'connected'
      await nextTick()
      await flushPromises()
      expect(view.text()).toContain('Recovered view')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })
})
