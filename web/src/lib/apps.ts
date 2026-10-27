import { computed, reactive } from 'vue'
import { onMessage, send, state } from './connection'
import type { AppEntry } from './protocol'

let requested = 0
/** The app list was opened, so keep it current across reconnects. */
let wanted = false

/** Apps asked to quit from this device, and when. */
const quitting = reactive(new Map<string, number>())
/** Long enough for an app to finish quitting, short enough that one which
 * asked to save a document comes back into the list. */
const QUIT_GRACE_MS = 5000
let followUps: ReturnType<typeof setTimeout>[] = []

/**
 * Show an app as closed as soon as it is asked to quit. The Mac announces
 * the change once the app is gone, but a list made while it was still
 * quitting would bring it back, so ask again after it should have finished.
 */
export function markQuitting(id: string) {
  quitting.set(id, Date.now())
  followUps.forEach(clearTimeout)
  followUps = [1200, QUIT_GRACE_MS + 100].map((ms) =>
    setTimeout(() => {
      for (const [app, at] of quitting) if (Date.now() - at >= QUIT_GRACE_MS) quitting.delete(app)
      loadApps(true)
    }, ms),
  )
}

/** Whether the app is open, counting one asked to quit as closed. */
export function isOpen(app: AppEntry): boolean {
  const at = quitting.get(app.id)
  return app.running && (at === undefined || Date.now() - at >= QUIT_GRACE_MS)
}

/** Ask the Mac for its app list, at most every few seconds. */
export function loadApps(force = false) {
  wanted = true
  const now = Date.now()
  if (!force && now - requested < 3000) return
  // A request that couldn't be sent (reconnecting) is asked again on welcome.
  if (send({ t: 'apps' })) requested = now
}

onMessage((message) => {
  // Something launched or quit; refresh only if someone is looking. After a
  // reconnect, changes made meanwhile were never announced.
  if ((message.t === 'appsChanged' && state.appsLoaded) || (message.t === 'welcome' && wanted)) loadApps(true)
  // The quit app is gone from the list the Mac sent, so it no longer needs hiding.
  if (message.t === 'apps') for (const id of quitting.keys()) if (!message.apps.some((a) => a.id === id && a.running)) quitting.delete(id)
})

export const appNames = computed(() => new Map(state.apps.map((app) => [app.id, app.name])))
