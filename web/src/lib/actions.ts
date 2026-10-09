import { comboLabel, type LabelMap } from './keys'
import type { Action, MediaKey, SystemAction } from './protocol'

export interface Meta {
  label: string
  symbol: string
  group: string
}

export const SYSTEM: Record<SystemAction, Meta> = {
  missionControl: { label: 'Mission Control', symbol: 'layout-grid', group: 'Windows & Spaces' },
  appExpose: { label: 'App Windows', symbol: 'app-window', group: 'Windows & Spaces' },
  showDesktop: { label: 'Show Desktop', symbol: 'monitor', group: 'Windows & Spaces' },
  launchpad: { label: 'Apps', symbol: 'grid-2x2', group: 'Windows & Spaces' },
  spaceLeft: { label: 'Space Left', symbol: 'arrow-left-to-line', group: 'Windows & Spaces' },
  spaceRight: { label: 'Space Right', symbol: 'arrow-right-to-line', group: 'Windows & Spaces' },
  appSwitcher: { label: 'Previous App', symbol: 'repeat', group: 'Windows & Spaces' },
  fullscreen: { label: 'Full Screen', symbol: 'maximize', group: 'Windows & Spaces' },
  minimize: { label: 'Minimize', symbol: 'minimize', group: 'Windows & Spaces' },
  closeWindow: { label: 'Close Window', symbol: 'x', group: 'Windows & Spaces' },
  hideApp: { label: 'Hide App', symbol: 'eye-off', group: 'Windows & Spaces' },
  quitApp: { label: 'Quit App', symbol: 'power', group: 'Windows & Spaces' },
  spotlight: { label: 'Spotlight', symbol: 'search', group: 'System' },
  emojiPicker: { label: 'Emoji & Symbols', symbol: 'smile', group: 'System' },
  screenshot: { label: 'Screenshot', symbol: 'camera', group: 'System' },
  screenshotArea: { label: 'Screenshot Area', symbol: 'scan', group: 'System' },
  screenshotTool: { label: 'Screenshot Tool', symbol: 'aperture', group: 'System' },
  forceQuit: { label: 'Force Quit', symbol: 'octagon-x', group: 'System' },
  lockScreen: { label: 'Lock Screen', symbol: 'lock', group: 'System' },
  sleepDisplay: { label: 'Display Off', symbol: 'monitor-off', group: 'System' },
  sleep: { label: 'Sleep', symbol: 'moon', group: 'System' },
  undo: { label: 'Undo', symbol: 'undo', group: 'Editing' },
  redo: { label: 'Redo', symbol: 'redo', group: 'Editing' },
  copy: { label: 'Copy', symbol: 'copy', group: 'Editing' },
  cut: { label: 'Cut', symbol: 'scissors', group: 'Editing' },
  paste: { label: 'Paste', symbol: 'clipboard', group: 'Editing' },
  selectAll: { label: 'Select All', symbol: 'text-select', group: 'Editing' },
  find: { label: 'Find', symbol: 'search', group: 'Editing' },
  newTab: { label: 'New Tab', symbol: 'plus', group: 'Browsing' },
  closeTab: { label: 'Close Tab', symbol: 'x', group: 'Browsing' },
  nextTab: { label: 'Next Tab', symbol: 'chevron-right', group: 'Browsing' },
  previousTab: { label: 'Previous Tab', symbol: 'chevron-left', group: 'Browsing' },
  back: { label: 'Back', symbol: 'arrow-left', group: 'Browsing' },
  forward: { label: 'Forward', symbol: 'arrow-right', group: 'Browsing' },
  reload: { label: 'Reload', symbol: 'rotate-cw', group: 'Browsing' },
  zoomIn: { label: 'Zoom In', symbol: 'zoom-in', group: 'Browsing' },
  zoomOut: { label: 'Zoom Out', symbol: 'zoom-out', group: 'Browsing' },
  actualSize: { label: 'Actual Size', symbol: 'scan-search', group: 'Browsing' },
}

export const MEDIA: Record<MediaKey, Meta> = {
  playPause: { label: 'Play / Pause', symbol: 'play-pause', group: 'Media' },
  next: { label: 'Next Track', symbol: 'skip-forward', group: 'Media' },
  previous: { label: 'Previous Track', symbol: 'skip-back', group: 'Media' },
  fastForward: { label: 'Fast Forward', symbol: 'fast-forward', group: 'Media' },
  rewind: { label: 'Rewind', symbol: 'rewind', group: 'Media' },
  volumeUp: { label: 'Volume Up', symbol: 'volume-2', group: 'Sound & Display' },
  volumeDown: { label: 'Volume Down', symbol: 'volume-1', group: 'Sound & Display' },
  mute: { label: 'Mute', symbol: 'volume-x', group: 'Sound & Display' },
  brightnessUp: { label: 'Brightness Up', symbol: 'sun', group: 'Sound & Display' },
  brightnessDown: { label: 'Brightness Down', symbol: 'sun-dim', group: 'Sound & Display' },
  illuminationUp: { label: 'Backlight Up', symbol: 'lightbulb', group: 'Sound & Display' },
  illuminationDown: { label: 'Backlight Down', symbol: 'lightbulb-off', group: 'Sound & Display' },
  illuminationToggle: { label: 'Backlight On/Off', symbol: 'lightbulb', group: 'Sound & Display' },
}

export const ACTION_KINDS: { kind: Action['kind']; label: string; symbol: string; advanced?: boolean }[] = [
  { kind: 'keys', label: 'Keyboard shortcut', symbol: 'command' },
  { kind: 'system', label: 'Mac action', symbol: 'laptop' },
  { kind: 'media', label: 'Media & sound', symbol: 'music' },
  { kind: 'app', label: 'Open app', symbol: 'app-window' },
  { kind: 'text', label: 'Type text', symbol: 'type' },
  { kind: 'url', label: 'Open link', symbol: 'link' },
  { kind: 'shortcut', label: 'Run Shortcut', symbol: 'workflow', advanced: true },
  { kind: 'mouse', label: 'Mouse click', symbol: 'mouse-pointer-click', advanced: true },
  { kind: 'sequence', label: 'Sequence', symbol: 'list-ordered', advanced: true },
  { kind: 'delay', label: 'Wait', symbol: 'timer', advanced: true },
  { kind: 'shell', label: 'Shell command', symbol: 'square-terminal', advanced: true },
]

export function defaultAction(kind: Action['kind']): Action {
  switch (kind) {
    case 'keys':
      return { kind: 'keys', code: 0x08, mods: 1, char: 'c' }
    case 'system':
      return { kind: 'system', name: 'missionControl' }
    case 'media':
      return { kind: 'media', key: 'playPause' }
    case 'app':
      return { kind: 'app', id: '', op: 'toggle' }
    case 'text':
      return { kind: 'text', text: '', enter: false }
    case 'url':
      return { kind: 'url', url: 'https://' }
    case 'shortcut':
      return { kind: 'shortcut', name: '' }
    case 'mouse':
      return { kind: 'mouse', button: 'left', clicks: 1 }
    case 'sequence':
      return { kind: 'sequence', steps: [] }
    case 'delay':
      return { kind: 'delay', ms: 250 }
    case 'shell':
      return { kind: 'shell', command: '' }
  }
}

export function describe(action: Action | null, labels: LabelMap, apps?: Map<string, string>): string {
  if (!action) return 'Nothing'
  switch (action.kind) {
    case 'keys':
      return comboLabel(action.code, action.mods, labels)
    case 'system':
      return SYSTEM[action.name]?.label ?? action.name
    case 'media':
      return MEDIA[action.key]?.label ?? action.key
    case 'app':
      return `Open ${apps?.get(action.id) ?? (action.id.split('.').pop() || 'app')}`
    case 'text':
      return action.text ? `Type “${action.text.length > 18 ? `${action.text.slice(0, 18)}…` : action.text}”` : 'Type text'
    case 'url':
      return action.url.replace(/^https?:\/\//, '')
    case 'shortcut':
      return action.name ? `Shortcut “${action.name}”` : 'Run Shortcut'
    case 'mouse':
      return `${action.clicks && action.clicks > 1 ? (action.clicks === 2 ? 'Double' : 'Triple') : ''}${action.clicks && action.clicks > 1 ? '-' : ''}${action.button} click`
    case 'sequence':
      return `${action.steps.length} step${action.steps.length === 1 ? '' : 's'}`
    case 'delay':
      return `Wait ${action.ms} ms`
    case 'shell':
      return action.command ? `$ ${action.command}` : 'Shell command'
  }
}

export function actionSymbol(action: Action): string {
  switch (action.kind) {
    case 'system':
      return SYSTEM[action.name]?.symbol ?? 'laptop'
    case 'media':
      return MEDIA[action.key]?.symbol ?? 'music'
    default:
      return ACTION_KINDS.find((k) => k.kind === action.kind)?.symbol ?? 'zap'
  }
}
