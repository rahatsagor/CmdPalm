// Pointer acceleration: slow movements stay precise, fast flicks cross the
// screen. Kept apart from the trackpad component so it can be tested.

export interface GainOptions {
  /** The pointer speed setting, 0.2–4. */
  speed: number
  /** The acceleration setting, 0–1. */
  acceleration: number
}

/** Finger speed (CSS px per ms) where acceleration starts and how fast it ramps. */
const ACCEL_START = 0.08
const ACCEL_RANGE = 0.9
const ACCEL_MAX = 2.2
/** How gently the curve bends into and out of its flat parts. The lower knee
 * is tight so slow, precise movements keep the gain they always had. */
const LOW_KNEE = 0.03
const HIGH_KNEE = 0.1

const softplus = (x: number, knee: number) => knee * Math.log1p(Math.exp(x / knee))

/**
 * 0 below the start speed, rising linearly, flattening at the maximum. The
 * corners are rounded: a hard corner makes the gain jump as the finger's
 * speed crosses it, which shows as a hitch at high pointer speeds.
 */
export function boost(speed: number): number {
  const x = (speed - ACCEL_START) / ACCEL_RANGE
  const low = softplus(x, LOW_KNEE)
  return Math.max(0, ACCEL_MAX - softplus(ACCEL_MAX - low, HIGH_KNEE))
}

/**
 * Speed is smoothed over a few samples: touch samples arrive with uneven
 * timing, and raw per-sample speed makes the gain (and so the cursor) jitter
 * even when the finger moves steadily. Faster pointer settings magnify that
 * jitter, so they smooth a little longer.
 */
export class PointerGain {
  private smoothed = -1

  /** Call when a finger lands, so the last gesture's speed doesn't carry over. */
  reset() {
    this.smoothed = -1
  }

  gain(dx: number, dy: number, dt: number, options: GainOptions): number {
    const elapsed = Math.max(1, dt)
    const instant = Math.hypot(dx, dy) / elapsed
    const tau = 25 + 15 * Math.min(Math.max((options.speed - 1) / 3, 0), 1)
    this.smoothed = this.smoothed < 0 ? instant : this.smoothed + (instant - this.smoothed) * (1 - Math.exp(-elapsed / tau))
    const accel = options.acceleration
    return options.speed * (0.8 + accel * boost(this.smoothed) * 1.4 + (1 - accel) * 0.25)
  }
}
