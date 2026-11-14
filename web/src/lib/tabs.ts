import { AppWindow, Keyboard, LayoutGrid, Monitor, Music, Touchpad } from '@lucide/vue'
import { haptic } from './haptics'
import { settings, type Tab } from './settings'

export const TABS: { id: Tab; label: string; icon: typeof Touchpad }[] = [
  { id: 'trackpad', label: 'Trackpad', icon: Touchpad },
  { id: 'keyboard', label: 'Keyboard', icon: Keyboard },
  { id: 'display', label: 'Display', icon: Monitor },
  { id: 'deck', label: 'Deck', icon: LayoutGrid },
  { id: 'apps', label: 'Apps', icon: AppWindow },
  { id: 'media', label: 'Media', icon: Music },
]

export function selectTab(id: Tab) {
  if (settings.tab === id) return
  settings.tab = id
  haptic('select')
}
