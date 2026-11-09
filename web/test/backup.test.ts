import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

let backup: typeof import('../src/lib/backup')
let prefs: typeof import('../src/lib/settings')
let boards: typeof import('../src/lib/customKeyboards')

beforeEach(async () => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.resetModules()
  prefs = await import('../src/lib/settings')
  boards = await import('../src/lib/customKeyboards')
  const sync = await import('../src/lib/settingsSync')
  sync.installSettingsSync()
  backup = await import('../src/lib/backup')
})

afterEach(() => { vi.useRealTimers() })

describe('device backups', () => {
  it('round trips preferences and custom keyboards while preserving identity and pairing', async () => {
    prefs.settings.theme = 'dark'
    prefs.settings.pointerSpeed = 2
    boards.keyboards.boards[0]!.name = 'My presentation'
    localStorage.setItem('cmdpalm.token', 'private-token')
    localStorage.setItem('cmdpalm.deviceId', 'private-id')
    prefs.settings.deviceName = 'Old phone'
    const json = backup.exportBackup(123)
    expect(json).not.toContain('private-token')
    expect(json).not.toContain('private-id')
    expect(json).not.toContain('Old phone')
    prefs.settings.theme = 'light'
    prefs.settings.deviceName = 'New phone'
    prefs.settings.rememberDevice = false
    prefs.settings.deckPage = 'current-page'
    boards.keyboards.boards[0]!.name = 'Changed'
    expect(backup.restoreBackup(backup.readBackup(json))).toBe(true)
    expect(prefs.settings.theme).toBe('dark')
    expect(prefs.settings.pointerSpeed).toBe(2)
    expect(boards.keyboards.boards[0]!.name).toBe('My presentation')
    expect(prefs.settings.deviceName).toBe('New phone')
    expect(prefs.settings.rememberDevice).toBe(false)
    expect(prefs.settings.deckPage).toBe('current-page')
    expect(localStorage.getItem('cmdpalm.token')).toBe('private-token')
    await nextTick()
    vi.advanceTimersByTime(2000)
    expect(JSON.parse(localStorage.getItem('cmdpalm.settings')!).theme).toBe('dark')
    expect(JSON.parse(localStorage.getItem('cmdpalm.keyboards')!).boards[0].name).toBe('My presentation')
  })

  it('restores sequence gestures regardless of JSON property order', () => {
    prefs.settings.threeFinger.tap = { kind: 'sequence', steps: [{ kind: 'text', text: 'Hello' }, { kind: 'delay', ms: 100 }] }
    const raw = JSON.parse(backup.exportBackup())
    raw.setup.settings.threeFinger = Object.fromEntries(Object.entries(raw.setup.settings.threeFinger).reverse())
    expect(backup.restoreBackup(backup.readBackup(JSON.stringify(raw)))).toBe(true)
    expect(prefs.settings.threeFinger.tap?.kind).toBe('sequence')
  })

  it.each(['json', 'format', 'version', 'size', 'keyboard', 'gesture', 'setting'] as const)('rejects a damaged %s without changing the current setup', (kind) => {
    const before = backup.exportBackup(123)
    const raw = JSON.parse(before)
    let json = before
    if (kind === 'json') json = '{'
    else if (kind === 'format') raw.format = 'deck'
    else if (kind === 'version') raw.version = 99
    else if (kind === 'size') json = ' '.repeat(backup.MAX_BACKUP_BYTES + 1)
    else if (kind === 'keyboard') raw.setup.keyboards[0].keys[0].w = 99
    else if (kind === 'gesture') raw.setup.settings.threeFinger.tap = { kind: 'system', name: 'madeUp' }
    else raw.setup.settings.pointerSpeed = 'fast'
    if (json === before) json = JSON.stringify(raw)
    expect(() => backup.readBackup(json)).toThrow()
    expect(backup.exportBackup(123)).toBe(before)
  })

  it('keeps newer preferences when restoring an older backup that lacks them', () => {
    const raw = JSON.parse(backup.exportBackup())
    delete raw.setup.settings.sidewaysTurn
    prefs.settings.sidewaysTurn = 'right'
    expect(backup.restoreBackup(backup.readBackup(JSON.stringify(raw)))).toBe(true)
    expect(prefs.settings.sidewaysTurn).toBe('right')
  })
})
