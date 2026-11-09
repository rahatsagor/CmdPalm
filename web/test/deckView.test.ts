import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeepAlive, defineComponent, h, nextTick, ref, type Component } from 'vue'
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

async function deckView(selected: string, wrap?: (deckView: Component) => Component) {
  conn.connect()
  const socket = lastSocket()
  socket.open()
  socket.receive({ ...welcome, deck })
  socket.acceptDeckSaves = true
  const { settings } = await import('../src/lib/settings')
  settings.deckPage = selected
  const { default: DeckView } = await import('../src/views/DeckView.vue')
  const view = mount(wrap ? wrap(DeckView) : DeckView, { attachTo: document.body })
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

function dialogButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`no ${text} button`)
  return button
}

describe('DeckView', () => {
  it('runs the pressed tile by id when another device reorders before the finger lifts', async () => {
    const { socket, view } = await deckView('essentials')
    pointer(tile('Mute'), 'pointerdown')
    socket.receive({ t: 'deck', revision: 1, deck: { ...deck, pages: [{ ...deck.pages[0], tiles: [...deck.pages[0]!.tiles].reverse() }, deck.pages[1]] } })
    await nextTick()
    pointer(tile('Mute'), 'pointerup')
    expect(socket.sent.filter((m) => m.t === 'action')).toMatchObject([{ action: { key: 'mute' } }])
    view.unmount()
  })

  it('never runs a neighbouring tile if the pressed tile was removed remotely', async () => {
    const { socket, view } = await deckView('essentials')
    const target = tile('Mute')
    pointer(target, 'pointerdown')
    socket.receive({ t: 'deck', revision: 1, deck: { ...deck, pages: [{ ...deck.pages[0], tiles: [deck.pages[0]!.tiles[1]] }, deck.pages[1]] } })
    // The captured element can receive the lift before Vue removes it.
    pointer(target, 'pointerup')
    expect(socket.sent.filter((m) => m.t === 'action')).toEqual([])
    view.unmount()
  })

  it('keeps a rejected draft and lets the person retry the same edit', async () => {
    const { socket, view } = await deckView('essentials')
    socket.acceptDeckSaves = false
    pointer(tile('Mute'), 'pointerdown')
    vi.advanceTimersByTime(600)
    pointer(tile('Mute'), 'pointerup')
    await nextTick()
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    field.value = 'My saved label'
    field.dispatchEvent(new Event('input'))
    await nextTick()
    dialogButton('Save').click()
    await nextTick()
    expect(dialogButton('Saving…').disabled).toBe(true)
    const id = socket.sent.filter((m) => m.t === 'deckSave').at(-1)!.id
    socket.receive({ t: 'deckSaved', id, ok: false, revision: 0, message: 'The Mac could not save the deck.' })
    await nextTick()
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe('My saved label')
    socket.acceptDeckSaves = true
    dialogButton('Save').click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(conn.state.deck?.pages[0]?.tiles[0]?.label).toBe('My saved label')
    expect(view.find('button[aria-label="Undo last Deck edit"]').attributes('disabled')).toBeUndefined()
    const activation = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    view.find('button[aria-label="Undo last Deck edit"]').element.dispatchEvent(activation)
    await flushPromises()
    expect(activation.defaultPrevented).toBe(true)
    expect(conn.state.deck?.pages[0]?.tiles[0]?.label).toBe('Mute')
    view.unmount()
  })

  it('cancels a local drag when a newer deck arrives', async () => {
    const { socket, view } = await deckView('essentials')
    await view.findAll('button').find((b) => b.text() === 'Edit')!.trigger('click')
    const mute = tile('Mute')
    const play = tile('Play / Pause')
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [play] })
    mute.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', bubbles: true }))
    mute.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 40, bubbles: true }))
    await nextTick()
    const remote = { ...deck, pages: [{ ...deck.pages[0], name: 'Remote page', tiles: deck.pages[0]!.tiles.slice(0, 1) }, deck.pages[1]] }
    socket.receive({ t: 'deck', deck: remote, revision: 1 })
    await nextTick()
    pointer(tile('Mute'), 'pointerup')
    Reflect.deleteProperty(document, 'elementsFromPoint')
    expect(socket.sent.filter((m) => m.t === 'deckSave')).toEqual([])
    expect(conn.state.deck?.pages[0]?.name).toBe('Remote page')
    view.unmount()
  })

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

  it('runs a button from the keyboard, and edits it in edit mode', async () => {
    const { socket, view } = await deckView('essentials')
    const target = tile('My Button')
    expect(target.tabIndex).toBe(0)
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(socket.sent.filter((m) => m.t === 'action')).toMatchObject([{ action: { kind: 'app', id: 'com.apple.Safari' } }])

    await view.findAll('button').find((b) => b.text() === 'Edit')!.trigger('click')
    tile('Mute').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await nextTick()
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit button')
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
    dialogButton('Save').click()
    await nextTick()
    const saved = socket.sent.filter((m) => m.t === 'deckSave').at(-1) as { deck: typeof deck } | undefined
    expect(saved?.deck.pages.map((p) => p.tiles.map((t) => t.label))).toEqual([
      ['Mute', 'Play / Pause'],
      ['Finder', 'Safari'],
    ])
    view.unmount()
  })

  it('stays on the selected page when a new page could not be saved', async () => {
    const { socket, settings, view } = await deckView('apps')
    await view.findAll('button').find((b) => b.text() === 'Edit')!.trigger('click')
    socket.readyState = FakeSocket.CLOSED
    await view.find('button[aria-label="Add page"]').trigger('click')
    expect(settings.deckPage).toBe('apps')
    expect(view.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Essentials', 'Apps'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })

  it('scrolls back to the selected page when the deck comes back into view', async () => {
    const shown = ref(true)
    const Other = defineComponent({ render: () => h('div') })
    const { view } = await deckView('apps', (DeckView) =>
      defineComponent({ render: () => h(KeepAlive, null, { default: () => h(shown.value ? DeckView : Other) }) }),
    )
    const strip = document.querySelector<HTMLElement>('[role="tabpanel"]')!.parentElement!
    Object.defineProperty(strip, 'clientWidth', { value: 320 })
    const scrollTo = vi.spyOn(strip, 'scrollTo')
    shown.value = false
    await nextTick()
    shown.value = true
    await nextTick()
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 320, behavior: 'instant' })
    view.unmount()
  })
  it('scrolls to the selected page when another device reorders the pages', async () => {
    const { socket, view } = await deckView('essentials')
    const strip = document.querySelector<HTMLElement>('[role="tabpanel"]')!.parentElement!
    Object.defineProperty(strip, 'clientWidth', { value: 320 })
    const scrollTo = vi.spyOn(strip, 'scrollTo')
    socket.receive({ t: 'deck', deck: { ...deck, pages: [...deck.pages].reverse() } })
    await nextTick()
    await nextTick()
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 320, behavior: 'instant' })
    view.unmount()
  })

  it('saves page-tab order to the Mac while keeping the selected page', async () => {
    const { socket, settings, view } = await deckView('apps')
    await view.findAll('button').find((b) => b.text() === 'Edit')!.trigger('click')
    await view.find('[data-group-id="apps"]').trigger('keydown', { key: 'ArrowLeft', altKey: true })
    const saved = socket.sent.filter((m) => m.t === 'deckSave') as { deck: typeof deck }[]
    expect(saved).toHaveLength(1)
    expect(saved[0]!.deck.pages.map((page) => page.id)).toEqual(['apps', 'essentials'])
    expect(settings.deckPage).toBe('apps')
    expect(view.find('[role="tab"][aria-selected="true"]').text()).toBe('Apps')
    view.unmount()
  })

  it('saves the edited button by id after another device reorders its page', async () => {
    const { socket, view } = await deckView('apps')
    const target = tile('My Button')
    pointer(target, 'pointerdown')
    vi.advanceTimersByTime(600)
    pointer(target, 'pointerup')
    await nextTick()
    const apps = deck.pages[1]!
    socket.receive({ t: 'deck', deck: { ...deck, pages: [deck.pages[0], { ...apps, tiles: [...apps.tiles].reverse() }] } })
    await nextTick()
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    field.value = 'Safari'
    field.dispatchEvent(new Event('input'))
    await nextTick()
    dialogButton('Save').click()
    await nextTick()
    const saved = socket.sent.filter((m) => m.t === 'deckSave').at(-1) as { deck: typeof deck } | undefined
    expect(saved?.deck.pages[1]?.tiles.map((t) => t.label)).toEqual(['Safari', 'Finder'])
    view.unmount()
  })

  it('keeps the button editor open when the change could not be saved', async () => {
    const { socket, view } = await deckView('apps')
    const target = tile('My Button')
    pointer(target, 'pointerdown')
    vi.advanceTimersByTime(600)
    pointer(target, 'pointerup')
    await nextTick()
    socket.readyState = FakeSocket.CLOSED
    dialogButton('Save').click()
    await nextTick()
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit button')
    view.unmount()
  })

  it('keeps edits made before Duplicate, for the button and its copy', async () => {
    const { socket, view } = await deckView('apps')
    const target = tile('My Button')
    pointer(target, 'pointerdown')
    vi.advanceTimersByTime(600)
    pointer(target, 'pointerup')
    await nextTick()
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    field.value = 'Safari'
    field.dispatchEvent(new Event('input'))
    await nextTick()
    dialogButton('Duplicate').click()
    await nextTick()
    const saved = socket.sent.filter((m) => m.t === 'deckSave').at(-1) as { deck: typeof deck } | undefined
    const tiles = saved?.deck.pages[1]?.tiles ?? []
    expect(tiles.map((t) => t.label)).toEqual(['Finder', 'Safari', 'Safari'])
    expect(new Set(tiles.map((t) => t.id)).size).toBe(3)
    view.unmount()
  })

  it('saves a reorder when Done is tapped before the dragging finger lifts', async () => {
    const { socket, view } = await deckView('essentials')
    await view.findAll('button').find((b) => b.text() === 'Edit')!.trigger('click')
    const mute = tile('Mute')
    const play = tile('Play / Pause')
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [play] })
    const at = (type: string, clientX: number) =>
      mute.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX, clientY: 0, bubbles: true }))
    at('pointerdown', 0)
    at('pointermove', 40)
    await nextTick()
    await view.findAll('button').find((b) => b.text() === 'Done')!.trigger('click')
    at('pointerup', 40)
    await nextTick()
    Reflect.deleteProperty(document, 'elementsFromPoint')
    const saved = socket.sent.filter((m) => m.t === 'deckSave').at(-1) as { deck: typeof deck } | undefined
    expect(saved?.deck.pages[0]?.tiles.map((t) => t.label)).toEqual(['Play / Pause', 'Mute'])
    view.unmount()
  })

  it('closes the page editor when another device deletes the page', async () => {
    const { socket, view } = await deckView('apps')
    await view.findAll('button').find((b) => b.text() === 'Edit')!.trigger('click')
    await view.findAll('[role="tab"]').find((t) => t.text().includes('Apps'))!.trigger('click')
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Page')
    socket.receive({ t: 'deck', deck: { ...deck, pages: [deck.pages[0]] } })
    await nextTick()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(socket.sent.filter((m) => m.t === 'deckSave')).toEqual([])
    view.unmount()
  })
})
