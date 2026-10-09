import { describe, expect, it } from 'vitest'
import { Key, LabelMap, comboLabel } from '../src/lib/keys'
import { Mod } from '../src/lib/protocol'
import { migrate } from '../src/lib/settings'

describe('layout labels', () => {
  it('defaults to US and follows the Mac layout when known', () => {
    const us = new LabelMap()
    expect(us.label(Key.Q, 0)).toBe('Q')
    expect(us.label(Key.Two, Mod.Shift)).toBe('@')
    const azerty = new LabelMap({
      id: 'fr',
      name: 'French',
      iso: true,
      keys: [
        { code: Key.Q, base: 'a', shift: 'A' },
        { code: Key.A, base: 'q', shift: 'Q', option: '‡' },
        { code: Key.E, base: 'e', shift: 'E', option: '´' },
      ],
    })
    expect(azerty.label(Key.Q, 0)).toBe('A')
    expect(azerty.forChar('q')).toEqual({ code: Key.A, mods: 0 })
    expect(azerty.forChar('Q')).toEqual({ code: Key.A, mods: Mod.Shift })
    expect(azerty.forChar('‡')).toEqual({ code: Key.A, mods: Mod.Option })
  })

  it('formats combos in Mac order', () => {
    expect(comboLabel(Key.Four, Mod.Command | Mod.Shift, new LabelMap())).toBe('⇧⌘4')
    expect(comboLabel(Key.Left, Mod.Control, new LabelMap())).toBe('⌃←')
  })
})

describe('settings', () => {
  it('drops malformed values and clamps ranges', () => {
    const s = migrate({ pointerSpeed: 99, naturalScroll: 'yes', threeFinger: { up: null, sideways: 1 }, bogus: true })
    expect(s.pointerSpeed).toBe(4)
    expect(s.naturalScroll).toBe(true)
    expect(s.threeFinger.up).toBeNull()
    expect(s.threeFinger.down).toEqual({ kind: 'system', name: 'appExpose' })
    expect('bogus' in s).toBe(false)
  })
})
