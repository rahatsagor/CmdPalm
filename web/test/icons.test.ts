import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let conn: typeof import('../src/lib/connection')
let icons: typeof import('../src/lib/icons')
let fetchMock: ReturnType<typeof vi.fn>
let revoke: ReturnType<typeof vi.fn>
let created = 0

beforeEach(async () => {
  created = 0
  fetchMock = vi.fn(async () => new Response(new Blob(['png'])))
  revoke = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  URL.createObjectURL = () => `blob:icon-${++created}`
  URL.revokeObjectURL = revoke as typeof URL.revokeObjectURL
  vi.resetModules()
  conn = await import('../src/lib/connection')
  icons = await import('../src/lib/icons')
  conn.state.sessionKey = 'first'
})

describe('app icon cache', () => {
  it('does not fetch again after a reconnect with a new session key', async () => {
    const url = await icons.loadAppIcon('com.example.a', 48)
    conn.state.sessionKey = 'second'
    expect(icons.appIcon('com.example.a', 48)).toBe(url)
    expect(await icons.loadAppIcon('com.example.a', 48)).toBe(url)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('k=first')
  })

  it('does not reuse a request still pending under an old session key', async () => {
    let refuse!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (refuse = resolve)))
    const stale = icons.loadAppIcon('x', 48)
    conn.state.sessionKey = 'second'
    const fresh = icons.loadAppIcon('x', 48)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]![0])).toContain('k=second')
    refuse(new Response('no', { status: 403 }))
    await expect(stale).rejects.toThrow()
    const url = await fresh
    expect(icons.appIcon('x', 48)).toBe(url)
  })

  it('shares one request between callers', async () => {
    const [a, b] = await Promise.all([icons.loadAppIcon('x', 48), icons.loadAppIcon('x', 48)])
    expect(a).toBe(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('revokes and refetches after clearing', async () => {
    const url = await icons.loadAppIcon('x', 48)
    icons.clearAppIcons()
    expect(revoke).toHaveBeenCalledWith(url)
    expect(icons.appIcon('x', 48)).toBeUndefined()
    await icons.loadAppIcon('x', 48)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('evicts and revokes the oldest icon past 256 entries', async () => {
    const first = await icons.loadAppIcon('app-0', 48)
    for (let i = 1; i <= 256; i++) await icons.loadAppIcon(`app-${i}`, 48)
    expect(revoke).toHaveBeenCalledWith(first)
    expect(icons.appIcon('app-0', 48)).toBeUndefined()
    expect(icons.appIcon('app-256', 48)).toBeDefined()
  })

  it('keeps recently read icons when evicting', async () => {
    await icons.loadAppIcon('app-0', 48)
    for (let i = 1; i < 256; i++) await icons.loadAppIcon(`app-${i}`, 48)
    icons.appIcon('app-0', 48)
    await icons.loadAppIcon('app-256', 48)
    expect(icons.appIcon('app-0', 48)).toBeDefined()
    expect(icons.appIcon('app-1', 48)).toBeUndefined()
  })

  it('does not cache a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 404 }))
    await expect(icons.loadAppIcon('x', 48)).rejects.toThrow()
    await expect(icons.loadAppIcon('x', 48)).resolves.toBe('blob:icon-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('discards a fetch that finishes after the cache was cleared', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (finish = resolve)))
    const loading = icons.loadAppIcon('x', 48)
    icons.clearAppIcons()
    finish(new Response(new Blob(['png'])))
    const url = await loading
    expect(revoke).toHaveBeenCalledWith(url)
    expect(icons.appIcon('x', 48)).toBeUndefined()
  })
})

describe('AppIcon', () => {
  it('renders the cached blob URL', async () => {
    const { default: AppIcon } = await import('../src/components/AppIcon.vue')
    const wrapper = mount(AppIcon, { props: { id: 'x', size: 48 } })
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).toBe('blob:icon-1')
    const again = mount(AppIcon, { props: { id: 'x', size: 48 } })
    expect(again.find('img').attributes('src')).toBe('blob:icon-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ends with the icon when the key changes while it loads', async () => {
    let refuse!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (refuse = resolve)))
    const { default: AppIcon } = await import('../src/components/AppIcon.vue')
    const wrapper = mount(AppIcon, { props: { id: 'x', size: 48 } })
    conn.state.sessionKey = 'second'
    await flushPromises()
    refuse(new Response('no', { status: 403 }))
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).toMatch(/^blob:/)
  })

  it('shows the fallback when the icon cannot be loaded', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 500 }))
    const { default: AppIcon } = await import('../src/components/AppIcon.vue')
    const wrapper = mount(AppIcon, { props: { id: 'x', size: 48 } })
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(true)
  })
})
