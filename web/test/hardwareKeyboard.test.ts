import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let conn: typeof import('../src/lib/connection')
let Key: typeof import('../src/lib/keys').Key

beforeEach(async () => {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  conn = await import('../src/lib/connection')
  ;({ Key } = await import('../src/lib/keys'))
  const { installHardwareKeyboard } = await import('../src/lib/hardware')
  installHardwareKeyboard()
})

afterEach(() => {
  conn.disconnect(false)
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function connect() {
  conn.connect()
  const socket = lastSocket()
  socket.open()
  socket.receive(welcome)
  return socket
}

function press(type: 'keydown' | 'keyup', code: string, caps?: boolean, target: EventTarget = document.body, repeat = false) {
  const event = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, repeat })
  if (caps !== undefined) {
    Object.defineProperty(event, 'getModifierState', { value: (name: string) => name === 'CapsLock' && caps })
  }
  target.dispatchEvent(event)
  return event
}

const toggles = (socket: FakeSocket) => socket.sent.filter(m => m.t === 'tap' && m.code === Key.CapsLock).length

describe('hardware Caps Lock', () => {
  it('toggles once per press when only keydown turns it on and only keyup turns it off', () => {
    const socket = connect()
    press('keydown', 'CapsLock', true)
    expect(toggles(socket)).toBe(1)
    press('keyup', 'CapsLock', false)
    expect(toggles(socket)).toBe(2)
    press('keydown', 'CapsLock', true)
    expect(toggles(socket)).toBe(3)
  })

  it('toggles once per press when both keydown and keyup arrive', () => {
    const socket = connect()
    press('keydown', 'CapsLock', true)
    press('keyup', 'CapsLock', true)
    expect(toggles(socket)).toBe(1)
    press('keydown', 'CapsLock', false)
    press('keyup', 'CapsLock', false)
    expect(toggles(socket)).toBe(2)
  })

  it('toggles on every keydown when the browser reports keydown for both presses', () => {
    const socket = connect()
    press('keydown', 'CapsLock', true)
    press('keydown', 'CapsLock', false)
    expect(toggles(socket)).toBe(2)
  })

  it('handles keyboards that report the old state on keydown', () => {
    const socket = connect()
    press('keydown', 'KeyA', false)
    press('keyup', 'KeyA', false)
    press('keydown', 'CapsLock', false)
    press('keyup', 'CapsLock', true)
    expect(toggles(socket)).toBe(1)
    press('keydown', 'CapsLock', true)
    press('keyup', 'CapsLock', false)
    expect(toggles(socket)).toBe(2)
  })

  it('ignores a press in a text field and still toggles once for the next press outside', () => {
    const socket = connect()
    const input = document.createElement('input')
    document.body.append(input)
    press('keydown', 'KeyA', false)
    press('keydown', 'CapsLock', true, input)
    press('keyup', 'CapsLock', true, input)
    expect(toggles(socket)).toBe(0)
    press('keydown', 'CapsLock', false)
    press('keyup', 'CapsLock', false)
    expect(toggles(socket)).toBe(1)
  })

  it('toggles on the first press after the window loses focus', () => {
    const socket = connect()
    press('keydown', 'CapsLock', true)
    expect(toggles(socket)).toBe(1)
    window.dispatchEvent(new Event('blur'))
    press('keydown', 'CapsLock', true)
    expect(toggles(socket)).toBe(2)
  })

  it('never sends Caps Lock as a held key', () => {
    const socket = connect()
    press('keydown', 'CapsLock', true)
    press('keyup', 'CapsLock', true)
    press('keydown', 'CapsLock', false)
    press('keyup', 'CapsLock', false)
    expect(socket.sent.some(m => m.t === 'key' && m.code === Key.CapsLock)).toBe(false)
  })
})

describe('hardware keys after release-all', () => {
  it('presses a held key again on its next repeat', async () => {
    const socket = connect()
    press('keydown', 'KeyA')
    const downs = () => socket.sent.filter(m => m.t === 'key' && m.code === Key.A && m.down === true).length
    expect(downs()).toBe(1)
    const { releaseAll } = await import('../src/lib/input')
    releaseAll()
    press('keydown', 'KeyA', undefined, document.body, true)
    expect(downs()).toBe(2)
  })
})
