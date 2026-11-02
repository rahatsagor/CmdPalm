import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function connect() {
  conn.connect()
  const socket = lastSocket()
  socket.open()
  socket.receive(welcome)
  return socket
}

/** A screen reader's click: no press before it, so a detail of 0. */
const readerClick = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
const enter = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

describe('controls used without touch', () => {
  it('click the Mac from the click bar', async () => {
    const socket = connect()
    const { default: ClickBar } = await import('../src/components/ClickBar.vue')
    const view = mount(ClickBar, { attachTo: document.body })
    const left = view.find('[aria-label="left mouse button"]')
    expect(left.attributes('tabindex')).toBe('0')
    readerClick(left.element)
    enter(left.element)
    expect(socket.sent.filter((m) => m.t === 'button')).toMatchObject([
      { button: 'left', op: 'click' },
      { button: 'left', op: 'click' },
    ])
  })

  it('latch a modifier key like a tap', async () => {
    connect()
    const { default: ModKey } = await import('../src/components/ModKey.vue')
    const { modifiers } = await import('../src/lib/input')
    const { Key } = await import('../src/lib/keys')
    const { Mod } = await import('../src/lib/protocol')
    const view = mount(ModKey, { props: { mod: Mod.Command, code: Key.Command, symbol: '⌘', label: 'Command' }, attachTo: document.body })
    view.find('[role="button"]').element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    expect(modifiers.status(Mod.Command)).toBe('latched')
  })

  it('tap the composer’s keys, without a hardware keyboard also sending Return', async () => {
    const socket = connect()
    const { installHardwareKeyboard } = await import('../src/lib/hardware')
    installHardwareKeyboard()
    const { Key } = await import('../src/lib/keys')
    const { default: Composer } = await import('../src/components/Composer.vue')
    const view = mount(Composer, { attachTo: document.body })
    enter(view.find('[aria-label="Left"]').element)
    readerClick(view.find('[aria-label="Return"]').element)
    expect(socket.sent.filter((m) => m.t === 'tap')).toMatchObject([{ code: Key.Left }, { code: Key.Return }])
    expect(socket.sent.filter((m) => m.t === 'key')).toEqual([])
  })
})

describe('forgetting a Mac', () => {
  it('drops its app list', () => {
    const socket = connect()
    socket.receive({ t: 'apps', apps: [{ id: 'a', name: 'A', running: false, active: false, hidden: false }] })
    expect(conn.state.apps).toHaveLength(1)
    conn.disconnect(true)
    expect(conn.state.apps).toEqual([])
    expect(conn.state.appsLoaded).toBe(false)
  })
})
