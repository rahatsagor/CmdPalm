<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import SettingsSheet from '@/components/SettingsSheet.vue'
import SideRail from '@/components/SideRail.vue'
import StatusBar from '@/components/StatusBar.vue'
import TabBar from '@/components/TabBar.vue'
import Toasts from '@/components/Toasts.vue'
import { connect, disconnect, state } from '@/lib/connection'
import { token } from '@/lib/device'
import { layout } from '@/lib/layout'
import { pairingLink } from '@/lib/pairing'
import { lazy } from '@/lib/reload'
import { settings } from '@/lib/settings'
import ConnectView from '@/views/ConnectView.vue'
import OfflineView from '@/views/OfflineView.vue'
import TrackpadView from '@/views/TrackpadView.vue'

// Less-used sections load on first visit to keep startup fast on phones.
const KeyboardView = lazy(() => import('@/views/KeyboardView.vue'))
const DeckView = lazy(() => import('@/views/DeckView.vue'))
const AppsView = lazy(() => import('@/views/AppsView.vue'))
const MediaView = lazy(() => import('@/views/MediaView.vue'))

const views = { trackpad: TrackpadView, keyboard: KeyboardView, deck: DeckView, apps: AppsView, media: MediaView }

const showSettings = ref(false)

/** Reconnecting for long enough that the Mac is probably asleep or off. */
const LOST_AFTER_MS = 6000
const lost = ref(false)
let lostTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => state.status,
  (status) => {
    if (status !== 'reconnecting') {
      clearTimeout(lostTimer)
      lostTimer = undefined
      lost.value = false
    } else if (!lostTimer && !lost.value) {
      lostTimer = setTimeout(() => {
        lostTimer = undefined
        lost.value = true
      }, LOST_AFTER_MS)
    }
  },
)

const welcomed = ref(false)
watch(
  () => state.status,
  (status) => {
    if (status === 'connected') welcomed.value = true
    else if (status === 'idle' || status === 'denied') welcomed.value = false
  },
)

const view = computed(() => {
  if (state.status === 'connected' || (state.status === 'reconnecting' && welcomed.value)) return 'shell'
  // Connecting with a saved token at launch: no need to show the pairing form.
  if ((state.status === 'connecting' || state.status === 'reconnecting') && token.get() && !state.denied) return 'splash'
  return 'connect'
})

const prefersLight = matchMedia('(prefers-color-scheme: light)')
const systemLight = ref(prefersLight.matches)
prefersLight.addEventListener('change', (e) => (systemLight.value = e.matches))

watchEffect(() => {
  const theme = settings.theme === 'system' ? (systemLight.value ? 'light' : 'dark') : settings.theme
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#eef0f3' : '#0a0b0d')
})

onMounted(() => {
  // A pairing link wins over a saved token: ConnectView pairs with its code.
  if (!pairingLink) connect()
})
</script>

<template>
  <div class="app flex flex-col overflow-hidden">
    <template v-if="view === 'shell'">
      <StatusBar v-if="!layout.compact" @settings="showSettings = true" />
      <div class="flex min-h-0 flex-1">
        <SideRail v-if="layout.compact" @settings="showSettings = true" />
        <main class="relative min-h-0 min-w-0 flex-1" :class="layout.compact ? 'main-compact' : 'safe-x'">
          <KeepAlive>
            <component :is="views[settings.tab]" :key="settings.tab" />
          </KeepAlive>
          <div
            v-if="state.paused"
            class="paused-veil absolute inset-0 z-10 grid place-items-center bg-bg/70 px-8 text-center backdrop-blur-sm"
            role="status"
          >
            <div>
              <div class="text-[17px] font-semibold">Paused on the Mac</div>
              <p class="mt-1 text-[14px] text-muted">Resume from the CmdPalm menu in the Mac’s menu bar.</p>
            </div>
          </div>
          <OfflineView v-if="lost" :patience="0" class="absolute inset-0 z-20" />
        </main>
      </div>
      <TabBar v-if="!layout.compact" />
      <SettingsSheet v-if="showSettings" @close="showSettings = false" />
    </template>

    <OfflineView v-else-if="view === 'splash'" class="safe-top safe-x min-h-0 flex-1" />

    <ConnectView v-else class="min-h-0 flex-1" />
    <Toasts />
  </div>
</template>

<style scoped>
.app {
  /* iOS 26+ draws a Liquid Glass blur over the top edge of home screen apps
     unless the content there sits in a full-width fixed container with an
     opaque background. */
  position: fixed;
  inset-inline: 0;
  top: 0;
  /* Tracks the visual viewport so the on-screen keyboard never covers inputs. */
  height: var(--app-height, 100dvh);
  background: var(--bg);
}
/* In landscape the veil reaches the top edge, where a translucent layer
   brings back the home screen app's edge blur. */
@media (display-mode: standalone) {
  .paused-veil {
    background: var(--bg);
    backdrop-filter: none;
  }
}
.main-compact {
  padding-right: env(safe-area-inset-right);
  padding-top: env(safe-area-inset-top);
  padding-bottom: max(calc(env(safe-area-inset-bottom) - 10px), 0px);
}
</style>
