// After a CmdPalm update on the Mac, an open page still refers to the previous
// build's lazily loaded files, which the Mac no longer serves. Reloading picks
// up the new build; the guards keep a broken setup from reloading in a loop.

import { defineAsyncComponent, type Component } from 'vue'

const KEY = 'cmdpalm.reloadedAt'
const VERSION_KEY = 'cmdpalm.reloadedFor'
const MIN_GAP_MS = 10_000
const PROBE_TIMEOUT_MS = 2_000

export function reloadForUpdate(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY)) < MIN_GAP_MS) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return false
  }
  location.reload()
  return true
}

/** Reload once per Mac version when the Mac runs a different CmdPalm than this page. */
export function checkHostVersion(version: string): boolean {
  if (!version || version === __APP_VERSION__) return false
  try {
    if (sessionStorage.getItem(VERSION_KEY) === version) return false
    if (reloadForUpdate()) {
      sessionStorage.setItem(VERSION_KEY, version)
      return true
    }
  } catch {
    // No session storage: reloadForUpdate refuses too, so there is no loop.
  }
  return false
}

/**
 * Check whether a failed chunk import happened because the Mac updated its build.
 * Ordinary network drops (when the Mac is asleep or Wi-Fi briefly disconnects)
 * must NOT reload the page, or a reconnecting session loses its control shell.
 */
export async function reloadIfBuildChanged(): Promise<boolean> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch('/api/info', { cache: 'no-store', signal: abort.signal })
    if (!response.ok) return false
    const info = (await response.json()) as { version?: unknown }
    return typeof info.version === 'string' && checkHostVersion(info.version)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** A lazily loaded component that retries on network blips and reloads if the Mac updated. */
export function lazy(loader: () => Promise<Component | { default: Component }>) {
  return defineAsyncComponent({
    loader,
    onError(_error, retry, fail, attempts) {
      void reloadIfBuildChanged().then((reloading) => {
        if (reloading) fail()
        else if (attempts <= 2) setTimeout(retry, 800 * attempts)
        else fail()
      })
    },
  })
}

export function installReloadOnStaleBuild() {
  addEventListener('vite:preloadError', () => {
    // Do not call preventDefault(): Vite rethrows to `lazy()`'s `onError` so
    // Vue retries on transient network drops instead of resolving `undefined`.
    void reloadIfBuildChanged()
  })
}
