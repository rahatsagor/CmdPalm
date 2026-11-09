import { LIMITS, sanitizeBoard, type CustomKeyboard } from './customKeyboards'
import { buildPayload, MAX_BYTES, replaceSynced, validAction, type SyncedSettings } from './settingsSync'
import { migrate, type GestureMap } from './settings'
import { equalJson } from './value'

export const MAX_BACKUP_BYTES = MAX_BYTES + 4096
const FORMAT = 'cmdpalm-device'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export interface DeviceBackup {
  format: typeof FORMAT
  version: 1
  exportedAt: number
  setup: SyncedSettings
}

/** Pairing tokens, device identity and the shared Mac deck never enter this file. */
export function exportBackup(now = Date.now()): string {
  const backup: DeviceBackup = { format: FORMAT, version: 1, exportedAt: now, setup: buildPayload() }
  const json = JSON.stringify(backup)
  if (new TextEncoder().encode(json).length > MAX_BACKUP_BYTES) throw new Error('This setup is too large to export. Remove unused keyboards and try again.')
  readBackup(json)
  return json
}

/** Reject damaged files before changing any settings or keyboards. */
export function readBackup(json: string): DeviceBackup {
  if (new TextEncoder().encode(json).length > MAX_BACKUP_BYTES) throw new Error('This backup is too large to open.')
  let raw: unknown
  try { raw = JSON.parse(json) } catch { throw new Error('This file isn’t a readable JSON backup.') }
  if (!record(raw) || raw.format !== FORMAT || raw.version !== 1 || !record(raw.setup) || raw.setup.version !== 1 || !record(raw.setup.settings)) {
    throw new Error('Choose a CmdPalm device backup. Deck files are imported from Settings → Deck on the Mac.')
  }
  const boards = raw.setup.keyboards
  if (!Array.isArray(boards) || !boards.length || boards.length > LIMITS.boards) throw new Error('This backup contains an invalid keyboard list.')
  const seen = new Set<string>()
  const keyboards: CustomKeyboard[] = boards.map((rawBoard) => {
    const board = sanitizeBoard(rawBoard)
    if (!record(rawBoard) || typeof rawBoard.id !== 'string' || !rawBoard.id || rawBoard.id.length > 32 || !Array.isArray(rawBoard.keys) || !board || board.keys.length !== rawBoard.keys.length || new Set(board.keys.map((key) => key.id)).size !== board.keys.length || seen.has(board.id)) {
      throw new Error('A keyboard in this backup is damaged. Your current setup hasn’t changed.')
    }
    seen.add(board.id)
    return board
  })
  const incoming = migrate(raw.setup.settings)
  const prefs = buildPayload().settings
  for (const key of Object.keys(prefs) as (keyof typeof prefs)[]) {
    if (!Object.hasOwn(raw.setup.settings, key)) continue
    const value = raw.setup.settings[key]
    if (!equalJson(value, incoming[key])) throw new Error('This backup contains an invalid setting. Your current setup hasn’t changed.')
    if (key === 'threeFinger' || key === 'fourFinger') {
      for (const action of Object.values(value as GestureMap)) {
        if (action !== null && !validAction(action)) throw new Error('This backup contains an invalid gesture action.')
      }
    }
    ;(prefs as unknown as Record<string, unknown>)[key] = incoming[key]
  }
  const setup: SyncedSettings = { version: 1, settings: prefs, keyboards }
  if (new TextEncoder().encode(JSON.stringify(setup)).length > MAX_BYTES) throw new Error('This setup is too large to restore.')
  return { format: FORMAT, version: 1, exportedAt: typeof raw.exportedAt === 'number' && Number.isFinite(raw.exportedAt) ? raw.exportedAt : 0, setup }
}

export function restoreBackup(backup: DeviceBackup): boolean {
  // Validate again rather than trusting a preview object a caller could edit.
  return replaceSynced(readBackup(JSON.stringify(backup)).setup)
}
