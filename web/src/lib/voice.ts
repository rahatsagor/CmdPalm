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
let finals: ((text: string) => void) | null = null
let starting = false
/** Bumped by every stop, so a start still awaiting the microphone knows it was cancelled. */
let generation = 0

export function voiceSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined'
}

onMessage((message) => {
  if (message.t !== 'voice') return
  if (message.state === 'listening') {
    if (message.text !== undefined) voice.partial = message.text
    if (message.final && message.text) {
      finals?.(message.text)
      voice.partial = ''
    }
  } else if (message.state === 'stopped') {
    if (message.text) finals?.(message.text)
    voice.partial = ''
    void stopVoice(false, false)
  } else {
    voice.error = message.message ?? 'Speech recognition stopped.'
    void stopVoice(true, false)
  }
})

watch(
  () => conn.status,
  (status) => {
    // The socket is gone, so there is no Mac to tell.
    if (status !== 'connected') void stopVoice(true, false)
  },
)

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void stopVoice()
  })
}

/** Start listening. `onFinal` receives each finished phrase. */
export async function startVoice(onFinal: (text: string) => void, locale = navigator.language) {
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
      voice.level = voice.level * 0.6 + event.data.peak * 0.4
      sendBinary(encodeAudio(event.data.pcm))
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
    finals = onFinal
    voice.active = true
    if (!send({ t: 'voiceStart', locale })) {
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
  generation++
  starting = false
  if (notifyMac && voice.active) send({ t: 'voiceStop', cancel })
  voice.active = false
  voice.level = 0
  node?.disconnect()
  node = null
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  await context?.close().catch(() => {})
  context = null
  if (cancel) finals = null
}
