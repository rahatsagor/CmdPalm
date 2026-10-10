import { createApp } from 'vue'
import App from './App.vue'
import { installDisplayTracking } from './lib/display'
import { onMessage } from './lib/connection'
import { installHardwareKeyboard } from './lib/hardware'
import { checkHostVersion, installReloadOnStaleBuild } from './lib/reload'
import { installSettingsSync } from './lib/settingsSync'
import { installWakeLock } from './lib/wakeLock'
import './style.css'

function trackViewport() {
  const vv = window.visualViewport
  const update = () => {
    document.documentElement.style.setProperty('--app-height', `${Math.round(vv?.height ?? innerHeight)}px`)
    // iOS scrolls the page when the keyboard opens; keep the app pinned.
    if (vv && vv.offsetTop > 0) scrollTo(0, 0)
  }
  vv?.addEventListener('resize', update)
  vv?.addEventListener('scroll', update)
  addEventListener('resize', update)
  update()
}

// Safari ignores user-scalable=no; block its pinch-zoom so two-finger
// gestures always reach the trackpad.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
}
installReloadOnStaleBuild()
if (import.meta.env.PROD) {
  onMessage((message) => {
    if (message.t === 'welcome') checkHostVersion(message.host.version)
  })
}
trackViewport()
installDisplayTracking()
// Before mounting: App connects on mount, and the welcome may carry saved settings.
installSettingsSync()
createApp(App).mount('#app')
installWakeLock()
installHardwareKeyboard()

if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Self-signed certificates the phone does not trust cannot register workers.
    })
  })
}
