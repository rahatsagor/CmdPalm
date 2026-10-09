import { computed } from 'vue'
import { onMessage, send, state } from './connection'

let requested = 0

/** Ask the Mac for its app list, at most every few seconds. */
export function loadApps(force = false) {
  const now = Date.now()
  if (!force && now - requested < 3000) return
  requested = now
  send({ t: 'apps' })
}

onMessage((message) => {
  // Something launched or quit; refresh only if someone is looking.
  if (message.t === 'appsChanged' && state.appsLoaded) loadApps(true)
})

export const appNames = computed(() => new Map(state.apps.map((app) => [app.id, app.name])))
