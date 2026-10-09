// Mirrors core/src/protocol.rs and core/src/deck.rs. See docs/PROTOCOL.md.

export const PROTOCOL_VERSION = 1

export const Op = {
  Move: 0x01,
  Scroll: 0x02,
  Fling: 0x03,
  Touch: 0x04,
  Audio: 0x10,
} as const

export const ScrollPhase = {
  None: 0,
  Began: 1,
  Changed: 2,
  Ended: 4,
  Cancelled: 8,
} as const

/** Wire modifier bits. */
export const Mod = {
  Command: 1,
  Shift: 2,
  Option: 4,
  Control: 8,
  Fn: 16,
} as const

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward'
export type PressOp = 'down' | 'up' | 'click'
export type MediaKey =
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'brightnessUp'
  | 'brightnessDown'
  | 'playPause'
  | 'next'
  | 'previous'
  | 'fastForward'
  | 'rewind'
  | 'illuminationUp'
  | 'illuminationDown'
  | 'illuminationToggle'
export type AppOp = 'open' | 'toggle' | 'hide' | 'quit'

export const SYSTEM_ACTIONS = [
  'missionControl',
  'appExpose',
  'showDesktop',
  'launchpad',
  'spotlight',
  'spaceLeft',
  'spaceRight',
  'appSwitcher',
  'lockScreen',
  'sleepDisplay',
  'sleep',
  'screenshot',
  'screenshotArea',
  'screenshotTool',
  'forceQuit',
  'emojiPicker',
  'closeWindow',
  'quitApp',
  'minimize',
  'hideApp',
  'fullscreen',
  'undo',
  'redo',
  'copy',
  'cut',
  'paste',
  'selectAll',
  'find',
  'newTab',
  'closeTab',
  'nextTab',
  'previousTab',
  'back',
  'forward',
  'reload',
  'zoomIn',
  'zoomOut',
  'actualSize',
] as const
export type SystemAction = (typeof SYSTEM_ACTIONS)[number]

export type Action =
  | { kind: 'keys'; code: number; mods: number; char?: string }
  | { kind: 'text'; text: string; enter?: boolean }
  | { kind: 'media'; key: MediaKey }
  | { kind: 'app'; id: string; op?: AppOp }
  | { kind: 'url'; url: string }
  | { kind: 'system'; name: SystemAction }
  | { kind: 'shortcut'; name: string }
  | { kind: 'shell'; command: string }
  | { kind: 'mouse'; button: MouseButton; clicks?: number }
  | { kind: 'delay'; ms: number }
  | { kind: 'sequence'; steps: Action[] }

export type TileIcon = { kind: 'app'; id: string } | { kind: 'symbol'; name: string } | { kind: 'emoji'; text: string }

export interface Tile {
  id: string
  label: string
  icon?: TileIcon
  color?: string
  action: Action
}

export interface DeckPage {
  id: string
  name: string
  columns: number
  tiles: Tile[]
}

export interface Deck {
  version: 1
  pages: DeckPage[]
}

export type TextMode = 'unicode' | 'keystrokes' | 'paste'

export interface DeviceInfo {
  id: string
  name: string
  model: string
}

/** A device's own settings as kept on the Mac. `updatedAt` is ms since 1970. */
export interface SavedSettings {
  settings: Record<string, unknown>
  updatedAt: number
}

/** Another paired device whose settings can be copied. */
export interface SettingsSource {
  id: string
  name: string
  model: string
  updatedAt: number
}

export type AuthRequest =
  | { method: 'token'; token: string }
  | { method: 'pair'; code: string }
  | { method: 'pin'; pin: string }
  | { method: 'approve' }

export type ClientMessage =
  | { t: 'hello'; v: number; device: DeviceInfo; auth: AuthRequest; remember: boolean }
  | { t: 'ping'; id: number }
  | { t: 'key'; code: number; down: boolean; mods?: number; repeat?: boolean }
  | { t: 'tap'; code: number; mods?: number }
  | { t: 'button'; button: MouseButton; op: PressOp; mods?: number }
  | { t: 'media'; key: MediaKey; op: PressOp }
  | { t: 'text'; text: string; mode?: TextMode }
  | { t: 'edit'; delete: number; insert: string }
  | { t: 'action'; action: Action; id?: number }
  | { t: 'release' }
  | { t: 'apps' }
  | { t: 'appAction'; id: string; op: AppOp }
  | { t: 'deckSave'; deck: Deck }
  | { t: 'volume'; value?: number; muted?: boolean }
  | { t: 'clipboardSet'; text: string }
  | { t: 'clipboardGet' }
  | { t: 'voiceStart'; locale?: string }
  | { t: 'voiceStop'; cancel?: boolean }
  | ({ t: 'settingsSave' } & SavedSettings)
  | { t: 'settingsList' }
  | { t: 'settingsCopy'; from: string }

export interface Features {
  voice: boolean
  shell: boolean
  secure: boolean
  permission: boolean
}

export interface KeyCap {
  code: number
  base: string
  shift: string
  option?: string
  optionShift?: string
  /** Bit mask of levels that are dead keys (1 base, 2 shift, 4 option, 8 option-shift). */
  dead?: number
}

export interface KeyboardLayout {
  id: string
  name: string
  iso: boolean
  keys: KeyCap[]
}

export interface AppEntry {
  id: string
  name: string
  running: boolean
  active: boolean
  hidden: boolean
}

export interface VolumeState {
  value: number
  muted: boolean
}

export type DenyReason = 'unknown' | 'wrongPin' | 'expiredCode' | 'rejected' | 'blocked' | 'busy' | 'incompatible'
export type VoiceState = 'listening' | 'stopped' | 'unavailable' | 'error'

export type ServerMessage =
  | {
      t: 'welcome'
      v: number
      host: { name: string; version: string; os: string }
      sessionKey: string
      token?: string
      features: Features
      deck: Deck
      layout?: KeyboardLayout
      volume?: VolumeState
      paused: boolean
      /** This device's settings saved on the Mac earlier, if any. */
      settings?: SavedSettings
    }
  | { t: 'pending' }
  | { t: 'denied'; reason: DenyReason; retryAfter?: number }
  | { t: 'pong'; id: number }
  | { t: 'apps'; apps: AppEntry[] }
  | { t: 'appsChanged' }
  | { t: 'deck'; deck: Deck }
  | { t: 'layout'; layout: KeyboardLayout }
  | ({ t: 'volume' } & VolumeState)
  | { t: 'volumeUnavailable' }
  | { t: 'paused'; paused: boolean }
  | { t: 'features'; features: Features }
  | { t: 'notice'; level: 'info' | 'warning' | 'error'; code: string; message: string }
  | { t: 'clipboard'; text: string }
  | { t: 'voice'; state: VoiceState; text?: string; final: boolean; message?: string }
  | { t: 'actionResult'; id?: number; ok: boolean; message?: string }
  | { t: 'settingsList'; devices: SettingsSource[] }
  | ({ t: 'settings' } & SavedSettings)
  /** `reconnect`: the Mac stopped or restarted its server, so retry with the token. */
  | { t: 'bye'; reason: string; reconnect?: boolean }

export function encodeMove(dx: number, dy: number): ArrayBuffer {
  const buf = new ArrayBuffer(9)
  const view = new DataView(buf)
  view.setUint8(0, Op.Move)
  view.setFloat32(1, dx, true)
  view.setFloat32(5, dy, true)
  return buf
}

export function encodeScroll(phase: number, dx: number, dy: number): ArrayBuffer {
  const buf = new ArrayBuffer(10)
  const view = new DataView(buf)
  view.setUint8(0, Op.Scroll)
  view.setUint8(1, phase)
  view.setFloat32(2, dx, true)
  view.setFloat32(6, dy, true)
  return buf
}

export function encodeFling(vx: number, vy: number): ArrayBuffer {
  const buf = new ArrayBuffer(9)
  const view = new DataView(buf)
  view.setUint8(0, Op.Fling)
  view.setFloat32(1, vx, true)
  view.setFloat32(5, vy, true)
  return buf
}

export function encodeTouch(): ArrayBuffer {
  return new Uint8Array([Op.Touch]).buffer
}

export function encodeAudio(pcm: Int16Array): ArrayBuffer {
  const out = new Uint8Array(1 + pcm.byteLength)
  out[0] = Op.Audio
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1)
  return out.buffer
}
