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
  /** Pinching sends zoom key steps instead of a smooth zoom gesture. */
  zoomKeys: boolean
  rotate: boolean
  /** Two-finger double-tap; right-clicks wait to see if a second tap follows. */
  smartZoom: boolean
  /** Three fingers drag, as with the Mac's accessibility option. */
  threeFingerDrag: boolean
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
  /** Three or more fingers pinched together (`inward`) or spread apart. */
  multiPinch(fingers: number, inward: boolean): void
  /** One zoom key step, with `zoomKeys`. */
  pinch(direction: 1 | -1): void
  /** Change in magnification since the last call, as a fraction. */
  zoom(phase: number, delta: number): void
  /** Rotation since the last call, in degrees, counterclockwise. */
  rotate(phase: number, degrees: number): void
  smartZoom(): void
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
const PINCH_STEP = 1.22
/** From one two-finger tap's lift to the next's, for a smart zoom. */
const SMART_ZOOM_MS = 400
/** Two fingers: how far the furthest one travels before deciding between
 * scrolling and zooming or rotating. */
const TWO_FINGER_DECIDE = 9
/**
 * Fingers moving toward, away from or around each other zoom or rotate;
 * fingers moving together scroll. It is a transform when the fingers' motion
 * relative to each other is this much larger than their shared motion. A
 * pinch or twist around one still finger has a ratio of 2, a scroll about 0.
 */
const TRANSFORM_RATIO = 1.1
/** Once transforming, the travel in px, along or across the line between
 * the fingers, that starts a zoom or a rotation. */
const ZOOM_START_PX = 8
const TURN_START_PX = 10
/** A zoom or rotation only starts while it is at least this share of the
 * other motion, so a pinch doesn't turn a photo and a twist doesn't zoom. */
const DOMINANCE = 0.6
/** Both fingers moving at least this far, the same way, is a scroll. A
 * pinch or twist moves them apart, together or around, or keeps one still. */
const TOGETHER_MIN = 4
const TOGETHER_COS = 0.7
/** Three or more fingers: how far their spread changes to count as a pinch. */
const MULTI_PINCH_IN = 0.68
const MULTI_PINCH_OUT = 1.45
/** A swipe keeps the fingers' spread within these. */
const SWIPE_SPREAD = [0.8, 1.25] as const
const FLING_MIN = 140
const VELOCITY_WINDOW = 90
/** Lifting after the fingers came to rest should not fling. */
const FLING_STALE = 55

type Mode = 'idle' | 'pending' | 'pointing' | 'dragging' | 'scrolling' | 'transforming' | 'dragging3' | 'done'

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
  /** Smooth zoom and rotation: spread and angle last reported, once begun. */
  private zoomFrom = 0
  private turnFrom = 0
  private zooming = false
  private turning = false
  /** A two-finger tap waiting to see whether it is a smart zoom. */
  private twoTap: { t: number; timer: ReturnType<typeof setTimeout> } | null = null
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
      case 'transforming':
        this.updateTransform()
        break
      case 'dragging3': {
        const n = this.points.size
        this.handler.move(dx / n, dy / n, dt)
        break
      }
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
      this.releaseTwoTap()
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
      const { furthest, shared, relative, together } = this.pairMotion()
      if (furthest <= TWO_FINGER_DECIDE) return
      this.releaseTwoTap()
      const { radial, twist } = this.transformTravel()
      const enabled = radial >= twist ? this.options.pinch : this.options.rotate
      if (enabled && !together && relative > shared * TRANSFORM_RATIO) {
        this.mode = 'transforming'
        this.pinchBase = this.spread(true)
        this.zoomFrom = this.pinchBase
        this.turnFrom = this.angle(true)
        this.zooming = this.turning = false
        this.handler.begin()
        this.updateTransform()
      } else {
        this.startScroll(t, cx, cy)
      }
      return
    }
    if (fingers === 3 && this.options.threeFingerDrag) {
      if (Math.hypot(cx, cy) <= MULTI_SLOP) return
      this.releaseTwoTap()
      this.mode = 'dragging3'
      this.handler.begin()
      this.handler.buttonDown('left')
      this.handler.move(cx, cy, Math.max(dt, t - this.start, 1))
      return
    }
    const ratio = this.reach(true) > 0 ? this.reach() / this.reach(true) : 1
    if (fingers >= 3 && (ratio < MULTI_PINCH_IN || ratio > MULTI_PINCH_OUT)) {
      this.releaseTwoTap()
      this.handler.multiPinch(Math.min(fingers, 4), ratio < 1)
      this.handler.feedback('light')
      this.mode = 'done'
      return
    }
    const swiping = ratio >= SWIPE_SPREAD[0] && ratio <= SWIPE_SPREAD[1]
    if (fingers >= 3 && swiping && Math.hypot(cx, cy) > SWIPE_DISTANCE) {
      this.releaseTwoTap()
      const direction: Direction = Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? 'right' : 'left') : cy > 0 ? 'down' : 'up'
      this.handler.swipe(Math.min(fingers, 4), direction)
      this.handler.feedback('light')
      this.mode = 'done'
    }
  }

  private startScroll(t: number, cx: number, cy: number) {
    this.mode = 'scrolling'
    this.handler.begin()
    this.handler.scroll(ScrollPhase.Began, cx, cy)
    this.sample(t, cx, cy)
  }

  /**
   * Two fingers' travel since they landed: the furthest one's, what they
   * share, relative to each other, and whether both go the same way.
   */
  private pairMotion(): { furthest: number; shared: number; relative: number; together: boolean } {
    const [a, b] = [...this.points.values()]
    if (!a || !b) return { furthest: 0, shared: 0, relative: 0, together: false }
    const ax = a.x - a.startX
    const ay = a.y - a.startY
    const bx = b.x - b.startX
    const by = b.y - b.startY
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    return {
      furthest: Math.max(la, lb),
      shared: Math.hypot((ax + bx) / 2, (ay + by) / 2),
      relative: Math.hypot(bx - ax, by - ay),
      together: la >= TOGETHER_MIN && lb >= TOGETHER_MIN && (ax * bx + ay * by) / (la * lb) >= TOGETHER_COS,
    }
  }

  /** How far two fingers moved apart or together, and around each other, in px since they landed. */
  private transformTravel(): { radial: number; twist: number } {
    const start = this.spread(true)
    const radial = Math.abs(this.spread() - start)
    const twist = (Math.abs(turn(this.angle(true), this.angle())) * Math.PI * start) / 180
    return { radial, twist }
  }

  private lastMoveAt(): number {
    return Math.max(...[...this.points.values()].map((p) => p.t))
  }

  /** Average distance of the fingers from their center. */
  private reach(atStart = false): number {
    const points = [...this.points.values()]
    if (points.length === 0) return 0
    const x = (p: Point) => (atStart ? p.startX : p.x)
    const y = (p: Point) => (atStart ? p.startY : p.y)
    const mx = points.reduce((a, p) => a + x(p), 0) / points.length
    const my = points.reduce((a, p) => a + y(p), 0) / points.length
    return points.reduce((a, p) => a + Math.hypot(x(p) - mx, y(p) - my), 0) / points.length
  }

  /** Direction from the first finger to the second, in degrees. */
  private angle(atStart = false): number {
    const [a, b] = [...this.points.values()]
    if (!a || !b) return 0
    return atStart
      ? (Math.atan2(b.startY - a.startY, b.startX - a.startX) * 180) / Math.PI
      : (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
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

  private updateTransform() {
    // A scroll whose second finger was slow to get going can look like a
    // pinch at first. Until a zoom or rotation starts, it can still become one.
    if (!this.zooming && !this.turning && this.points.size === 2) {
      const { shared, relative, together } = this.pairMotion()
      if (together || (shared > TWO_FINGER_DECIDE && relative < shared * 0.6)) {
        const { cx, cy } = this.centroidShift()
        this.startScroll(this.lastMoveAt(), cx, cy)
        return
      }
    }
    if (this.options.pinch) {
      if (this.options.zoomKeys) this.stepZoom()
      else this.smoothZoom()
    }
    if (this.options.rotate) this.smoothTurn()
  }

  // Zoom and rotation each start once they pass their threshold, so a pinch
  // doesn't also turn a photo a little, and the other way round. Both can
  // then run together, as on a Mac trackpad.
  private smoothZoom() {
    const spread = this.spread()
    if (!this.zoomFrom || !spread) return
    if (!this.zooming) {
      const { radial, twist } = this.transformTravel()
      if (radial < ZOOM_START_PX || radial < twist * DOMINANCE) return
    }
    const delta = spread / this.zoomFrom - 1
    if (Math.abs(delta) < 0.001) return
    this.handler.zoom(this.zooming ? ScrollPhase.Changed : ScrollPhase.Began, delta)
    this.zooming = true
    this.zoomFrom = spread
  }

  private smoothTurn() {
    const angle = this.angle()
    const degrees = turn(this.turnFrom, angle)
    if (!this.turning) {
      const { radial, twist } = this.transformTravel()
      if (twist < TURN_START_PX || twist < radial * DOMINANCE) return
    }
    if (Math.abs(degrees) < 0.1) return
    // Screen y points down, so a clockwise turn has a growing angle; macOS
    // counts counterclockwise as positive.
    this.handler.rotate(this.turning ? ScrollPhase.Changed : ScrollPhase.Began, -degrees)
    this.turning = true
    this.turnFrom = angle
  }

  private endTransform(phase: number) {
    if (this.zooming) this.handler.zoom(phase, 0)
    if (this.turning) this.handler.rotate(phase, 0)
    this.zooming = this.turning = false
  }

  private stepZoom() {
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
      if (this.mode === 'transforming') {
        this.endTransform(ScrollPhase.Ended)
        this.mode = 'done'
      }
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
      case 'transforming':
        this.endTransform(ScrollPhase.Ended)
        break
      case 'dragging3':
        this.handler.buttonUp('left')
        break
      default:
        break
    }
    this.mode = 'idle'
    this.secondTap = false
  }

  private tapped(duration: number, t: number) {
    if (this.maxFingers !== 2) this.releaseTwoTap()
    if (this.maxFingers === 1) {
      if (this.dragLocked) {
        this.dragLocked = false
        this.handler.buttonUp('left')
        this.handler.feedback('select')
        return
      }
      if (this.secondTap) {
        // Second tap of a double tap: the first click was held back.
        this.handler.feedback('light')
        this.handler.click('left')
        this.handler.click('left')
        return
      }
      if (duration > TAP_MS || !this.options.tapToClick) return
      // Felt as the finger lifts, even when the click itself is held back to
      // see whether a drag follows: iPhones only play haptics during a tap.
      this.handler.feedback('light')
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
      if (duration > TAP_MS * 1.4) return
      if (!this.options.smartZoom) {
        if (this.options.twoFingerTap) {
          this.handler.feedback('light')
          this.handler.click('right')
        }
        return
      }
      if (this.twoTap && t - this.twoTap.t <= SMART_ZOOM_MS) {
        clearTimeout(this.twoTap.timer)
        this.twoTap = null
        this.handler.feedback('light')
        this.handler.smartZoom()
        return
      }
      this.releaseTwoTap()
      if (this.options.twoFingerTap) this.handler.feedback('light')
      this.twoTap = { t, timer: setTimeout(() => this.releaseTwoTap(), SMART_ZOOM_MS) }
      return
    }
    if (duration <= TAP_MS * 1.5) {
      this.handler.feedback('light')
      this.handler.multiTap(Math.min(this.maxFingers, 4))
    }
  }

  /** A two-finger tap held back for a possible smart zoom was a right-click. */
  private releaseTwoTap() {
    if (!this.twoTap) return
    clearTimeout(this.twoTap.timer)
    this.twoTap = null
    if (this.options.twoFingerTap) this.handler.click('right')
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
    if ((this.mode === 'dragging' && !this.dragLocked) || this.mode === 'dragging3') this.handler.buttonUp('left')
    if (this.mode === 'scrolling') this.handler.scroll(ScrollPhase.Cancelled, 0, 0)
    if (this.mode === 'transforming') this.endTransform(ScrollPhase.Cancelled)
    this.mode = 'idle'
    this.secondTap = false
  }

  private onLongPress() {
    this.longPressTimer = undefined
    if (this.mode !== 'pending' || this.points.size !== 1 || this.maxFingers !== 1) return
    this.releaseTwoTap()
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
    clearTimeout(this.twoTap?.timer)
    this.twoTap = null
    if (this.mode === 'dragging' || this.mode === 'dragging3' || this.dragLocked) this.handler.buttonUp('left')
    if (this.mode === 'scrolling') this.handler.scroll(ScrollPhase.Cancelled, 0, 0)
    if (this.mode === 'transforming') this.endTransform(ScrollPhase.Cancelled)
    this.points.clear()
    this.dragLocked = false
    this.mode = 'idle'
  }
}

/** Signed difference between two angles in degrees, in [-180, 180). */
function turn(from: number, to: number): number {
  return ((((to - from + 180) % 360) + 360) % 360) - 180
}
