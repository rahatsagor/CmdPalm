import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let conn: typeof import('../src/lib/connection')

enableAutoUnmount(afterEach)

beforeEach(async () => {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  conn = await import('../src/lib/connection')
})

afterEach(() => {
  conn.disconnect(false)
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function connect(capsLock?: boolean) {
  conn.connect()
  const socket = lastSocket()
  socket.open()
  socket.receive({ ...welcome, ...(capsLock === undefined ? {} : { capsLock }) })
  return socket
}

describe('Caps Lock', () => {
  it('lights the Mac keyboard’s Caps Lock key while it is on', async () => {
    const socket = connect(true)
    const { Key } = await import('../src/lib/keys')
    const { default: VirtualKeyboard } = await import('../src/components/VirtualKeyboard.vue')
    const view = mount(VirtualKeyboard, { attachTo: document.body })
    const caps = () => view.find(`[data-key="${Key.CapsLock}"]`)
    expect(caps().find('.caps-light').exists()).toBe(true)
    expect(caps().attributes('aria-pressed')).toBe('true')

    socket.receive({ t: 'capsLock', on: false })
    await nextTick()
    expect(caps().find('.caps-light').exists()).toBe(false)
    expect(caps().attributes('aria-pressed')).toBe('false')
  })

  it('lights a custom key that sends Caps Lock, and starts off for Macs that don’t say', async () => {
    const socket = connect()
    expect(conn.state.capsLock).toBe(false)
    const { Key } = await import('../src/lib/keys')
    const { default: CustomKeyboard } = await import('../src/components/CustomKeyboard.vue')
    const board = {
      id: 'b', name: 'Test', cols: 1, rows: 1, trackpad: false,
      keys: [{ id: 'caps', x: 0, y: 0, w: 1, h: 1, action: { kind: 'key' as const, code: Key.CapsLock, mods: 0 } }],
    }
    const view = mount(CustomKeyboard, { props: { board, editing: false }, attachTo: document.body })
    expect(view.find('.caps-light').exists()).toBe(false)
    socket.receive({ t: 'capsLock', on: true })
    await nextTick()
    expect(view.find('.caps-light').exists()).toBe(true)
    expect(view.find('.key').classes()).toContain('is-caps')
  })
})
