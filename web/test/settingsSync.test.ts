import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  binaryType = ''
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: unknown) {
    if (typeof data === 'string') this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = FakeSocket.CLOSED
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
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

const NOW = 1_750_000_000_000

let conn: typeof import('../src/lib/connection')
let prefs: typeof import('../src/lib/settings')
let boards: typeof import('../src/lib/customKeyboards')
let sync: typeof import('../src/lib/settingsSync')

async function load() {
  vi.resetModules()
  conn = await import('../src/lib/connection')
  prefs = await import('../src/lib/settings')
  boards = await import('../src/lib/customKeyboards')
  sync = await import('../src/lib/settingsSync')
  sync.installSettingsSync()
}

function connect(extra: object = {}) {
  conn.connect()
  const socket = FakeSocket.all.at(-1)!
  socket.open()
  socket.receive({ ...welcome, ...extra })
  return socket
}

const saves = (socket: FakeSocket) => socket.sent.filter((m) => m.t === 'settingsSave')

/** Let the change watchers run, then wait out the save delay. */
async function settle(ms = sync.SAVE_DELAY_MS + 100) {
  await nextTick()
  vi.advanceTimersByTime(ms)
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('WebSocket', FakeSocket)
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  await load()
})

afterEach(() => {
  conn.disconnect(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('synced payload', () => {
  it('leaves out device-local settings and the active keyboard', () => {
    prefs.settings.deviceName = 'Kitchen iPad'
    prefs.settings.rememberDevice = false
    prefs.settings.tab = 'deck'
    prefs.settings.deckPage = 'p-1'
    prefs.settings.theme = 'light'
    const payload = JSON.parse(JSON.stringify(sync.buildPayload())) as { settings: Record<string, unknown>; keyboards: unknown[] }
    for (const key of sync.UNSYNCED) expect(payload.settings).not.toHaveProperty(key)
    expect(payload.settings.theme).toBe('light')
    expect(payload.settings.threeFinger).toBeTruthy()
    expect(payload).not.toHaveProperty('active')
    expect(payload.keyboards).toHaveLength(boards.keyboards.boards.length)
  })

  it('does not save when only device-local state changes', async () => {
    const socket = connect()
    prefs.settings.tab = 'media'
    prefs.settings.deviceName = 'Desk'
    boards.keyboards.active = boards.keyboards.boards.at(-1)!.id
    await settle()
    expect(saves(socket)).toHaveLength(0)
  })

  it('sends nothing when nothing was customized and the Mac has nothing', async () => {
    const socket = connect()
    await settle(10_000)
    expect(saves(socket)).toHaveLength(0)
  })
})

describe('reconciling with the Mac', () => {
  it('applies a newer copy from the Mac without echoing it back', async () => {
    const remoteBoard = { id: 'r', name: 'Remote', cols: 3, rows: 2, trackpad: false, keys: [] }
    const socket = connect({
      settings: {
        settings: { version: 1, settings: { theme: 'light', pointerSpeed: 2, deviceName: 'Other', tab: 'apps' }, keyboards: [remoteBoard] },
        updatedAt: NOW - 1000,
      },
    })
    expect(prefs.settings.theme).toBe('light')
    expect(prefs.settings.pointerSpeed).toBe(2)
    expect(prefs.settings.deviceName).toBe('')
    expect(prefs.settings.tab).toBe('trackpad')
    expect(boards.keyboards.boards.map((b) => b.name)).toEqual(['Remote'])
    expect(boards.keyboards.active).toBe('r')
    await settle(10_000)
    expect(saves(socket)).toHaveLength(0)
  })

  it('keeps newer local settings and pushes them over an older copy', async () => {
    prefs.settings.theme = 'dark'
    await settle()
    const socket = connect({ settings: { settings: { version: 1, settings: { theme: 'light' }, keyboards: [] }, updatedAt: NOW - 60_000 } })
    expect(prefs.settings.theme).toBe('dark')
    const sent = saves(socket)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.updatedAt).toBe(NOW)
    expect((sent[0]!.settings as { settings: { theme: string } }).settings.theme).toBe('dark')
  })

  it('pushes a change made while offline once reconnected', async () => {
    prefs.settings.haptics = false
    await settle()
    expect(FakeSocket.all).toHaveLength(0)
    const socket = connect()
    expect(saves(socket)).toHaveLength(1)
  })

  it('skips the save for a device the Mac does not remember', async () => {
    localStorage.removeItem('cmdpalm.token')
    prefs.settings.haptics = false
    await settle()
    conn.connect({ method: 'pin', pin: '123456' })
    const socket = FakeSocket.all.at(-1)!
    socket.open()
    socket.receive(welcome)
    expect(saves(socket)).toHaveLength(0)
  })
})

describe('saving changes', () => {
  it('coalesces rapid changes into one save', async () => {
    const socket = connect()
    for (let i = 1; i <= 5; i++) {
      prefs.settings.pointerSpeed = 1 + i / 10
      await nextTick()
      vi.advanceTimersByTime(300)
    }
    expect(saves(socket)).toHaveLength(0)
    vi.advanceTimersByTime(sync.SAVE_DELAY_MS)
    const sent = saves(socket)
    expect(sent).toHaveLength(1)
    expect((sent[0]!.settings as { settings: { pointerSpeed: number } }).settings.pointerSpeed).toBe(1.5)
  })

  it('saves custom keyboard edits', async () => {
    const socket = connect()
    boards.keyboards.boards[0]!.name = 'Slides'
    await settle()
    expect(saves(socket)).toHaveLength(1)
  })
})

describe('untrusted settings', () => {
  it('cleans invalid values from the Mac', () => {
    connect({
      settings: {
        settings: {
          version: 1,
          settings: {
            pointerSpeed: 99,
            theme: 'sepia',
            haptics: 'yes',
            threeFinger: { up: { kind: 'text' }, down: { kind: 'bogus' }, left: null, tap: 'x', right: { kind: 'system', name: 'lockScreen' } },
            fourFinger: [1, 2],
          },
          keyboards: [{ cols: 99 }, 'junk'],
        },
        updatedAt: NOW - 10,
      },
    })
    const defaults = prefs.defaultSettings()
    expect(prefs.settings.pointerSpeed).toBe(4)
    expect(prefs.settings.theme).toBe('system')
    expect(prefs.settings.haptics).toBe(true)
    expect(prefs.settings.threeFinger.up).toEqual(defaults.threeFinger.up)
    expect(prefs.settings.threeFinger.down).toEqual(defaults.threeFinger.down)
    expect(prefs.settings.threeFinger.left).toBeNull()
    expect(prefs.settings.threeFinger.tap).toEqual(defaults.threeFinger.tap)
    expect(prefs.settings.threeFinger.right).toEqual({ kind: 'system', name: 'lockScreen' })
    expect(prefs.settings.fourFinger).toEqual(defaults.fourFinger)
    expect(boards.keyboards.boards.length).toBeGreaterThan(0)
    expect(boards.keyboards.boards.some((b) => b.id === boards.keyboards.active)).toBe(true)
  })

  it('ignores a malformed saved copy', () => {
    prefs.settings.theme = 'dark'
    connect({ settings: { settings: 'nope', updatedAt: 'later' } })
    expect(prefs.settings.theme).toBe('dark')
  })
})

describe('copying from another device', () => {
  it('lists devices, applies the copy and saves it as this device’s own', async () => {
    const socket = connect()
    sync.listDevices()
    expect(socket.sent.at(-1)).toEqual({ t: 'settingsList' })
    socket.receive({
      t: 'settingsList',
      devices: [{ id: 'd2', name: 'Studio iPad', model: 'iPad', updatedAt: NOW - 3_600_000 }, { id: 3 }],
    })
    expect(sync.copier.devices).toHaveLength(1)

    const done = sync.copyFrom(sync.copier.devices![0]!)
    expect(socket.sent.at(-1)).toEqual({ t: 'settingsCopy', from: 'd2' })
    socket.receive({ t: 'settings', settings: { version: 1, settings: { theme: 'light' }, keyboards: [] }, updatedAt: NOW - 3_600_000 })
    expect(await done).toBe(true)
    expect(prefs.settings.theme).toBe('light')
    const sent = saves(socket)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.updatedAt).toBe(NOW)
  })

  it('gives up when the device is gone', async () => {
    const socket = connect()
    const done = sync.copyFrom({ id: 'gone', name: 'Old phone', model: 'iPhone', updatedAt: 1 })
    socket.receive({ t: 'notice', level: 'warning', code: 'settings', message: 'Those settings are no longer on this Mac.' })
    expect(await done).toBe(false)
    expect(sync.copier.copying).toBe('')
  })
})

describe('relative times', () => {
  it('reads naturally', () => {
    expect(sync.ago(NOW - 5_000, NOW)).toBe('just now')
    expect(sync.ago(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago')
    expect(sync.ago(NOW - 86_400_000, NOW)).toBe('yesterday')
  })
})
