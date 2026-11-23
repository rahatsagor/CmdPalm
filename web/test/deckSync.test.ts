import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, lastSocket, welcome } from './fakeSocket'
import type { Deck } from '../src/lib/protocol'

let conn: typeof import('../src/lib/connection')
let deckLib: typeof import('../src/lib/deck')
const initial: Deck = { version: 1, pages: [{ id: 'p', name: 'Original', columns: 4, tiles: [] }] }
const changed = (name: string): Deck => ({ version: 1, pages: [{ ...initial.pages[0]!, name }] })

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  FakeSocket.all = []
  localStorage.clear()
  localStorage.setItem('cmdpalm.token', 'saved')
  vi.resetModules()
  conn = await import('../src/lib/connection')
  deckLib = await import('../src/lib/deck')
  conn.connect()
  lastSocket().open()
  lastSocket().receive({ ...welcome, deck: initial, deckRevision: 0 })
})

afterEach(() => {
  conn.disconnect(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function accept(next: Deck, revision: number) {
  const socket = lastSocket()
  const request = socket.sent.filter((m) => m.t === 'deckSave').at(-1)!
  socket.receive({ t: 'deck', deck: next, revision })
  socket.receive({ t: 'deckSaved', id: request.id, ok: true, revision })
}

describe('confirmed Deck saves and history', () => {
  const deckOfSize = (bytes: number): Deck => {
    const make = (len: number, extra: number): Deck => ({ version: 1, pages: [{ ...initial.pages[0]!, tiles: Array.from({ length: 64 }, (_, i) => ({ id: `t${i}`, label: 'x', action: { kind: 'text' as const, text: 'a'.repeat(len + (i < extra ? 1 : 0)) } })) }] })
    const size = (deck: Deck) => new TextEncoder().encode(JSON.stringify(deck)).length
    const deficit = bytes - size(make(0, 0))
    return make(Math.floor(deficit / 64), deficit % 64)
  }

  describe('a deck saved before the size limit', () => {
    const page = (id: string): Deck['pages'][number] => ({ id, name: id, columns: 4, tiles: [{ id: `${id}-t`, label: 'x', action: { kind: 'text', text: 'a'.repeat(600_000) } }] })
    const legacy: Deck = { version: 1, pages: [page('a'), page('b'), page('c')] }
    const sentSaves = () => lastSocket().sent.filter((m) => m.t === 'deckSave')

    beforeEach(() => {
      lastSocket().receive({ ...welcome, deck: legacy, deckRevision: 4 })
    })

    it('can be trimmed on the phone until it fits, then saves once', async () => {
      expect(await deckLib.saveDeck({ ...legacy, pages: legacy.pages.slice(1) })).toBe(true)
      expect(sentSaves()).toHaveLength(0)
      expect(conn.state.deck?.pages.map((p) => p.id)).toEqual(['b', 'c'])
      expect(conn.state.notices.at(-1)).toMatchObject({ level: 'info' })
      expect(conn.state.notices.at(-1)?.message).toMatch(/^Not saved yet\. Remove about \d+ KB more/)

      const trimmed: Deck = { ...legacy, pages: [legacy.pages[2]!] }
      const saving = deckLib.saveDeck(trimmed)
      expect(sentSaves()).toHaveLength(1)
      expect(sentSaves()[0]).toMatchObject({ t: 'deckSave', revision: 4, deck: trimmed })
      accept(trimmed, 5)
      expect(await saving).toBe(true)
      expect(conn.state.deck).toEqual(trimmed)
    })

    it('refuses edits that do not shrink the draft and keeps the draft', async () => {
      await deckLib.saveDeck({ ...legacy, pages: legacy.pages.slice(1) })
      const draft = JSON.parse(JSON.stringify(conn.state.deck)) as Deck
      const renamed = { ...draft, pages: draft.pages.map((p, i) => (i === 0 ? { ...p, name: 'Renamed' } : p)) }
      expect(await deckLib.saveDeck(renamed)).toBe(false)
      expect(conn.state.deck).toEqual(draft)
      expect(conn.state.notices.at(-1)).toMatchObject({ level: 'warning' })
      expect(conn.state.notices.at(-1)?.message).toContain('too large to save')
      expect(sentSaves()).toHaveLength(0)
    })
  })

  it('refuses a deck over the size limit without sending it', async () => {
    const big = deckOfSize(deckLib.LIMITS.bytes + 1500)
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBe(deckLib.LIMITS.bytes + 1500)
    const sent = lastSocket().sent.length
    expect(await deckLib.saveDeck(big)).toBe(false)
    expect(lastSocket().sent.length).toBe(sent)
    expect(conn.state.notices.at(-1)?.message).toBe('This deck is too large to save: it’s 2 KB over the limit. Remove some buttons, or shorten long text and sequences.')
    expect(conn.state.deck).toEqual(initial)
  })

  it('sends a deck just under the size limit', () => {
    const deck = deckOfSize(deckLib.LIMITS.bytes)
    void deckLib.saveDeck(deck)
    expect(lastSocket().sent.at(-1)).toMatchObject({ t: 'deckSave' })
  })

  it('records icon edits when the Mac serializes object properties in a different order', async () => {
    const next: Deck = { version: 1, pages: [{ ...initial.pages[0]!, tiles: [{ id: 'tile', label: 'Example', action: { kind: 'media', key: 'mute' }, icon: { kind: 'symbol', name: 'volume-x' } }] }] }
    const saving = deckLib.saveDeck(next)
    const fromMac: Deck = { version: 1, pages: [{ ...initial.pages[0]!, tiles: [{ id: 'tile', label: 'Example', icon: { kind: 'symbol', name: 'volume-x' }, action: { kind: 'media', key: 'mute' } }] }] }
    accept(fromMac, 1)
    expect(await saving).toBe(true)
    expect(deckLib.deckHistory.undo).toBe(1)
    const undo = deckLib.undoDeck()
    accept(initial, 2)
    expect(await undo).toBe(true)
    expect(conn.state.deck).toEqual(initial)
  })

  it('waits for the matching persistence acknowledgement and sends the base revision', async () => {
    let settled = false
    const saving = deckLib.saveDeck(changed('Saved')).then((ok) => { settled = true; return ok })
    const socket = lastSocket()
    expect(socket.sent.at(-1)).toMatchObject({ t: 'deckSave', revision: 0 })
    socket.receive({ t: 'deck', deck: changed('Saved'), revision: 1 })
    socket.receive({ t: 'deckSaved', id: 999, ok: true, revision: 1 })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(deckLib.deckHistory.saving).toBe(true)
    socket.receive({ t: 'deckSaved', id: socket.sent.at(-1)!.id, ok: true, revision: 1 })
    expect(await saving).toBe(true)
    expect(deckLib.deckHistory.undo).toBe(1)
  })

  it('keeps the last accepted deck and history on a failed save', async () => {
    const saving = deckLib.saveDeck(changed('Rejected'))
    const socket = lastSocket()
    socket.receive({ t: 'deckSaved', id: socket.sent.at(-1)!.id, ok: false, revision: 0, message: 'Disk full.' })
    expect(await saving).toBe(false)
    expect(conn.state.deck).toEqual(initial)
    expect(deckLib.deckHistory.undo).toBe(0)
    expect(conn.state.notices.at(-1)?.message).toBe('Disk full.')
  })

  it('undoes and redoes only confirmed edits', async () => {
    const saving = deckLib.saveDeck(changed('Saved'))
    accept(changed('Saved'), 1)
    expect(await saving).toBe(true)
    const undo = deckLib.undoDeck()
    expect(lastSocket().sent.at(-1)).toMatchObject({ revision: 1, deck: initial })
    accept(initial, 2)
    expect(await undo).toBe(true)
    expect(deckLib.deckHistory).toMatchObject({ undo: 0, redo: 1, saving: false })
    const redo = deckLib.redoDeck()
    accept(changed('Saved'), 3)
    expect(await redo).toBe(true)
    expect(conn.state.deck).toEqual(changed('Saved'))
    expect(deckLib.deckHistory).toMatchObject({ undo: 1, redo: 0 })
  })

  it('never undoes another device’s later change', async () => {
    const saving = deckLib.saveDeck(changed('Mine'))
    accept(changed('Mine'), 1)
    await saving
    lastSocket().receive({ t: 'deck', deck: changed('Theirs'), revision: 2 })
    expect(await deckLib.undoDeck()).toBe(false)
    expect(conn.state.deck).toEqual(changed('Theirs'))
    expect(lastSocket().sent.filter((m) => m.t === 'deckSave')).toHaveLength(1)
  })

  it.each(['timeout', 'disconnect'] as const)('preserves the accepted deck on %s', async (reason) => {
    const saving = deckLib.saveDeck(changed('Unconfirmed'))
    if (reason === 'timeout') vi.advanceTimersByTime(8001)
    else lastSocket().drop()
    expect(await saving).toBe(false)
    expect(conn.state.deck).toEqual(initial)
    expect(deckLib.deckHistory.saving).toBe(false)
  })

  it('accepts an echoed save from an older Mac without revision support', async () => {
    lastSocket().receive({ ...welcome, deck: initial })
    const saving = deckLib.saveDeck(changed('Legacy'))
    lastSocket().receive({ t: 'deck', deck: changed('Legacy') })
    expect(await saving).toBe(true)
  })
})
