import { describe, expect, it } from 'vitest'
import { PointerGain, boost } from '@/lib/pointerGain'

describe('pointer acceleration', () => {
  it('follows the linear ramp away from its corners', () => {
    expect(boost(0)).toBeLessThan(0.01)
    expect(boost(0.08 + 0.9)).toBeCloseTo(1, 1)
    expect(boost(10)).toBeCloseTo(2.2, 2)
  })

  it('never jumps as the finger speeds up', () => {
    let last = boost(0)
    for (let speed = 0.001; speed < 4; speed += 0.001) {
      const next = boost(speed)
      expect(next).toBeGreaterThanOrEqual(last - 1e-12)
      // The ramp's slope is 1/0.9 per px/ms; nothing steeper than that.
      expect(next - last).toBeLessThan(0.0012)
      last = next
    }
  })

  it('keeps the gain steady for a steady finger with uneven sample timing', () => {
    const acceleration = new PointerGain()
    const options = { speed: 4, acceleration: 1 }
    const gains: number[] = []
    // The finger moves 8 px per 8 ms sample, but the timestamps arrive 4 and
    // 12 ms apart, so the raw speed swings between 2 and 0.67 px/ms.
    for (let i = 0; i < 80; i++) gains.push(acceleration.gain(8, 0, i % 2 ? 12 : 4, options))
    const settled = gains.slice(30)
    const spread = (Math.max(...settled) - Math.min(...settled)) / Math.min(...settled)
    expect(spread).toBeLessThan(0.1)
  })

  it('starts each touch from its own speed', () => {
    const acceleration = new PointerGain()
    const options = { speed: 1, acceleration: 0.6 }
    for (let i = 0; i < 20; i++) acceleration.gain(30, 0, 8, options)
    acceleration.reset()
    const slow = acceleration.gain(0.4, 0, 8, options)
    const fresh = new PointerGain().gain(0.4, 0, 8, options)
    expect(slow).toBe(fresh)
  })
})
