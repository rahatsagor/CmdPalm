// Deck editing helpers. Limits mirror core/src/deck.rs so the editor can
// explain a problem before the Mac rejects the save.

import { notify, onMessage, send, state } from './connection'
import type { Action, Deck, DeckPage, Tile } from './protocol'

export const LIMITS = { pages: 24, tiles: 64, label: 80, text: 4096, steps: 64, depth: 3, delayMs: 10_000 }

export function newId(prefix = 't'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `${prefix}-${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10)}`
}

const encoder = new TextEncoder()
/** The Mac limits text by its UTF-8 size. */
const tooLong = (text: string) => encoder.encode(text).length > LIMITS.text

/** Returns a problem with the action, or '' when it can be saved. */
export function actionProblem(action: Action, depth = 0): string {
  switch (action.kind) {
    case 'keys':
      return action.code < 0 || action.code > 0xff ? 'Pick a key.' : ''
    case 'text':
      if (!action.text) return 'Enter the text to type.'
      return tooLong(action.text) ? 'The text is too long.' : ''
    case 'shell':
      if (!action.command.trim()) return 'Enter a command.'
      return tooLong(action.command) ? 'The command is too long.' : ''
    case 'url':
      if (tooLong(action.url)) return 'The link is too long.'
      return /^[a-z][\w+.-]*:\S+/i.test(action.url.trim()) ? '' : 'Enter a full link, like https://example.com.'
    case 'app':
      return action.id ? '' : 'Choose an app.'
    case 'shortcut':
      return action.name.trim() ? '' : 'Enter the name of a shortcut from the Shortcuts app.'
    case 'delay':
      return action.ms >= 0 && action.ms <= LIMITS.delayMs ? '' : 'Waits are limited to 10 seconds.'
    case 'mouse':
      return (action.clicks ?? 1) >= 1 && (action.clicks ?? 1) <= 3 ? '' : 'Use one to three clicks.'
    case 'sequence': {
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
    case 'system':
      return ''
  }
}

/** Plain deep copy; reactive proxies cannot go through structuredClone. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** The last deck the Mac accepted, restored if a save is rejected. A copy,
 * because editing (dragging tiles) changes the shown deck in place. */
let confirmed: Deck | null = null
onMessage((message) => {
  if (message.t === 'welcome' || message.t === 'deck') confirmed = clone(message.deck)
  else if (message.t === 'notice' && message.code === 'deck' && confirmed) state.deck = clone(confirmed)
})

/** Returns whether the change went to the Mac. */
export function saveDeck(deck: Deck): boolean {
  if (send({ t: 'deckSave', deck: clone(deck) })) {
    // Show the change immediately; the Mac echoes the saved deck to every device.
    state.deck = clone(deck)
    return true
  }
  // While reconnecting, the change would be shown and then replaced by the
  // Mac's deck without a word.
  if (confirmed) state.deck = clone(confirmed)
  notify('Not connected to the Mac, so the deck wasn’t changed.', 'warning', 'deck')
  return false
}

export function newPage(name: string, columns = 4): DeckPage {
  return { id: newId('p'), name, columns, tiles: [] }
}

export function newTile(action: Action, label = ''): Tile {
  return { id: newId(), label, action }
}

/** Add a tile to the page the user last looked at. Returns the page name,
 * '' if it is full, or null if it couldn't be saved (already explained). */
export function addTileToCurrentPage(tile: Tile, pageId: string): string | null {
  if (!state.deck) return ''
  const deck = clone(state.deck)
  const page = deck.pages.find((p) => p.id === pageId) ?? deck.pages[0]
  if (!page || page.tiles.length >= LIMITS.tiles) return ''
  page.tiles.push(tile)
  return saveDeck(deck) ? page.name : null
}

export const COLORS = ['#ff8a3d', '#ff5f57', '#f5b942', '#3ecf8e', '#2ec4d6', '#4f8cff', '#8b6cff', '#e85fb5', '#8d949e']
