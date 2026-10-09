// Running as a home screen app, full screen, or in a browser tab, and how to
// get out of the tab on each platform.

import { reactive } from 'vue'
import { deviceModel } from './device'

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const standaloneQuery = typeof matchMedia === 'function' ? matchMedia('(display-mode: standalone), (display-mode: fullscreen)') : null

export const display = reactive({
  standalone: standaloneQuery?.matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  fullscreen: false,
  /** The browser offered to install the app (Chromium, over HTTPS only). */
  installable: false,
})

let installPrompt: InstallPrompt | null = null

export function installDisplayTracking() {
  standaloneQuery?.addEventListener('change', (event) => (display.standalone = event.matches))
  document.addEventListener('fullscreenchange', () => (display.fullscreen = document.fullscreenElement !== null))
  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt = event as InstallPrompt
    display.installable = true
  })
  addEventListener('appinstalled', () => {
    installPrompt = null
    display.installable = false
  })
}

/** Browsers that can hide their own bars for a page (Android, desktop; not iPhone). */
export const canFullscreen = () => typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
  } catch {
    // Refused (not from a tap, or blocked by the browser): nothing to undo.
  }
}

export async function install() {
  const prompt = installPrompt
  if (!prompt) return
  installPrompt = null
  display.installable = false
  await prompt.prompt().catch(() => {})
}

/** How to add CmdPalm to the home screen in this browser. */
export function installHint(): string {
  const model = deviceModel()
  const ua = navigator.userAgent
  if (model === 'iPhone' || model === 'iPad' || model === 'iPod touch') {
    return 'Tap Share, then Add to Home Screen, to open CmdPalm full screen like an app.'
  }
  if (model.startsWith('Android')) {
    // Android browsers install web apps only over HTTPS; over plain HTTP they
    // offer a shortcut that opens in a browser tab.
    if (!isSecureContext) {
      return 'To install CmdPalm as an app, use an encrypted connection: on the Mac, open CmdPalm Settings → Phone Setup → Encrypted Connection. Otherwise, add a shortcut (menu ⋮ → Add to Home screen) and use Full screen.'
    }
    if (display.installable) return 'Install CmdPalm to open it full screen like an app.'
    if (/SamsungBrowser/.test(ua)) return 'Open the menu ☰, then Add page to → Home screen.'
    if (/Firefox/.test(ua)) return 'Open the menu ⋮, then Add to Home screen.'
    return 'Open the browser menu ⋮, then Add to Home screen → Install.'
  }
  if (display.installable) return 'Install CmdPalm to open it in its own window.'
  return 'Use your browser’s Install or Add to Home Screen option to open CmdPalm in its own window.'
}
