// macOS virtual key codes (key positions) and the on-screen keyboard layout.
// Labels come from the Mac's active input source when available so the caps
// always show what the Mac will type.

import { Mod, type KeyboardLayout, type MediaKey, type SystemAction } from './protocol'

export const Key = {
  A: 0x00, S: 0x01, D: 0x02, F: 0x03, H: 0x04, G: 0x05, Z: 0x06, X: 0x07, C: 0x08, V: 0x09,
  ISOSection: 0x0a, B: 0x0b, Q: 0x0c, W: 0x0d, E: 0x0e, R: 0x0f, Y: 0x10, T: 0x11,
  One: 0x12, Two: 0x13, Three: 0x14, Four: 0x15, Six: 0x16, Five: 0x17, Equal: 0x18, Nine: 0x19,
  Seven: 0x1a, Minus: 0x1b, Eight: 0x1c, Zero: 0x1d, RightBracket: 0x1e, O: 0x1f, U: 0x20,
  LeftBracket: 0x21, I: 0x22, P: 0x23, Return: 0x24, L: 0x25, J: 0x26, Quote: 0x27, K: 0x28,
  Semicolon: 0x29, Backslash: 0x2a, Comma: 0x2b, Slash: 0x2c, N: 0x2d, M: 0x2e, Period: 0x2f,
  Tab: 0x30, Space: 0x31, Grave: 0x32, Delete: 0x33, Escape: 0x35, RightCommand: 0x36,
  Command: 0x37, Shift: 0x38, CapsLock: 0x39, Option: 0x3a, Control: 0x3b, RightShift: 0x3c,
  RightOption: 0x3d, RightControl: 0x3e, Fn: 0x3f,
  F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61, F7: 0x62, F8: 0x64, F9: 0x65,
  F10: 0x6d, F11: 0x67, F12: 0x6f,
  Home: 0x73, PageUp: 0x74, ForwardDelete: 0x75, End: 0x77, PageDown: 0x79,
  Left: 0x7b, Right: 0x7c, Down: 0x7d, Up: 0x7e,
} as const

export const MODIFIER_CODES: Record<number, number> = {
  [Key.Command]: Mod.Command,
  [Key.RightCommand]: Mod.RightCommand,
  [Key.Shift]: Mod.Shift,
  [Key.RightShift]: Mod.RightShift,
  [Key.Option]: Mod.Option,
  [Key.RightOption]: Mod.RightOption,
  [Key.Control]: Mod.Control,
  [Key.RightControl]: Mod.RightControl,
  [Key.Fn]: Mod.Fn,
}

const SIDES: [right: number, plain: number][] = [
  [Mod.RightCommand, Mod.Command],
  [Mod.RightShift, Mod.Shift],
  [Mod.RightOption, Mod.Option],
  [Mod.RightControl, Mod.Control],
]

/** The plain modifiers in `mods`, whichever side they are on: for labels. */
export function plainMods(mods: number): number {
  let plain = mods & 0x1f
  for (const [right, generic] of SIDES) if (mods & right) plain |= generic
  return plain
}

export const MOD_ORDER: { mod: number; code: number; symbol: string; name: string }[] = [
  { mod: Mod.Control, code: Key.Control, symbol: '⌃', name: 'Control' },
  { mod: Mod.Option, code: Key.Option, symbol: '⌥', name: 'Option' },
  { mod: Mod.Shift, code: Key.Shift, symbol: '⇧', name: 'Shift' },
  { mod: Mod.Command, code: Key.Command, symbol: '⌘', name: 'Command' },
  { mod: Mod.Fn, code: Key.Fn, symbol: 'fn', name: 'Function' },
]

/** The keys on the right of a Mac keyboard, which some apps treat differently. */
export const RIGHT_MODS: typeof MOD_ORDER = [
  { mod: Mod.RightControl, code: Key.RightControl, symbol: '⌃', name: 'Right Control' },
  { mod: Mod.RightOption, code: Key.RightOption, symbol: '⌥', name: 'Right Option' },
  { mod: Mod.RightShift, code: Key.RightShift, symbol: '⇧', name: 'Right Shift' },
  { mod: Mod.RightCommand, code: Key.RightCommand, symbol: '⌘', name: 'Right Command' },
]

export const ALL_MODS = [...MOD_ORDER, ...RIGHT_MODS]

/** US ANSI labels, used until the Mac reports its layout. */
const US: Record<number, [string, string]> = {
  [Key.Grave]: ['`', '~'], [Key.One]: ['1', '!'], [Key.Two]: ['2', '@'], [Key.Three]: ['3', '#'],
  [Key.Four]: ['4', '$'], [Key.Five]: ['5', '%'], [Key.Six]: ['6', '^'], [Key.Seven]: ['7', '&'],
  [Key.Eight]: ['8', '*'], [Key.Nine]: ['9', '('], [Key.Zero]: ['0', ')'], [Key.Minus]: ['-', '_'],
  [Key.Equal]: ['=', '+'], [Key.Q]: ['q', 'Q'], [Key.W]: ['w', 'W'], [Key.E]: ['e', 'E'],
  [Key.R]: ['r', 'R'], [Key.T]: ['t', 'T'], [Key.Y]: ['y', 'Y'], [Key.U]: ['u', 'U'],
  [Key.I]: ['i', 'I'], [Key.O]: ['o', 'O'], [Key.P]: ['p', 'P'], [Key.LeftBracket]: ['[', '{'],
  [Key.RightBracket]: [']', '}'], [Key.Backslash]: ['\\', '|'], [Key.A]: ['a', 'A'],
  [Key.S]: ['s', 'S'], [Key.D]: ['d', 'D'], [Key.F]: ['f', 'F'], [Key.G]: ['g', 'G'],
  [Key.H]: ['h', 'H'], [Key.J]: ['j', 'J'], [Key.K]: ['k', 'K'], [Key.L]: ['l', 'L'],
  [Key.Semicolon]: [';', ':'], [Key.Quote]: ["'", '"'], [Key.Z]: ['z', 'Z'], [Key.X]: ['x', 'X'],
  [Key.C]: ['c', 'C'], [Key.V]: ['v', 'V'], [Key.B]: ['b', 'B'], [Key.N]: ['n', 'N'],
  [Key.M]: ['m', 'M'], [Key.Comma]: [',', '<'], [Key.Period]: ['.', '>'], [Key.Slash]: ['/', '?'],
  [Key.ISOSection]: ['§', '±'], [Key.Space]: [' ', ' '],
}

export interface Labels {
  base: string
  shift: string
  option: string
  optionShift: string
}

export class LabelMap {
  private readonly caps = new Map<number, Labels>()
  private readonly chars = new Map<string, { code: number; mods: number }>()
  readonly iso: boolean
  readonly name: string

  constructor(layout?: KeyboardLayout) {
    this.iso = layout?.iso ?? false
    this.name = layout?.name ?? 'U.S.'
    for (const [code, [base, shift]] of Object.entries(US)) {
      this.caps.set(Number(code), { base, shift, option: '', optionShift: '' })
    }
    const dead = new Map<number, number>()
    for (const cap of layout?.keys ?? []) {
      this.caps.set(cap.code, { base: cap.base, shift: cap.shift, option: cap.option ?? '', optionShift: cap.optionShift ?? '' })
      if (cap.dead) dead.set(cap.code, cap.dead)
    }
    // Prefer the simplest chord that produces each character. Dead keys only
    // start an accent, so they never stand for their label's character.
    const order: [keyof Labels, number, number][] = [
      ['base', 0, 1],
      ['shift', Mod.Shift, 2],
      ['option', Mod.Option, 4],
      ['optionShift', Mod.Option | Mod.Shift, 8],
    ]
    for (const [field, mods, bit] of order) {
      for (const [code, labels] of this.caps) {
        const ch = labels[field]
        if ((dead.get(code) ?? 0) & bit) continue
        if (ch && [...ch].length === 1 && !this.chars.has(ch)) this.chars.set(ch, { code, mods })
      }
    }
  }

  labels(code: number): Labels | undefined {
    return this.caps.get(code)
  }

  /** The label to show for `code` given the active modifiers. */
  label(code: number, mods: number): string {
    const caps = this.caps.get(code)
    if (!caps) return ''
    mods = plainMods(mods)
    const shift = (mods & Mod.Shift) !== 0
    const option = (mods & Mod.Option) !== 0
    let text = caps.base
    if (option && shift) text = caps.optionShift || caps.shift
    else if (option) text = caps.option || caps.base
    else if (shift) text = caps.shift
    return displayLabel(text)
  }

  /** Key position and modifiers that type `ch` on the Mac's layout. */
  forChar(ch: string): { code: number; mods: number } | undefined {
    return this.chars.get(ch) ?? this.chars.get(ch.toLowerCase())
  }
}

function displayLabel(text: string): string {
  if (!text) return ''
  // Dead keys and combining marks are invisible on their own.
  if (/^\p{M}$/u.test(text)) return `◌${text}`
  return text.length === 1 && /[a-z]/.test(text) ? text.toUpperCase() : text
}

export type KeySpec =
  | { kind: 'char'; code: number; width?: number }
  | { kind: 'special'; code: number; label: string; symbol?: string; width?: number; align?: 'left' | 'right' }
  | { kind: 'mod'; code: number; mod: number; label: string; symbol: string; width?: number; align?: 'left' | 'right' }
  | { kind: 'arrows' }
  | { kind: 'fn'; code: number; label: string; media?: MediaKey; system?: SystemAction; mediaLabel?: string }

const char = (code: number, width?: number): KeySpec => ({ kind: 'char', code, width })

// Not ↩: iOS draws it as an emoji, and with a text variation selector it
// falls back to a glyph much smaller than ⌫ and ⇥.
const RETURN = '⏎'

export function keyboardRows(iso: boolean): KeySpec[][] {
  return [
    [
      { kind: 'special', code: Key.Escape, label: 'esc', width: 1.4, align: 'left' },
      { kind: 'fn', code: Key.F1, label: 'F1', media: 'brightnessDown', mediaLabel: 'brightness down' },
      { kind: 'fn', code: Key.F2, label: 'F2', media: 'brightnessUp', mediaLabel: 'brightness up' },
      { kind: 'fn', code: Key.F3, label: 'F3', system: 'missionControl', mediaLabel: 'mission control' },
      { kind: 'fn', code: Key.F4, label: 'F4', system: 'spotlight', mediaLabel: 'spotlight' },
      { kind: 'fn', code: Key.F5, label: 'F5', media: 'illuminationDown', mediaLabel: 'backlight down' },
      { kind: 'fn', code: Key.F6, label: 'F6', media: 'illuminationUp', mediaLabel: 'backlight up' },
      { kind: 'fn', code: Key.F7, label: 'F7', media: 'previous', mediaLabel: 'previous' },
      { kind: 'fn', code: Key.F8, label: 'F8', media: 'playPause', mediaLabel: 'play/pause' },
      { kind: 'fn', code: Key.F9, label: 'F9', media: 'next', mediaLabel: 'next' },
      { kind: 'fn', code: Key.F10, label: 'F10', media: 'mute', mediaLabel: 'mute' },
      { kind: 'fn', code: Key.F11, label: 'F11', media: 'volumeDown', mediaLabel: 'volume down' },
      { kind: 'fn', code: Key.F12, label: 'F12', media: 'volumeUp', mediaLabel: 'volume up' },
      { kind: 'special', code: Key.ForwardDelete, label: 'del', symbol: '⌦', width: 1 },
    ],
    [
      char(iso ? Key.ISOSection : Key.Grave),
      char(Key.One), char(Key.Two), char(Key.Three), char(Key.Four), char(Key.Five), char(Key.Six),
      char(Key.Seven), char(Key.Eight), char(Key.Nine), char(Key.Zero), char(Key.Minus), char(Key.Equal),
      { kind: 'special', code: Key.Delete, label: 'delete', symbol: '⌫', width: 1.5, align: 'right' },
    ],
    [
      { kind: 'special', code: Key.Tab, label: 'tab', symbol: '⇥', width: 1.5, align: 'left' },
      char(Key.Q), char(Key.W), char(Key.E), char(Key.R), char(Key.T), char(Key.Y), char(Key.U),
      char(Key.I), char(Key.O), char(Key.P), char(Key.LeftBracket), char(Key.RightBracket),
      char(Key.Backslash, 1.0),
    ],
    [
      { kind: 'special', code: Key.CapsLock, label: 'caps', symbol: '⇪', width: 1.8, align: 'left' },
      char(Key.A), char(Key.S), char(Key.D), char(Key.F), char(Key.G), char(Key.H), char(Key.J),
      char(Key.K), char(Key.L), char(Key.Semicolon), char(Key.Quote),
      { kind: 'special', code: Key.Return, label: 'return', symbol: RETURN, width: 1.7, align: 'right' },
    ],
    [
      { kind: 'mod', code: Key.Shift, mod: Mod.Shift, label: 'shift', symbol: '⇧', width: iso ? 1.25 : 2.3, align: 'left' },
      ...(iso ? [char(Key.Grave)] : []),
      char(Key.Z), char(Key.X), char(Key.C), char(Key.V), char(Key.B), char(Key.N), char(Key.M),
      char(Key.Comma), char(Key.Period), char(Key.Slash),
      { kind: 'mod', code: Key.RightShift, mod: Mod.RightShift, label: 'shift', symbol: '⇧', width: 2.2, align: 'right' },
    ],
    [
      { kind: 'mod', code: Key.Fn, mod: Mod.Fn, label: 'fn', symbol: 'fn', width: 1, align: 'left' },
      { kind: 'mod', code: Key.Control, mod: Mod.Control, label: 'control', symbol: '⌃', width: 1, align: 'right' },
      { kind: 'mod', code: Key.Option, mod: Mod.Option, label: 'option', symbol: '⌥', width: 1, align: 'right' },
      { kind: 'mod', code: Key.Command, mod: Mod.Command, label: 'command', symbol: '⌘', width: 1.25, align: 'right' },
      { kind: 'special', code: Key.Space, label: '', width: 5.0 },
      { kind: 'mod', code: Key.RightCommand, mod: Mod.RightCommand, label: 'command', symbol: '⌘', width: 1.25, align: 'left' },
      { kind: 'mod', code: Key.RightOption, mod: Mod.RightOption, label: 'option', symbol: '⌥', width: 1, align: 'left' },
      { kind: 'arrows' },
    ],
  ]
}

/** Human-readable name for a key position, used in combo labels. */
export function keyName(code: number, labels: LabelMap): string {
  const special: Record<number, string> = {
    [Key.Return]: RETURN, [Key.Tab]: '⇥', [Key.Space]: 'Space', [Key.Delete]: '⌫', [Key.Escape]: 'esc',
    [Key.ForwardDelete]: '⌦', [Key.Left]: '←', [Key.Right]: '→', [Key.Up]: '↑', [Key.Down]: '↓',
    [Key.Home]: '⇱', [Key.End]: '⇲', [Key.PageUp]: '⇞', [Key.PageDown]: '⇟', [Key.CapsLock]: '⇪',
    [Key.F1]: 'F1', [Key.F2]: 'F2', [Key.F3]: 'F3', [Key.F4]: 'F4', [Key.F5]: 'F5', [Key.F6]: 'F6',
    [Key.F7]: 'F7', [Key.F8]: 'F8', [Key.F9]: 'F9', [Key.F10]: 'F10', [Key.F11]: 'F11', [Key.F12]: 'F12',
  }
  return special[code] ?? (labels.label(code, 0) || `#${code}`)
}

const DOM_CODES: Record<string, number> = {
  Minus: Key.Minus, Equal: Key.Equal, BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket,
  Backslash: Key.Backslash, Semicolon: Key.Semicolon, Quote: Key.Quote, Comma: Key.Comma,
  Period: Key.Period, Slash: Key.Slash, Backquote: Key.Grave, IntlBackslash: Key.ISOSection,
  Enter: Key.Return, NumpadEnter: Key.Return, Tab: Key.Tab, Space: Key.Space, Backspace: Key.Delete,
  Delete: Key.ForwardDelete, Escape: Key.Escape, ArrowLeft: Key.Left, ArrowRight: Key.Right,
  ArrowUp: Key.Up, ArrowDown: Key.Down, Home: Key.Home, End: Key.End, PageUp: Key.PageUp,
  PageDown: Key.PageDown,
  Digit0: Key.Zero, Digit1: Key.One, Digit2: Key.Two, Digit3: Key.Three, Digit4: Key.Four,
  Digit5: Key.Five, Digit6: Key.Six, Digit7: Key.Seven, Digit8: Key.Eight, Digit9: Key.Nine,
}

/**
 * Mac key position for a hardware `KeyboardEvent.code` (e.g. an iPad's Magic
 * Keyboard). Software keyboards report no code and return undefined.
 */
export function fromDomCode(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return Key[code.slice(3) as keyof typeof Key]
  if (/^F([1-9]|1[0-2])$/.test(code)) return Key[code as keyof typeof Key]
  return DOM_CODES[code]
}

export const SPECIAL_KEYS: { code: number; label: string }[] = [
  { code: Key.Return, label: 'Return' }, { code: Key.Tab, label: 'Tab' }, { code: Key.Space, label: 'Space' },
  { code: Key.Delete, label: 'Delete' }, { code: Key.ForwardDelete, label: 'Fwd Del' }, { code: Key.Escape, label: 'Esc' },
  { code: Key.Left, label: '←' }, { code: Key.Right, label: '→' }, { code: Key.Up, label: '↑' }, { code: Key.Down, label: '↓' },
  { code: Key.Home, label: 'Home' }, { code: Key.End, label: 'End' }, { code: Key.PageUp, label: 'Page Up' },
  { code: Key.PageDown, label: 'Page Down' },
  ...Array.from({ length: 12 }, (_, i) => ({ code: Key[`F${i + 1}` as keyof typeof Key], label: `F${i + 1}` })),
]

export function modsLabel(mods: number): string {
  const plain = plainMods(mods)
  return MOD_ORDER.filter((m) => (plain & m.mod) !== 0)
    .map((m) => m.symbol)
    .join('')
}

export function comboLabel(code: number, mods: number, labels: LabelMap): string {
  return `${modsLabel(mods)}${keyName(code, labels)}`
}
