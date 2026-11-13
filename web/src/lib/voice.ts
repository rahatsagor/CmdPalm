// Streams microphone audio to the Mac for speech recognition. Browsers only
// expose the microphone on secure (HTTPS) pages.

import { reactive, watch } from 'vue'
import { encodeAudio } from './protocol'
import { onMessage, send, sendBinary, state as conn } from './connection'

const RATE = 16000

export const voice = reactive({
  active: false,
  partial: '',
  error: '',
  level: 0,
})

let context: AudioContext | null = null
let stream: MediaStream | null = null
let node: AudioWorkletNode | null = null
const dictations = new Map<number, (text: string) => void>()
let nextId = 0
let activeId: number | null = null
let lastStoppedId: number | null = null
let starting = false
/** Bumped by every stop, so a start still awaiting the microphone knows it was cancelled. */
let generation = 0
let finishing: Promise<void> | null = null
let cancelFinishing: (() => void) | undefined
/** Whether the Mac is dictating for this page. Its last update for a dictation
 * already stopped here can arrive after the next start, and must not end it. */

export function voiceSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined'
}

onMessage((message) => {
  if (message.t !== 'voice') return
  // Untagged replies keep older Macs usable. Updated Macs echo the id of
  // the dictation that produced the reply, even after the next one starts.
  const id = message.id ?? activeId ?? lastStoppedId
  if (id === null || !dictations.has(id)) return
  const current = id === activeId
  if (message.state === 'listening') {
    if (current && message.text !== undefined) voice.partial = message.text
    if (message.final && message.text) {
      dictations.get(id)?.(message.text)
      if (current) voice.partial = ''
    }
  } else if (message.state === 'stopped') {
    if (message.text) dictations.get(id)?.(message.text)
    dictations.delete(id)
    if (current) {
      voice.partial = ''
      void stopVoice(false, false)
    }
  } else if (current) {
    voice.error = message.message ?? 'Speech recognition stopped.'
    void stopVoice(true, false)
  } else {
    dictations.delete(id)
  }
})

watch(
  () => [conn.status, conn.paused, conn.features.voice] as const,
  ([status, paused, allowed]) => {
    if (status !== 'connected' || paused || !allowed) void stopVoice(true, status === 'connected')
  },
  { flush: 'sync' },
)

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void stopVoice()
  })
}

/** Start listening. `onFinal` receives each finished phrase. */
export async function startVoice(onFinal: (text: string) => void, locale = navigator.language) {
  if (finishing) {
    const waitingGeneration = generation
    await finishing
    if (waitingGeneration !== generation) return
  }
  if (voice.active || starting) return
  voice.error = ''
  voice.partial = ''
  // Reconnecting keeps the last features; a start now would never reach the Mac.
  if (conn.status !== 'connected') {
    voice.error = 'Not connected to the Mac.'
    return
  }
  if (!conn.features.voice) {
    voice.error = 'Speech recognition is turned off on the Mac.'
    return
  }
  if (conn.paused) {
    voice.error = 'Control is paused on the Mac.'
    return
  }
  if (!voiceSupported()) {
    voice.error = 'The microphone needs a secure connection. Open CmdPalm over HTTPS.'
    return
  }
  starting = true
  const run = ++generation
  // Held locally until the start completes; a stop meanwhile cannot see them.
  let media: MediaStream | null = null
  let audio: AudioContext | null = null
  const discard = () => {
    media?.getTracks().forEach((t) => t.stop())
    void audio?.close().catch(() => {})
  }
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (run !== generation) return discard()
    audio = new AudioContext()
    // Created after an await, so outside the tap that started dictation: iOS
    // leaves such a context suspended until asked.
    await audio.resume()
    // A static file rather than a blob: URL so the page's CSP can stay strict.
    await audio.audioWorklet.addModule('/voice-worklet.js')
    if (run !== generation) return discard()
    const source = audio.createMediaStreamSource(media)
    const worklet = new AudioWorkletNode(audio, 'cmdpalm-downsampler', { processorOptions: { rate: RATE } })
    worklet.port.onmessage = (event: MessageEvent<{ pcm: Int16Array; peak: number }>) => {
      if (run === generation && voice.active && !conn.paused && conn.features.voice) {
        voice.level = voice.level * 0.6 + event.data.peak * 0.4
        sendBinary(encodeAudio(event.data.pcm))
      }
    }
    source.connect(worklet)
    // Safari only runs nodes that lead to the output; a silent gain keeps the
    // microphone from playing through the speaker.
    const mute = audio.createGain()
    mute.gain.value = 0
    worklet.connect(mute).connect(audio.destination)
    stream = media
    context = audio
    node = worklet
    const id = ++nextId
    // Recognition normally finishes within a few seconds. Bound callbacks
    // retained for a Mac that never sends its final reply.
    while (dictations.size >= 8) dictations.delete(dictations.keys().next().value!)
    dictations.set(id, onFinal)
    activeId = id
    voice.active = true
    // A phone call, Siri or another app can take the microphone mid-dictation.
    const live = audio
    const lost = () => {
      if (context !== live) return
      voice.error = 'The microphone stopped.'
      void stopVoice()
    }
    for (const track of media.getTracks()) track.addEventListener('ended', lost)
    live.onstatechange = () => {
      if (live.state !== 'running') lost()
    }
    if (!send({ t: 'voiceStart', locale, id })) {
      voice.error = 'Not connected to the Mac.'
      await stopVoice(true, false)
    }
  } catch (error) {
    discard()
    if (run !== generation) return
    voice.error = error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone access was denied.' : 'Could not start the microphone.'
    await stopVoice(true, false)
  } finally {
    if (run === generation) starting = false
  }
}

export async function stopVoice(cancel = false, notifyMac = true) {
  if (finishing) {
    if (cancel) {
      generation++
      dictations.clear()
      voice.partial = ''
      cancelFinishing?.()
      if (notifyMac) send({ t: 'voiceStop', cancel: true, ...(lastStoppedId !== null ? { id: lastStoppedId } : {}) })
      lastStoppedId = null
    }
    return finishing
  }
  const run = ++generation
  starting = false
  const id = activeId
  activeId = null
  if (id !== null) lastStoppedId = id
  const wasActive = voice.active
  if (cancel) {
    dictations.clear()
    lastStoppedId = null
    voice.partial = ''
  }
  voice.active = false
  voice.level = 0
  // Detach globals before waiting: a cancelled start cannot take ownership of
  // this recording, and the next dictation waits until its final audio is sent.
  const closing = context
  const endingNode = node
  const endingStream = stream
  context = null
  node = null
  stream = null
  if (!closing && !endingNode && !endingStream) {
    if (notifyMac && wasActive) send({ t: 'voiceStop', cancel, ...(id !== null ? { id } : {}) })
    return
  }
  let cancelled = cancel
  let cleaned = false
  let wakeFlush: (() => void) | undefined
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    endingNode?.disconnect()
    endingStream?.getTracks().forEach((track) => track.stop())
  }
  cancelFinishing = () => {
    cancelled = true
    cleanup()
    wakeFlush?.()
  }
  finishing = (async () => {
    if (!cancel && notifyMac && wasActive && endingNode && typeof endingNode.port.postMessage === 'function') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(done, 150)
        wakeFlush = done
        endingNode.port.onmessage = (event: MessageEvent<{ pcm?: Int16Array; flushed?: boolean }>) => {
          // Also deliver full chunks already queued on the port before Stop.
          if (!cancelled && run === generation && conn.status === 'connected' && !conn.paused && conn.features.voice && event.data.pcm?.length) {
            sendBinary(encodeAudio(event.data.pcm))
          }
          if (event.data.flushed) done()
        }
        try { endingNode.port.postMessage({ t: 'flush' }) } catch { done() }
      })
    }
    if (notifyMac && wasActive && !cancelled) send({ t: 'voiceStop', cancel: false, ...(id !== null ? { id } : {}) })
    if (notifyMac && wasActive && cancel) send({ t: 'voiceStop', cancel: true, ...(id !== null ? { id } : {}) })
    cleanup()
    if (endingNode) endingNode.port.onmessage = null
    await closing?.close().catch(() => {})
  })().finally(() => {
    finishing = null
    cancelFinishing = undefined
  })
  return finishing
}
