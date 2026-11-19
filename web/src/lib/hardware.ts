// Forwards a hardware keyboard attached to the phone or iPad (e.g. a Magic
// Keyboard) to the Mac, key by key, whenever no text field has focus.

import { onMessage, send } from './connection'
import { Key, fromDomCode } from './keys'

const MODIFIERS: Record<string, number> = {
  ShiftLeft: Key.Shift, ShiftRight: Key.RightShift, ControlLeft: Key.Control, ControlRight: Key.RightControl,
  AltLeft: Key.Option, AltRight: Key.RightOption, MetaLeft: Key.Command, MetaRight: Key.RightCommand,
  CapsLock: Key.CapsLock,
}

const down = new Set<number>()

const INTERACTIVE = 'button, a[href], summary, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="option"], [role="menuitem"], [role="checkbox"]'
const REMOTE_TAB_MODS = [Key.Command, Key.RightCommand, Key.Control, Key.RightControl, Key.Option, Key.RightOption]
const CLEANUP_KEY = Symbol.for('cmdpalm.hardwareKeyboard')

function activatesControl(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key !== 'Enter' && event.key !== ' ' && event.code !== 'Enter' && event.code !== 'NumpadEnter' && event.code !== 'Space') return false
  const el = event.target as Element | null
  return !!el?.closest?.(INTERACTIVE)
}

function navigatesControls(event: KeyboardEvent): boolean {
  return (event.key === 'Tab' || event.code === 'Tab') && !event.metaKey && !event.ctrlKey && !event.altKey
    && !REMOTE_TAB_MODS.some(mod => down.has(mod))
}

function editable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

function codeFor(event: KeyboardEvent): number | undefined {
  return MODIFIERS[event.code] ?? fromDomCode(event.code)
}

function onKeyDown(event: KeyboardEvent) {
  // Sheets keep the keyboard for their own fields and Escape-to-close; unmodified
  // Tab moves between phone controls, and focused controls keep Enter and Space.
  if (event.isComposing || event.defaultPrevented || document.querySelector('[role="dialog"]')) return
  if (navigatesControls(event) || editable(event.target) || activatesControl(event)) return
  const code = codeFor(event)
  if (code === undefined) return
  event.preventDefault()
  if (event.repeat && down.has(code)) return
  down.add(code)
  // Hardware keys repeat on the Mac at the Mac's own rate.
  send({ t: 'key', code, down: true, repeat: true })
}

function onKeyUp(event: KeyboardEvent) {
  const code = codeFor(event)
  if (code === undefined || !down.delete(code)) return
  event.preventDefault()
  send({ t: 'key', code, down: false })
}

export function releaseHardwareKeys() {
  for (const code of down) send({ t: 'key', code, down: false })
  down.clear()
}

export function installHardwareKeyboard() {
  const host = globalThis as unknown as { [CLEANUP_KEY]?: () => void }
  host[CLEANUP_KEY]?.()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') down.clear()
  }
  addEventListener('keydown', onKeyDown)
  addEventListener('keyup', onKeyUp)
  // Key-up events are lost when focus leaves the page mid-press.
  addEventListener('blur', releaseHardwareKeys)
  // The Mac lets go of every key on reconnect, on pause and when the page
  // hides. Forgetting them here lets a key still held press again on its
  // next repeat instead of being ignored.
  const offMessage = onMessage((message) => {
    if (message.t === 'welcome' || message.t === 'paused') down.clear()
  })
  document.addEventListener('visibilitychange', onVisibility)
  host[CLEANUP_KEY] = () => {
    removeEventListener('keydown', onKeyDown)
    removeEventListener('keyup', onKeyUp)
    removeEventListener('blur', releaseHardwareKeys)
    document.removeEventListener('visibilitychange', onVisibility)
    offMessage()
    releaseHardwareKeys()
  }
}
