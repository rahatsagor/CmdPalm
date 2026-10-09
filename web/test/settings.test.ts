import { describe, expect, it } from 'vitest'
import { defaultSettings, migrate } from '../src/lib/settings'

describe('migrating stored settings', () => {
  it('keeps other settings when a gesture map is null', () => {
    const out = migrate({ pointerSpeed: 2, theme: 'light', threeFinger: null, fourFinger: null })
    expect(out.pointerSpeed).toBe(2)
    expect(out.theme).toBe('light')
    expect(out.threeFinger).toEqual(defaultSettings().threeFinger)
    expect(out.fourFinger).toEqual(defaultSettings().fourFinger)
  })

  it('keeps known gesture slots and drops malformed ones', () => {
    const out = migrate({ threeFinger: { up: null, down: 'nope', tap: { kind: 'mouse', button: 'left' }, extra: null } })
    expect(out.threeFinger.up).toBeNull()
    expect(out.threeFinger.down).toEqual(defaultSettings().threeFinger.down)
    expect(out.threeFinger.tap).toEqual({ kind: 'mouse', button: 'left' })
    expect(out.threeFinger).not.toHaveProperty('extra')
  })

  it('drops values of the wrong type or outside the choices', () => {
    const out = migrate({ theme: 'sepia', haptics: 'yes', scrollSpeed: 99 })
    expect(out.theme).toBe('system')
    expect(out.haptics).toBe(true)
    expect(out.scrollSpeed).toBe(4)
  })
})
