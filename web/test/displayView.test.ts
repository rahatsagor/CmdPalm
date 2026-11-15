import { mount, type VueWrapper } from '@vue/test-utils'
import { KeepAlive, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let connection: typeof import('../src/lib/connection')
let viewing: typeof import('../src/lib/screen')
let wrapper: VueWrapper | undefined

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
  wrapper?.unmount(); wrapper = undefined
  connection.disconnect(false)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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
      await button(view, 'Exit').trigger('keydown', { key: 'Enter', code: 'Enter' })
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
})
