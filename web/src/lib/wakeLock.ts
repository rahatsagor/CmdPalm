import { watch } from 'vue'
import { settings } from './settings'
import { state } from './connection'

// Keeps the phone's screen on while connected so the trackpad stays usable.
let sentinel: WakeLockSentinel | null = null
let requesting = false

const wanted = () => settings.keepAwake && state.status === 'connected' && document.visibilityState === 'visible'

async function acquire() {
  if (sentinel || requesting || !('wakeLock' in navigator)) return
  requesting = true
  try {
    const lock = await navigator.wakeLock.request('screen')
    lock.addEventListener('release', () => {
      if (sentinel === lock) sentinel = null
    })
    // Things may have changed while the request was in flight.
    if (wanted()) sentinel = lock
    else void lock.release()
  } catch {
    // Not allowed (low battery, no secure context); the screen may dim.
  } finally {
    requesting = false
  }
}

function release() {
  void sentinel?.release()
  sentinel = null
}

function update() {
  if (wanted()) void acquire()
  else release()
}

export function installWakeLock() {
  watch(() => [settings.keepAwake, state.status], update, { immediate: true })
  document.addEventListener('visibilitychange', update)
}
