// Deck editing helpers. Limits mirror core/src/deck.rs so the editor can
// explain a problem before the Mac rejects the save.

import { reactive, watch } from 'vue'
import { notify, onMessage, send, state } from './connection'
import { MEDIA, SYSTEM } from './actions'
import { equalJson } from './value'
import type { Action, Deck, DeckPage, Tile } from './protocol'

export const LIMITS = { pages: 24, tiles: 64, label: 80, text: 4096, name: 512, steps: 64, depth: 3, delayMs: 10_000 }

export function newId(prefix = 't'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `${prefix}-${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10)}`
}

const encoder = new TextEncoder()
/** The Mac limits text by its UTF-8 size. */
const tooLong = (text: string, limit = LIMITS.text) => encoder.encode(text).length > limit

/** Returns a problem with the action, or '' when it can be saved. */
export function actionProblem(action: Action, depth = 0): string {
  if (!action || typeof action !== 'object') return 'Choose an action.'
  switch (action.kind) {
    case 'keys':
      if (!Number.isInteger(action.code) || action.code < 0 || action.code > 0xff) return 'Pick a key.'
      if (action.char !== undefined && (typeof action.char !== 'string' || tooLong(action.char, 16))) return 'Choose a valid shortcut character.'
      return !Number.isInteger(action.mods) || action.mods < 0 || action.mods > 0xffff || (action.mods & ~0x1f) !== 0 ? 'Choose valid modifiers.' : ''
    case 'text':
      if (typeof action.text !== 'string' || !action.text) return 'Enter the text to type.'
      if (action.enter !== undefined && typeof action.enter !== 'boolean') return 'Choose whether to press Return.'
      return tooLong(action.text) ? 'The text is too long.' : ''
    case 'shell':
      if (typeof action.command !== 'string' || !action.command.trim()) return 'Enter a command.'
      return tooLong(action.command) ? 'The command is too long.' : ''
    case 'url':
      if (typeof action.url !== 'string') return 'Enter a full link.'
      if (tooLong(action.url)) return 'The link is too long.'
      return /^[a-z][\w+.-]*:\S+/i.test(action.url.trim()) ? '' : 'Enter a full link, like https://example.com.'
    case 'app':
      return typeof action.id === 'string' && action.id && !tooLong(action.id, LIMITS.name) && (action.op === undefined || ['open', 'toggle', 'hide', 'quit'].includes(action.op)) ? '' : 'Choose an app.'
    case 'shortcut':
      if (typeof action.name !== 'string' || !action.name.trim()) return 'Enter the name of a shortcut from the Shortcuts app.'
      return tooLong(action.name, LIMITS.name) ? 'The shortcut name is too long.' : ''
    case 'delay':
      return Number.isInteger(action.ms) && action.ms >= 0 && action.ms <= LIMITS.delayMs ? '' : 'Waits are limited to 10 seconds.'
    case 'mouse':
      return ['left', 'right', 'middle', 'back', 'forward'].includes(action.button) && Number.isInteger(action.clicks ?? 1) && (action.clicks ?? 1) >= 1 && (action.clicks ?? 1) <= 3 ? '' : 'Use one to three clicks and a mouse button.'
    case 'sequence': {
      if (!Array.isArray(action.steps)) return 'Add at least one step.'
      if (depth >= LIMITS.depth - 1 && action.steps.some((s) => s.kind === 'sequence')) return 'Sequences can only be nested a few levels deep.'
      if (action.steps.length === 0) return 'Add at least one step.'
      if (action.steps.length > LIMITS.steps) return `Sequences are limited to ${LIMITS.steps} steps.`
      for (const [i, step] of action.steps.entries()) {
        const problem = actionProblem(step, depth + 1)
        if (problem) return `Step ${i + 1}: ${problem}`
      }
      return ''
    }
    case 'media':
      return Object.hasOwn(MEDIA, action.key) ? '' : 'Choose a media key.'
    case 'system':
      return Object.hasOwn(SYSTEM, action.name) ? '' : 'Choose a Mac action.'
    default:
      return 'Choose an action supported by this version of CmdPalm.'
  }
}

/** Plain deep copy; reactive proxies cannot go through structuredClone. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** The last deck the Mac accepted, restored if a save is rejected. A copy,
 * because editing (dragging tiles) changes the shown deck in place. */
let confirmed: Deck | null = state.deck ? clone(state.deck) : null
export const deckHistory = reactive({ saving: false, undo: 0, redo: 0 })
interface Edit { before: Deck; after: Deck }
const undo: Edit[] = []
const redo: Edit[] = []
let historyEpoch = 0
let nextSaveId = 0
let pending: {
  id: number
  next: Deck
  before: Deck
  record: boolean
  resolve: (saved: boolean) => void
  timer: ReturnType<typeof setTimeout>
} | null = null

function counts() {
  deckHistory.undo = undo.length
  deckHistory.redo = redo.length
}

function clearHistory() {
  undo.length = redo.length = 0
  historyEpoch++
  counts()
}

const same = (a: Deck | null, b: Deck) => equalJson(a, b)

function finishSave(ok: boolean, message?: string) {
  const saving = pending
  if (!saving) return
  pending = null
  clearTimeout(saving.timer)
  deckHistory.saving = false
  if (!ok) {
    if (confirmed && !same(confirmed, saving.before)) clearHistory()
    if (confirmed) state.deck = clone(confirmed)
    if (message) notify(message, 'warning', 'deck')
  } else if (saving.record && confirmed && same(confirmed, saving.next) && !same(saving.before, saving.next)) {
    undo.push({ before: saving.before, after: clone(saving.next) })
    redo.length = 0
    // Keep history useful without retaining unbounded snippet contents.
    while (undo.length > 20 || (undo.length > 1 && JSON.stringify(undo).length > 1024 * 1024)) undo.shift()
    counts()
  }
  saving.resolve(ok)
}

onMessage((message) => {
  if (message.t === 'welcome') {
    finishSave(false)
    confirmed = clone(message.deck)
    clearHistory()
  } else if (message.t === 'deck') {
    const ours = pending && same(pending.next, message.deck)
    if (!ours) clearHistory()
    confirmed = clone(message.deck)
    // Older Macs acknowledge a save by echoing the saved deck.
    if (ours && message.revision === undefined) finishSave(true)
  } else if (message.t === 'deckSaved' && message.id === pending?.id) {
    finishSave(message.ok, message.message)
  } else if (message.t === 'notice' && message.code === 'deck') {
    if (confirmed) state.deck = clone(confirmed)
    finishSave(false)
  }
})

watch(() => state.status, (status) => {
  if (status !== 'connected') finishSave(false, 'Lost the connection. Your edit is still here; reconnect and save again.')
}, { flush: 'sync' })

/** Resolve only after the Mac accepted the change, keeping drafts on failure. */
export function saveDeck(deck: Deck, record = true): Promise<boolean> {
  if (pending) {
    notify('Wait for the current Deck change to finish.', 'info', 'deck')
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const id = ++nextSaveId
    pending = {
      id, next: clone(deck), before: clone(confirmed ?? deck), record, resolve,
      timer: setTimeout(() => finishSave(false, 'The Mac hasn’t confirmed this change. Your edit is still here; try saving again.'), 8000),
    }
    deckHistory.saving = true
    if (!send({ t: 'deckSave', deck: clone(deck), id, ...(state.deckRevision !== undefined ? { revision: state.deckRevision } : {}) })) {
      finishSave(false, 'Not connected to the Mac, so the deck wasn’t changed.')
    }
  })
}

export async function undoDeck(): Promise<boolean> {
  const edit = undo.at(-1)
  if (!edit || deckHistory.saving) return false
  const epoch = historyEpoch
  if (!(await saveDeck(edit.before, false))) return false
  if (epoch === historyEpoch) { undo.pop(); redo.push(edit); counts() }
  return true
}

export async function redoDeck(): Promise<boolean> {
  const edit = redo.at(-1)
  if (!edit || deckHistory.saving) return false
  const epoch = historyEpoch
  if (!(await saveDeck(edit.after, false))) return false
  if (epoch === historyEpoch) { redo.pop(); undo.push(edit); counts() }
  return true
}

export function newPage(name: string, columns = 4): DeckPage {
  return { id: newId('p'), name, columns, tiles: [] }
}

export function newTile(action: Action, label = ''): Tile {
  return { id: newId(), label, action }
}

/** Add a tile to the page the user last looked at. Returns the page name,
 * '' if it is full, or null if it couldn't be saved (already explained). */
export async function addTileToCurrentPage(tile: Tile, pageId: string): Promise<string | null> {
  if (!state.deck) return ''
  const deck = clone(state.deck)
  const page = deck.pages.find((p) => p.id === pageId) ?? deck.pages[0]
  if (!page || page.tiles.length >= LIMITS.tiles) return ''
  page.tiles.push(tile)
  return (await saveDeck(deck)) ? page.name : null
}

export const COLORS = ['#ff8a3d', '#ff5f57', '#f5b942', '#3ecf8e', '#2ec4d6', '#4f8cff', '#8b6cff', '#e85fb5', '#8d949e']
