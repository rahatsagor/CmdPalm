import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let conn: typeof import('../src/lib/connection')

function connected() {
  conn.connect()
  lastSocket().open()
  lastSocket().receive(welcome)
  return lastSocket()
}

beforeEach(async () => {
  vi.useFakeTimers()
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ConnectView', () => {
  it('offers to reconnect after disconnecting from Settings', async () => {
    connected()
    conn.disconnect(false)
    const { default: ConnectView } = await import('../src/views/ConnectView.vue')
    const view = mount(ConnectView)
    await nextTick()
    expect(view.text()).toContain('Disconnected from the Mac.')
    const reconnect = view.findAll('button').find((b) => b.text() === 'Reconnect')!
    await reconnect.trigger('click')
    expect(FakeSocket.all).toHaveLength(2)
    expect(conn.state.status).toBe('connecting')
    view.unmount()
  })

  it('cancels a request waiting for approval', async () => {
    localStorage.clear()
    const { default: ConnectView } = await import('../src/views/ConnectView.vue')
    const view = mount(ConnectView)
    conn.connect({ method: 'approve' })
    lastSocket().open()
    lastSocket().receive({ t: 'pending' })
    await nextTick()
    await view.findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(conn.state.status).toBe('idle')
    expect(view.find('form').exists()).toBe(true)
    view.unmount()
  })
})

describe('Composer live typing', () => {
  async function composer() {
    const { settings } = await import('../src/lib/settings')
    settings.liveTyping = true
    const { default: Composer } = await import('../src/components/Composer.vue')
    const view = mount(Composer)
    const field = view.find('textarea')
    const type = (value: string) => field.setValue(value)
    return { view, field, type }
  }

  const edits = (socket: FakeSocket) => socket.sent.filter((m) => m.t === 'edit')

  it('does not count text the Mac never got as typed', async () => {
    const first = connected()
    const { view, field, type } = await composer()
    await type('ab')
    expect(edits(first)).toEqual([{ t: 'edit', delete: 0, insert: 'ab' }])

    first.drop()
    await type('abc')
    expect(conn.state.status).toBe('reconnecting')

    vi.advanceTimersByTime(1000)
    const second = lastSocket()
    second.open()
    second.receive(welcome)
    await nextTick()
    expect((field.element as HTMLTextAreaElement).value).toBe('')

    await type('x')
    expect(edits(second)).toEqual([{ t: 'edit', delete: 0, insert: 'x' }])
    view.unmount()
  })

  it('keeps the text when sending fails', async () => {
    const { settings } = await import('../src/lib/settings')
    const { view, field } = await composer()
    settings.liveTyping = false
    await nextTick()
    await field.setValue('hello')
    await view.find('button[aria-label="Type on the Mac"]').trigger('click')
    expect((field.element as HTMLTextAreaElement).value).toBe('hello')

    const socket = connected()
    await view.find('button[aria-label="Type on the Mac"]').trigger('click')
    expect(socket.sent.filter((m) => m.t === 'text')).toMatchObject([{ text: 'hello' }])
    expect((field.element as HTMLTextAreaElement).value).toBe('')
    view.unmount()
  })
})
