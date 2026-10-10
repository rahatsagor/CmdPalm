import { settings } from './settings'

export type Haptic = 'light' | 'medium' | 'heavy' | 'select'

let toggle: HTMLLabelElement | null = null

function iosToggle(): HTMLLabelElement {
  if (toggle) return toggle
  // Safari has no Vibration API, but toggling a native switch control plays
  // the system selection haptic (iOS 18+). It must happen inside a gesture.
  const label = document.createElement('label')
  label.setAttribute('aria-hidden', 'true')
  label.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('switch', '')
  input.tabIndex = -1
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

export const hapticsSupported = typeof navigator !== 'undefined' && (typeof navigator.vibrate === 'function' || switchHaptics())

function editing(): boolean {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'range'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

const PATTERN: Record<Haptic, number> = { select: 4, light: 8, medium: 14, heavy: 24 }

export function haptic(kind: Haptic = 'light') {
  if (!settings.haptics || !hapticsSupported) return
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(PATTERN[kind])
    return
  }
  // Clicking the label focuses the switch, which would close the keyboard.
  if (!editing()) iosToggle().click()
}
