// Trackpad gesture recognition. Feed it pointer events; it reports intent
// (move, click, drag, scroll, swipe…) to a handler. Kept free of DOM and
// network code so it can be tested with synthetic touches.

import type { Haptic } from './haptics'
import { ScrollPhase, type MouseButton } from './protocol'

export type Direction = 'left' | 'right' | 'up' | 'down'

export interface GestureOptions {
  tapToClick: boolean
  twoFingerTap: boolean
  longPress: 'drag' | 'rightClick' | 'off'
  tapAndDrag: boolean
  dragLock: boolean
  pinch: boolean
  momentum: boolean
}

export interface GestureHandler {
  /** A finger landed on an idle surface (stops scroll momentum). */
  touch(): void
  /** A drag, scroll or pointer motion started. */
  begin(): void
  move(dx: number, dy: number, dt: number): void
  /** Finger deltas in CSS pixels; the consumer applies direction and speed. */
  scroll(phase: number, dx: number, dy: number): void
  /** Finger velocity in CSS pixels per second at lift-off. */
  fling(vx: number, vy: number): void
  click(button: MouseButton): void
  buttonDown(button: MouseButton): void
  buttonUp(button: MouseButton): void
  swipe(fingers: number, direction: Direction): void
  multiTap(fingers: number): void
  pinch(direction: 1 | -1): void
  feedback(kind: Haptic): void
}

/** One finger: movement allowed before a touch stops being a tap. */
export const SLOP = 5
/** Two fingers wobble more, and must also tell scrolling from pinching. */
const MULTI_SLOP = 7
export const TAP_MS = 260
export const LONG_PRESS_MS = 450
export const DOUBLE_TAP_MS = 260
const DOUBLE_TAP_DISTANCE = 40
const SWIPE_DISTANCE = 38
const PINCH_START = 0.14
const PINCH_STEP = 1.22
const FLING_MIN = 140
const VELOCITY_WINDOW = 90
/** Lifting after the fingers came to rest should not fling. */
const FLING_STALE = 55

type Mode = 'idle' | 'pending' | 'pointing' | 'dragging' | 'scrolling' | 'pinching' | 'done'

interface Point {
  x: number
  y: number
  startX: number
  startY: number
  t: number
}

export class GestureRecognizer {
  private points = new Map<number, Point>()
  private primary = -1
  private mode: Mode = 'idle'
  private maxFingers = 0
  private start = 0
  private secondTap = false
  private dragLocked = false
  private longPressTimer: ReturnType<typeof setTimeout> | undefined
  private deferredClick: ReturnType<typeof setTimeout> | undefined
  private lastTap: { t: number; x: number; y: number } | null = null
  private samples: { t: number; dx: number; dy: number }[] = []
  private pinchBase = 0
  private lastPosition = { x: 0, y: 0 }

  constructor(
    private handler: GestureHandler,
    public options: GestureOptions,
  ) {}

  get fingers(): number {
    return this.points.size
  }

  get dragging(): boolean {
    return this.mode === 'dragging' || this.dragLocked
  }

  down(id: number, x: number, y: number, t: number) {
    if (this.points.size === 0) {
      this.beginGesture(id, x, y, t)
    } else if (this.mode === 'pending' || this.mode === 'pointing') {
      // More fingers turn a touch into a multi-finger gesture.
      this.cancelLongPress()
      this.releaseHeldTap()
      this.mode = 'pending'
      for (const p of this.points.values()) {
        p.startX = p.x
        p.startY = p.y
      }
    }
    this.points.set(id, { x, y, startX: x, startY: y, t })
    this.maxFingers = Math.max(this.maxFingers, this.points.size)
  }

  private beginGesture(id: number, x: number, y: number, t: number) {
    this.primary = id
    this.maxFingers = 1
    this.start = t
    this.mode = 'pending'
    this.secondTap = false
    this.samples = []
    this.handler.touch()
    if (this.deferredClick !== undefined) {
      const near = this.lastTap && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) <= DOUBLE_TAP_DISTANCE
      if (near && !this.dragLocked) {
        clearTimeout(this.deferredClick)
        this.deferredClick = undefined
        this.secondTap = true
      } else {
        this.fireDeferredClick()
      }
    }
    if (this.options.longPress !== 'off' && !this.dragLocked && !this.secondTap) {
      this.longPressTimer = setTimeout(() => this.onLongPress(), LONG_PRESS_MS)
    }
  }

  move(id: number, x: number, y: number, t: number) {
    const p = this.points.get(id)
    if (!p) return
    const dx = x - p.x
    const dy = y - p.y
    const dt = Math.max(1, t - p.t)
    p.x = x
    p.y = y
    p.t = t
    if (dx === 0 && dy === 0) return

    switch (this.mode) {
      case 'pending':
        this.resolvePending(id, p, dx, dy, dt, t)
        break
      case 'pointing':
      case 'dragging':
        if (id === this.primary || this.points.size === 1) {
          this.primary = id
          this.handler.move(dx, dy, dt)
        }
        break
      case 'scrolling': {
        const n = this.points.size
        this.handler.scroll(ScrollPhase.Changed, dx / n, dy / n)
        this.sample(t, dx / n, dy / n)
        break
      }
      case 'pinching':
        this.updatePinch()
        break
      default:
        break
    }
  }

  private resolvePending(id: number, p: Point, dx: number, dy: number, dt: number, t: number) {
    const fingers = this.points.size
    if (fingers === 1) {
      const sx = p.x - p.startX
      const sy = p.y - p.startY
      if (Math.hypot(sx, sy) <= SLOP) return
      this.cancelLongPress()
      if (this.secondTap) {
        this.secondTap = false
        this.handler.begin()
        this.handler.buttonDown('left')
        this.mode = 'dragging'
      } else if (this.dragLocked) {
        this.mode = 'dragging'
      } else {
        this.handler.begin()
        this.mode = 'pointing'
      }
      this.primary = id
      // Include the motion that was held back while this could still have
      // been a tap, so the pointer does not feel stuck at the start.
      this.handler.move(sx, sy, Math.max(dt, t - this.start, 1))
      return
    }
    const { cx, cy } = this.centroidShift()
    if (fingers === 2) {
      const spread = this.spread()
      const startSpread = this.spread(true)
      const ratio = startSpread > 0 ? spread / startSpread : 1
      if (this.options.pinch && Math.abs(ratio - 1) > PINCH_START && Math.hypot(cx, cy) < MULTI_SLOP * 3) {
        this.mode = 'pinching'
        this.pinchBase = startSpread
        this.updatePinch()
        return
      }
      if (Math.hypot(cx, cy) > MULTI_SLOP) {
        this.mode = 'scrolling'
        this.handler.begin()
        this.handler.scroll(ScrollPhase.Began, cx, cy)
        this.sample(t, cx, cy)
      }
      return
    }
    if (fingers >= 3 && Math.hypot(cx, cy) > SWIPE_DISTANCE) {
      const direction: Direction = Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? 'right' : 'left') : cy > 0 ? 'down' : 'up'
      this.handler.swipe(Math.min(fingers, 4), direction)
      this.handler.feedback('light')
      this.mode = 'done'
    }
  }

  private centroidShift(): { cx: number; cy: number } {
    let cx = 0
    let cy = 0
    for (const p of this.points.values()) {
      cx += p.x - p.startX
      cy += p.y - p.startY
    }
    const n = this.points.size || 1
    return { cx: cx / n, cy: cy / n }
  }

  private spread(atStart = false): number {
    const [a, b] = [...this.points.values()]
    if (!a || !b) return 0
    return atStart ? Math.hypot(a.startX - b.startX, a.startY - b.startY) : Math.hypot(a.x - b.x, a.y - b.y)
  }

  private updatePinch() {
    const spread = this.spread()
    if (!this.pinchBase || !spread) return
    const ratio = spread / this.pinchBase
    if (ratio >= PINCH_STEP) {
      this.handler.pinch(1)
      this.handler.feedback('select')
      this.pinchBase = spread
    } else if (ratio <= 1 / PINCH_STEP) {
      this.handler.pinch(-1)
      this.handler.feedback('select')
      this.pinchBase = spread
    }
  }

  private sample(t: number, dx: number, dy: number) {
    this.samples.push({ t, dx, dy })
    const cutoff = t - VELOCITY_WINDOW * 2
    while (this.samples.length && this.samples[0]!.t < cutoff) this.samples.shift()
  }

  private velocity(now: number): { vx: number; vy: number } {
    const recent = this.samples.filter((s) => s.t >= now - VELOCITY_WINDOW)
    const last = this.samples[this.samples.length - 1]
    if (recent.length < 2 || !last || now - last.t > FLING_STALE) return { vx: 0, vy: 0 }
    const span = Math.max(16, last.t - recent[0]!.t)
    const sx = recent.reduce((a, s) => a + s.dx, 0)
    const sy = recent.reduce((a, s) => a + s.dy, 0)
    return { vx: (sx / span) * 1000, vy: (sy / span) * 1000 }
  }

  up(id: number, t: number) {
    const lifted = this.points.get(id)
    if (!lifted) return
    this.points.delete(id)
    this.lastPosition = { x: lifted.x, y: lifted.y }
    if (this.points.size > 0) {
      if (this.mode === 'scrolling') this.endScroll(t, true)
      if (this.mode === 'dragging' && id === this.primary) this.primary = this.points.keys().next().value!
      return
    }
    this.cancelLongPress()
    const quick = t - this.start
    switch (this.mode) {
      case 'pending':
        this.tapped(quick, t)
        break
      case 'dragging':
        if (this.dragLocked) {
          // Lifting during a locked drag keeps the button down.
        } else if (this.options.dragLock) {
          this.dragLocked = true
          this.handler.feedback('select')
        } else {
          this.handler.buttonUp('left')
        }
        break
      case 'scrolling':
        this.endScroll(t, true)
        break
      default:
        break
    }
    this.mode = 'idle'
    this.secondTap = false
  }

  private tapped(duration: number, t: number) {
    if (this.maxFingers === 1) {
      if (this.dragLocked) {
        this.dragLocked = false
        this.handler.buttonUp('left')
        this.handler.feedback('select')
        return
      }
      if (this.secondTap) {
        // Second tap of a double tap: the first click was held back.
        this.handler.click('left')
        this.handler.click('left')
        return
      }
      if (duration > TAP_MS || !this.options.tapToClick) return
      const p = this.lastPosition
      if (this.options.tapAndDrag) {
        this.lastTap = { t, x: p.x, y: p.y }
        this.deferredClick = setTimeout(() => this.fireDeferredClick(), DOUBLE_TAP_MS)
      } else {
        this.handler.click('left')
      }
      return
    }
    if (this.maxFingers === 2) {
      if (this.options.twoFingerTap && duration <= TAP_MS * 1.4) this.handler.click('right')
      return
    }
    if (duration <= TAP_MS * 1.5) this.handler.multiTap(Math.min(this.maxFingers, 4))
  }

  /** The tap held back for a possible double tap was a plain click after all. */
  private releaseHeldTap() {
    if (!this.secondTap) return
    this.secondTap = false
    this.handler.click('left')
  }

  private fireDeferredClick() {
    if (this.deferredClick === undefined) return
    clearTimeout(this.deferredClick)
    this.deferredClick = undefined
    this.handler.click('left')
  }

  private endScroll(t: number, allowFling: boolean) {
    const { vx, vy } = this.velocity(t)
    this.handler.scroll(ScrollPhase.Ended, 0, 0)
    if (allowFling && this.options.momentum && Math.hypot(vx, vy) >= FLING_MIN) this.handler.fling(vx, vy)
    this.mode = 'done'
  }

  cancel(id: number) {
    if (!this.points.delete(id)) return
    if (this.points.size > 0) return
    this.cancelLongPress()
    this.releaseHeldTap()
    if (this.mode === 'dragging' && !this.dragLocked) this.handler.buttonUp('left')
    if (this.mode === 'scrolling') this.handler.scroll(ScrollPhase.Cancelled, 0, 0)
    this.mode = 'idle'
    this.secondTap = false
  }

  private onLongPress() {
    this.longPressTimer = undefined
    if (this.mode !== 'pending' || this.points.size !== 1 || this.maxFingers !== 1) return
    if (this.options.longPress === 'drag') {
      this.handler.begin()
      this.handler.buttonDown('left')
      this.handler.feedback('medium')
      this.mode = 'dragging'
    } else if (this.options.longPress === 'rightClick') {
      this.handler.click('right')
      this.handler.feedback('medium')
      this.mode = 'done'
    }
  }

  private cancelLongPress() {
    clearTimeout(this.longPressTimer)
    this.longPressTimer = undefined
  }

  /** Drop all state, releasing anything held (e.g. on disconnect). */
  reset() {
    this.cancelLongPress()
    clearTimeout(this.deferredClick)
    this.deferredClick = undefined
    if (this.mode === 'dragging' || this.dragLocked) this.handler.buttonUp('left')
    if (this.mode === 'scrolling') this.handler.scroll(ScrollPhase.Cancelled, 0, 0)
    this.points.clear()
    this.dragLocked = false
    this.mode = 'idle'
  }
}
