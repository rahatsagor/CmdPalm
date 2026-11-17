// The phone is receive-only. No getUserMedia, getDisplayMedia, WebCodecs,
// secure-context requirement, or third-party ICE service is needed here.
import { reactive, watch } from 'vue'
import { onMessage, send, state as connection } from './connection'
import { releaseAll } from './input'
import type { DisplayInfo } from './protocol'
import { settings } from './settings'
import { ScreenImageAssembler } from './screenImages'

export const screen = reactive({
  active: false,
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'connecting' | 'live' | 'error',
  displays: [] as DisplayInfo[],
  message: '',
  needsPlay: false,
  canRequest: false,
  accessState: 'idle' as string,
  accessMessage: '',
  original: false,
})

let video: HTMLVideoElement | null = null
let picture: HTMLImageElement | null = null
let pictureURL: string | null = null
let channel: RTCDataChannel | null = null
const images = new ScreenImageAssembler()
let peer: RTCPeerConnection | null = null
let request = 0
let streamId: number | null = null
let listId: number | null = null
let generation = 0
let heartbeat: ReturnType<typeof setInterval> | undefined
let timeout: ReturnType<typeof setTimeout> | undefined
let listTimeout: ReturnType<typeof setTimeout> | undefined
let disconnected: ReturnType<typeof setTimeout> | undefined
let cancelGathering: (() => void) | undefined
let accessId: number | null = null
let accessTimeout: ReturnType<typeof setTimeout> | undefined
let approvalRefresh: ReturnType<typeof setTimeout> | undefined

export function cancelAccessRequest() {
  if (accessId !== null) send({ t: 'displayAccessCancel', id: accessId })
  accessId = null
  clearTimeout(accessTimeout)
  clearTimeout(approvalRefresh)
  if (screen.accessState === 'pending') { screen.accessState = 'idle'; screen.accessMessage = '' }
}

export function requestScreenAccess() {
  if (!canView() || !connection.features.displayRequests || accessId !== null) return
  const id = ++request
  accessId = id
  screen.accessState = 'pending'
  screen.accessMessage = 'Approve screen mirroring on the Mac. This request expires in one minute.'
  if (!send({ t: 'displayAccessRequest', id })) { cancelAccessRequest(); screen.accessState = 'error'; return }
  accessTimeout = setTimeout(() => {
    if (accessId !== id) return
    cancelAccessRequest()
    screen.accessState = 'expired'
    screen.accessMessage = 'The access request expired. Ask again when someone is at the Mac.'
  }, 65_000)
}

export const screenSupported = () => typeof RTCPeerConnection !== 'undefined'
export const selectedDisplay = () => screen.displays.find(display => display.id === settings.displayId)
const visible = () => screen.active && document.visibilityState === 'visible'
const canView = () => visible() && connection.status === 'connected' && !connection.paused

function closeStream(notify = true) {
  const wasViewing = streamId !== null || peer !== null
  generation++
  cancelGathering?.()
  cancelGathering = undefined
  clearInterval(heartbeat)
  clearTimeout(timeout)
  clearTimeout(disconnected)
  heartbeat = undefined
  timeout = undefined
  disconnected = undefined
  if (channel) { channel.onmessage = null; channel.onclose = null; channel.close(); channel = null }
  images.reset()
  if (picture) { picture.onload = null; picture.onerror = null; picture.removeAttribute('src') }
  if (pictureURL) URL.revokeObjectURL(pictureURL)
  pictureURL = null
  const id = streamId
  streamId = null
  if (notify && id !== null) send({ t: 'displayStop', id })
  if (peer) {
    peer.ontrack = null
    peer.onconnectionstatechange = null
    peer.close()
    peer = null
  }
  if (video) {
    video.onplaying = null
    video.pause()
    const media = video.srcObject as MediaStream | null
    media?.getTracks().forEach(track => track.stop())
    video.srcObject = null
  }
  screen.needsPlay = false
  return wasViewing
}

export function stopViewing(message = '', notify = true) {
  const wasViewing = closeStream(notify)
  if (wasViewing || screen.active) releaseAll()
  screen.status = screen.displays.length ? 'ready' : 'idle'
  screen.message = message
}

function fail(message: string) {
  stopViewing(message)
  screen.status = 'error'
}

export function refreshDisplays() {
  if (listId !== null) return
  stopViewing()
  screen.canRequest = false
  clearTimeout(listTimeout)
  listId = null
  if (!canView()) return
  if (!screenSupported()) {
    fail('This browser cannot receive live video. Try Safari, Chrome, Firefox, or Samsung Internet.')
    return
  }
  if (connection.features.display === undefined) {
    fail('Update CmdPalm on the Mac to use screen mirroring.')
    return
  }
  screen.status = 'loading'
  const id = ++request
  listId = id
  if (!send({ t: 'displays', id })) {
    listId = null
    fail('The Mac is not connected.')
    return
  }
  listTimeout = setTimeout(() => {
    if (listId !== id) return
    listId = null
    fail('The Mac did not answer. Check its connection, then refresh the display list.')
  }, 8_000)
}

function gathered(current: RTCPeerConnection): Promise<void> {
  if (current.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(finish, 2_000)
    function finish() {
      clearTimeout(timer)
      current.removeEventListener('icegatheringstatechange', changed)
      if (cancelGathering === finish) cancelGathering = undefined
      resolve()
    }
    function changed() { if (current.iceGatheringState === 'complete') finish() }
    cancelGathering = finish
    current.addEventListener('icegatheringstatechange', changed)
  })
}

export async function playViewing() {
  const current = generation
  try {
    await video?.play()
    if (current === generation) screen.needsPlay = false
  } catch {
    if (current === generation) {
      screen.needsPlay = true
      clearTimeout(timeout)
      timeout = setTimeout(() => { if (current === generation) fail('Playback did not start. Tap View when you are ready to try again.') }, 30_000)
    }
  }
}

export async function startViewing() {
  if (!canView() || !selectedDisplay() || !video || !screenSupported()) return
  if (settings.displayQuality === 'original' && (!connection.features.displayOriginal || !picture)) {
    fail('Update CmdPalm on the Mac to use HD text, or choose another viewing quality.')
    return
  }
  closeStream()
  releaseAll()
  const current = generation
  const id = ++request
  streamId = id
  screen.status = 'connecting'
  screen.message = ''
  screen.original = settings.displayQuality === 'original'
  try {
    // Empty iceServers keeps negotiation entirely on the user's network.
    const rtc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
    peer = rtc
    if (screen.original) {
      const data = rtc.createDataChannel('cmdpalm.original', { ordered: true })
      channel = data
      data.binaryType = 'arraybuffer'
      data.onclose = () => { if (current === generation) fail('The HD text connection ended. Start viewing again.') }
      data.onmessage = event => {
        if (current !== generation || !canView() || !picture) return
        try {
          if (!(event.data instanceof ArrayBuffer)) throw new Error('Unsupported picture format')
          const png = images.push(event.data)
          if (!png) return
          const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }))
          if (pictureURL) URL.revokeObjectURL(pictureURL)
          pictureURL = url
          picture.onload = () => {
            if (current !== generation || !canView() || pictureURL !== url) return
            clearTimeout(timeout)
            screen.status = 'live'
            screen.message = ''
          }
          picture.onerror = () => { if (current === generation && pictureURL === url) fail('The HD picture could not be displayed. Try Sharper text.') }
          picture.src = url
        } catch { fail('The HD picture could not be received safely. Try Sharper text or reconnect.') }
      }
    } else {
    const transceiver = rtc.addTransceiver('video', { direction: 'recvonly' })
    const capabilities = typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('video') : undefined
    const codecs = capabilities?.codecs.filter(codec => ['video/h264', 'video/rtx'].includes(codec.mimeType.toLowerCase()))
    if (codecs?.some(codec => codec.mimeType.toLowerCase() === 'video/h264') && typeof transceiver.setCodecPreferences === 'function') transceiver.setCodecPreferences(codecs)
    rtc.ontrack = event => {
      if (current !== generation || !canView() || !video) { event.track.stop(); return }
      video.srcObject = event.streams[0] ?? new MediaStream([event.track])
      video.onplaying = () => {
        if (current !== generation || !canView()) return
        clearTimeout(timeout)
        screen.status = 'live'
        screen.message = ''
        screen.needsPlay = false
      }
      void playViewing()
    }
    }
    rtc.onconnectionstatechange = () => {
      if (current !== generation) return
      clearTimeout(disconnected)
      if (rtc.connectionState === 'failed' || rtc.connectionState === 'closed') {
        fail('The video connection ended. Check your Wi-Fi or VPN, then start viewing again.')
      } else if (rtc.connectionState === 'disconnected') {
        screen.message = 'Video connection interrupted…'
        disconnected = setTimeout(() => {
          if (current === generation) fail('The video connection was lost. Start viewing again when your network is ready.')
        }, 5_000)
      } else if (rtc.connectionState === 'connected') screen.message = ''
    }
    timeout = setTimeout(() => {
      if (current === generation) fail('Video did not start. Check Screen Recording permission on the Mac and that your network allows a direct video connection.')
    }, 17_000)
    await rtc.setLocalDescription(await rtc.createOffer())
    await gathered(rtc)
    if (current !== generation || !canView()) return
    const sdp = rtc.localDescription?.sdp
    if (!sdp || !send({ t: 'displayStart', id, displayId: settings.displayId, quality: settings.displayQuality, sdp })) {
      fail('The Mac is not connected.')
      return
    }
    send({ t: 'displayAlive', id })
    heartbeat = setInterval(() => {
      if (current !== generation || !canView()) { stopViewing(); return }
      send({ t: 'displayAlive', id })
    }, 1_000)
  } catch {
    if (current === generation) fail('The browser could not start live video. Refresh the display list and try again.')
  }
}

export function focusDisplay() {
  if (streamId !== null && screen.status === 'live' && connection.features.permission) send({ t: 'displayFocus', id: streamId })
}

export function activateScreen(element: HTMLVideoElement, image?: HTMLImageElement) {
  video = element
  picture = image ?? null
  if (screen.active) return
  screen.active = true
  refreshDisplays()
}

export function deactivateScreen() {
  screen.active = false
  listId = null
  clearTimeout(listTimeout)
  cancelAccessRequest()
  stopViewing()
  releaseAll()
  video = null
  picture = null
}

onMessage(message => {
  if (message.t === 'displays') {
    if (!visible() || message.id !== listId) return
    clearTimeout(listTimeout)
    listId = null
    screen.displays = message.displays
    // A feature update can finish this refresh before the approval fallback
    // timer fires. Never replace a usable list or interrupt its new viewer.
    if (message.displays.length) clearTimeout(approvalRefresh)
    screen.canRequest = message.canRequest === true && connection.features.displayRequests === true
    screen.message = message.message ?? ''
    if (!settings.displayId && message.displays.length) settings.displayId = (message.displays.find(display => display.main) ?? message.displays[0]!).id
    if (settings.displayId && message.displays.length && !selectedDisplay()) screen.message = 'The selected display is unavailable. Choose another display above.'
    screen.status = message.displays.length ? 'ready' : 'error'
  } else if (message.t === 'displayAccess') {
    if (!message.allowed) stopViewing('Screen mirroring permission was removed on the Mac.')
    if (canView() && accessId === null && streamId === null) refreshDisplays()
  } else if (message.t === 'displayRequest' && message.id === accessId) {
    screen.accessState = message.state
    screen.accessMessage = message.message ?? ''
    if (message.state !== 'pending') {
      accessId = null
      clearTimeout(accessTimeout)
      if (message.state === 'allowed' && canView()) {
        screen.canRequest = false
        clearTimeout(approvalRefresh)
        approvalRefresh = setTimeout(() => { if (canView() && !screen.displays.length) refreshDisplays() }, 350)
      }
    }
  } else if (message.t === 'displayState' && message.id === streamId) {
    if (message.state === 'answer' && message.sdp && peer) {
      const current = generation
      void peer.setRemoteDescription({ type: 'answer', sdp: message.sdp }).catch(() => {
        if (current === generation) fail('The browser could not accept the video connection. Try again.')
      })
    } else if (message.state === 'error' || message.state === 'stopped') {
      stopViewing(message.message ?? 'Screen mirroring stopped.', false)
    }
  }
})

watch([() => connection.status, () => connection.paused, () => connection.features.display], ([status, paused]) => {
  if (status !== 'connected' || paused) {
    cancelAccessRequest()
    listId = null
    clearTimeout(listTimeout)
    stopViewing(paused ? 'Screen mirroring is paused on the Mac.' : 'Reconnect to the Mac, then start viewing again.')
    screen.displays = []
    screen.canRequest = false
  } else if (visible() && accessId === null) refreshDisplays()
}, { flush: 'sync' })

document.addEventListener('visibilitychange', () => {
  if (!visible()) {
    cancelAccessRequest()
    listId = null
    clearTimeout(listTimeout)
    stopViewing('Start viewing again when you are ready.')
  } else if (canView()) refreshDisplays()
})
addEventListener('pagehide', () => { cancelAccessRequest(); listId = null; clearTimeout(listTimeout); stopViewing() })
