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
    multiPinch: record('multiPinch'),
    pinch: record('pinch'),
    zoom: record('zoom'),
    rotate: record('rotate'),
    smartZoom: record('smartZoom'),
    feedback: () => {},
  }
  const options: GestureOptions = {
    tapToClick: true,
    twoFingerTap: true,
    longPress: 'drag',
    tapAndDrag: false,
    dragLock: false,
    pinch: true,
    zoomKeys: false,
    rotate: true,
    smartZoom: false,
    threeFingerDrag: false,
    momentum: true,
    ...overrides,
  }
  const g = new GestureRecognizer(handler, options)
  const names = () => calls.map((c) => c[0]).filter((n) => n !== 'touch' && n !== 'begin')
  return { g, calls, names }
}

type Recognizer = ReturnType<typeof setup>['g']

/**
 * One touch frame at 60 Hz: each finger reports its own move, in order, as
 * browsers do. A finger left out of a frame didn't move in it.
 */
function frame(g: Recognizer, n: number, ...fingers: [id: number, x: number, y: number][]) {
  for (const [id, x, y] of fingers) g.move(id, x, y, 5 + n * 16)
}

const twoFingerEvents = (calls: Call[]) => calls.filter((c) => ['scroll', 'zoom', 'rotate'].includes(c[0])).map((c) => c[0])
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

  it('a tap held back for a double tap still clicks when more fingers join', () => {
    const { g, calls } = setup({ tapAndDrag: true, longPress: 'off' })
    g.down(1, 100, 100, 0)
    g.up(1, 60)
    g.down(2, 102, 101, 150)
    g.down(3, 150, 101, 160)
    g.up(2, 200)
    g.up(3, 210)
    expect(calls.filter((c) => c[0] === 'click')).toEqual([
      ['click', 'left'],
      ['click', 'right'],
    ])
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

  it('pinch zooms in steps with zoom keys', () => {
    const { g, calls } = setup({ zoomKeys: true })
    g.down(1, 150, 300, 0)
    g.down(2, 250, 300, 5)
    g.move(1, 120, 300, 20)
    g.move(2, 280, 300, 20)
    g.move(1, 100, 300, 40)
    g.move(2, 300, 300, 40)
    expect(calls.filter((c) => c[0] === 'pinch').map((c) => c[1])).toEqual([1, 1, 1])
  })

  it('pinch zooms smoothly, and lifting ends the zoom', () => {
    const { g, calls } = setup()
    g.down(1, 150, 300, 0)
    g.down(2, 250, 300, 5)
    frame(g, 1, [1, 145, 300], [2, 255, 300])
    expect(calls.some((c) => c[0] === 'zoom')).toBe(false)
    frame(g, 2, [1, 135, 300], [2, 265, 300])
    frame(g, 3, [1, 120, 300], [2, 280, 300])
    g.up(1, 70)
    g.up(2, 71)
    const zooms = calls.filter((c) => c[0] === 'zoom')
    expect(zooms[0]).toEqual(['zoom', ScrollPhase.Began, expect.closeTo(0.3)])
    expect(zooms.slice(1, -1).every((c) => c[1] === ScrollPhase.Changed)).toBe(true)
    expect(zooms.at(-1)![1]).toBe(ScrollPhase.Ended)
    // The steps multiply to the whole pinch, from 100 px apart to 160.
    expect(zooms.slice(0, -1).reduce((scale, c) => scale * (1 + (c[2] as number)), 1)).toBeCloseTo(1.6)
    expect(calls.some((c) => c[0] === 'scroll' || c[0] === 'rotate')).toBe(false)
  })

  it('turning two fingers rotates counterclockwise-positive, without zooming', () => {
    const { g, calls } = setup()
    g.down(1, 200, 300, 0)
    g.down(2, 300, 300, 5)
    // A clockwise turn about the middle, 5° a frame.
    const at = (deg: number) => [250 + 50 * Math.cos((deg * Math.PI) / 180), 300 + 50 * Math.sin((deg * Math.PI) / 180)] as const
    for (let n = 1; n <= 6; n++) frame(g, n, [2, ...at(n * 5)], [1, ...at(180 + n * 5)])
    g.cancel(1)
    g.cancel(2)
    const turns = calls.filter((c) => c[0] === 'rotate')
    expect(turns[0]![1]).toBe(ScrollPhase.Began)
    expect(turns.at(-1)![1]).toBe(ScrollPhase.Cancelled)
    expect(turns.reduce((sum, c) => sum + (c[2] as number), 0)).toBeCloseTo(-30)
    expect(calls.some((c) => c[0] === 'zoom' || c[0] === 'scroll')).toBe(false)
  })

  // Most people twist or pinch around one finger that stays put, which also
  // moves the point between the fingers like the start of a scroll.
  it('twisting around a still finger rotates instead of scrolling', () => {
    const { g, calls } = setup()
    g.down(1, 200, 400, 0)
    g.down(2, 200, 300, 5)
    // Finger 2 swings 24° clockwise around finger 1, 2° a frame.
    for (let n = 1; n <= 12; n++) {
      const r = (n * 2 * Math.PI) / 180
      frame(g, n, [2, 200 + 100 * Math.sin(r), 400 - 100 * Math.cos(r)])
    }
    g.up(2, 300)
    g.up(1, 301)
    expect(calls.some((c) => c[0] === 'scroll' || c[0] === 'zoom')).toBe(false)
    const turns = calls.filter((c) => c[0] === 'rotate')
    expect(turns.at(-1)![1]).toBe(ScrollPhase.Ended)
    expect(turns.reduce((sum, c) => sum + (c[2] as number), 0)).toBeCloseTo(-24)
  })

  it('pinching with one finger zooms instead of scrolling', () => {
    const { g, calls } = setup()
    g.down(1, 200, 400, 0)
    g.down(2, 200, 300, 5)
    for (let n = 1; n <= 8; n++) frame(g, n, [2, 201, 300 + n * 5])
    expect(calls.some((c) => c[0] === 'scroll' || c[0] === 'rotate')).toBe(false)
    expect(calls.filter((c) => c[0] === 'zoom')[0]?.[1]).toBe(ScrollPhase.Began)
  })

  it('scrolls when the fingers move at different speeds', () => {
    // Side by side scrolling down the page, and one above the other
    // scrolling sideways; one finger moves faster, which turns the line
    // between them as a twist would.
    for (const [a, b, step] of [
      [[100, 300], [160, 300], [0, -12, 0, -7]],
      [[200, 250], [200, 350], [-12, 0, -7, 0]],
    ] as const) {
      const { g, calls } = setup()
      g.down(1, a[0], a[1], 0)
      g.down(2, b[0], b[1], 5)
      for (let n = 1; n <= 8; n++) frame(g, n, [1, a[0] + n * step[0], a[1] + n * step[1]], [2, b[0] + n * step[2], b[1] + n * step[3]])
      expect(new Set(twoFingerEvents(calls))).toEqual(new Set(['scroll']))
    }
  })

  it('scrolls either way when the second finger starts a few frames late', () => {
    for (const dir of [1, -1]) {
      const { g, calls } = setup()
      g.down(1, 100, 300, 0)
      g.down(2, 160, 300, 5)
      for (let n = 1; n <= 8; n++) {
        const lead: [number, number, number] = [1, 100, 300 + dir * n * 10]
        if (n <= 2) frame(g, n, lead)
        else frame(g, n, lead, [2, 160, 300 + dir * (n - 2) * 10])
      }
      expect(new Set(twoFingerEvents(calls))).toEqual(new Set(['scroll']))
    }
  })

  it('cancels a rotation that turns out to be a late-starting scroll', () => {
    const { g, calls } = setup()
    g.down(1, 100, 300, 0)
    g.down(2, 160, 300, 5)
    // Finger 2 waits long enough to look like the still finger of a twist.
    for (let n = 1; n <= 12; n++) {
      const lead: [number, number, number] = [1, 100, 300 - n * 6]
      if (n <= 5) frame(g, n, lead)
      else frame(g, n, lead, [2, 160, 300 - (n - 5) * 6])
    }
    const events = calls.filter((c) => c[0] === 'rotate' || c[0] === 'scroll').map((c) => `${c[0]}:${c[1]}`)
    // With this long a lead it does start rotating, then gives the scroll back.
    expect(events[0]).toBe(`rotate:${ScrollPhase.Began}`)
    const cancelled = events.indexOf(`rotate:${ScrollPhase.Cancelled}`)
    expect(cancelled).toBeGreaterThan(0)
    expect(events[cancelled + 1]).toBe(`scroll:${ScrollPhase.Began}`)
    expect(events.at(-1)).toBe(`scroll:${ScrollPhase.Changed}`)
  })
  it('a two-finger double-tap smart zooms instead of right-clicking', () => {
    const { g, names } = setup({ smartZoom: true })
    const twoTap = (t: number) => {
      g.down(1, 100, 100, t)
      g.down(2, 160, 100, t + 10)
      g.up(1, t + 80)
      g.up(2, t + 90)
    }
    twoTap(0)
    expect(names()).toEqual([])
    twoTap(200)
    expect(names()).toEqual(['smartZoom'])
    twoTap(2000)
    vi.advanceTimersByTime(500)
    expect(names()).toEqual(['smartZoom', 'click'])
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

  it('pinches four fingers together, even when the thumb moves the middle', () => {
    const { g, calls } = setup()
    const start = [
      [100, 400],
      [140, 300],
      [190, 290],
      [240, 300],
    ]
    start.forEach(([x, y], i) => g.down(i + 1, x!, y!, i))
    // The thumb sweeps up to the fingers, which close in a little.
    g.move(1, 150, 340, 30)
    g.move(2, 150, 305, 30)
    g.move(3, 185, 300, 30)
    g.move(4, 215, 305, 30)
    for (const id of [1, 2, 3, 4]) g.up(id, 60)
    expect(calls.filter((c) => c[0] === 'multiPinch' || c[0] === 'swipe')).toEqual([['multiPinch', 4, true]])
  })

  it('three-finger drag holds the button and follows the fingers', () => {
    const { g, calls, names } = setup({ threeFingerDrag: true })
    for (const id of [1, 2, 3]) g.down(id, 100 + id * 40, 300, id)
    for (const x of [10, 30]) for (const id of [1, 2, 3]) g.move(id, 100 + id * 40 + x, 300, 10 + x)
    for (const id of [1, 2, 3]) g.up(id, 80)
    expect(names()[0]).toBe('buttonDown')
    expect(names().at(-1)).toBe('buttonUp')
    expect(names()).not.toContain('swipe')
    const moved = calls.filter((c) => c[0] === 'move').reduce((sum, c) => sum + (c[1] as number), 0)
    expect(moved).toBeCloseTo(30)
  })
})

it('cancel and reset release held buttons', () => {
  const { g, names } = setup()
  g.down(1, 100, 100, 0)
  vi.advanceTimersByTime(LONG_PRESS_MS + 5)
  g.cancel(1)
  expect(names()).toEqual(['buttonDown', 'buttonUp'])
})
