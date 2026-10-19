import { reactive, watch } from 'vue'
import type { Action, TextMode } from './protocol'

export type GestureSlot = 'left' | 'right' | 'up' | 'down' | 'tap'
export type GestureMap = Record<GestureSlot, Action | null>

export interface Settings {
  version: 1
  pointerSpeed: number
  pointerAcceleration: number
  tapToClick: boolean
  twoFingerTapRightClick: boolean
  longPress: 'drag' | 'rightClick' | 'off'
  tapAndDrag: boolean
  dragLock: boolean
  clickButtons: boolean
  scrollSpeed: number
  naturalScroll: boolean
  momentum: boolean
  scrollStrip: 'short' | 'long' | 'off'
  scrollStripSide: 'right' | 'left'
  scrollHold: boolean
  pinchToZoom: boolean
  threeFinger: GestureMap
  fourFinger: GestureMap
  keyboard: 'auto' | 'mac' | 'custom' | 'phone'
  functionRow: 'media' | 'function'
  keyRepeat: boolean
  textMode: TextMode
  liveTyping: boolean
  haptics: boolean
  theme: 'system' | 'dark' | 'light'
  keepAwake: boolean
  showTouches: boolean
  rememberDevice: boolean
  deviceName: string
  showAdvanced: boolean
  tab: Tab
  deckPage: string
}

export type Tab = 'trackpad' | 'keyboard' | 'deck' | 'apps' | 'media'

const sys = (name: Extract<Action, { kind: 'system' }>['name']): Action => ({ kind: 'system', name })

export function defaultSettings(): Settings {
  return {
    version: 1,
    pointerSpeed: 1.2,
    pointerAcceleration: 0.6,
    tapToClick: true,
    twoFingerTapRightClick: true,
    longPress: 'drag',
    tapAndDrag: true,
    dragLock: false,
    clickButtons: true,
    scrollSpeed: 1,
    naturalScroll: true,
    momentum: true,
    scrollStrip: 'short',
    scrollStripSide: 'right',
    scrollHold: true,
    pinchToZoom: true,
    threeFinger: {
      up: sys('missionControl'),
      down: sys('appExpose'),
      // Swiping left reveals the space to the right, as on a Mac trackpad.
      left: sys('spaceRight'),
      right: sys('spaceLeft'),
      tap: { kind: 'mouse', button: 'middle' },
    },
    fourFinger: {
      up: sys('launchpad'),
      down: sys('showDesktop'),
      left: sys('nextTab'),
      right: sys('previousTab'),
      tap: null,
    },
    keyboard: 'auto',
    functionRow: 'media',
    keyRepeat: true,
    textMode: 'unicode',
    liveTyping: true,
    haptics: true,
    theme: 'system',
    keepAwake: true,
    showTouches: true,
    rememberDevice: true,
    deviceName: '',
    showAdvanced: false,
    tab: 'trackpad',
    deckPage: '',
  }
}

const KEY = 'cmdpalm.settings'

const clamp = (value: unknown, lo: number, hi: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback

// A value saved by a newer or older version may no longer be offered.
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
  longPress: ['drag', 'rightClick', 'off'],
  scrollStrip: ['short', 'long', 'off'],
  scrollStripSide: ['right', 'left'],
  keyboard: ['auto', 'mac', 'custom', 'phone'],
  functionRow: ['media', 'function'],
  textMode: ['unicode', 'keystrokes', 'paste'],
  theme: ['system', 'dark', 'light'],
  tab: ['trackpad', 'keyboard', 'deck', 'apps', 'media'],
}

/** Merge stored values over defaults, dropping anything malformed. */
export function migrate(raw: unknown): Settings {
  const defaults = defaultSettings()
  if (!raw || typeof raw !== 'object') return defaults
  const stored = raw as Partial<Record<keyof Settings, unknown>>
  const out: Settings = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    const value = stored[key]
    const fallback = defaults[key]
    if (value === undefined || typeof value !== typeof fallback) continue
    if (CHOICES[key] && !CHOICES[key].includes(value as string)) continue
    if (fallback !== null && typeof fallback === 'object') {
      // Gesture maps: keep known slots only.
      if (value === null) continue
      const map = { ...(fallback as GestureMap) }
      for (const slot of Object.keys(map) as GestureSlot[]) {
        const action = (value as Record<string, unknown>)[slot]
        if (action === null || (action && typeof action === 'object' && 'kind' in action)) map[slot] = action as Action | null
      }
      ;(out as unknown as Record<string, unknown>)[key] = map
    } else {
      ;(out as unknown as Record<string, unknown>)[key] = value
    }
  }
  out.pointerSpeed = clamp(out.pointerSpeed, 0.2, 4, defaults.pointerSpeed)
  out.pointerAcceleration = clamp(out.pointerAcceleration, 0, 1, defaults.pointerAcceleration)
  out.scrollSpeed = clamp(out.scrollSpeed, 0.2, 4, defaults.scrollSpeed)
  // Up to 0.3.0, one setting held both the side and whether the strip showed.
  const legacy = (raw as { scrollRail?: unknown }).scrollRail
  if (stored.scrollStrip === undefined && legacy === 'off') out.scrollStrip = 'off'
  if (stored.scrollStripSide === undefined && legacy === 'left') out.scrollStripSide = 'left'
  return out
}

function load(): Settings {
  try {
    return migrate(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return defaultSettings()
  }
}

export const settings = reactive<Settings>(load())

let saveTimer: ReturnType<typeof setTimeout> | undefined
function store() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Private browsing or full storage: settings last for this session.
  }
}
watch(
  settings,
  () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(store, 150)
  },
  { deep: true },
)
if (typeof document !== 'undefined') {
  // A hidden page can be closed before the delay runs out.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer !== undefined) store()
  })
}

export function resetSettings(section?: (keyof Settings)[]) {
  const defaults = defaultSettings()
  const keys = section ?? (Object.keys(defaults) as (keyof Settings)[])
  for (const key of keys) {
    if (key === 'deviceName' || key === 'tab' || key === 'deckPage') continue
    ;(settings as unknown as Record<string, unknown>)[key] = structuredClone(defaults[key])
  }
}
