import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'

let conn: typeof import('../src/lib/connection')
let voiceLib: typeof import('../src/lib/voice')
let microphone: ((stream: MediaStream) => void)[] = []

class FakeAudioContext {
  destination = {}
  audioWorklet = { addModule: () => Promise.resolve() }
  resume = () => Promise.resolve()
  close = () => Promise.resolve()
  createMediaStreamSource = () => ({ connect: () => {} })
  createGain = () => ({ gain: { value: 1 }, connect: (next: unknown) => next })
}
class FakeWorkletNode {
  port = { onmessage: null }
  connect = (next: unknown) => next
  disconnect = () => {}
}

function connected() {
  conn.connect()
  lastSocket().open()
  lastSocket().receive({ ...welcome, features: { ...welcome.features, voice: true } })
  return lastSocket()
}

const fakeStream = () => ({ getTracks: () => [] }) as unknown as MediaStream
const sentTypes = (socket: FakeSocket) => socket.sent.map((m) => m.t).filter((t) => String(t).startsWith('voice'))
const settle = () => vi.waitFor(() => Promise.resolve())

beforeEach(async () => {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('isSecureContext', true)
  microphone = []
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => new Promise<MediaStream>((resolve) => microphone.push(resolve)) },
  })
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  conn = await import('../src/lib/connection')
  voiceLib = await import('../src/lib/voice')
})

afterEach(() => {
  conn.disconnect(false)
  vi.unstubAllGlobals()
})

describe('voice typing', () => {
  it("keeps a new dictation when the Mac's stop for the previous one arrives late", async () => {
    const socket = connected()
    const heard: string[] = []
    const first = voiceLib.startVoice((t) => heard.push(t))
    microphone.shift()!(fakeStream())
    await first
    expect(voiceLib.voice.active).toBe(true)
    await voiceLib.stopVoice()

    const second = voiceLib.startVoice((t) => heard.push(t))
    socket.receive({ t: 'voice', state: 'stopped', text: 'last phrase', final: false })
    expect(heard).toEqual(['last phrase'])
    microphone.shift()!(fakeStream())
    await second
    await settle()
    expect(voiceLib.voice.active).toBe(true)
    expect(sentTypes(socket)).toEqual(['voiceStart', 'voiceStop', 'voiceStart'])

    socket.receive({ t: 'voice', state: 'stopped', final: false })
    expect(voiceLib.voice.active).toBe(false)
  })

  it('stops when the Mac reports an error for the current dictation', async () => {
    const socket = connected()
    const start = voiceLib.startVoice(() => {})
    microphone.shift()!(fakeStream())
    await start
    socket.receive({ t: 'voice', state: 'unavailable', message: 'The Mac is still busy.', final: false })
    expect(voiceLib.voice.active).toBe(false)
    expect(voiceLib.voice.error).toBe('The Mac is still busy.')
  })
})
