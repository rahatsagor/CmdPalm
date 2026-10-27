import { describe, expect, it } from 'vitest'
import { plainPunctuation } from '../src/lib/text'

describe('plain punctuation for shell commands', () => {
  it('turns smart quotes, dashes and ellipses back into what was typed', () => {
    expect(plainPunctuation('say “hi” ; echo ‘a’ >> ~/log — done…')).toBe(`say "hi" ; echo 'a' >> ~/log -- done...`)
    expect(plainPunctuation('ls -la; echo "ok"')).toBe('ls -la; echo "ok"')
  })
})
