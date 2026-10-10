// Custom keyboards: named grids of keys a person builds for one job, such as
// arrows and space for presentations or WASD for a game. Keys are held while
// the finger is down, so several can be pressed together.
//
// Stored per device (and backed up on the Mac with this device's settings): a
// layout made for a phone's screen rarely suits a tablet's.

import { reactive, watch } from 'vue'
import { MEDIA } from './actions'
import { comboLabel, Key, MOD_ORDER, MODIFIER_CODES, type LabelMap } from './keys'
import { Mod, type MediaKey, type MouseButton } from './protocol'

export type CustomAction =
  | { kind: 'key'; code: number; mods: number }
  | { kind: 'mod'; mod: number }
  | { kind: 'media'; key: MediaKey }
  | { kind: 'mouse'; button: MouseButton }

export interface CustomKey {
  id: string
  /** Top-left cell and size, in grid cells. */
  x: number
  y: number
  w: number
  h: number
  action: CustomAction
  label?: string
}

export interface CustomKeyboard {
  id: string
  name: string
  cols: number
  rows: number
  /** Show a trackpad next to the keys. */
  trackpad: boolean
  keys: CustomKey[]
}

export const LIMITS = { minCols: 2, maxCols: 12, minRows: 1, maxRows: 8, boards: 24, name: 32, label: 12 } as const

const STORAGE_KEY = 'cmdpalm.keyboards'
const MOUSE_BUTTONS: MouseButton[] = ['left', 'right', 'middle']
const MOUSE_LABELS: Partial<Record<MouseButton, string>> = { left: 'Click', right: 'Right-click', middle: 'Middle click' }

export const newId = () => Math.random().toString(36).slice(2, 10)

const key = (x: number, y: number, action: CustomAction, w = 1, h = 1, label?: string): CustomKey => ({
  id: newId(),
  x,
  y,
  w,
  h,
  action,
  ...(label ? { label } : {}),
})
const k = (code: number, mods = 0): CustomAction => ({ kind: 'key', code, mods })

export function presets(): CustomKeyboard[] {
  return [
    {
      id: newId(),
      name: 'Presentation',
      cols: 4,
      rows: 3,
      trackpad: false,
      keys: [
        key(0, 0, k(Key.Escape)),
        key(1, 0, k(Key.B), 1, 1, 'Blank'),
        // Keynote's Play Slideshow.
        key(2, 0, k(Key.P, Mod.Command | Mod.Option), 2, 1, 'Play'),
        key(0, 1, k(Key.Left), 2, 2, 'Back'),
        key(2, 1, k(Key.Right), 2, 2, 'Next'),
      ],
    },
    {
      id: newId(),
      name: 'Game',
      cols: 6,
      rows: 3,
      trackpad: true,
      keys: [
        key(0, 0, k(Key.Escape)),
        key(1, 0, k(Key.Q)),
        key(2, 0, k(Key.W)),
        key(3, 0, k(Key.E)),
        key(4, 0, k(Key.R)),
        key(5, 0, k(Key.Tab)),
        key(0, 1, { kind: 'mod', mod: Mod.Shift }),
        key(1, 1, k(Key.A)),
        key(2, 1, k(Key.S)),
        key(3, 1, k(Key.D)),
        key(4, 1, k(Key.F)),
        key(5, 1, { kind: 'mouse', button: 'left' }, 1, 2, 'Click'),
        key(0, 2, { kind: 'mod', mod: Mod.Control }),
        key(1, 2, k(Key.Space), 4, 1),
      ],
    },
    {
      id: newId(),
      name: 'Editing',
      cols: 4,
      rows: 3,
      trackpad: true,
      keys: [
        key(0, 0, k(Key.Z, Mod.Command), 1, 1, 'Undo'),
        key(1, 0, k(Key.Z, Mod.Command | Mod.Shift), 1, 1, 'Redo'),
        key(2, 0, k(Key.S, Mod.Command), 1, 1, 'Save'),
        key(3, 0, k(Key.Delete)),
        key(0, 1, k(Key.C, Mod.Command), 1, 1, 'Copy'),
        key(1, 1, k(Key.V, Mod.Command), 1, 1, 'Paste'),
        key(2, 1, k(Key.Up)),
        key(3, 1, k(Key.Return)),
        key(0, 2, { kind: 'mod', mod: Mod.Shift }),
        key(1, 2, k(Key.Left)),
        key(2, 2, k(Key.Down)),
        key(3, 2, k(Key.Right)),
      ],
    },
  ]
}

export function overlaps(a: Pick<CustomKey, 'x' | 'y' | 'w' | 'h'>, b: Pick<CustomKey, 'x' | 'y' | 'w' | 'h'>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Whether `rect` fits on the board without covering a key other than `ignore`. */
export function fits(board: CustomKeyboard, rect: Pick<CustomKey, 'x' | 'y' | 'w' | 'h'>, ignore?: string): boolean {
  if (rect.x < 0 || rect.y < 0 || rect.w < 1 || rect.h < 1) return false
  if (rect.x + rect.w > board.cols || rect.y + rect.h > board.rows) return false
  return board.keys.every((other) => other.id === ignore || !overlaps(other, rect))
}

/** Every key still fits after resizing the grid to `cols` × `rows`. */
export function canResize(board: CustomKeyboard, cols: number, rows: number): boolean {
  return board.keys.every((key) => key.x + key.w <= cols && key.y + key.h <= rows)
}

/** Cells not covered by any key, in reading order. */
export function emptyCells(board: CustomKeyboard): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = []
  for (let y = 0; y < board.rows; y++) {
    for (let x = 0; x < board.cols; x++) {
      if (board.keys.every((key) => !overlaps(key, { x, y, w: 1, h: 1 }))) cells.push({ x, y })
    }
  }
  return cells
}

export function actionLabel(action: CustomAction, labels: LabelMap): string {
  switch (action.kind) {
    case 'key':
      return comboLabel(action.code, action.mods, labels)
    case 'mod':
      return MOD_ORDER.find((m) => m.mod === action.mod)?.symbol ?? '?'
    case 'media':
      return MEDIA[action.key]?.label ?? action.key
    case 'mouse':
      return MOUSE_LABELS[action.button] ?? action.button
  }
}

export function actionName(action: CustomAction): string {
  if (action.kind === 'mod') return MOD_ORDER.find((m) => m.mod === action.mod)?.name ?? 'Modifier'
  return ''
}

const int = (value: unknown, lo: number, hi: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi ? value : null

function sanitizeAction(raw: unknown): CustomAction | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  switch (a.kind) {
    case 'key': {
      const code = int(a.code, 0, 0x7f)
      const mods = int(a.mods ?? 0, 0, 0x1f)
      if (code === null || mods === null) return null
      // A modifier stored as a plain key behaves as a held modifier.
      if (MODIFIER_CODES[code] !== undefined) return { kind: 'mod', mod: MODIFIER_CODES[code]! }
      return { kind: 'key', code, mods }
    }
    case 'mod':
      return MOD_ORDER.some((m) => m.mod === a.mod) ? { kind: 'mod', mod: a.mod as number } : null
    case 'media':
      return typeof a.key === 'string' && a.key in MEDIA ? { kind: 'media', key: a.key as MediaKey } : null
    case 'mouse':
      return MOUSE_BUTTONS.includes(a.button as MouseButton) ? { kind: 'mouse', button: a.button as MouseButton } : null
    default:
      return null
  }
}

export function sanitizeBoard(raw: unknown): CustomKeyboard | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const cols = int(b.cols, LIMITS.minCols, LIMITS.maxCols)
  const rows = int(b.rows, LIMITS.minRows, LIMITS.maxRows)
  if (cols === null || rows === null) return null
  const board: CustomKeyboard = {
    id: typeof b.id === 'string' && b.id ? b.id.slice(0, 32) : newId(),
    name: (typeof b.name === 'string' ? b.name.trim().slice(0, LIMITS.name) : '') || 'Keyboard',
    cols,
    rows,
    trackpad: b.trackpad === true,
    keys: [],
  }
  for (const item of Array.isArray(b.keys) ? b.keys : []) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const action = sanitizeAction(r.action)
    const x = int(r.x, 0, cols - 1)
    const y = int(r.y, 0, rows - 1)
    const w = int(r.w, 1, cols)
    const h = int(r.h, 1, rows)
    if (!action || x === null || y === null || w === null || h === null) continue
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, LIMITS.label) : ''
    const keyId = typeof r.id === 'string' && r.id && board.keys.every((other) => other.id !== r.id) ? r.id.slice(0, 32) : newId()
    const candidate: CustomKey = { id: keyId, x, y, w, h, action, ...(label ? { label } : {}) }
    // Drop keys that fall off the grid or cover another one.
    if (fits(board, candidate)) board.keys.push(candidate)
  }
  return board
}

interface Stored {
  active: string
  boards: CustomKeyboard[]
}

export function migrateKeyboards(raw: unknown): Stored {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const seen = new Set<string>()
  const boards = (Array.isArray(source.boards) ? source.boards : [])
    .map(sanitizeBoard)
    .filter((b): b is CustomKeyboard => {
      if (!b || seen.has(b.id)) return false
      seen.add(b.id)
      return true
    })
    .slice(0, LIMITS.boards)
  if (boards.length === 0) boards.push(...presets())
  const active = typeof source.active === 'string' && boards.some((b) => b.id === source.active) ? source.active : boards[0]!.id
  return { active, boards }
}

function load(): Stored {
  try {
    return migrateKeyboards(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return migrateKeyboards(null)
  }
}

export const keyboards = reactive<Stored>(load())

let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(
  keyboards,
  () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(keyboards))
      } catch {
        // Storage unavailable: changes last for this session.
      }
    }, 200)
  },
  { deep: true },
)

export function activeBoard(): CustomKeyboard {
  return keyboards.boards.find((b) => b.id === keyboards.active) ?? keyboards.boards[0]!
}

export function addBoard(board: CustomKeyboard): boolean {
  if (keyboards.boards.length >= LIMITS.boards) return false
  keyboards.boards.push(board)
  keyboards.active = board.id
  return true
}

export function removeBoard(id: string) {
  const index = keyboards.boards.findIndex((b) => b.id === id)
  if (index < 0 || keyboards.boards.length <= 1) return
  keyboards.boards.splice(index, 1)
  if (keyboards.active === id) keyboards.active = keyboards.boards[Math.max(0, index - 1)]!.id
}

export function blankBoard(): CustomKeyboard {
  return { id: newId(), name: 'New keyboard', cols: 4, rows: 3, trackpad: false, keys: [] }
}

export function copyBoard(board: CustomKeyboard): CustomKeyboard {
  // JSON rather than structuredClone: boards are reactive proxies.
  const copy = JSON.parse(JSON.stringify(board)) as CustomKeyboard
  return {
    ...copy,
    id: newId(),
    name: `${board.name} copy`.slice(0, LIMITS.name),
    keys: copy.keys.map((key) => ({ ...key, id: newId() })),
  }
}
