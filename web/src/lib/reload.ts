// After a CmdPalm update on the Mac, an open page still refers to the previous
// build's lazily loaded files, which the Mac no longer serves. Reloading picks
// up the new build; the guards keep a broken setup from reloading in a loop.

import { defineAsyncComponent, defineComponent, h, ref, watch, type Component } from 'vue'
import { state } from './connection'

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

/** A lazily loaded component that retries on network blips, recovers on reconnect, and reloads if the Mac updated. */
export function lazy(loader: () => Promise<Component | { default: Component }>) {
  const attempt = ref(0)
  let failed = false

  const bump = () => {
    failed = false
    attempt.value++
  }

  const Fallback = defineComponent({
    setup() {
      return () =>
        h('div', { class: 'flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted' }, [
          h('p', { class: 'text-[14px]' }, 'Couldn’t load this view while the Mac was unreachable.'),
          h(
            'button',
            {
              type: 'button',
              class: 'h-9 rounded-full bg-surface-3 px-4 text-[13px] font-medium text-text',
              onClick: bump,
            },
            'Try again',
          ),
        ])
    },
  })

  const makeInner = () =>
    defineAsyncComponent({
      loader: async () => {
        const mod = await loader()
        failed = false
        return mod
      },
      errorComponent: Fallback,
      onError(_error, retry, fail, attempts) {
        void reloadIfBuildChanged().then((reloading) => {
          if (reloading) {
            fail()
          } else if (attempts <= 2) {
            setTimeout(retry, 800 * attempts)
          } else {
            failed = true
            fail()
          }
        })
      },
    })

  let inner = makeInner()
  let currentAttempt = 0

  watch(
    () => state.status,
    (status) => {
      if (status === 'connected' && failed) bump()
    },
  )
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (failed) bump()
    })
  }

  return defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => {
        if (attempt.value !== currentAttempt) {
          currentAttempt = attempt.value
          inner = makeInner()
        }
        return h(inner, { ...attrs, key: attempt.value }, slots)
      }
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
