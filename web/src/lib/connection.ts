// The control connection to the Mac: authentication, reconnects, heartbeats
// and coalesced pointer traffic.

import { reactive, shallowRef } from 'vue'
import { deviceInfo, token } from './device'
import { LabelMap } from './keys'
import {
  PROTOCOL_VERSION,
  ScrollPhase,
  encodeFling,
  encodeMove,
  encodeScroll,
  encodeTouch,
  type Action,
  type AppEntry,
  type AuthRequest,
  type ClientMessage,
  type Deck,
  type DenyReason,
  type Features,
  type ServerMessage,
  type VolumeState,
} from './protocol'
import { settings } from './settings'

export type Status =
  | 'idle' // never paired on this origin
  | 'connecting'
  | 'pending' // waiting for approval on the Mac
  | 'connected'
  | 'reconnecting'
  | 'denied'

export interface Notice {
  id: number
  level: 'info' | 'warning' | 'error'
  message: string
  code?: string
}

const HEARTBEAT_MS = 2000
const DEAD_AFTER_MS = 6000
const OPEN_TIMEOUT_MS = 5000
const BACKOFF_MS = [250, 500, 1000, 2000, 3500, 5000]
const MAX_BUFFERED = 64 * 1024

export const state = reactive({
  status: 'idle' as Status,
  hostName: '',
  hostVersion: '',
  features: { voice: false, shell: false, secure: false, permission: true } as Features,
  deck: null as Deck | null,
  volume: null as VolumeState | null,
  paused: false,
  sessionKey: '',
  denied: null as { reason: DenyReason; retryAfter?: number } | null,
  byeReason: '',
  latency: 0,
  attempts: 0,
  notices: [] as Notice[],
  apps: [] as AppEntry[],
  appsLoaded: false,
})

export const labels = shallowRef(new LabelMap())

type Listener = (message: ServerMessage) => void
const listeners = new Set<Listener>()
export function onMessage(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let ws: WebSocket | null = null
let pendingAuth: AuthRequest | null = null
let heartbeat: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let openTimer: ReturnType<typeof setTimeout> | undefined
let lastHeard = 0
let pingId = 0
let pingSent = new Map<number, number>()
let noticeId = 0
let actionId = 0
const pendingActions = new Map<number, { resolve: (r: { ok: boolean; message?: string }) => void; timer: ReturnType<typeof setTimeout> }>()

export function notify(message: string, level: Notice['level'] = 'info', code?: string) {
  // Repeated warnings (e.g. secure input) replace the previous one.
  if (code) state.notices = state.notices.filter((n) => n.code !== code)
  const notice = { id: ++noticeId, level, message, code }
  state.notices = [...state.notices.slice(-2), notice]
  setTimeout(() => dismiss(notice.id), level === 'error' ? 7000 : 4500)
}

export function dismiss(id: number) {
  state.notices = state.notices.filter((n) => n.id !== id)
}

function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

function clearTimers() {
  clearInterval(heartbeat)
  clearTimeout(retryTimer)
  clearTimeout(openTimer)
  heartbeat = undefined
  retryTimer = undefined
  openTimer = undefined
}

function settleActions() {
  for (const { resolve, timer } of pendingActions.values()) {
    clearTimeout(timer)
    resolve({ ok: false, message: 'Lost the connection to the Mac.' })
  }
  pendingActions.clear()
}

function teardown() {
  clearTimers()
  if (ws) {
    ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null
    try {
      ws.close()
    } catch {
      // already closed
    }
    ws = null
  }
  pointer.reset()
  settleActions()
}

/** Connect with the stored token, or with `auth` when pairing. */
export function connect(auth?: AuthRequest) {
  const saved = token.get()
  const request: AuthRequest | null = auth ?? (saved ? { method: 'token', token: saved } : null)
  if (!request) {
    state.status = 'idle'
    return
  }
  teardown()
  pendingAuth = request
  state.denied = null
  state.byeReason = ''
  // A live session stays 'reconnecting' so the shell, and every view's state, stays up.
  state.status = state.status === 'connected' || state.status === 'reconnecting' ? 'reconnecting' : 'connecting'
  const socket = new WebSocket(socketUrl())
  socket.binaryType = 'arraybuffer'
  ws = socket
  // An unreachable address can leave the socket connecting for a long time.
  openTimer = setTimeout(() => {
    if (ws !== socket) return
    teardown()
    scheduleReconnect()
  }, OPEN_TIMEOUT_MS)
  socket.onopen = () => {
    clearTimeout(openTimer)
    openTimer = undefined
    lastHeard = Date.now()
    const hello: ClientMessage = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      device: deviceInfo(),
      auth: request,
      remember: settings.rememberDevice,
    }
    socket.send(JSON.stringify(hello))
  }
  socket.onmessage = (event) => {
    lastHeard = Date.now()
    if (typeof event.data !== 'string') return
    let message: ServerMessage
    try {
      message = JSON.parse(event.data) as ServerMessage
    } catch {
      return
    }
    handle(message)
  }
  socket.onclose = () => {
    if (ws !== socket) return
    ws = null
    clearInterval(heartbeat)
    clearTimeout(openTimer)
    pointer.reset()
    settleActions()
    if (state.status === 'denied' || state.status === 'idle') return
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  // Pairing codes and PINs are single-use; only tokens reconnect on their own.
  if (!token.get()) {
    if (state.status !== 'denied') state.status = 'idle'
    return
  }
  state.status = 'reconnecting'
  const delay = BACKOFF_MS[Math.min(state.attempts, BACKOFF_MS.length - 1)]!
  state.attempts++
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => connect(), delay * (0.8 + Math.random() * 0.4))
}

/** Reconnect now (e.g. when the page becomes visible again). */
export function reconnectSoon() {
  if (state.status === 'reconnecting' || (state.status === 'connected' && Date.now() - lastHeard > DEAD_AFTER_MS)) {
    state.attempts = 0
    connect()
  }
}

export function disconnect(forget: boolean) {
  if (forget) token.set(null)
  state.status = 'idle'
  teardown()
}

function handle(message: ServerMessage) {
  switch (message.t) {
    case 'welcome': {
      if (message.token) token.set(message.token)
      state.status = 'connected'
      state.attempts = 0
      state.hostName = message.host.name
      state.hostVersion = message.host.version
      state.features = message.features
      state.deck = message.deck
      state.volume = message.volume ?? null
      state.paused = message.paused
      state.sessionKey = message.sessionKey
      labels.value = new LabelMap(message.layout)
      pendingAuth = null
      startHeartbeat()
      break
    }
    case 'pending':
      state.status = 'pending'
      break
    case 'denied':
      // Other reasons (a version mismatch after a Mac update, a busy Mac) leave the pairing intact.
      if (pendingAuth?.method === 'token' && message.reason === 'unknown') token.set(null)
      state.denied = { reason: message.reason, retryAfter: message.retryAfter }
      state.status = message.reason === 'unknown' ? 'idle' : 'denied'
      if (message.reason === 'unknown') state.byeReason = 'This device is no longer paired with the Mac. Pair it again.'
      break
    case 'pong': {
      const sent = pingSent.get(message.id)
      if (sent) {
        const rtt = performance.now() - sent
        state.latency = state.latency ? Math.round(state.latency * 0.7 + rtt * 0.3) : Math.round(rtt)
        pingSent.delete(message.id)
      }
      break
    }
    case 'apps':
      state.apps = message.apps
      state.appsLoaded = true
      break
    case 'deck':
      state.deck = message.deck
      break
    case 'layout':
      labels.value = new LabelMap(message.layout)
      break
    case 'volume':
      state.volume = { value: message.value, muted: message.muted }
      break
    case 'volumeUnavailable':
      state.volume = null
      break
    case 'paused':
      state.paused = message.paused
      break
    case 'features':
      state.features = message.features
      break
    case 'notice':
      notify(message.message, message.level, message.code)
      break
    case 'actionResult': {
      const pending = message.id !== undefined ? pendingActions.get(message.id) : undefined
      if (pending) {
        clearTimeout(pending.timer)
        pendingActions.delete(message.id!)
        pending.resolve({ ok: message.ok, message: message.message })
      } else if (!message.ok && message.message) {
        notify(message.message, 'error')
      }
      break
    }
    case 'bye':
      state.byeReason = message.reason
      if (!message.reconnect) {
        // Disconnected or removed on the Mac: only the person here reconnects.
        teardown()
        state.status = 'idle'
      }
      break
    default:
      break
  }
  for (const listener of listeners) listener(message)
}

function startHeartbeat() {
  clearInterval(heartbeat)
  pingSent = new Map()
  heartbeat = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastHeard > DEAD_AFTER_MS) {
      // The socket looks open but nothing is arriving (Wi-Fi dropped). Its
      // close handshake can take a minute on a half-open link, so don't wait.
      teardown()
      scheduleReconnect()
      return
    }
    const id = ++pingId
    pingSent.set(id, performance.now())
    if (pingSent.size > 8) pingSent.delete(pingSent.keys().next().value!)
    send({ t: 'ping', id })
  }, HEARTBEAT_MS)
}

export function isOpen(): boolean {
  return ws?.readyState === WebSocket.OPEN && state.status === 'connected'
}

export function send(message: ClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  // A click must land where the pointer is now, not before the last frame.
  if (message.t !== 'ping' && message.t !== 'hello') pointer.flush()
  ws.send(JSON.stringify(message))
  return true
}

export function sendBinary(data: ArrayBuffer): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN || state.status !== 'connected') return false
  ws.send(data)
  return true
}

/** Run an action and resolve with the Mac's result. */
export function runAction(action: Action): Promise<{ ok: boolean; message?: string }> {
  const id = ++actionId
  return new Promise((resolve) => {
    if (!send({ t: 'action', action, id })) {
      resolve({ ok: false, message: 'Not connected to the Mac.' })
      return
    }
    // The Mac answers every action with an id, but a long one (a shell
    // command, a queue of steps) may still be running: stop waiting without
    // calling it a failure. A late failure still arrives as an error notice.
    const timer = setTimeout(() => {
      pendingActions.delete(id)
      resolve({ ok: true })
    }, 15000)
    pendingActions.set(id, { resolve, timer })
  })
}

export function iconUrl(appId: string, size = 128): string {
  const params = new URLSearchParams({ id: appId, size: String(Math.round(size * Math.min(devicePixelRatio || 2, 3))), k: state.sessionKey })
  return `/api/icon?${params}`
}

/**
 * Pointer and scroll deltas from one burst of touch events are summed and
 * sent together, at most every few milliseconds, and held back while the
 * socket is congested so motion never queues up behind stale packets.
 *
 * Timers rather than animation frames: Low Power Mode and some Android
 * browsers drop frames to 30 per second, which would halve the update rate.
 */
export const pointer = (() => {
  const MIN_GAP_MS = 6
  let mx = 0
  let my = 0
  let sx = 0
  let sy = 0
  let scrollPhase: number = ScrollPhase.None
  let timer: ReturnType<typeof setTimeout> | undefined
  let queued = false
  let lastSent = 0

  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    queued = false
  }
  const flush = (force = false) => {
    cancel()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!force && ws.bufferedAmount > MAX_BUFFERED) {
      queued = true
      timer = setTimeout(() => flush(), 8)
      return
    }
    if (mx !== 0 || my !== 0) {
      sendBinary(encodeMove(mx, my))
      mx = my = 0
    }
    if (scrollPhase !== ScrollPhase.None) {
      sendBinary(encodeScroll(scrollPhase, sx, sy))
      sx = sy = 0
      scrollPhase = ScrollPhase.None
    }
    lastSent = performance.now()
  }
  const schedule = () => {
    if (queued) return
    queued = true
    const wait = MIN_GAP_MS - (performance.now() - lastSent)
    if (wait <= 0) {
      // After the current event handler, so coalesced samples go out as one.
      queueMicrotask(() => queued && flush())
    } else {
      timer = setTimeout(() => flush(), wait)
    }
  }
  return {
    move(dx: number, dy: number) {
      mx += dx
      my += dy
      schedule()
    },
    scroll(phase: number, dx: number, dy: number) {
      if (phase === ScrollPhase.Ended || phase === ScrollPhase.Cancelled) {
        flush(true)
        sendBinary(encodeScroll(phase, 0, 0))
        return
      }
      if (phase === ScrollPhase.Began) {
        flush(true)
        scrollPhase = ScrollPhase.Began
      } else if (scrollPhase === ScrollPhase.None) {
        scrollPhase = ScrollPhase.Changed
      }
      sx += dx
      sy += dy
      schedule()
    },
    fling(vx: number, vy: number) {
      flush(true)
      sendBinary(encodeFling(vx, vy))
    },
    touch() {
      sendBinary(encodeTouch())
    },
    /** Send anything pending now, before a discrete event like a click. */
    flush() {
      flush(true)
    },
    reset() {
      cancel()
      mx = my = sx = sy = 0
      scrollPhase = ScrollPhase.None
    },
  }
})()

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Never leave keys or buttons held while the phone is locked.
      send({ t: 'release' })
    } else {
      reconnectSoon()
    }
  })
  addEventListener('online', () => reconnectSoon())
  addEventListener('pageshow', (event) => {
    if (event.persisted) reconnectSoon()
  })
}
