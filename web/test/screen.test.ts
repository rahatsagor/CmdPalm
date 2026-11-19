import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let connection: typeof import('../src/lib/connection')
let library: typeof import('../src/lib/screen')
let video: HTMLVideoElement

class FakeChannel {
  binaryType = 'blob'
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  close() { this.closed = true }
}

class FakePeer extends EventTarget {
  static all: FakePeer[] = []
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  remoteDescription: unknown = null
  ontrack: ((event: { track: { stop: () => void }; streams: unknown[]; receiver?: { playoutDelayHint?: number; jitterBufferTarget?: number | null } }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  closed = false
  transceiver = { setCodecPreferences: vi.fn() }
  channel = new FakeChannel()
  constructor(readonly configuration: unknown) { super(); FakePeer.all.push(this) }
  addTransceiver = vi.fn(() => this.transceiver)
  createDataChannel = vi.fn(() => this.channel)
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\n' }))
  setLocalDescription = vi.fn(async (description: { type: string; sdp: string }) => { this.localDescription = description })
  setRemoteDescription = vi.fn(async (description: unknown) => { this.remoteDescription = description })
  close() { this.closed = true; this.connectionState = 'closed' }
}

function connect(display: boolean | 'old' = true) {
  connection.connect()
  lastSocket().open()
  lastSocket().receive({ ...welcome, features: { ...welcome.features, display: display === 'old' ? undefined : display, displayRequests: true, displayOriginal: true } })
  return lastSocket()
}

function list(socket: FakeSocket, displays = [{ id: 'main', name: 'Built-in display', width: 2560, height: 1600, main: true }]) {
  const request = socket.sent.filter(message => message.t === 'displays').at(-1)!
  socket.receive({ t: 'displays', id: request.id, displays, message: null })
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('isSecureContext', false)
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
  FakePeer.all = []
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  connection = await import('../src/lib/connection')
  library = await import('../src/lib/screen')
  video = document.createElement('video')
  video.play = vi.fn(async () => {})
  video.pause = vi.fn()
})

afterEach(() => {
  library.deactivateScreen()
  connection.disconnect(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('receive-only display viewing', () => {
  it('negotiates video on HTTP without a camera API or an external ICE server', async () => {
    const socket = connect()
    library.activateScreen(video)
    list(socket)
    await library.startViewing()
    const rtc = FakePeer.all[0]!
    expect(rtc.configuration).toEqual({ iceServers: [], bundlePolicy: 'max-bundle' })
    expect(rtc.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' })
    const start = socket.sent.find(message => message.t === 'displayStart')!
    expect(start).toMatchObject({ displayId: 'main', quality: 'auto' })
    socket.receive({ t: 'displayState', id: start.id, state: 'answer', sdp: 'answer', message: null })
    expect(rtc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' })
    expect(library.screen.status).toBe('connecting')
  })

  it('sets zero playout delay hints on incoming video receivers when supported', async () => {
    const socket = connect()
    library.activateScreen(video)
    list(socket)
    await library.startViewing()
    const rtc = FakePeer.all[0]!
    const receiver = { playoutDelayHint: 0.25, jitterBufferTarget: 150 }
    const stream = Object.assign(new MediaStream(), { getTracks: () => [] })
    rtc.ontrack!({ track: { stop: vi.fn() }, streams: [stream], receiver })
    expect(receiver.playoutDelayHint).toBe(0)
    expect(receiver.jitterBufferTarget).toBe(0)
  })

  it('ignores a late answer, stop, and track from the previous viewer', async () => {
    const socket = connect()
    library.activateScreen(video)
    list(socket)
    await library.startViewing()
    const previous = socket.sent.find(message => message.t === 'displayStart')!
    const oldTrackHandler = FakePeer.all[0]!.ontrack!
    await library.startViewing()
    const rtc = FakePeer.all[1]!
    socket.receive({ t: 'displayState', id: previous.id, state: 'answer', sdp: 'old' })
    socket.receive({ t: 'displayState', id: previous.id, state: 'stopped', message: 'old stop' })
    const stop = vi.fn()
    oldTrackHandler({ track: { stop }, streams: [] })
    expect(stop).toHaveBeenCalledOnce()
    expect(rtc.setRemoteDescription).not.toHaveBeenCalled()
    expect(rtc.closed).toBe(false)
    expect(library.screen.status).toBe('connecting')
    expect(video.srcObject).toBeNull()
  })

  it('releases video and stops renewing its lease when the cached page deactivates', async () => {
    const socket = connect()
    library.activateScreen(video)
    list(socket)
    await library.startViewing()
    vi.advanceTimersByTime(2_100)
    expect(socket.sent.filter(message => message.t === 'displayAlive')).toHaveLength(3)
    library.deactivateScreen()
    expect(FakePeer.all[0]!.closed).toBe(true)
    expect(socket.sent.filter(message => message.t === 'displayStop')).toHaveLength(1)
    vi.advanceTimersByTime(2_100)
    expect(socket.sent.filter(message => message.t === 'displayAlive')).toHaveLength(3)
  })

  it('stops on phone backgrounding and requires another explicit start after returning', async () => {
    const socket = connect()
    library.activateScreen(video)
    list(socket)
    await library.startViewing()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakePeer.all[0]!.closed).toBe(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    list(socket)
    expect(FakePeer.all).toHaveLength(1)
    expect(library.screen.status).toBe('ready')
  })

  it.each(['pause', 'revoke', 'disconnect'] as const)('stops promptly on %s', async reason => {
    const socket = connect()
    library.activateScreen(video)
    list(socket)
    await library.startViewing()
    if (reason === 'pause') socket.receive({ t: 'paused', paused: true })
    else if (reason === 'revoke') socket.receive({ t: 'displayAccess', allowed: false })
    else socket.drop()
    expect(FakePeer.all[0]!.closed).toBe(true)
    expect(video.srcObject).toBeNull()
    vi.advanceTimersByTime(2_000)
    expect(socket.sent.filter(message => message.t === 'displayAlive')).toHaveLength(1)
  })

  it('keeps a missing selected monitor unselected instead of switching to another screen', async () => {
    const socket = connect()
    const { settings } = await import('../src/lib/settings')
    settings.displayId = 'unplugged'
    library.activateScreen(video)
    list(socket)
    expect(library.selectedDisplay()).toBeUndefined()
    expect(settings.displayId).toBe('unplugged')
    await library.startViewing()
    expect(FakePeer.all).toHaveLength(0)
    expect(library.screen.message).toContain('unavailable')
  })

  it('ignores a list that completes after the page is hidden', () => {
    const socket = connect()
    library.activateScreen(video)
    library.deactivateScreen()
    list(socket)
    expect(library.screen.displays).toEqual([])
    expect(library.screen.status).toBe('idle')
  })

  it('explains an older host without trying unsupported screen messages', () => {
    const socket = connect('old')
    library.activateScreen(video)
    expect(library.screen.message).toContain('Update CmdPalm')
    expect(socket.sent.some(message => message.t === 'displays')).toBe(false)
  })

  it('keeps viewing when unrelated Mac capabilities change', async () => {
    const socket = connect()
    library.activateScreen(video); list(socket); await library.startViewing()
    const rtc = FakePeer.all[0]!
    socket.receive({ t: 'features', features: { ...connection.state.features, permission: false, shell: true } })
    expect(rtc.closed).toBe(false)
    expect(socket.sent.filter(message => message.t === 'displays')).toHaveLength(1)
    expect(connection.state.features.permission).toBe(false)
  })

  it('keeps an active view when its existing grant is reported again', async () => {
    const socket = connect()
    library.activateScreen(video); list(socket); await library.startViewing()
    socket.receive({ t: 'displayAccess', allowed: true })
    expect(FakePeer.all[0]!.closed).toBe(false)
    expect(socket.sent.filter(message => message.t === 'displays')).toHaveLength(1)
  })

  it('keeps an active view when the display list is refreshed', async () => {
    const socket = connect()
    library.activateScreen(video); list(socket); await library.startViewing()
    const rtc = FakePeer.all[0]!
    const second = { id: 'side', name: 'Side display', width: 1920, height: 1080, main: false }
    library.refreshDisplays()
    expect(rtc.closed).toBe(false)
    expect(socket.sent.some(message => message.t === 'displayStop')).toBe(false)
    list(socket, [{ id: 'main', name: 'Built-in display', width: 2560, height: 1600, main: true }, second])
    expect(library.screen.displays).toHaveLength(2)
    expect(library.screen.status).toBe('connecting')
    // A failed list must not hide the display being watched.
    library.refreshDisplays()
    list(socket, [])
    expect(library.screen.displays).toHaveLength(2)
    expect(rtc.closed).toBe(false)
  })

  it('can retry a display list whose control message could not be sent', () => {
    const socket = connect()
    socket.readyState = FakeSocket.CLOSING
    library.activateScreen(video)
    expect(library.screen.message).toContain('not connected')
    socket.readyState = FakeSocket.OPEN
    library.refreshDisplays()
    expect(socket.sent.filter(message => message.t === 'displays')).toHaveLength(1)
  })

  it('does not refresh again after approval has already produced a usable list', async () => {
    const socket = connect(false)
    library.activateScreen(video)
    const sourceRequest = socket.sent.find(message => message.t === 'displays')!
    socket.receive({ t: 'displays', id: sourceRequest.id, displays: [], canRequest: true })
    library.requestScreenAccess()
    const request = socket.sent.find(message => message.t === 'displayAccessRequest')!
    socket.receive({ t: 'displayRequest', id: request.id, state: 'allowed' })
    socket.receive({ t: 'features', features: { ...connection.state.features, display: true } })
    list(socket)
    await library.startViewing()
    vi.advanceTimersByTime(400)
    expect(FakePeer.all[0]!.closed).toBe(false)
    expect(socket.sent.filter(message => message.t === 'displays')).toHaveLength(2)
  })

  it('requests native approval once and waits for approval without starting a viewer', async () => {
    const socket = connect(false)
    library.activateScreen(video)
    const sourceRequest = socket.sent.find(message => message.t === 'displays')!
    socket.receive({ t: 'displays', id: sourceRequest.id, displays: [], canRequest: true, message: 'Allow viewing' })
    library.requestScreenAccess(); library.requestScreenAccess()
    const requests = socket.sent.filter(message => message.t === 'displayAccessRequest')
    expect(requests).toHaveLength(1)
    expect(library.screen.accessState).toBe('pending')
    socket.receive({ t: 'displayAccess', allowed: true })
    socket.receive({ t: 'displayRequest', id: requests[0]!.id, state: 'allowed' })
    vi.advanceTimersByTime(400)
    expect(socket.sent.filter(message => message.t === 'displays')).toHaveLength(2)
    expect(FakePeer.all).toHaveLength(0)
  })

  it('cancels a hidden approval request and ignores its late approval', () => {
    const socket = connect(); library.activateScreen(video)
    library.requestScreenAccess()
    const request = socket.sent.find(message => message.t === 'displayAccessRequest')!
    library.deactivateScreen()
    expect(socket.sent).toContainEqual({ t: 'displayAccessCancel', id: request.id })
    socket.receive({ t: 'displayRequest', id: request.id, state: 'allowed' })
    vi.advanceTimersByTime(1000)
    expect(FakePeer.all).toHaveLength(0)
    expect(library.screen.active).toBe(false)
  })

  it('receives lossless pictures over a data-only peer on HTTP and revokes them on stop', async () => {
    const socket = connect(); const image = document.createElement('img')
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hd-frame')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { settings } = await import('../src/lib/settings'); settings.displayQuality = 'original'
    library.activateScreen(video, image); list(socket); await library.startViewing()
    const rtc = FakePeer.all[0]!
    expect(rtc.createDataChannel).toHaveBeenCalledWith('cmdpalm.original', { ordered: true })
    expect(rtc.addTransceiver).not.toHaveBeenCalled()
    expect(rtc.channel.binaryType).toBe('arraybuffer')
    const bytes = new Uint8Array(49); bytes.set([67,80,78,71]); const view = new DataView(bytes.buffer)
    view.setUint32(4, 1, true); view.setUint32(8, 33, true)
    view.setUint32(16, 0x89504e47); view.setUint32(20, 0x0d0a1a0a)
    view.setUint32(24, 13); view.setUint32(28, 0x49484452); view.setUint32(32, 1920); view.setUint32(36, 1080)
    const handler = rtc.channel.onmessage!
    handler({ data: bytes.buffer })
    expect(create).toHaveBeenCalledOnce()
    image.dispatchEvent(new Event('load'))
    expect(library.screen.status).toBe('live')
    expect(library.screen.original).toBe(true)
    library.stopViewing()
    expect(revoke).toHaveBeenCalledWith('blob:hd-frame')
    expect(image.getAttribute('src')).toBeNull()
    expect(rtc.channel.closed).toBe(true)
    handler({ data: bytes.buffer })
    expect(create).toHaveBeenCalledOnce()
    create.mockRestore(); revoke.mockRestore()
  })

  it('rejects HD text on hosts without its capability', async () => {
    const socket = connect(); connection.state.features.displayOriginal = undefined
    const { settings } = await import('../src/lib/settings'); settings.displayQuality = 'original'
    library.activateScreen(video, document.createElement('img')); list(socket); await library.startViewing()
    expect(library.screen.message).toContain('Update CmdPalm')
    expect(FakePeer.all).toHaveLength(0)
  })
})
