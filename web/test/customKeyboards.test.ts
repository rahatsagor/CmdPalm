import { describe, expect, it } from 'vitest'
import { canResize, copyBoard, emptyCells, fits, LIMITS, migrateKeyboards, presets, sanitizeBoard, type CustomKeyboard } from '../src/lib/customKeyboards'
import { Key } from '../src/lib/keys'
import { Mod } from '../src/lib/protocol'

const board = (keys: CustomKeyboard['keys'] = []): CustomKeyboard => ({ id: 'b', name: 'Test', cols: 4, rows: 2, trackpad: false, keys })
const key = (id: string, x: number, y: number, w = 1, h = 1) => ({ id, x, y, w, h, action: { kind: 'key' as const, code: Key.A, mods: 0 } })

describe('geometry', () => {
  it('fits keys only inside the grid and away from other keys', () => {
    const b = board([key('a', 0, 0, 2, 1)])
    expect(fits(b, { x: 2, y: 0, w: 2, h: 1 })).toBe(true)
    expect(fits(b, { x: 1, y: 0, w: 1, h: 1 })).toBe(false)
    expect(fits(b, { x: 3, y: 0, w: 2, h: 1 })).toBe(false)
    expect(fits(b, { x: 0, y: 1, w: 1, h: 2 })).toBe(false)
    // A key can always stay where it is.
    expect(fits(b, { x: 0, y: 0, w: 2, h: 1 }, 'a')).toBe(true)
  })

  it('refuses to shrink the grid under a key', () => {
    const b = board([key('a', 3, 1)])
    expect(canResize(b, 3, 2)).toBe(false)
    expect(canResize(b, 4, 1)).toBe(false)
    expect(canResize(b, 5, 3)).toBe(true)
  })

  it('lists empty cells in reading order', () => {
    const b = board([key('a', 0, 0, 3, 2)])
    expect(emptyCells(b)).toEqual([
      { x: 3, y: 0 },
      { x: 3, y: 1 },
    ])
  })
})

describe('sanitizing stored keyboards', () => {
  it('drops overlapping, off-grid and malformed keys', () => {
    const b = sanitizeBoard({
      id: 'x',
      name: '  Mine  ',
      cols: 3,
      rows: 1,
      keys: [
        key('a', 0, 0, 2, 1),
        key('b', 1, 0),
        key('c', 2, 0, 2, 1),
        { id: 'd', x: 2, y: 0, w: 1, h: 1, action: { kind: 'media', key: 'nope' } },
        { id: 'e', x: 2, y: 0, w: 1, h: 1, action: { kind: 'media', key: 'mute' } },
        'junk',
      ],
    })
    expect(b?.name).toBe('Mine')
    expect(b?.keys.map((k) => k.id)).toEqual(['a', 'e'])
  })

  it('turns a modifier stored as a key into a held modifier', () => {
    const b = sanitizeBoard({ cols: 2, rows: 1, keys: [{ id: 'm', x: 0, y: 0, w: 1, h: 1, action: { kind: 'key', code: Key.Command, mods: 0 } }] })
    expect(b?.keys[0]?.action).toEqual({ kind: 'mod', mod: Mod.Command })
  })

  it('keeps right-side modifiers and drops unknown ones', () => {
    const key = (action: unknown) => ({ id: 'm', x: 0, y: 0, w: 1, h: 1, action })
    expect(sanitizeBoard({ cols: 2, rows: 1, keys: [key({ kind: 'mod', mod: Mod.RightCommand })] })?.keys[0]?.action).toEqual({
      kind: 'mod',
      mod: Mod.RightCommand,
    })
    expect(sanitizeBoard({ cols: 2, rows: 1, keys: [key({ kind: 'key', code: Key.RightOption, mods: 0 })] })?.keys[0]?.action).toEqual({
      kind: 'mod',
      mod: Mod.RightOption,
    })
    expect(sanitizeBoard({ cols: 2, rows: 1, keys: [key({ kind: 'mod', mod: 0x1000 })] })?.keys).toEqual([])
  })

  it('rejects grids outside the limits', () => {
    expect(sanitizeBoard({ cols: LIMITS.maxCols + 1, rows: 2, keys: [] })).toBeNull()
    expect(sanitizeBoard({ cols: 2, rows: 0, keys: [] })).toBeNull()
  })

  it('falls back to the presets and a valid active keyboard', () => {
    const empty = migrateKeyboards(null)
    expect(empty.boards.length).toBe(presets().length)
    expect(empty.active).toBe(empty.boards[0]!.id)

    const kept = migrateKeyboards({ active: 'gone', boards: [board(), board()] })
    expect(kept.boards.length).toBe(1)
    expect(kept.active).toBe('b')
  })

  it('ships presets that pass their own validation', () => {
    for (const p of presets()) expect(sanitizeBoard(p)?.keys.length).toBe(p.keys.length)
  })
})

it('copies a keyboard with fresh ids', () => {
  const original = board([key('a', 0, 0)])
  const copy = copyBoard(original)
  expect(copy.id).not.toBe(original.id)
  expect(copy.keys[0]!.id).not.toBe('a')
  expect(copy.name).toBe('Test copy')
  copy.keys[0]!.x = 3
  expect(original.keys[0]!.x).toBe(0)
})
