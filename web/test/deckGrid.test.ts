import { describe, expect, it } from 'vitest'
import { compactTiles, deckColumns, MAX_COLUMNS, REFERENCE_WIDTH } from '@/lib/deckGrid'

describe('deck columns', () => {
  it('uses the page’s columns on a phone held upright', () => {
    expect(deckColumns(4, REFERENCE_WIDTH, 1)).toBe(4)
    expect(deckColumns(4, 340, 1)).toBe(4)
    expect(deckColumns(6, 300, 1)).toBe(6)
  })

  it('fits more buttons of the same size on wider screens', () => {
    // A phone turned sideways and an iPad held upright.
    expect(deckColumns(4, 820, 1)).toBe(9)
    expect(deckColumns(4, 744, 1)).toBe(8)
  })

  it('lets the button size trade size for count', () => {
    expect(deckColumns(4, REFERENCE_WIDTH, 0.8)).toBe(5)
    expect(deckColumns(4, REFERENCE_WIDTH, 1.4)).toBe(3)
    expect(deckColumns(4, 820, 1.6)).toBe(6)
  })

  it('stays within limits', () => {
    expect(deckColumns(8, 2000, 0.5)).toBe(MAX_COLUMNS)
    expect(deckColumns(1, 200, 1.6)).toBe(1)
  })

  it('uses compact faces for narrow buttons', () => {
    expect(compactTiles(4, REFERENCE_WIDTH)).toBe(false)
    expect(compactTiles(5, REFERENCE_WIDTH)).toBe(true)
  })
})
