import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { KeepAlive, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let connection: typeof import('../src/lib/connection')
let viewing: typeof import('../src/lib/screen')
let wrapper: VueWrapper | undefined
let overlay: VueWrapper | undefined

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  connection = await import('../src/lib/connection')
  viewing = await import('../src/lib/screen')
  connection.connect()
  lastSocket().open()
  lastSocket().receive({ ...welcome, features: { ...welcome.features, display: true, displayOriginal: true } })
  document.body.innerHTML = '<main><button id="outside">Other control</button><div id="mount"></div></main><aside inert="">Already inert</aside>'
})

afterEach(() => {
  overlay?.unmount(); overlay = undefined
  wrapper?.unmount(); wrapper = undefined
  connection.disconnect(false)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Negotiation without native video or screen capture. */
class PreviewPeer {
  static all: PreviewPeer[] = []
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  closed = false
  constructor() { PreviewPeer.all.push(this) }
  addTransceiver() { return { setCodecPreferences() {} } }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\n' } }
  async setLocalDescription(description: { sdp: string }) { this.localDescription = description }
  close() { this.closed = true }
}

async function mountViewer(cached = false) {
  const { default: DisplayView } = await import('../src/views/DisplayView.vue')
  const { settings } = await import('../src/lib/settings')
  settings.displayId = 'primary'
  const visible = ref(true)
  const Host = { setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(DisplayView) : h('div', 'Another page') }) }
  wrapper = mount(cached ? Host : DisplayView, { attachTo: document.querySelector('#mount')! })
  viewing.screen.displays = [{ id: 'primary', name: 'Test display', width: 1920, height: 1080, main: true }]
  viewing.screen.status = 'live'
  await nextTick()
  return { view: wrapper.findComponent(DisplayView), visible }
}

function button(view: VueWrapper, label: string) {
  return view.findAll('button').find(item => item.text() === label)!
}

describe('display preferences while viewing', () => {
  it('restarts quality from either settings surface and keeps layout changes on the same stream', async () => {
    PreviewPeer.all = []
    vi.stubGlobal('RTCPeerConnection', PreviewPeer)
    const { view } = await mountViewer()
    await viewing.startViewing()
    viewing.screen.status = 'live'
    const { settings } = await import('../src/lib/settings')
    const { default: SettingsSheet } = await import('../src/components/SettingsSheet.vue')
    overlay = mount(SettingsSheet, { attachTo: document.body })
    document.querySelector<HTMLButtonElement>('#settings-tab-display')!.click()
    await nextTick()
    await nextTick()
    const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]')!
    const sharp = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim().startsWith('Sharper text'))!
    sharp.click()
    await flushPromises()
    expect(PreviewPeer.all).toHaveLength(2)
    expect(PreviewPeer.all[0]!.closed).toBe(true)
    expect(lastSocket().sent.filter(message => message.t === 'displayStart').map(message => message.quality)).toEqual(['auto', 'sharp'])
    sharp.click()
    await flushPromises()
    expect(PreviewPeer.all).toHaveLength(2)

    viewing.screen.status = 'live'
    const layout = dialog.querySelector('[role="radiogroup"][aria-label="Controls with the display"]')!
    Array.from(layout.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === 'Keyboard')!.click()
    await nextTick()
    const split = dialog.querySelector<HTMLInputElement>('input[aria-label="Preview space"]')!
    split.value = '0.6'
    split.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(settings.displayControls).toBe('keyboard')
    expect(settings.displaySplit).toBe(0.6)
    expect(PreviewPeer.all).toHaveLength(2)
    expect(viewing.screen.status).toBe('live')
    overlay.unmount(); overlay = undefined

    await view.get('[aria-label="Display options"]').trigger('click')
    const options = document.querySelector('[role="dialog"][aria-label="Display options"]')!
    Array.from(options.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim().startsWith('Save battery'))!.click()
    await flushPromises()
    expect(PreviewPeer.all).toHaveLength(3)
    expect(PreviewPeer.all[1]!.closed).toBe(true)
    expect(lastSocket().sent.filter(message => message.t === 'displayStart').map(message => message.quality)).toEqual(['auto', 'sharp', 'battery'])
    expect(document.querySelector('[role="dialog"][aria-label="Display options"]')).toBeNull()
  })
})

describe('fullscreen display accessibility', () => {
  it('isolates the viewport fallback and restores focus and existing inert state on exit', async () => {
    const { view } = await mountViewer()
    const opener = view.get('button[aria-label="Fullscreen display"]')
    ;(opener.element as HTMLElement).focus()
    await opener.trigger('keydown', { key: 'Enter', code: 'Enter' })
    const region = view.get('[aria-label="Fullscreen Mac display"]')
    expect(document.activeElement).toBe(region.element)
    expect(document.querySelector('#outside')!.hasAttribute('inert')).toBe(true)
    expect(button(view, 'Exit').element.closest('[inert]')).toBeNull()
    await button(view, 'Exit').trigger('click')
    expect(document.querySelector('#outside')!.hasAttribute('inert')).toBe(false)
    expect(document.querySelector('aside')!.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(opener.element)
  })

  it('keeps focused viewer button keys local while other hardware input can reach the Mac', async () => {
    const { view } = await mountViewer()
    await view.get('button[aria-label="Fullscreen display"]').trigger('click')
    const received = vi.fn()
    window.addEventListener('keydown', received)
    try {
      const region = view.get('[aria-label="Fullscreen Mac display"]')
      const fsStop = region.findAll('button').find(item => item.text() === 'Stop')!
      const fsExit = region.findAll('button').find(item => item.text() === 'Exit')!
      ;(fsStop.element as HTMLElement).focus()
      await fsStop.trigger('keydown', { key: 'Tab', code: 'Tab' })
      ;(fsExit.element as HTMLElement).focus()
      await fsExit.trigger('keydown', { key: 'Tab', code: 'Tab', shiftKey: true })
      expect(received).not.toHaveBeenCalled()
      await fsExit.trigger('keydown', { key: 'Enter', code: 'Enter' })
      expect(received).not.toHaveBeenCalled()
      await view.get('[aria-label="Fullscreen Mac display"]').trigger('keydown', { key: 'a', code: 'KeyA' })
      expect(received).toHaveBeenCalledOnce()
      await view.get('[aria-label="Fullscreen Mac display"]').trigger('keydown', { key: 'Escape', code: 'Escape' })
      expect(document.querySelector('#outside')!.hasAttribute('inert')).toBe(false)
    } finally { window.removeEventListener('keydown', received) }
  })

  it('isolates replacement navigation created by responsive layout changes', async () => {
    const { view } = await mountViewer()
    await view.get('button[aria-label="Fullscreen display"]').trigger('click')
    const navigation = document.createElement('nav')
    navigation.innerHTML = '<button>Replacement tab bar</button>'
    document.body.append(navigation)
    await vi.advanceTimersByTimeAsync(0)
    expect(navigation.hasAttribute('inert')).toBe(true)
    // A detached cached control must not retain an attribute we added.
    navigation.remove()
    await vi.advanceTimersByTimeAsync(0)
    expect(navigation.hasAttribute('inert')).toBe(false)
    document.body.append(navigation)
    await vi.advanceTimersByTimeAsync(0)
    expect(navigation.hasAttribute('inert')).toBe(true)
    await button(view, 'Exit').trigger('click')
    expect(navigation.hasAttribute('inert')).toBe(false)
  })

  it('restores the rest of the app when its cached Display page deactivates', async () => {
    const { view, visible } = await mountViewer(true)
    await view.get('button[aria-label="Fullscreen display"]').trigger('click')
    expect(document.querySelector('#outside')!.hasAttribute('inert')).toBe(true)
    visible.value = false
    await nextTick()
    expect(viewing.screen.active).toBe(false)
    expect(document.querySelector('#outside')!.hasAttribute('inert')).toBe(false)
    visible.value = true
    await nextTick()
    expect(wrapper!.find('[aria-label="Fullscreen Mac display"]').exists()).toBe(false)
  })

  it('extends only a right-side scroll strip to the outer screen edge in wide display mode', async () => {
    let resize: ResizeObserverCallback | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) { resize = cb }
      observe() {}
      disconnect() {}
    })
    const { view } = await mountViewer()
    const { settings } = await import('../src/lib/settings')
    settings.displayControls = 'trackpad'
    settings.scrollStrip = 'short'
    settings.scrollStripEdge = true
    resize?.([{ contentRect: { width: 800, height: 400 } } as ResizeObserverEntry], {} as ResizeObserver)

    settings.scrollStripSide = 'right'
    await nextTick()
    const trackpad = view.get('.trackpad')
    expect((trackpad.element as HTMLElement).style.marginRight).toBe('-0.5rem')

    settings.scrollStripSide = 'left'
    await nextTick()
    expect((trackpad.element as HTMLElement).style.marginLeft).toBe('')
    expect((trackpad.element as HTMLElement).style.marginRight).toBe('')
  })
})
