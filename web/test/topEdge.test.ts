// iOS 26+ blurs the top edge of home screen apps (Liquid Glass) unless the
// content there sits in a full-width fixed container with an opaque
// background. These guard the markup that keeps it sharp.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('top edge in home screen apps', () => {
  it('keeps the app root fixed, full width and opaque', () => {
    const app = read('../src/App.vue')
    const rule = /\.app\s*\{([^}]*)\}/.exec(app)?.[1] ?? ''
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).toMatch(/inset-inline:\s*0/)
    expect(rule).toMatch(/top:\s*0/)
    expect(rule).toMatch(/background:\s*var\(--bg\)/)
    expect(rule).toMatch(/height:\s*var\(--app-height/)
  })

  it('gives the edge-docked bars an opaque background', () => {
    expect(read('../src/components/StatusBar.vue')).toMatch(/<header class="[^"]*\bbg-bg\b(?!\/)/)
    expect(read('../src/components/TabBar.vue')).toMatch(/<nav class="[^"]*\bbg-bg\b(?!\/)/)
  })

  it('leaves the status bar style unset', () => {
    expect(read('../index.html')).not.toMatch(/<meta[^>]+apple-mobile-web-app-status-bar-style/)
  })
})
