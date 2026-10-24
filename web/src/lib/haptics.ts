import { settings } from './settings'

export type Haptic = 'select' | 'light' | 'medium' | 'heavy' | 'error'

let toggle: HTMLLabelElement | null = null

function iosToggle(): HTMLLabelElement {
  if (toggle) return toggle
  // Safari has no Vibration API, but toggling a native switch control plays
  // the system selection haptic (iOS 18+). It must happen inside a gesture.
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

/** iOS and iPadOS 18 or later, which play a haptic for switch controls. */
function switchHaptics(): boolean {
  const ua = navigator.userAgent
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const version = Number((/ OS (\d+)_/.exec(ua) ?? /Version\/(\d+)/.exec(ua))?.[1] ?? 0)
  return apple && version >= 18
}

const canVibrate = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

export const hapticsSupported = typeof navigator !== 'undefined' && (canVibrate() || switchHaptics())

function editing(): boolean {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'range'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

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

/** Extra switch clicks on iOS, in ms after the first, for patterns. */
const IOS_REPEAT: Partial<Record<Haptic, number[]>> = { error: [80] }

export function haptic(kind: Haptic = 'light') {
  if (!settings.haptics || !hapticsSupported) return
  if (canVibrate()) {
    navigator.vibrate(PATTERN[kind])
    return
  }
  // Clicking the label focuses the switch, which would close the keyboard.
  if (editing()) return
  const label = iosToggle()
  label.click()
  for (const delay of IOS_REPEAT[kind] ?? []) setTimeout(() => label.click(), delay)
}
