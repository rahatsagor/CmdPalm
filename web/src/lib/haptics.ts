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

const PATTERN: Record<Haptic, number> = { select: 4, light: 8, medium: 14, heavy: 24 }

export function haptic(kind: Haptic = 'light') {
  if (!settings.haptics) return
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(PATTERN[kind])
    return
  }
  iosToggle().click()
}
