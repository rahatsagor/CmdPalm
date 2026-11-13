import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  port: { onmessage: unknown; postMessage?: (message?: unknown) => void } = { onmessage: null }
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
  it('ignores an old dictation stop after the next microphone is fully running', async () => {
    const socket = connected()
    const previous: string[] = []
    const current: string[] = []
    const first = voiceLib.startVoice((text) => previous.push(text))
    microphone.shift()!(fakeStream())
    await first
    const firstId = socket.sent.find((m) => m.t === 'voiceStart')!.id
    await voiceLib.stopVoice()
    const second = voiceLib.startVoice((text) => current.push(text))
    microphone.shift()!(fakeStream())
    await second
    const secondId = socket.sent.filter((m) => m.t === 'voiceStart').at(-1)!.id
    expect(secondId).not.toBe(firstId)
    socket.receive({ t: 'voice', id: firstId, state: 'stopped', text: 'old phrase', final: false })
    expect(voiceLib.voice.active).toBe(true)
    expect(previous).toEqual(['old phrase'])
    expect(current).toEqual([])
    socket.receive({ t: 'voice', id: secondId, state: 'listening', text: 'new phrase', final: true })
    expect(current).toEqual(['new phrase'])
  })

  it.each(['pause', 'disable'] as const)('releases the microphone on %s and ignores late recognition', async (reason) => {
    const socket = connected()
    const heard: string[] = []
    const stop = vi.fn()
    const start = voiceLib.startVoice((text) => heard.push(text))
    microphone.shift()!({ getTracks: () => [{ stop, addEventListener: vi.fn() }] } as unknown as MediaStream)
    await start
    const id = socket.sent.find((m) => m.t === 'voiceStart')!.id
    if (reason === 'pause') socket.receive({ t: 'paused', paused: true })
    else socket.receive({ t: 'features', features: { ...welcome.features, voice: false } })
    expect(voiceLib.voice.active).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
    expect(socket.sent.at(-1)).toMatchObject({ t: 'voiceStop', cancel: true, id })
    socket.receive({ t: 'voice', id, state: 'listening', text: 'discard me', final: true })
    expect(heard).toEqual([])
  })

  it('cancels microphone permission requests when the Mac pauses', async () => {
    const socket = connected()
    const stop = vi.fn()
    const start = voiceLib.startVoice(() => {})
    socket.receive({ t: 'paused', paused: true })
    microphone.shift()!({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await start
    expect(stop).toHaveBeenCalledOnce()
    expect(voiceLib.voice.active).toBe(false)
    expect(sentTypes(socket)).toEqual([])
  })

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


it('flushes the final partial worklet packet before disconnecting', () => {
  const postMessage = vi.fn()
  class ProcessorBase {
    port = { postMessage, onmessage: null as ((event: { data: { t: string } }) => void) | null }
  }
  type Processor = ProcessorBase & { process(inputs: Float32Array[][]): boolean }
  let make!: () => Processor
  const source = readFileSync(resolve(import.meta.dirname, '../public/voice-worklet.js'), 'utf8')
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    ProcessorBase,
    (_name: string, type: new (options: { processorOptions: { rate: number } }) => Processor) => { make = () => new type({ processorOptions: { rate: 16000 } }) },
    48000,
  )
  const processor = make()
  processor.process([[new Float32Array(128).fill(0.5)]])
  expect(postMessage).not.toHaveBeenCalled()
  processor.port.onmessage!({ data: { t: 'flush' } })
  expect(postMessage.mock.calls[0]![0].pcm).toHaveLength(43)
  expect(postMessage.mock.calls[0]![0].flushed).toBe(true)
})

it('sends worklet tail audio before voiceStop and does not flush cancelled audio', async () => {
  class FlushingNode extends FakeWorkletNode {
    override port = {
      onmessage: null as ((event: { data: { pcm: Int16Array; flushed: boolean } }) => void) | null,
      postMessage: () => queueMicrotask(() => this.port.onmessage?.({ data: { pcm: new Int16Array([9]), flushed: true } })),
    }
  }
  vi.stubGlobal('AudioWorkletNode', FlushingNode)
  const socket = connected()
  const events: string[] = []
  const send = socket.send.bind(socket)
  socket.send = (data: unknown) => {
    if (data instanceof ArrayBuffer) events.push('audio')
    else if (typeof data === 'string' && JSON.parse(data).t === 'voiceStop') events.push('stop')
    send(data)
  }
  let started = voiceLib.startVoice(() => {})
  microphone.shift()!(fakeStream())
  await started
  await voiceLib.stopVoice()
  expect(events).toEqual(['audio', 'stop'])
  events.length = 0
  started = voiceLib.startVoice(() => {})
  microphone.shift()!(fakeStream())
  await started
  await voiceLib.stopVoice(true)
  expect(events).toEqual(['stop'])
})

it('cancels a new dictation waiting for the previous audio flush on a quick pause and resume', async () => {
  class HeldFlushNode extends FakeWorkletNode {
    override port = { onmessage: null, postMessage: vi.fn() }
  }
  vi.stubGlobal('AudioWorkletNode', HeldFlushNode)
  const socket = connected()
  const stop = vi.fn()
  const started = voiceLib.startVoice(() => {})
  microphone.shift()!({ getTracks: () => [{ stop, addEventListener: vi.fn() }] } as unknown as MediaStream)
  await started
  const finishing = voiceLib.stopVoice()
  const pending = voiceLib.startVoice(() => {})
  socket.receive({ t: 'paused', paused: true })
  socket.receive({ t: 'paused', paused: false })
  await finishing
  expect(stop).toHaveBeenCalledOnce()
  expect(microphone).toHaveLength(0)
  await pending
  expect(voiceLib.voice.active).toBe(false)
  expect(sentTypes(socket)).toEqual(['voiceStart', 'voiceStop'])
})
