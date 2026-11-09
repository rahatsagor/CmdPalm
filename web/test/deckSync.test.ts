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
