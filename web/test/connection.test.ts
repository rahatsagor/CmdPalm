import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  binaryType = ''
  bufferedAmount = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: unknown) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data)
  }
  // Like a half-open link: the close handshake never finishes.
  close() {
    this.readyState = FakeSocket.CLOSING
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
}

const welcome = {
  t: 'welcome',
  v: 1,
  host: { name: 'Mac', version: '1.0', os: 'macOS' },
  sessionKey: 'k',
  features: { voice: false, shell: false, secure: false, permission: true },
  deck: { version: 1, pages: [] },
  paused: false,
}

type Connection = typeof import('../src/lib/connection')
let conn: Connection

const last = () => FakeSocket.all.at(-1)!

function connected() {
  conn.connect()
  last().open()
  last().receive(welcome)
  expect(conn.state.status).toBe('connected')
  return last()
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  conn = await import('../src/lib/connection')
})

afterEach(() => {
  // Earlier module copies keep their document listeners; leave them inert.
  conn.disconnect(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('reconnecting', () => {
  it('stays in the shell when the page comes back with a stale socket', () => {
    connected()
    vi.advanceTimersByTime(7000)
    conn.reconnectSoon()
    expect(conn.state.status).toBe('reconnecting')
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('keeps an attempt that is still under way when the page comes back', () => {
    const first = connected()
    first.drop()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    conn.reconnectSoon()
    document.dispatchEvent(new Event('visibilitychange'))
    dispatchEvent(new Event('online'))
    expect(FakeSocket.all).toHaveLength(2)
    last().open()
    last().receive(welcome)
    expect(conn.state.status).toBe('connected')
  })

  it('reconnects as soon as the heartbeat finds the socket dead', () => {
    const first = connected()
    vi.advanceTimersByTime(8000)
    expect(conn.state.status).toBe('reconnecting')
    expect(first.onclose).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('gives up on a socket that never opens and tries again', () => {
    conn.connect()
    expect(conn.state.status).toBe('connecting')
    vi.advanceTimersByTime(5000)
    expect(conn.state.status).toBe('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('waits as long as it takes for approval once the socket is open', () => {
    localStorage.clear()
    conn.connect({ method: 'approve' })
    last().open()
    last().receive({ t: 'pending' })
    const socket = last()
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(2000)
      const ping = socket.sent.at(-1) as { t: string; id: number }
      if (ping.t === 'ping') socket.receive({ t: 'pong', id: ping.id })
    }
    expect(conn.state.status).toBe('pending')
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('notices when the Mac goes quiet while waiting for approval', () => {
    localStorage.clear()
    conn.connect({ method: 'approve' })
    last().open()
    last().receive({ t: 'pending' })
    vi.advanceTimersByTime(8000)
    expect(conn.state.status).toBe('idle')
    expect(conn.state.byeReason).toBe(
      'Lost the connection to the Mac while waiting for approval. Check that this phone is on the same network as the Mac, then try again.',
    )
    vi.advanceTimersByTime(30000)
    expect(FakeSocket.all).toHaveLength(1)
  })
})

describe('pairing on a slow network', () => {
  it('tries the same code again, then explains what to do', () => {
    localStorage.clear()
    conn.connect({ method: 'pair', code: 'abc' })
    vi.advanceTimersByTime(5000)
    expect(conn.state.status).toBe('connecting')
    expect(conn.state.byeReason).toBe('')
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    conn.connect()
    expect(FakeSocket.all).toHaveLength(2)

    last().open()
    expect(last().sent).toMatchObject([{ t: 'hello', auth: { method: 'pair', code: 'abc' } }])
    last().drop()
    expect(conn.state.status).toBe('connecting')
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(3)

    vi.advanceTimersByTime(5000)
    expect(conn.state.status).toBe('idle')
    expect(conn.state.byeReason).toBe(
      'Couldn’t reach the Mac. Check that this phone is on the same network as the Mac, then scan the QR code again.',
    )
    vi.advanceTimersByTime(30000)
    expect(FakeSocket.all).toHaveLength(3)
  })

  it('connects when a retry gets through', () => {
    localStorage.clear()
    conn.connect({ method: 'pair', code: 'abc' })
    vi.advanceTimersByTime(6000)
    last().open()
    last().receive({ ...welcome, token: 'new' })
    expect(conn.state.status).toBe('connected')
    expect(localStorage.getItem('cmdpalm.token')).toBe('new')
  })

  it('does not try again once the Mac has answered', () => {
    localStorage.clear()
    conn.connect({ method: 'pair', code: 'abc' })
    last().open()
    last().receive({ t: 'denied', reason: 'expiredCode' })
    last().drop()
    vi.advanceTimersByTime(30000)
    expect(conn.state.status).toBe('denied')
    expect(FakeSocket.all).toHaveLength(1)
  })
})

describe('bye', () => {
  it('reconnects on its own when the Mac restarts its server', () => {
    const first = connected()
    first.receive({ t: 'bye', reason: 'The Mac stopped sharing.', reconnect: true })
    first.drop()
    expect(conn.state.status).toBe('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('stays disconnected when the Mac disconnects this device', () => {
    const first = connected()
    first.receive({ t: 'bye', reason: 'Disconnected from the Mac.' })
    first.drop()
    expect(conn.state.status).toBe('idle')
    expect(conn.state.byeReason).toBe('Disconnected from the Mac.')
    expect(localStorage.getItem('cmdpalm.token')).toBe('saved')
    conn.reconnectSoon()
    document.dispatchEvent(new Event('visibilitychange'))
    dispatchEvent(new Event('online'))
    vi.advanceTimersByTime(30000)
    expect(FakeSocket.all).toHaveLength(1)

    conn.connect()
    expect(conn.state.byeReason).toBe('')
    expect(FakeSocket.all).toHaveLength(2)
  })
})

describe('while reconnecting', () => {
  it('doesn’t show deck changes the Mac never received', async () => {
    const deck = await import('../src/lib/deck')
    const first = connected()
    expect(deck.saveDeck({ version: 1, pages: [deck.newPage('New')] })).toBe(true)
    first.drop()
    expect(deck.saveDeck({ version: 1, pages: [] })).toBe(false)
    // The last deck the Mac confirmed, not either edit.
    expect(conn.state.deck?.pages).toEqual([])
    expect(conn.state.notices.at(-1)?.code).toBe('deck')
  })

  it('restores the confirmed deck after an edit in place is rejected', async () => {
    const deck = await import('../src/lib/deck')
    const socket = connected()
    conn.state.deck!.pages.push(deck.newPage('Dragged'))
    socket.receive({ t: 'notice', level: 'error', code: 'deck', message: 'Too many pages.' })
    expect(conn.state.deck?.pages).toEqual([])
  })

  it('asks for the app list again once connected', async () => {
    const apps = await import('../src/lib/apps')
    const first = connected()
    first.drop()
    apps.loadApps(true)
    vi.advanceTimersByTime(1000)
    last().open()
    last().receive(welcome)
    expect(last().sent).toContainEqual({ t: 'apps' })
  })
})

describe('denied', () => {
  it('forgets the token only when the Mac no longer knows it', () => {
    conn.connect()
    last().open()
    last().receive({ t: 'denied', reason: 'incompatible' })
    expect(conn.state.status).toBe('denied')
    expect(localStorage.getItem('cmdpalm.token')).toBe('saved')

    conn.connect()
    last().open()
    last().receive({ t: 'denied', reason: 'unknown' })
    expect(conn.state.status).toBe('idle')
    expect(localStorage.getItem('cmdpalm.token')).toBeNull()
  })
})

describe('actions', () => {
  it('fails pending actions when the connection drops', async () => {
    const socket = connected()
    const result = conn.runAction({ kind: 'system', name: 'missionControl' })
    socket.drop()
    await expect(result).resolves.toEqual({ ok: false, message: 'Lost the connection to the Mac.' })
  })

  it('resolves with the Mac’s answer', async () => {
    const socket = connected()
    const result = conn.runAction({ kind: 'system', name: 'missionControl' })
    const sent = socket.sent.at(-1) as { id: number }
    socket.receive({ t: 'actionResult', id: sent.id, ok: false, message: 'Nope.' })
    await expect(result).resolves.toEqual({ ok: false, message: 'Nope.' })
  })
})

describe('pairing', () => {
  it('keeps a pairing in progress when the app connects with a saved token', () => {
    conn.connect({ method: 'pair', code: 'abc' })
    conn.connect()
    expect(FakeSocket.all).toHaveLength(1)
    last().open()
    expect(last().sent).toMatchObject([{ t: 'hello', auth: { method: 'pair', code: 'abc' } }])
  })

  it('stays connecting when there is no saved token', () => {
    localStorage.clear()
    conn.connect({ method: 'pin', pin: '123456' })
    conn.connect()
    expect(conn.state.status).toBe('connecting')
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('reads the pairing link once and drops it from the address bar', async () => {
    history.replaceState(null, '', '/#pair=one-time_1')
    vi.resetModules()
    const pairing = await import('../src/lib/pairing')
    expect(location.hash).toBe('')
    expect(pairing.pairingLink).toBe(true)
    expect(pairing.takePairingCode()).toBe('one-time_1')
    expect(pairing.takePairingCode()).toBeNull()
  })
})

describe('disconnecting here', () => {
  it('keeps the pairing so the device can reconnect', () => {
    connected()
    conn.disconnect(false)
    expect(conn.state.status).toBe('idle')
    expect(conn.state.byeReason).toBe('')
    expect(localStorage.getItem('cmdpalm.token')).toBe('saved')
    conn.connect()
    expect(FakeSocket.all).toHaveLength(2)
  })
})

describe('sending', () => {
  it('drops input until the Mac welcomes a reconnect', () => {
    connected()
    vi.advanceTimersByTime(8000)
    vi.advanceTimersByTime(1000)
    const socket = last()
    socket.open()
    expect(conn.state.status).toBe('reconnecting')
    expect(conn.send({ t: 'key', code: 0, down: true })).toBe(false)
    expect(socket.sent).toMatchObject([{ t: 'hello' }])
    socket.receive(welcome)
    expect(conn.send({ t: 'key', code: 0, down: true })).toBe(true)
  })
})
