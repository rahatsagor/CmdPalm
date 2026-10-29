import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let conn: typeof import('../src/lib/connection')

const deck = {
  version: 1,
  pages: [
    {
      id: 'essentials',
      name: 'Essentials',
      columns: 4,
      tiles: [
        { id: 'mute', label: 'Mute', action: { kind: 'media', key: 'mute' } },
        { id: 'play', label: 'Play / Pause', action: { kind: 'media', key: 'playPause' } },
      ],
    },
    {
      id: 'apps',
      name: 'Apps',
      columns: 4,
      tiles: [
        { id: 'finder', label: 'Finder', action: { kind: 'app', id: 'com.apple.finder', op: 'toggle' } },
        { id: 't-custom', label: 'My Button', action: { kind: 'app', id: 'com.apple.Safari', op: 'toggle' } },
      ],
    },
  ],
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

async function deckView(selected: string) {
  conn.connect()
  const socket = lastSocket()
  socket.open()
  socket.receive({ ...welcome, deck })
  const { settings } = await import('../src/lib/settings')
  settings.deckPage = selected
  const { default: DeckView } = await import('../src/views/DeckView.vue')
  const view = mount(DeckView, { attachTo: document.body })
  await nextTick()
  return { socket, settings, view }
}

function tile(label: string): HTMLElement {
  const el = Array.from(document.querySelectorAll<HTMLElement>('label[role="button"]')).find((e) => e.getAttribute('aria-label') === label)
  if (!el) throw new Error(`no ${label} button`)
  return el
}

function pointer(el: HTMLElement, type: string) {
  el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true }))
}

describe('DeckView', () => {
  // The selected page and the page on screen can differ, for example after
  // the scroll position was lost while another tab was open.
  it('runs the button that was tapped, not the one at its spot on the selected page', async () => {
    const { socket, view } = await deckView('essentials')
    const target = tile('My Button')
    pointer(target, 'pointerdown')
    pointer(target, 'pointerup')
    await nextTick()
    expect(socket.sent.filter((m) => m.t === 'action')).toMatchObject([{ action: { kind: 'app', id: 'com.apple.Safari' } }])
    view.unmount()
  })

  it('edits and saves the button that was held, on its own page', async () => {
    const { socket, settings, view } = await deckView('essentials')
    const target = tile('My Button')
    pointer(target, 'pointerdown')
    vi.advanceTimersByTime(600)
    pointer(target, 'pointerup')
    await nextTick()
    expect(settings.deckPage).toBe('apps')
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit button')
    expect(field.value).toBe('My Button')

    field.value = 'Safari'
    field.dispatchEvent(new Event('input'))
    await nextTick()
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((b) => b.textContent?.trim() === 'Save')!
      .click()
    await nextTick()
    const saved = socket.sent.filter((m) => m.t === 'deckSave').at(-1) as { deck: typeof deck } | undefined
    expect(saved?.deck.pages.map((p) => p.tiles.map((t) => t.label))).toEqual([
      ['Mute', 'Play / Pause'],
      ['Finder', 'Safari'],
    ])
    view.unmount()
  })
})
