import { computed } from 'vue'
import { onMessage, send, state } from './connection'

let requested = 0
/** The app list was opened, so keep it current across reconnects. */
let wanted = false

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
})

export const appNames = computed(() => new Map(state.apps.map((app) => [app.id, app.name])))
