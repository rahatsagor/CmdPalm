import { iconPixels, iconUrl, state } from './connection'

const MAX_ICONS = 256

// Icon URLs carry the per-connection session key, so the browser would fetch
// every icon again after each reconnect. Keep the pictures here instead.
const cache = new Map<string, string>()
const loading = new Map<string, Promise<string>>()
let generation = 0

const keyOf = (appId: string, size: number) => `${appId}@${iconPixels(size)}`

/** The cached icon, if any; reading it makes it the newest. */
export function appIcon(appId: string, size = 128): string | undefined {
  const key = keyOf(appId, size)
  const url = cache.get(key)
  if (url === undefined) return undefined
  cache.delete(key)
  cache.set(key, url)
  return url
}

export function loadAppIcon(appId: string, size = 128): Promise<string> {
  const key = keyOf(appId, size)
  const cached = appIcon(appId, size)
  if (cached) return Promise.resolve(cached)
  // A request still pending under an old session key will be refused.
  const flight = `${key}|${state.sessionKey}`
  const pending = loading.get(flight)
  if (pending) return pending
  const started = generation
  const request = fetch(iconUrl(appId, size))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Icon request failed (${response.status})`)
      const url = URL.createObjectURL(await response.blob())
      if (started !== generation) {
        URL.revokeObjectURL(url)
        return url
      }
      cache.set(key, url)
      while (cache.size > MAX_ICONS) {
        const [oldest, stale] = cache.entries().next().value!
        cache.delete(oldest)
        URL.revokeObjectURL(stale)
      }
      return url
    })
    .finally(() => {
      if (loading.get(flight) === request) loading.delete(flight)
    })
  loading.set(flight, request)
  return request
}

/** Forget every icon, such as when the phone pairs with a different Mac. */
export function clearAppIcons() {
  generation++
  loading.clear()
  for (const url of cache.values()) URL.revokeObjectURL(url)
  cache.clear()
}
