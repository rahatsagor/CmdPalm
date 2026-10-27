// Live typing: turn each change in a text field into "delete N, insert S"
// against the end of the text, which is where the Mac's caret is.

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** User-perceived characters; one Delete key press removes one of these. */
export function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment)
  return Array.from(text)
}

/**
 * Undo the typographic quotes, dashes and ellipses that phone keyboards put
 * in as you type (Smart Punctuation on iPhone). A shell reads them as other
 * characters, so a quoted argument or an option like --help stops working.
 */
export function plainPunctuation(text: string): string {
  return text
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
}

/** A field the on-screen keyboard types into. */
export function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'range', 'submit', 'reset', 'color', 'file'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

export function diff(previous: string, next: string): { delete: number; insert: string } {
  const a = graphemes(previous)
  const b = graphemes(next)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return { delete: a.length - common, insert: b.slice(common).join('') }
}
