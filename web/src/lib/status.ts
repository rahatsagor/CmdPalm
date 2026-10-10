// Connection status shown in the header (portrait) or side rail (landscape).

import { computed, ref } from 'vue'
import { notify, state } from './connection'
import { releaseHardwareKeys } from './hardware'
import { modifiers, releaseAll } from './input'
import { modsLabel } from './keys'

export const online = computed(() => state.status === 'connected')
/** Modifiers left on (latched or locked), as symbols. */
export const stuck = computed(() => modsLabel(modifiers.state.locked | modifiers.state.latched))

/** True for a moment after `panic`, to confirm it on the button. */
export const released = ref(false)
let releasedTimer: ReturnType<typeof setTimeout> | undefined

export function explainPermission() {
  notify(
    'CmdPalm needs Accessibility permission to control the Mac. On the Mac, turn on CmdPalm in System Settings → Privacy & Security → Accessibility.',
    'warning',
    'permission',
  )
}

/** Release every key and button this device holds on the Mac. */
export function panic() {
  releaseHardwareKeys()
  releaseAll()
  notify('Released all keys and buttons on the Mac.', 'info', 'release')
  released.value = true
  clearTimeout(releasedTimer)
  releasedTimer = setTimeout(() => (released.value = false), 1200)
}
