import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUBLE_TAP_MS, GestureRecognizer, LONG_PRESS_MS, type GestureHandler, type GestureOptions } from '../src/lib/gestures'
import { ScrollPhase } from '../src/lib/protocol'

type Call = [string, ...unknown[]]

function setup(overrides: Partial<GestureOptions> = {}) {
  const calls: Call[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args])
  const handler: GestureHandler = {
    touch: record('touch'),
    begin: record('begin'),
    move: record('move'),
    scroll: record('scroll'),
    fling: record('fling'),
    click: record('click'),
    buttonDown: record('buttonDown'),
    buttonUp: record('buttonUp'),
    swipe: record('swipe'),
    multiTap: record('multiTap'),
    pinch: record('pinch'),
    feedback: () => {},
  }
  const options: GestureOptions = {
    tapToClick: true,
    twoFingerTap: true,
    longPress: 'drag',
    tapAndDrag: false,
    dragLock: false,
    pinch: true,
    momentum: true,
    ...overrides,
  }
  const g = new GestureRecognizer(handler, options)
  const names = () => calls.map((c) => c[0]).filter((n) => n !== 'touch' && n !== 'begin')
  return { g, calls, names }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('one finger', () => {
  it('taps to click', () => {
    const { g, names } = setup()
    g.down(1, 100, 100, 0)
    g.up(1, 80)
    expect(names()).toEqual(['click'])
  })

  it('moves the pointer without clicking', () => {
    const { g, calls, names } = setup()
    g.down(1, 100, 100, 0)
    g.move(1, 104, 100, 10)
    g.move(1, 112, 100, 20)
    g.move(1, 130, 110, 30)
    g.up(1, 40)
    expect(names()).toEqual(['move', 'move'])
    // The first move carries everything since touch-down, not just the last step.
    expect(calls.find((c) => c[0] === 'move')).toEqual(['move', 12, 0, 20])
  })

  it('long press starts a drag and lifting ends it', () => {
    const { g, names } = setup()
    g.down(1, 100, 100, 0)
    vi.advanceTimersByTime(LONG_PRESS_MS + 5)
    g.move(1, 140, 100, 600)
    g.up(1, 700)
    expect(names()).toEqual(['buttonDown', 'move', 'buttonUp'])
  })

  it('drag lock keeps the button down until the next tap', () => {
    const { g, names } = setup({ dragLock: true })
    g.down(1, 100, 100, 0)
    vi.advanceTimersByTime(LONG_PRESS_MS + 5)
    g.move(1, 140, 100, 600)
    g.up(1, 700)
    expect(names()).toEqual(['buttonDown', 'move'])
    g.down(2, 140, 100, 800)
    g.move(2, 170, 100, 820)
    g.up(2, 840)
    expect(names()).toEqual(['buttonDown', 'move', 'move'])
    g.down(3, 170, 100, 900)
    g.up(3, 950)
    expect(names()).toEqual(['buttonDown', 'move', 'move', 'buttonUp'])
  })

  it('double-tap-and-drag holds the button without a stray click', () => {
    const { g, names } = setup({ tapAndDrag: true, longPress: 'off' })
    g.down(1, 100, 100, 0)
    g.up(1, 60)
    expect(names()).toEqual([])
    g.down(2, 102, 101, 150)
    g.move(2, 130, 101, 170)
    g.up(2, 260)
    expect(names()).toEqual(['buttonDown', 'move', 'buttonUp'])
  })

  it('deferred taps still click, and double taps double-click', () => {
    const { g, names } = setup({ tapAndDrag: true })
    g.down(1, 100, 100, 0)
    g.up(1, 60)
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1)
    expect(names()).toEqual(['click'])
    g.down(2, 100, 100, 1000)
    g.up(2, 1050)
    g.down(3, 100, 100, 1150)
    g.up(3, 1200)
    expect(names()).toEqual(['click', 'click', 'click'])
  })

  it('a slow touch without movement is not a tap', () => {
    const { g, names } = setup({ longPress: 'off' })
    g.down(1, 100, 100, 0)
    g.up(1, 900)
    expect(names()).toEqual([])
  })
})

describe('two fingers', () => {
  it('tap to right-click', () => {
    const { g, names } = setup()
    g.down(1, 100, 100, 0)
    g.down(2, 160, 100, 20)
    g.up(1, 120)
    g.up(2, 130)
    expect(names()).toEqual(['click'])
  })

  it('scroll with phases and a fling at lift-off', () => {
    const { g, calls } = setup()
    g.down(1, 100, 300, 0)
    g.down(2, 160, 300, 5)
    let t = 10
    for (let y = 300; y >= 200; y -= 10) {
      t += 8
      g.move(1, 100, y, t)
      g.move(2, 160, y, t)
    }
    g.up(1, t + 4)
    g.up(2, t + 6)
    const scrolls = calls.filter((c) => c[0] === 'scroll')
    expect(scrolls[0]![1]).toBe(ScrollPhase.Began)
    expect(scrolls.slice(1, -1).every((c) => c[1] === ScrollPhase.Changed)).toBe(true)
    expect(scrolls.at(-1)![1]).toBe(ScrollPhase.Ended)
    const fling = calls.find((c) => c[0] === 'fling')
    expect(fling).toBeDefined()
    expect(fling![2] as number).toBeLessThan(-500)
    expect(calls.filter((c) => c[0] === 'scroll' && c[1] === ScrollPhase.Ended)).toHaveLength(1)
  })

  it('no fling after the fingers came to rest', () => {
    const { g, calls } = setup()
    g.down(1, 100, 300, 0)
    g.down(2, 160, 300, 5)
    g.move(1, 100, 280, 20)
    g.move(2, 160, 280, 20)
    g.move(1, 100, 260, 36)
    g.move(2, 160, 260, 36)
    g.up(1, 400)
    g.up(2, 401)
    expect(calls.some((c) => c[0] === 'fling')).toBe(false)
  })

  it('pinch zooms in steps', () => {
    const { g, calls } = setup()
    g.down(1, 150, 300, 0)
    g.down(2, 250, 300, 5)
    g.move(1, 120, 300, 20)
    g.move(2, 280, 300, 20)
    g.move(1, 100, 300, 40)
    g.move(2, 300, 300, 40)
    expect(calls.filter((c) => c[0] === 'pinch').map((c) => c[1])).toEqual([1, 1, 1])
  })
})

describe('three and four fingers', () => {
  it('swipes once per gesture', () => {
    const { g, calls } = setup()
    g.down(1, 100, 300, 0)
    g.down(2, 150, 300, 3)
    g.down(3, 200, 300, 6)
    for (const x of [20, 40, 60, 80]) {
      g.move(1, 100 - x, 300, 10 + x)
      g.move(2, 150 - x, 300, 10 + x)
      g.move(3, 200 - x, 300, 10 + x)
    }
    g.up(1, 120)
    g.up(2, 121)
    g.up(3, 122)
    expect(calls.filter((c) => c[0] === 'swipe')).toEqual([['swipe', 3, 'left']])
  })

  it('taps', () => {
    const { g, calls } = setup()
    for (const id of [1, 2, 3, 4]) g.down(id, id * 40, 300, id)
    for (const id of [1, 2, 3, 4]) g.up(id, 100 + id)
    expect(calls.filter((c) => c[0] === 'multiTap')).toEqual([['multiTap', 4]])
  })
})

it('cancel and reset release held buttons', () => {
  const { g, names } = setup()
  g.down(1, 100, 100, 0)
  vi.advanceTimersByTime(LONG_PRESS_MS + 5)
  g.cancel(1)
  expect(names()).toEqual(['buttonDown', 'buttonUp'])
})
