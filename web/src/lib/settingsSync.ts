// This device's settings, also kept on the Mac so they survive a cleared
// browser and can be copied to another phone or tablet. localStorage stays the
// primary store; the Mac's copy is applied only when it is newer.

import { reactive, watch } from 'vue'
import { ACTION_KINDS } from './actions'
import { notify, onMessage, send, state } from './connection'
import { keyboards, LIMITS, migrateKeyboards, presets, sanitizeBoard, type CustomKeyboard } from './customKeyboards'
import { actionProblem } from './deck'
import { token } from './device'
import type { Action, SavedSettings, ServerMessage, SettingsSource } from './protocol'
import { defaultSettings, migrate, settings, type GestureMap, type GestureSlot, type Settings } from './settings'

/**
 * Never saved on the Mac or copied from another device: the name the Mac knows
 * this device by, whether to remember it (a choice made per device, e.g. for a
 * shared tablet), and where the person left off (tab and deck page). The
 * active custom keyboard is left out for the same reason.
 */
export const UNSYNCED = ['version', 'deviceName', 'rememberDevice', 'tab', 'deckPage'] as const

export type SyncedPrefs = Omit<Settings, (typeof UNSYNCED)[number]>
export type SyncedSettings = {
  version: 1
  settings: SyncedPrefs
  keyboards: CustomKeyboard[]
}

/** Each preference belongs to one independently copyable section. */
export const COPY_CATEGORIES = [
  {
    id: 'trackpad', label: 'Trackpad', hint: 'Pointer, clicks and scrolling',
    keys: ['pointerSpeed', 'pointerAcceleration', 'tapToClick', 'twoFingerTapRightClick', 'longPress', 'tapAndDrag', 'dragLock', 'clickButtons', 'scrollSpeed', 'naturalScroll', 'momentum', 'scrollStrip', 'scrollStripSide', 'scrollStripWidth', 'scrollStripEdge', 'scrollHold'],
  },
  {
    id: 'gestures', label: 'Gestures', hint: 'Pinch, rotate and finger gestures',
    keys: ['pinchToZoom', 'pinchStyle', 'rotateGesture', 'smartZoom', 'threeFingerDrag', 'threeFinger', 'fourFinger'],
  },
  {
    id: 'keyboard', label: 'Keyboard settings', hint: 'Keyboard mode, typing and key repeat',
    keys: ['keyboard', 'functionRow', 'sidewaysKeyboard', 'sidewaysTurn', 'keyRepeat', 'textMode', 'liveTyping'],
  },
  { id: 'deck', label: 'Deck button size', hint: 'Button size on this device', keys: ['deckButtonSize'] },
  {
    id: 'appearance', label: 'Appearance and feedback', hint: 'Theme, haptics, screen and advanced options',
    keys: ['theme', 'haptics', 'keyHaptics', 'keepAwake', 'showTouches', 'showAdvanced'],
  },
] as const satisfies readonly { id: string; label: string; hint: string; keys: readonly (keyof SyncedPrefs)[] }[]

export type CopyCategory = (typeof COPY_CATEGORIES)[number]['id']
export interface CopyPreview {
  device: SettingsSource
  settings: Partial<SyncedPrefs>
  keyboards: CustomKeyboard[]
}
export interface CopySelection {
  categories: CopyCategory[]
  keyboards: string[]
}

export const SAVE_DELAY_MS = 1500
/** The Mac refuses larger settings. */
export const MAX_BYTES = 128 * 1024
const REPLY_TIMEOUT_MS = 8000
const META_KEY = 'cmdpalm.settingsSync'

const SYNCED_KEYS = (Object.keys(defaultSettings()) as (keyof Settings)[]).filter(
  (key): key is keyof SyncedPrefs => !(UNSYNCED as readonly string[]).includes(key),
)
const KINDS = new Set<string>(ACTION_KINDS.map((k) => k.kind))

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function buildPayload(source: Settings = settings, boards: CustomKeyboard[] = keyboards.boards): SyncedSettings {
  const prefs: Record<string, unknown> = {}
  for (const key of SYNCED_KEYS) prefs[key] = source[key]
  return { version: 1, settings: prefs as SyncedPrefs, keyboards: boards }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return hash >>> 0
}

// The built-in keyboards get fresh random ids until first edited, so ids alone
// never count as a change.
const signature = (payload: SyncedSettings) => fnv1a(JSON.stringify(payload.settings) + JSON.stringify(
  payload.keyboards.map((board) => ({ ...board, id: undefined, keys: board.keys.map((key) => ({ ...key, id: undefined })) })),
))

interface Meta {
  /** When the person last changed a synced setting here, or 0 if never. */
  updatedAt: number
  /** Signature of the settings as of `updatedAt`, to tell real changes apart. */
  hash: number
}

let meta: Meta = { updatedAt: 0, hash: 0 }
/** `updatedAt` of the copy the Mac has, as far as this connection knows. */
let macAt = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined
let changedAt = 0
let warnedTooLarge = false
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryDelay = SAVE_DELAY_MS

function loadMeta(): Meta {
  try {
    const stored = JSON.parse(localStorage.getItem(META_KEY) ?? 'null') as unknown
    if (isRecord(stored) && isTime(stored.updatedAt) && typeof stored.hash === 'number') return { updatedAt: stored.updatedAt, hash: stored.hash }
  } catch {
    // Unreadable: start over as if never customized.
  }
  return { updatedAt: 0, hash: signature(buildPayload(defaultSettings(), presets())) }
}

function storeMeta() {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch {
    // Storage unavailable: the Mac's copy wins on the next connection.
  }
}

/** Record a change made here, if the synced settings really changed. */
function commit() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  const at = changedAt || Date.now()
  changedAt = 0
  const hash = signature(buildPayload())
  if (hash === meta.hash) return
  meta = { updatedAt: Math.max(at, meta.updatedAt + 1), hash }
  storeMeta()
}

/** Send this device's settings if the Mac's copy is older. */
function push() {
  // The Mac keeps settings only for remembered devices.
  if (meta.updatedAt <= macAt || !token.get() || state.status !== 'connected') return
  const payload = buildPayload()
  const size = new TextEncoder().encode(JSON.stringify(payload)).length
  if (size > MAX_BYTES) {
    if (!warnedTooLarge) notify('Your custom keyboards are too large to back up on the Mac.', 'warning', 'settings')
    warnedTooLarge = true
    return
  }
  warnedTooLarge = false
  if (send({ t: 'settingsSave', settings: payload, updatedAt: meta.updatedAt })) macAt = meta.updatedAt
}

function schedule() {
  changedAt = Date.now()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    commit()
    push()
  }, SAVE_DELAY_MS)
}

export function validAction(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return false
  try {
    return !actionProblem(raw as unknown as Action)
  } catch {
    return false
  }
}

function cleanGestures(map: GestureMap, fallback: GestureMap) {
  for (const slot of Object.keys(map) as GestureSlot[]) {
    if (map[slot] !== null && !validAction(map[slot])) map[slot] = fallback[slot]
  }
}

/** Replace the synced settings with `raw`, cleaned like stored settings. */
export function applySynced(raw: unknown) {
  const data = isRecord(raw) ? raw : {}
  const incoming = migrate(isRecord(data.settings) ? data.settings : null)
  const defaults = defaultSettings()
  cleanGestures(incoming.threeFinger, defaults.threeFinger)
  cleanGestures(incoming.fourFinger, defaults.fourFinger)
  for (const key of SYNCED_KEYS) (settings as unknown as Record<string, unknown>)[key] = incoming[key]
  const next = migrateKeyboards({ boards: data.keyboards, active: keyboards.active })
  keyboards.boards = next.boards
  keyboards.active = next.active
}

function parseSaved(raw: unknown): SavedSettings | null {
  return isRecord(raw) && isRecord(raw.settings) && isTime(raw.updatedAt) ? { settings: raw.settings, updatedAt: raw.updatedAt } : null
}

function welcomed(saved: SavedSettings | null) {
  commit()
  macAt = saved?.updatedAt ?? 0
  if (saved && saved.updatedAt > meta.updatedAt) {
    applySynced(saved.settings)
    // Applying fires the change watcher; matching the signature keeps it from echoing back.
    meta = { updatedAt: saved.updatedAt, hash: signature(buildPayload()) }
    storeMeta()
    return
  }
  push()
}

export const copier = reactive({
  devices: null as SettingsSource[] | null,
  loading: false,
  failed: false,
  /** Id of the device being copied from. */
  copying: '',
})

let listTimer: ReturnType<typeof setTimeout> | undefined
let copyTimer: ReturnType<typeof setTimeout> | undefined
let nextCopyId = 0
let pendingCopy: { id: number; device: SettingsSource; resolve: (preview: CopyPreview | null) => void } | null = null

/** Ask the Mac which other devices have saved settings. */
export function listDevices() {
  clearTimeout(listTimer)
  copier.failed = false
  copier.loading = true
  if (!send({ t: 'settingsList' })) {
    copier.loading = false
    copier.failed = true
    return
  }
  listTimer = setTimeout(() => {
    copier.loading = false
    copier.failed = true
  }, REPLY_TIMEOUT_MS)
}

function finishCopy(preview: CopyPreview | null) {
  clearTimeout(copyTimer)
  const pending = pendingCopy
  pendingCopy = null
  copier.copying = ''
  pending?.resolve(preview)
}

/** Read a source for review. Nothing on this device changes until Copy selected. */
export function requestCopy(device: SettingsSource): Promise<CopyPreview | null> {
  finishCopy(null)
  return new Promise((resolve) => {
    const id = ++nextCopyId
    if (!send({ t: 'settingsCopy', from: device.id, id })) {
      notify('Not connected to the Mac.', 'error', 'settings')
      resolve(null)
      return
    }
    pendingCopy = { id, device, resolve }
    copier.copying = device.id
    copyTimer = setTimeout(() => {
      notify('The Mac didn’t answer. Try again.', 'error', 'settings')
      finishCopy(null)
    }, REPLY_TIMEOUT_MS)
  })
}

export function cancelCopy() {
  finishCopy(null)
}

function copied(saved: SavedSettings | null, id?: number) {
  const pending = pendingCopy
  if (!pending || id !== pending.id) return
  const raw = saved?.settings
  if (!raw || raw.version !== 1 || !isRecord(raw.settings)) {
    notify('Those settings couldn’t be read.', 'error', 'settings')
    finishCopy(null)
    return
  }
  const incoming = migrate(raw.settings)
  const defaults = defaultSettings()
  cleanGestures(incoming.threeFinger, defaults.threeFinger)
  cleanGestures(incoming.fourFinger, defaults.fourFinger)
  const prefs: Partial<SyncedPrefs> = {}
  for (const key of SYNCED_KEYS) {
    // A source saved by an older version must not reset newer preferences.
    if (Object.hasOwn(raw.settings, key)) (prefs as Record<string, unknown>)[key] = incoming[key]
  }
  const seen = new Set<string>()
  const boards = (Array.isArray(raw.keyboards) ? raw.keyboards : []).map(sanitizeBoard).filter((board): board is CustomKeyboard => {
    if (!board || seen.has(board.id)) return false
    seen.add(board.id)
    return true
  }).slice(0, LIMITS.boards)
  finishCopy({ device: pending.device, settings: prefs, keyboards: boards })
}

/** Copy only checked sections and keyboards, keeping everything else here. */
export function copyFrom(preview: CopyPreview, selection: CopySelection): boolean {
  const prefs = { ...settings }
  let selected = false
  for (const category of COPY_CATEGORIES) {
    if (!selection.categories.includes(category.id)) continue
    for (const key of category.keys) {
      if (!Object.hasOwn(preview.settings, key)) continue
      ;(prefs as unknown as Record<string, unknown>)[key] = preview.settings[key]
      selected = true
    }
  }
  const boards = [...keyboards.boards]
  for (const board of preview.keyboards) {
    if (!selection.keyboards.includes(board.id)) continue
    const at = boards.findIndex((b) => b.id === board.id)
    if (at >= 0) boards[at] = board
    else boards.push(board)
    selected = true
  }
  if (!selected) return false
  // Reject the whole operation before touching local state, rather than
  // partially importing a setup or silently dropping keyboards past the limit.
  if (boards.length > LIMITS.boards) {
    notify(`You can keep up to ${LIMITS.boards} keyboards. Select fewer keyboards or delete one here first.`, 'warning', 'settings')
    return false
  }
  const payload = buildPayload(prefs, boards)
  if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_BYTES) {
    notify('This selection is too large to back up on the Mac. Select fewer keyboards.', 'warning', 'settings')
    return false
  }
  if (!replaceSynced(payload)) return false
  notify(`Copied your selection from ${preview.device.name}.`, 'info', 'settings')
  return true
}

/** Install a validated setup atomically and make it newer than its Mac copy. */
export function replaceSynced(payload: SyncedSettings): boolean {
  if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_BYTES) {
    notify('This setup is too large to back up on the Mac.', 'warning', 'settings')
    return false
  }
  commit()
  applySynced(payload)
  meta = { updatedAt: Math.max(Date.now(), meta.updatedAt + 1, macAt + 1), hash: signature(buildPayload()) }
  storeMeta()
  push()
  return true
}

function parseDevices(raw: unknown): SettingsSource[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (d): d is SettingsSource =>
      isRecord(d) && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.model === 'string' && isTime(d.updatedAt),
  )
}

function handle(message: ServerMessage) {
  switch (message.t) {
    case 'welcome':
      clearTimeout(retryTimer)
      retryTimer = undefined
      retryDelay = SAVE_DELAY_MS
      welcomed(parseSaved(message.settings))
      break
    case 'settings':
      copied(parseSaved(message), message.id)
      break
    case 'settingsList':
      clearTimeout(listTimer)
      copier.devices = parseDevices(message.devices)
      copier.loading = false
      copier.failed = false
      break
    case 'notice':
      if ((message.level === 'error' && message.code === 'settings') || (message.code === 'busy' && meta.updatedAt > 0)) {
        macAt = 0
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          push()
        }, retryDelay)
        retryDelay = Math.min(retryDelay * 2, 60_000)
      }
      if (message.code !== 'settings') break
      // The notice itself is already shown.
      if (pendingCopy) finishCopy(null)
      if (copier.loading) {
        clearTimeout(listTimer)
        copier.loading = false
        copier.failed = true
      }
      break
    default:
      break
  }
}

let installed = false

export function installSettingsSync() {
  if (installed) return
  installed = true
  meta = loadMeta()
  watch([() => SYNCED_KEYS.map((key) => settings[key]), () => keyboards.boards], schedule, { deep: true })
  onMessage(handle)
  watch(() => state.status, (status) => {
    if (status !== 'connected') {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  })
  document.addEventListener('visibilitychange', () => {
    // Closing the app shouldn't lose a change still waiting out the delay.
    if (document.visibilityState === 'hidden' && saveTimer !== undefined) {
      commit()
      push()
    }
  })
}

let relative: Intl.RelativeTimeFormat | null = null
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['minute', 60],
  ['hour', 3600],
  ['day', 86400],
  ['week', 604800],
  ['month', 2629800],
  ['year', 31557600],
]

/** "just now", "5 minutes ago", "yesterday". */
export function ago(then: number, now = Date.now()): string {
  const seconds = Math.round((then - now) / 1000)
  if (Math.abs(seconds) < 45) return 'just now'
  let unit = UNITS[0]!
  for (const u of UNITS) if (Math.abs(seconds) >= u[1]) unit = u
  relative ??= new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  return relative.format(Math.round(seconds / unit[1]), unit[0])
}
