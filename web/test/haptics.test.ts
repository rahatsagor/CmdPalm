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

describe('haptics on iPhone', () => {
  const userAgent = navigator.userAgent

  beforeEach(() => {
    vi.resetModules()
    Reflect.deleteProperty(navigator, 'vibrate')
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      configurable: true,
    })
  })
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
  })

  it('lets a tap on a haptic control play only the haptics it asked for', async () => {
    const { haptic, switchOnly, tapZone } = await import('@/lib/haptics')
    expect(switchOnly).toBe(true)
    tapZone.down()
    tapZone.up()
    expect(tapZone.claim()).toBe(false)

    tapZone.down()
    haptic('select')
    tapZone.up()
    expect(tapZone.claim()).toBe(true)
    expect(tapZone.claim()).toBe(false)
  })

  it('keeps pointerdown for taps that need their click, unless a field is focused', async () => {
    const { needsClick } = await import('@/lib/haptics')
    const { settings } = await import('@/lib/settings')
    const touch = { pointerType: 'touch' } as PointerEvent
    expect(needsClick(touch)).toBe(true)
    expect(needsClick({ pointerType: 'mouse' } as PointerEvent)).toBe(false)
    settings.keyHaptics = false
    expect(needsClick(touch, true)).toBe(false)
    settings.keyHaptics = true
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    expect(needsClick(touch)).toBe(false)
    field.remove()
  })
})
