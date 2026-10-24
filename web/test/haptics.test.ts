import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('haptics on phones with the Vibration API', () => {
  const vibrate = vi.fn(() => true)

  beforeEach(() => {
    vi.resetModules()
    vibrate.mockClear()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true })
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'vibrate')
  })

  it('plays patterns long enough to feel', async () => {
    const { haptic, PATTERN, hapticsSupported } = await import('@/lib/haptics')
    expect(hapticsSupported).toBe(true)
    haptic('select')
    haptic('error')
    expect(vibrate).toHaveBeenNthCalledWith(1, PATTERN.select)
    expect(vibrate).toHaveBeenNthCalledWith(2, PATTERN.error)
    for (const pattern of Object.values(PATTERN)) expect(pattern[0]).toBeGreaterThanOrEqual(10)
  })

  it('stays quiet when turned off', async () => {
    const { haptic } = await import('@/lib/haptics')
    const { settings } = await import('@/lib/settings')
    settings.haptics = false
    haptic('heavy')
    settings.haptics = true
    expect(vibrate).not.toHaveBeenCalled()
  })
})
