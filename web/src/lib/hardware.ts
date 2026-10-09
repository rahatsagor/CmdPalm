// Forwards a hardware keyboard attached to the phone or iPad (e.g. a Magic
// Keyboard) to the Mac, key by key, whenever no text field has focus.

import { send } from './connection'
import { Key, fromDomCode } from './keys'

const MODIFIERS: Record<string, number> = {
  ShiftLeft: Key.Shift, ShiftRight: Key.RightShift, ControlLeft: Key.Control, ControlRight: Key.RightControl,
  AltLeft: Key.Option, AltRight: Key.RightOption, MetaLeft: Key.Command, MetaRight: Key.RightCommand,
  CapsLock: Key.CapsLock,
}

const down = new Set<number>()

function editable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

function codeFor(event: KeyboardEvent): number | undefined {
  return MODIFIERS[event.code] ?? fromDomCode(event.code)
}

function onKeyDown(event: KeyboardEvent) {
  // Sheets keep the keyboard for their own fields and Escape-to-close.
  if (editable(event.target) || event.isComposing || document.querySelector('[role="dialog"]')) return
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
  addEventListener('keydown', onKeyDown)
  addEventListener('keyup', onKeyUp)
  // Key-up events are lost when focus leaves the page mid-press.
  addEventListener('blur', releaseHardwareKeys)
}
