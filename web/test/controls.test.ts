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

  it('starts live typing fresh after composer navigation keys, phone pastes, interrupted IME composition and oversized pastes', async () => {
    const socket = connect()
    const { settings } = await import('../src/lib/settings')
    settings.liveTyping = true
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { readText: () => Promise.resolve('clip') },
    })
    const { default: Composer } = await import('../src/components/Composer.vue')
    const view = mount(Composer, { attachTo: document.body })
    const field = view.find('textarea')

    await field.setValue('hello')
    expect(socket.sent.filter((m) => m.t === 'edit')).toEqual([{ t: 'edit', delete: 0, insert: 'hello' }])

    // Moving the Mac's caret with the toolbar arrow strip must reset live history
    // instead of backspacing from the new caret position on the next edit.
    const left = view.find('[aria-label="Left"]')
    left.element.setPointerCapture = () => {}
    await left.trigger('pointerdown', { pointerId: 1 })
    await left.trigger('pointerup', { pointerId: 1 })
    expect((field.element as HTMLTextAreaElement).value).toBe('')

    await field.setValue('!')
    expect(socket.sent.filter((m) => m.t === 'edit').at(-1)).toEqual({ t: 'edit', delete: 0, insert: '!' })

    // Pasting the phone's clipboard onto the Mac also resets live history.
    await view.find('[aria-label="Paste the phone clipboard on the Mac"]').trigger('click')
    await Promise.resolve()
    expect((field.element as HTMLTextAreaElement).value).toBe('')

    // Clearing or blurring mid-composition must not leave live typing stuck.
    await field.trigger('compositionstart')
    await field.setValue('ni')
    await view.find('[aria-label^="Clear the field"]').trigger('click')
    await field.setValue('ok')
    expect(socket.sent.filter((m) => m.t === 'edit').at(-1)).toEqual({ t: 'edit', delete: 0, insert: 'ok' })

    // An oversized paste (>64 KiB UTF-8) is refused without advancing live state,
    // and in non-live mode keeps the draft in the field instead of losing it.
    const huge = '😀'.repeat(17_000)
    await field.setValue(`ok${huge}`)
    expect(conn.state.notices.some((n) => n.code === 'tooLong')).toBe(true)
    await field.setValue('ok!')
    expect(socket.sent.filter((m) => m.t === 'edit').at(-1)).toEqual({ t: 'edit', delete: 0, insert: '!' })

    settings.liveTyping = false
    await field.setValue(huge)
    await view.find('[aria-label="Type on the Mac"]').trigger('click')
    expect((field.element as HTMLTextAreaElement).value).toBe(huge)

    // Turning Live on when an unsent draft cannot be sent (e.g. >64 KiB) must
    // preserve the draft (and even if toggled again) instead of wiping it.
    await view.findAll('button').find((b) => b.text() === 'Live')!.trigger('click')
    expect((field.element as HTMLTextAreaElement).value).toBe(huge)
    expect(settings.liveTyping).toBe(false)
    await view.findAll('button').find((b) => b.text() === 'Live')!.trigger('click')
    expect((field.element as HTMLTextAreaElement).value).toBe(huge)
    expect(settings.liveTyping).toBe(false)

    // Turning Live off while an un-synced live edit is still in the field (for
    // example, typed while disconnected) also preserves the unsent suffix.
    await field.setValue('')
    settings.liveTyping = true
    await field.setValue('sent')
    socket.drop()
    await field.setValue('sent unsent')
    await view.findAll('button').find((b) => b.text() === 'Live')!.trigger('click')
    expect(settings.liveTyping).toBe(false)
    expect((field.element as HTMLTextAreaElement).value).toBe(' unsent')
  })

  it('pastes a single character from the phone clipboard as text even when a modifier is latched', async () => {
    const socket = connect()
    const { modifiers } = await import('../src/lib/input')
    const { Key } = await import('../src/lib/keys')
    const { Mod } = await import('../src/lib/protocol')
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { readText: () => Promise.resolve('q') },
    })
    const { default: Composer } = await import('../src/components/Composer.vue')
    const view = mount(Composer, { attachTo: document.body })

    // Latch Command (one-shot), then tap Paste with clipboard "q": it must paste
    // "q", never turn it into ⌘Q!
    modifiers.press(1, Mod.Command, Key.Command)
    modifiers.release(1)
    expect(modifiers.status(Mod.Command)).toBe('latched')

    await view.find('[aria-label="Paste the phone clipboard on the Mac"]').trigger('click')
    await Promise.resolve()

    expect(socket.sent.filter((m) => m.t === 'tap')).toEqual([])
    expect(socket.sent.filter((m) => m.t === 'text')).toEqual([{ t: 'text', text: 'q', mode: 'paste' }])
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
