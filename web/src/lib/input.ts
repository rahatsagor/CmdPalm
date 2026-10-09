// High-level input helpers shared by the trackpad, keyboards and deck.

import { send, onMessage, pointer, labels, isOpen } from './connection'
import { haptic } from './haptics'
import { Key, MODIFIER_CODES } from './keys'
import { Modifiers } from './modifiers'
import type { MediaKey, MouseButton, TextMode } from './protocol'
import { settings } from './settings'

export const modifiers = new Modifiers({
  keyDown: (code) => send({ t: 'key', code, down: true, repeat: false }),
  keyUp: (code) => send({ t: 'key', code, down: false }),
})

/** Keys currently held by a finger, so a lost touch can still be released. */
const heldKeys = new Map<number, number>()
/** Fingers holding each key code: the Mac has one key, released by the last. */
const keyCount = new Map<number, number>()

/** The Mac let go of everything this device held; press locks again. */
function macReleased(restore: boolean) {
  heldKeys.clear()
  keyCount.clear()
  if (restore) modifiers.restoreLocks()
}

onMessage((message) => {
  // The Mac releases everything a device held when it reconnects or pauses.
  if (message.t === 'welcome') macReleased(true)
  else if (message.t === 'paused') macReleased(!message.paused)
})

if (typeof document !== 'undefined') {
  // The connection sends a release when the page hides.
  document.addEventListener('visibilitychange', () => macReleased(document.visibilityState === 'visible' && isOpen()))

  // A control removed mid-press (a tab switch, a view swap) never sees its
  // finger lift; the lift still reaches the document.
  const lost = (event: PointerEvent) => {
    keyUp(event.pointerId)
    modifiers.cancel(event.pointerId)
  }
  document.addEventListener('pointerup', lost)
  document.addEventListener('pointercancel', lost)
  document.addEventListener('lostpointercapture', (event) => {
    if (event.target === document) lost(event)
  })
}

/** Press a key until `keyUp`; `extraMods` are held with it (a ⌘Z key). */
export function keyDown(pointerId: number, code: number, extraMods = 0) {
  if (MODIFIER_CODES[code] || heldKeys.has(pointerId)) return
  const mods = modifiers.use() | extraMods
  heldKeys.set(pointerId, code)
  const count = keyCount.get(code) ?? 0
  keyCount.set(code, count + 1)
  if (count === 0) send({ t: 'key', code, down: true, mods, repeat: settings.keyRepeat })
}

export function keyUp(pointerId: number) {
  const code = heldKeys.get(pointerId)
  if (code === undefined) return
  heldKeys.delete(pointerId)
  const count = (keyCount.get(code) ?? 1) - 1
  if (count > 0) {
    keyCount.set(code, count)
    return
  }
  keyCount.delete(code)
  send({ t: 'key', code, down: false })
}

export function tap(code: number, extraMods = 0) {
  const mods = modifiers.use() | extraMods
  send({ t: 'tap', code, mods })
}

/** Type a character as a key press so it can be part of a shortcut. */
export function tapChar(ch: string): boolean {
  const key = labels.value.forChar(ch)
  if (!key) return false
  tap(key.code, key.mods)
  return true
}

export function click(button: MouseButton = 'left') {
  const mods = modifiers.use()
  send({ t: 'button', button, op: 'click', mods })
}

export function buttonDown(button: MouseButton = 'left') {
  const mods = modifiers.use()
  send({ t: 'button', button, op: 'down', mods })
}

export function buttonUp(button: MouseButton = 'left') {
  send({ t: 'button', button, op: 'up' })
}

/** Scrolling and pointer motion pick up held modifiers (⇧-scroll, ⌘-drag). */
export function beginPointerGesture() {
  if (modifiers.state.touching) modifiers.use()
}

export function media(key: MediaKey, op: 'down' | 'up' | 'click' = 'click') {
  send({ t: 'media', key, op })
}

// macOS does not auto-repeat synthesized media keys, so stepping keys repeat
// here while held. Seeking keys stay down so apps can scrub.
const STEPPING = new Set<MediaKey>(['volumeUp', 'volumeDown', 'brightnessUp', 'brightnessDown', 'illuminationUp', 'illuminationDown'])
const SEEKING = new Set<MediaKey>(['rewind', 'fastForward'])
/** Stepping keys still repeating, so Release all can stop them. */
const repeating = new Set<() => void>()

/** Press a media key; call the returned function when the finger lifts. */
export function pressMedia(key: MediaKey): () => void {
  if (SEEKING.has(key)) {
    media(key, 'down')
    return () => media(key, 'up')
  }
  media(key, 'click')
  if (!STEPPING.has(key)) return () => {}
  const stop = () => {
    clearTimeout(timer)
    repeating.delete(stop)
  }
  let timer = setTimeout(function step() {
    media(key, 'click')
    timer = setTimeout(step, 110)
  }, 420)
  repeating.add(stop)
  return stop
}

export function typeText(text: string, mode: TextMode = settings.textMode) {
  if (!text) return
  // With a one-shot modifier waiting, a single character becomes a shortcut.
  if (modifiers.pending() && [...text].length === 1 && tapChar(text)) return
  modifiers.clearLatched()
  send({ t: 'text', text, mode })
}

export function edit(deleteCount: number, insert: string) {
  if (deleteCount === 0 && !insert) return
  send({ t: 'edit', delete: deleteCount, insert })
}

export function releaseAll() {
  for (const stop of repeating) stop()
  heldKeys.clear()
  keyCount.clear()
  modifiers.reset(false)
  pointer.reset()
  send({ t: 'release' })
  haptic('medium')
}

export { Key }
