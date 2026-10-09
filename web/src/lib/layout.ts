// Screen-shape decisions shared by the shell and the views.

import { reactive } from 'vue'

// A phone on its side: too short for a header, a bottom tab bar and a useful
// trackpad, so the chrome moves into a side rail.
const compactQuery = typeof matchMedia === 'function' ? matchMedia('(orientation: landscape) and (max-height: 500px)') : null

export const layout = reactive({
  compact: compactQuery?.matches ?? false,
})

compactQuery?.addEventListener('change', (event) => (layout.compact = event.matches))
