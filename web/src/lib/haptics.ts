import { settings } from './settings'
import { isTextField } from './text'

export type Haptic = 'select' | 'light' | 'medium' | 'heavy' | 'error'

/** iOS and iPadOS 18 or later, which play a haptic for switch controls. */
function switchHaptics(): boolean {
  const ua = navigator.userAgent
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const version = Number((/ OS (\d+)_/.exec(ua) ?? /Version\/(\d+)/.exec(ua))?.[1] ?? 0)
  return apple && version >= 18
}

const canVibrate = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

/** Haptics come from tapping a switch control (iPhone and iPad). */
export const switchOnly = typeof navigator !== 'undefined' && !canVibrate() && switchHaptics()

export const hapticsSupported = typeof navigator !== 'undefined' && (canVibrate() || switchOnly)

const editing = () => isTextField(document.activeElement)

/**
 * Android vibration patterns in milliseconds (on, off, on…). Many phone
 * motors can't be felt below about 10 ms.
 */
export const PATTERN: Record<Haptic, number[]> = {
  select: [12],
  light: [16],
  medium: [26],
  heavy: [40],
  error: [30, 50, 30],
}

// Safari has no Vibration API, but toggling a native switch control plays
// the system haptic. Since iOS 26.5 only a real tap does: a switch toggled by
// a scripted click stays silent. So controls that want haptics are labels
// tied to a hidden switch (see HapticSwitch.vue). A tap on one plays the
// haptic that the tap asked for and is cancelled when it asked for none.
// Earlier iOS versions also play the haptic for a scripted click, which
// covers everything outside those controls.

/** Pointers down on haptic controls. */
const fingers = new Set<number>()
let owed = 0
let settle: ReturnType<typeof setTimeout> | undefined
// The click for a tap arrives after the finger lifts; a touch that turned
// into a drag never gets one.
const SETTLE_MS = 400

/** A finger is on a haptic control, or just lifted from one. */
const onControl = () => fingers.size > 0 || settle !== undefined

export const tapZone = {
  down(pointerId: number) {
    fingers.add(pointerId)
    clearTimeout(settle)
    settle = undefined
  },
  up(pointerId: number) {
    if (!fingers.delete(pointerId) || fingers.size > 0) return
    clearTimeout(settle)
    settle = setTimeout(() => {
      settle = undefined
      owed = 0
    }, SETTLE_MS)
  },
  /** Whether the tap that produced this click asked for a haptic. */
  claim(): boolean {
    if (owed <= 0 || !settings.haptics) return false
    owed--
    return true
  },
}

if (typeof document !== 'undefined') {
  // Lifts are watched on the whole page: a control can leave it while a
  // finger is on it (a tab switch, or the keyboard opening), and its own
  // listeners then never hear the lift. Left counted, the finger would keep
  // every later haptic waiting for a tap that never comes.
  const lifted = (event: PointerEvent) => tapZone.up(event.pointerId)
  document.addEventListener('pointerup', lifted, true)
  document.addEventListener('pointercancel', lifted, true)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    for (const id of fingers) tapZone.up(id)
  })
}

/**
 * Whether a touch on a haptic control must keep its default action: iOS
 * fires no click, and so no haptic, for a touch whose pointerdown or
 * touchstart was cancelled. While a text field has focus, cancelling it is
 * what keeps the field focused and the keyboard up.
 */
export function needsClick(event: PointerEvent | TouchEvent, keys = false): boolean {
  if (!switchOnly || !settings.haptics || (keys && !settings.keyHaptics) || editing()) return false
  return !('pointerType' in event) || event.pointerType === 'touch'
}

/** Cancel a pointerdown unless iOS needs its click for a haptic. */
export function holdPointer(event: PointerEvent, keys = false) {
  if (!needsClick(event, keys)) event.preventDefault()
}

let toggle: HTMLLabelElement | null = null

function scriptedToggle(): HTMLLabelElement {
  if (toggle) return toggle
  // Both stay out of the layout; clicking the label still flips the switch.
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('switch', '')
  input.id = 'cmdpalm-haptic'
  input.tabIndex = -1
  input.style.all = 'initial'
  input.style.appearance = 'auto'
  input.style.display = 'none'
  const label = document.createElement('label')
  label.htmlFor = input.id
  label.setAttribute('aria-hidden', 'true')
  label.style.display = 'none'
  label.appendChild(input)
  document.body.appendChild(label)
  toggle = label
  return label
}

/** Extra switch clicks on iOS, in ms after the first, for patterns. */
const IOS_REPEAT: Partial<Record<Haptic, number[]>> = { error: [80] }

export function haptic(kind: Haptic = 'light') {
  if (!settings.haptics || !hapticsSupported) return
  if (canVibrate()) {
    navigator.vibrate(PATTERN[kind])
    return
  }
  if (onControl()) {
    owed = Math.min(owed + 1, Math.max(1, fingers.size))
    return
  }
  // Clicking the label focuses the switch, which would close the keyboard.
  if (editing()) return
  const label = scriptedToggle()
  label.click()
  for (const delay of IOS_REPEAT[kind] ?? []) setTimeout(() => label.click(), delay)
}

/** The tap felt on a key press, when key haptics are on. */
export function keyHaptic() {
  if (settings.keyHaptics) haptic('select')
}
