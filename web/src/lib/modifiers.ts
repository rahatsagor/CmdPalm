// On-screen modifier keys.
//
//   tap         → latched: applies to the next key or click, then clears
//   double tap  → locked: stays on until tapped again
//   hold        → held: pressed on the Mac for as long as the finger stays,
//                 so ⌘-click, ⌘-Tab-Tab-Tab and ⇧-scroll work like hardware
//
// A held modifier is only pressed on the Mac once something uses it. A lone
// press and release would otherwise trigger system actions (the fn/🌐 key
// opens the emoji picker, for example).

import { reactive } from 'vue'
import { Key, plainMods } from './keys'
import { Mod } from './protocol'

export type ModState = 'off' | 'latched' | 'locked'

export interface ModifierIO {
  keyDown(code: number): void
  keyUp(code: number): void
}

const TAP_MAX_MS = 320
const DOUBLE_TAP_MS = 380

const CODE_FOR: Record<number, number> = {
  [Mod.Command]: Key.Command,
  [Mod.Shift]: Key.Shift,
  [Mod.Option]: Key.Option,
  [Mod.Control]: Key.Control,
  [Mod.Fn]: Key.Fn,
  [Mod.RightCommand]: Key.RightCommand,
  [Mod.RightShift]: Key.RightShift,
  [Mod.RightOption]: Key.RightOption,
  [Mod.RightControl]: Key.RightControl,
}

interface Touch {
  mod: number
  code: number
  at: number
  committed: boolean
  used: boolean
}

export class Modifiers {
  readonly state = reactive({
    latched: 0,
    locked: 0,
    /** Modifiers with a finger on them (pressed on the Mac or not yet). */
    touching: 0,
  })
  private touches = new Map<number, Touch>()
  private lastTap = new Map<number, number>()
  /** Codes this client has pressed on the Mac for locks. */
  private lockHeld = new Map<number, number>()

  constructor(private io: ModifierIO, private now: () => number = () => performance.now()) {}

  /**
   * Everything currently in effect, for key labels, as plain modifiers: a
   * right ⇧ capitalizes like the left one. `status` tells the sides apart.
   */
  get active(): number {
    return plainMods(this.state.latched | this.state.locked | this.state.touching)
  }

  status(mod: number): ModState | 'held' {
    if (this.state.touching & mod) return 'held'
    if (this.state.locked & mod) return 'locked'
    if (this.state.latched & mod) return 'latched'
    return 'off'
  }

  /** A finger landed on a modifier key. `code` distinguishes left/right keys. */
  press(pointer: number, mod: number, code = CODE_FOR[mod]!) {
    this.touches.set(pointer, { mod, code, at: this.now(), committed: false, used: false })
    this.state.touching |= mod
  }

  release(pointer: number) {
    const touch = this.touches.get(pointer)
    if (!touch) return
    this.touches.delete(pointer)
    this.state.touching = [...this.touches.values()].reduce((acc, t) => acc | t.mod, 0)
    // Two fingers on ⇧ hold one key on the Mac; the last to lift releases it.
    if (touch.committed && !this.isPressed(touch.code)) this.io.keyUp(touch.code)
    if (touch.used || this.now() - touch.at > TAP_MAX_MS) return
    this.tap(touch.mod)
  }

  /** Cancel a touch without treating it as a tap (e.g. the finger slid off). */
  cancel(pointer: number) {
    const touch = this.touches.get(pointer)
    if (!touch) return
    touch.used = true
    this.release(pointer)
  }

  private tap(mod: number) {
    const now = this.now()
    const last = this.lastTap.get(mod) ?? -Infinity
    if (this.state.locked & mod) {
      this.setLocked(mod, false)
      this.lastTap.delete(mod)
    } else if (this.state.latched & mod) {
      this.state.latched &= ~mod
      if (now - last <= DOUBLE_TAP_MS) this.setLocked(mod, true)
      this.lastTap.delete(mod)
    } else {
      this.state.latched |= mod
      this.lastTap.set(mod, now)
    }
  }

  private setLocked(mod: number, on: boolean) {
    if (on) {
      this.state.locked |= mod
      // fn stays client-side: holding it for a long time and letting go
      // without another key would open the emoji picker.
      if (mod !== Mod.Fn) {
        const code = CODE_FOR[mod]!
        this.lockHeld.set(mod, code)
        this.io.keyDown(code)
      }
    } else {
      this.state.locked &= ~mod
      const code = this.lockHeld.get(mod)
      if (code !== undefined) {
        this.lockHeld.delete(mod)
        this.io.keyUp(code)
      }
    }
  }

  toggleLock(mod: number) {
    this.state.latched &= ~mod
    this.setLocked(mod, !(this.state.locked & mod))
  }

  /**
   * Called before any key, click or scroll. Presses held modifiers on the Mac
   * and returns the one-shot modifiers to attach to this event.
   */
  use(): number {
    for (const touch of this.touches.values()) {
      touch.used = true
      if (!touch.committed && !(this.state.locked & touch.mod && touch.mod !== Mod.Fn)) {
        if (!this.isPressed(touch.code)) this.io.keyDown(touch.code)
        touch.committed = true
      }
    }
    const oneShot = this.state.latched | (this.state.locked & Mod.Fn)
    this.state.latched = 0
    return oneShot
  }

  /** Peek without consuming, e.g. to label keys. */
  pending(): number {
    return this.state.latched | (this.state.locked & Mod.Fn)
  }

  clearLatched() {
    this.state.latched = 0
  }

  /**
   * Consume modifiers for something the client handles itself (fn + F1 as a
   * media key): one-shots clear and held keys stop counting as taps, but
   * nothing is pressed on the Mac.
   */
  consume(): number {
    for (const touch of this.touches.values()) touch.used = true
    const mods = this.active
    this.state.latched = 0
    return mods
  }

  /** Forget everything, e.g. after a reconnect (the Mac released it all). */
  reset(sendUps = false) {
    if (sendUps) {
      for (const touch of this.touches.values()) if (touch.committed) this.io.keyUp(touch.code)
      for (const code of this.lockHeld.values()) this.io.keyUp(code)
    }
    this.touches.clear()
    this.lockHeld.clear()
    this.lastTap.clear()
    this.state.latched = 0
    this.state.locked = 0
    this.state.touching = 0
  }

  /**
   * Forget fingers whose lift will never arrive (the page was hidden),
   * without key-ups: the Mac already released everything this device held.
   */
  dropTouches() {
    this.touches.clear()
    this.state.touching = 0
  }

  /**
   * The Mac released everything (reconnect, pause, page hidden): press locks
   * again, and press held modifiers again the next time they are used.
   */
  restoreLocks() {
    for (const touch of this.touches.values()) touch.committed = false
    for (const code of this.lockHeld.values()) this.io.keyDown(code)
  }

  private isPressed(code: number): boolean {
    for (const touch of this.touches.values()) if (touch.committed && touch.code === code) return true
    return false
  }
}
