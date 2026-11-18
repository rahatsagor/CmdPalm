import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

enableAutoUnmount(afterEach)
let connection: typeof import('../src/lib/connection')
let prefs: typeof import('../src/lib/settings')

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  connection = await import('../src/lib/connection')
  prefs = await import('../src/lib/settings')
  connection.connect()
  lastSocket().open()
  lastSocket().receive(welcome)
})
afterEach(() => {
  connection.disconnect(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function button(name: string, scope: ParentNode = document) {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.trim().startsWith(name))
  if (!found) throw new Error(`Missing button: ${name}`)
  return found
}
async function click(name: string) {
  button(name).click()
  await nextTick()
  await nextTick()
}
async function settings() {
  const { default: SettingsSheet } = await import('../src/components/SettingsSheet.vue')
  return mount(SettingsSheet, { attachTo: document.body })
}

describe('settings feature tabs', () => {
  it('keeps Mac details above the feature tabs, device actions below, and edits saved between tabs', async () => {
    connection.state.latency = 8
    await settings()
    expect(document.querySelectorAll('[aria-label="Feature settings"] button')).toHaveLength(5)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('CmdPalm 1.0 · Connected · 8 ms')
    expect(dialog.textContent).toContain('Not encrypted')
    expect(dialog.textContent).toContain('Others on this Wi-Fi')
    expect(dialog.querySelector('[role="tabpanel"]')!.getAttribute('aria-labelledby')).toBe('settings-tab-trackpad')
    const scroller = dialog.lastElementChild!
    scroller.scrollTop = 400
    const speed = dialog.querySelector<HTMLInputElement>('input[aria-label="Pointer speed"]')!
    speed.value = '2'
    speed.dispatchEvent(new Event('input', { bubbles: true }))
    const keyboard = button('Keyboard')
    keyboard.focus()
    await click('Keyboard')
    expect(scroller.scrollTop).toBe(0)
    expect(document.activeElement).toBe(keyboard)
    expect(dialog.getAttribute('aria-label')).toBe('Settings')
    expect(dialog.querySelector('[role="tabpanel"]')!.getAttribute('aria-labelledby')).toBe('settings-tab-keyboard')
    expect(prefs.settings.pointerSpeed).toBe(2)
    expect(
      button('Back up or restore this device').compareDocumentPosition(dialog.querySelector('[role="tabpanel"]')!) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy()
    await click('Trackpad')
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Pointer speed"]')!.value).toBe('2')
    expect(dialog.querySelector('input[aria-label="Acceleration"]')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.parse(localStorage.getItem('cmdpalm.settings')!).pointerSpeed).toBe(2)
  })

  it('shows settings sections without disclosures and keeps dictation setup in Keyboard', async () => {
    await settings()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const hostCard = dialog.querySelector('.card')!
    expect(hostCard.textContent).toContain('Connected')
    expect(hostCard.querySelector('button, input, details, summary')).toBeNull()
    expect(hostCard.textContent).not.toContain('Dictation setup')
    for (const feature of ['Trackpad', 'Gestures', 'Keyboard', 'Display', 'Deck']) {
      await click(feature)
      expect(dialog.querySelector('details, summary')).toBeNull()
      const panel = dialog.querySelector('[role="tabpanel"]')!
      expect(panel.textContent?.includes('Dictation setup')).toBe(feature === 'Keyboard')
      if (feature === 'Trackpad') expect(panel.querySelector('input[aria-label="Acceleration"]')).not.toBeNull()
      if (feature === 'Gestures') expect(panel.querySelector('[role="radiogroup"][aria-label="Pinching"]')).not.toBeNull()
      if (feature === 'Keyboard') expect(panel.querySelector('[role="radiogroup"][aria-label="Send text as"]')).not.toBeNull()
    }
  })

  it('opens the current feature and switches tabs with a hardware keyboard', async () => {
    prefs.settings.tab = 'keyboard'
    await settings()
    const keyboard = document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!
    expect(keyboard.textContent).toContain('Keyboard')
    keyboard.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    await nextTick()
    expect(document.activeElement?.textContent).toContain('Deck')
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Deck')
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await nextTick()
    expect(document.activeElement?.textContent).toContain('Trackpad')
    expect(document.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
  })

  it('edits just the selected finger map and keeps canceled gesture drafts out of settings', async () => {
    await settings()
    await click('Gestures')
    expect(prefs.settings.showAdvanced).toBe(false)
    await click('Four fingers')
    await click('Tap')
    const editor = document.querySelector<HTMLElement>('[aria-label="Four-finger tap"]')!
    editor.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    await nextTick()
    expect(prefs.settings.fourFinger.tap).toBeNull()
    editor.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()
    await nextTick()
    expect(prefs.settings.fourFinger.tap).toBeNull()
    await click('Tap')
    document.querySelector<HTMLButtonElement>('[aria-label="Four-finger tap"] [role="switch"]')!.click()
    await nextTick()
    await click('Save')
    expect(prefs.settings.fourFinger.tap).toEqual({ kind: 'system', name: 'missionControl' })
    expect(prefs.settings.threeFinger.tap).toEqual({ kind: 'mouse', button: 'middle' })
  })

  it('requires reset confirmation, supports cancel, and preserves the named setup and pairing', async () => {
    const boards = await import('../src/lib/customKeyboards')
    const originalBoards = JSON.stringify(boards.keyboards)
    prefs.settings.pointerSpeed = 3
    prefs.settings.deviceName = 'My phone'
    const deck = JSON.stringify(connection.state.deck)
    await settings()
    await click('Reset settings on this device')
    expect(prefs.settings.pointerSpeed).toBe(3)
    await click('Cancel')
    expect(document.body.textContent).not.toContain('Reset settings to defaults?')
    await click('Reset settings on this device')
    await click('Reset to defaults')
    expect(prefs.settings.pointerSpeed).toBe(prefs.defaultSettings().pointerSpeed)
    expect(prefs.settings.deviceName).toBe('My phone')
    expect(localStorage.getItem('cmdpalm.token')).toBe('saved')
    expect(JSON.stringify(boards.keyboards)).toBe(originalBoards)
    expect(JSON.stringify(connection.state.deck)).toBe(deck)
    expect(connection.state.notices.at(-1)?.message).toBe('Settings reset to defaults.')
  })

  it('cancels forget and clears its confirmation when switching tabs, then forgets only on confirmation', async () => {
    const view = await settings()
    await click('Forget this Mac')
    expect(localStorage.getItem('cmdpalm.token')).toBe('saved')
    await click('Cancel')
    await click('Forget this Mac')
    await click('Keyboard')
    expect(document.body.textContent).not.toContain('Forget and disconnect')
    await click('Forget this Mac')
    await click('Forget and disconnect')
    expect(localStorage.getItem('cmdpalm.token')).toBeNull()
    expect(view.emitted('close')).toHaveLength(1)
  })

  it('opens backup and copy from the bottom actions without losing the current feature', async () => {
    await settings()
    await click('Keyboard')
    await click('Back up or restore this device')
    await import('../src/components/BackupSheet.vue')
    await flushPromises()
    expect(document.querySelector('[aria-label="Device backup"]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[aria-label="Device backup"] [aria-label="Close"]')!.click()
    await nextTick()
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Keyboard')
    await click('Copy settings from another device')
    await import('../src/components/CopySettingsSheet.vue')
    await flushPromises()
    expect(document.querySelector('[aria-label="Copy from device"]')).not.toBeNull()
    expect(lastSocket().sent.at(-1)).toMatchObject({ t: 'settingsList' })
  })

  it('keeps quality choices in sync and resumes an active view only for a changed quality', async () => {
    const viewing = await import('../src/lib/screen')
    const start = vi.spyOn(viewing, 'startViewing').mockResolvedValue()
    await settings()
    await click('Display')
    expect(button('HD text').disabled).toBe(true)
    viewing.screen.active = true
    viewing.screen.status = 'live'
    await click('Sharper text')
    expect(prefs.settings.displayQuality).toBe('sharp')
    expect(start).toHaveBeenCalledOnce()
    await click('Sharper text')
    expect(start).toHaveBeenCalledOnce()
    viewing.screen.active = false
    await click('Save battery')
    expect(prefs.settings.displayQuality).toBe('battery')
    expect(start).toHaveBeenCalledOnce()
    start.mockRestore()
  })

  it('shows encryption status and tailored dictation setup guidance for each connection and feature state', async () => {
    const sheet = await settings()
    const hostCard = () => document.querySelector<HTMLElement>('[role="dialog"] .card')!
    expect(hostCard().textContent).toContain('Not encrypted')
    expect(hostCard().textContent).toContain('Others on this Wi-Fi')

    await click('Keyboard')
    const panelText = () => document.querySelector<HTMLElement>('[role="tabpanel"]')!.textContent!
    expect(panelText()).toContain('encrypted connection')
    expect(panelText()).toContain('Allow dictation from devices')

    connection.state.features.voice = true
    await nextTick()
    expect(panelText()).toContain('Phone Setup → Encrypted Connection')
    expect(panelText()).not.toContain('Allow dictation from devices')

    connection.state.features.secure = true
    connection.state.features.voice = false
    await nextTick()
    expect(hostCard().textContent).toContain('Encrypted')
    expect(hostCard().textContent).not.toContain('Not encrypted')
    expect(hostCard().textContent).not.toContain('Others on this Wi-Fi')
    expect(panelText()).toContain('Dictation is turned off on this Mac')

    connection.state.features.voice = true
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn() } })
    vi.stubGlobal('AudioWorkletNode', class {})
    sheet.unmount()
    await settings()
    await click('Keyboard')
    expect(panelText()).toContain('Dictation is ready')
  })
})
