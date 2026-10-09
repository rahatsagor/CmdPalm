// This device's settings, also kept on the Mac so they survive a cleared
// browser and can be copied to another phone or tablet. localStorage stays the
// primary store; the Mac's copy is applied only when it is newer.

import { reactive, watch } from 'vue'
import { ACTION_KINDS } from './actions'
import { notify, onMessage, send, state } from './connection'
import { keyboards, migrateKeyboards, presets, type CustomKeyboard } from './customKeyboards'
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
const withoutIds = (key: string, value: unknown) => (key === 'id' ? undefined : value)
const signature = (payload: SyncedSettings) => fnv1a(JSON.stringify(payload.settings) + JSON.stringify(payload.keyboards, withoutIds))

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

function validAction(raw: unknown): boolean {
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
let pendingCopy: { device: SettingsSource; resolve: (ok: boolean) => void } | null = null

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

function finishCopy(ok: boolean) {
  clearTimeout(copyTimer)
  const pending = pendingCopy
  pendingCopy = null
  copier.copying = ''
  pending?.resolve(ok)
}

/** Replace this device's settings with `device`'s and keep them as this device's own. */
export function copyFrom(device: SettingsSource): Promise<boolean> {
  finishCopy(false)
  return new Promise((resolve) => {
    if (!send({ t: 'settingsCopy', from: device.id })) {
      notify('Not connected to the Mac.', 'error', 'settings')
      resolve(false)
      return
    }
    pendingCopy = { device, resolve }
    copier.copying = device.id
    copyTimer = setTimeout(() => {
      notify('The Mac didn’t answer. Try again.', 'error', 'settings')
      finishCopy(false)
    }, REPLY_TIMEOUT_MS)
  })
}

function copied(saved: SavedSettings | null) {
  const pending = pendingCopy
  if (!pending) return
  if (!saved) {
    notify('Those settings couldn’t be read.', 'error', 'settings')
    finishCopy(false)
    return
  }
  commit()
  applySynced(saved.settings)
  meta = { updatedAt: Math.max(Date.now(), meta.updatedAt + 1), hash: signature(buildPayload()) }
  storeMeta()
  push()
  notify(`Copied settings from ${pending.device.name}.`, 'info', 'settings')
  finishCopy(true)
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
      welcomed(parseSaved(message.settings))
      break
    case 'settings':
      copied(parseSaved(message))
      break
    case 'settingsList':
      clearTimeout(listTimer)
      copier.devices = parseDevices(message.devices)
      copier.loading = false
      copier.failed = false
      break
    case 'notice':
      if (message.code !== 'settings') break
      // The notice itself is already shown.
      if (pendingCopy) finishCopy(false)
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
