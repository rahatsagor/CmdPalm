import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let conn: typeof import('../src/lib/connection')

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
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

async function mediaView() {
  conn.connect()
  const socket = lastSocket()
  socket.open()
  socket.receive(welcome)
  const { default: MediaView } = await import('../src/views/MediaView.vue')
  const view = mount(MediaView, { attachTo: document.body })
  await nextTick()
  return { socket, view }
}

const pointer = (el: Element, type: string, pointerId: number) =>
  el.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: 'touch', isPrimary: pointerId === 1, bubbles: true }))
const mediaSent = (socket: FakeSocket) => socket.sent.filter((m) => m.t === 'media').map((m) => `${m.key} ${m.op}`)

describe('MediaView', () => {
  it('works from a keyboard or screen reader, without doubling a tap', async () => {
    const { socket, view } = await mediaView()
    const play = view.find('button[aria-label="Play or pause"]')
    await play.trigger('click')
    expect(mediaSent(socket)).toEqual(['playPause click'])

    pointer(play.element, 'pointerdown', 1)
    pointer(play.element, 'pointerup', 1)
    await play.trigger('click', { detail: 1 })
    expect(mediaSent(socket)).toEqual(['playPause click', 'playPause click'])

    await view.find('button[aria-label="Rewind"]').trigger('click')
    expect(mediaSent(socket).slice(2)).toEqual(['rewind down', 'rewind up'])
    view.unmount()
  })

  it('keeps a held key down when another finger lifts from it', async () => {
    const { socket, view } = await mediaView()
    const rewind = view.find('button[aria-label="Rewind"]').element
    pointer(rewind, 'pointerdown', 1)
    pointer(rewind, 'pointerdown', 2)
    pointer(rewind, 'pointerup', 2)
    expect(mediaSent(socket)).toEqual(['rewind down'])
    pointer(rewind, 'pointerup', 1)
    expect(mediaSent(socket)).toEqual(['rewind down', 'rewind up'])
    view.unmount()
  })

  it('stops repeating media keys when control is paused on the Mac', async () => {
    const { socket, view } = await mediaView()
    const brighter = view.find('button[aria-label="Display brightness up"]').element
    brighter.setPointerCapture = () => {}
    pointer(brighter, 'pointerdown', 1)
    vi.advanceTimersByTime(550)
    expect(mediaSent(socket).length).toBeGreaterThanOrEqual(2)

    socket.receive({ t: 'paused', paused: true })
    await nextTick()
    const atPause = mediaSent(socket).length
    vi.advanceTimersByTime(500)
    expect(mediaSent(socket)).toHaveLength(atPause)
    expect(brighter.className).not.toContain('bg-surface-3')
    view.unmount()
  })
})
