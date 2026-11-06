import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

enableAutoUnmount(afterEach)
let conn: typeof import('../src/lib/connection')
let sync: typeof import('../src/lib/settingsSync')
let prefs: typeof import('../src/lib/settings')
let boards: typeof import('../src/lib/customKeyboards')

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  conn = await import('../src/lib/connection')
  prefs = await import('../src/lib/settings')
  boards = await import('../src/lib/customKeyboards')
  sync = await import('../src/lib/settingsSync')
  sync.installSettingsSync()
})

afterEach(() => {
  conn.disconnect(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function button(text: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((item) => item.textContent?.includes(text))
  if (!found) throw new Error(`Missing ${text} button`)
  return found
}

async function picker() {
  conn.connect()
  const socket = lastSocket()
  socket.open()
  socket.receive(welcome)
  const { default: CopySettingsSheet } = await import('../src/components/CopySettingsSheet.vue')
  const view = mount(CopySettingsSheet, { attachTo: document.body })
  socket.receive({ t: 'settingsList', devices: [{ id: 'source', name: 'Studio iPad', model: 'iPad', updatedAt: 100 }] })
  await nextTick()
  button('Studio iPad').click()
  const id = socket.sent.at(-1)!.id
  socket.receive({ t: 'settings', id, settings: { version: 1, settings: { theme: 'light', pointerSpeed: 2, deckButtonSize: 1.4 }, keyboards: [{ ...boards.blankBoard(), id: 'remote', name: 'Video editing' }] }, updatedAt: 100 })
  await nextTick()
  await nextTick()
  return { view, socket }
}

describe('selective device copy sheet', () => {
  it('requires a selection and copies just the checked keyboard', async () => {
    const { view, socket } = await picker()
    const original = boards.keyboards.boards.map((board) => board.id)
    const active = boards.keyboards.active
    expect(button('Copy selected').disabled).toBe(true)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Deck pages and buttons are already shared')
    document.querySelector<HTMLInputElement>('input[aria-label="Copy Video editing"]')!.click()
    await nextTick()
    expect(button('Copy selected').disabled).toBe(false)
    button('Copy selected').click()
    expect(view.emitted('close')).toHaveLength(1)
    expect(boards.keyboards.boards.map((board) => board.id)).toEqual([...original, 'remote'])
    expect(boards.keyboards.active).toBe(active)
    expect(prefs.settings.theme).toBe('system')
    expect(prefs.settings.pointerSpeed).toBe(1.2)
    expect(prefs.settings.deckButtonSize).toBe(1)
    expect(socket.sent.filter((message) => message.t === 'settingsSave')).toHaveLength(1)
  })

  it('selects available sections together and lets the user deselect them', async () => {
    await picker()
    button('Select all').click()
    await nextTick()
    const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(checkboxes).toHaveLength(4)
    expect(checkboxes.every((input) => input.checked)).toBe(true)
    button('Deselect all').click()
    await nextTick()
    expect(checkboxes.every((input) => !input.checked)).toBe(true)
    expect(button('Copy selected').disabled).toBe(true)
  })

  it('goes back without applying the preview', async () => {
    const { socket } = await picker()
    const before = JSON.stringify(sync.buildPayload())
    document.querySelector<HTMLInputElement>('input[aria-label="Trackpad"]')!.click()
    button('Devices').click()
    await nextTick()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Choose a paired device')
    expect(JSON.stringify(sync.buildPayload())).toBe(before)
    expect(socket.sent.filter((message) => message.t === 'settingsSave')).toHaveLength(0)
  })
})
