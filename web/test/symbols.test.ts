import { Zap, Star } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import { actionSymbol, describe as describeAction } from '@/lib/actions'
import { LabelMap } from '@/lib/keys'
import type { Action } from '@/lib/protocol'
import { symbol } from '@/lib/symbols'

describe('symbol', () => {
  it('falls back to the default icon for prototype keys', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) expect(symbol(name)).toBe(Zap)
  })
  it('resolves real names and falls back for unknown or missing ones', () => {
    expect(symbol('star')).toBe(Star)
    expect(symbol('nope')).toBe(Zap)
    expect(symbol(undefined)).toBe(Zap)
  })
})

describe('action labels', () => {
  it('ignore prototype keys a deck names', () => {
    const labels = new LabelMap()
    const action = (value: object) => value as unknown as Action
    expect(describeAction(action({ kind: 'app', id: 'com.apple.Safari', op: 'constructor' }), labels)).toBe('Show or hide Safari')
    expect(describeAction(action({ kind: 'mouse', button: 'constructor' }), labels)).toBe('Constructor click')
    expect(describeAction(action({ kind: 'system', name: 'toString' }), labels)).toBe('toString')
    expect(actionSymbol(action({ kind: 'media', key: 'valueOf' }))).toBe('music')
  })
})
