// How many columns a deck page shows on this screen.
//
// A page's column count is chosen on (and for) a phone held upright. Wider
// screens fit proportionally more columns, so buttons keep about the same
// size on a phone turned sideways or a tablet instead of growing to fill the
// width. The button size setting scales that per device.

/** Width of a deck page on a phone held upright, inside its padding. */
export const REFERENCE_WIDTH = 366
export const MAX_COLUMNS = 12
export const TILE_GAP = 10
/** Buttons narrower than this use the compact face. */
const COMPACT_TILE = 78

export function deckColumns(pageColumns: number, width: number, buttonSize: number): number {
  const scale = width > REFERENCE_WIDTH ? width / REFERENCE_WIDTH : 1
  const columns = Math.round((pageColumns * scale) / Math.max(buttonSize, 0.1))
  return Math.min(MAX_COLUMNS, Math.max(1, columns))
}

export function tileWidth(columns: number, width: number): number {
  return (width - TILE_GAP * (columns - 1)) / columns
}

export function compactTiles(columns: number, width: number): boolean {
  return tileWidth(columns, width) < COMPACT_TILE
}
