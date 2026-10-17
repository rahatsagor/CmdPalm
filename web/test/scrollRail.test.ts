import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { Op, ScrollPhase } from '../src/lib/protocol'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let conn: typeof import('../src/lib/connection')

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
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

function connected() {
  conn.connect()
  lastSocket().open()
  lastSocket().receive(welcome)
  return lastSocket()
}

function scrolls(socket: FakeSocket) {
  return socket.binary
    .map((buf) => new DataView(buf))
    .filter((view) => view.getUint8(0) === Op.Scroll)
    .map((view) => ({ phase: view.getUint8(1), dy: view.getFloat32(6, true) }))
}

/** Lets batched pointer messages go out. */
const settle = (ms = 20) => vi.advanceTimersByTimeAsync(ms)

// The track is 400px and the handle 96px, so the handle travels 152px each way.
async function rail() {
  const { default: ScrollRail } = await import('../src/components/ScrollRail.vue')
  const view = mount(ScrollRail, { attachTo: document.body })
  const [track, handle] = [view.element as HTMLElement, view.find('[aria-label="Scroll strip"]').element as HTMLElement]
  Object.defineProperty(track, 'clientHeight', { value: 400 })
  Object.defineProperty(handle, 'clientHeight', { value: 96 })
  handle.setPointerCapture = () => {}
  const fire = (type: string, clientY: number) => handle.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientY, bubbles: true }))
  return { view, fire }
}

describe('scroll strip', () => {
  it('scrolls with the handle, and keeps scrolling while it is held at an end', async () => {
    const socket = connected()
    const { view, fire } = await rail()
    fire('pointerdown', 300)
    fire('pointermove', 340)
    await settle()
    expect(scrolls(socket)).toEqual([{ phase: ScrollPhase.Began, dy: 64 }])

    // Short of the end, nothing happens while the finger rests.
    await settle(300)
    expect(scrolls(socket)).toHaveLength(1)

    fire('pointermove', 300 + 152 + 20)
    await settle()
    const before = scrolls(socket).length
    await settle(500)
    const held = scrolls(socket).slice(before)
    expect(held.length).toBeGreaterThan(5)
    expect(held.every((s) => s.phase === ScrollPhase.Changed && s.dy > 0)).toBe(true)
    // About (360 + 20 * 14) px/s for half a second, at 1.6× scroll scale.
    expect(held.reduce((sum, s) => sum + s.dy, 0)).toBeCloseTo(512, -2)

    fire('pointerup', 472)
    await settle()
    const done = scrolls(socket).length
    expect(scrolls(socket).at(-1)!.phase).toBe(ScrollPhase.Ended)
    await settle(500)
    expect(scrolls(socket)).toHaveLength(done)
    view.unmount()
  })

  it('scrolls the other way at the top', async () => {
    const socket = connected()
    const { view, fire } = await rail()
    fire('pointerdown', 300)
    fire('pointermove', 300 - 160)
    await settle()
    const before = scrolls(socket).length
    await settle(200)
    expect(scrolls(socket).slice(before).every((s) => s.dy < 0)).toBe(true)
    fire('pointerup', 140)
    view.unmount()
  })

  it('stops when the page hides', async () => {
    const socket = connected()
    const { view, fire } = await rail()
    fire('pointerdown', 300)
    fire('pointermove', 480)
    await settle(100)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    const stopped = scrolls(socket).length
    expect(scrolls(socket).at(-1)!.phase).toBe(ScrollPhase.Cancelled)
    await settle(500)
    expect(scrolls(socket)).toHaveLength(stopped)
    view.unmount()
  })

  it('stops when the connection drops', async () => {
    const first = connected()
    const { view, fire } = await rail()
    fire('pointerdown', 300)
    fire('pointermove', 480)
    await settle(100)
    first.drop()
    await nextTick()
    await settle(1000)
    const second = lastSocket()
    second.open()
    second.receive(welcome)
    await settle(500)
    expect(scrolls(second)).toEqual([])
    view.unmount()
  })

  it('only follows the finger when holding is turned off', async () => {
    const { settings } = await import('../src/lib/settings')
    settings.scrollHold = false
    const socket = connected()
    const { view, fire } = await rail()
    fire('pointerdown', 300)
    fire('pointermove', 480)
    await settle()
    await settle(500)
    expect(scrolls(socket)).toEqual([{ phase: ScrollPhase.Began, dy: 288 }])
    fire('pointerup', 480)
    view.unmount()
  })
})
