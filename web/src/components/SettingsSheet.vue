<script setup lang="ts">
import { ChevronRight, Copy, Download, Lock, LockOpen, LogOut, Maximize, Minimize, RotateCcw, Unplug } from '@lucide/vue'
import { computed, ref } from 'vue'
import { appNames } from '@/lib/apps'
import { describe } from '@/lib/actions'
import { disconnect, labels, state } from '@/lib/connection'
import { actionProblem, clone } from '@/lib/deck'
import { deviceModel } from '@/lib/device'
import { canFullscreen, display, install, installHint, toggleFullscreen } from '@/lib/display'
import { hapticsSupported } from '@/lib/haptics'
import type { Action } from '@/lib/protocol'
import { lazy } from '@/lib/reload'
import { resetSettings, settings, type GestureMap, type GestureSlot } from '@/lib/settings'
import { wakeLockSupported } from '@/lib/wakeLock'
import ActionEditor from './ActionEditor.vue'
import RangeRow from './RangeRow.vue'
import Segmented from './Segmented.vue'
import Sheet from './Sheet.vue'
import Toggle from './Toggle.vue'

const CopySettingsSheet = lazy(() => import('./CopySettingsSheet.vue'))

const emit = defineEmits<{ close: [] }>()

const secure = computed(() => location.protocol === 'https:')
const confirmForget = ref(false)
const confirmReset = ref(false)
const showCopy = ref(false)

const SLOTS: { slot: GestureSlot; label: string }[] = [
  { slot: 'up', label: 'Swipe up' },
  { slot: 'down', label: 'Swipe down' },
  { slot: 'left', label: 'Swipe left' },
  { slot: 'right', label: 'Swipe right' },
  { slot: 'tap', label: 'Tap' },
]

const gesture = ref<{ fingers: 3 | 4; slot: GestureSlot; label: string; draft: Action | null } | null>(null)
const gestureProblem = computed(() => (gesture.value?.draft ? actionProblem(gesture.value.draft) : ''))

function mapFor(fingers: 3 | 4): GestureMap {
  return fingers === 3 ? settings.threeFinger : settings.fourFinger
}

function editGesture(fingers: 3 | 4, slot: GestureSlot, label: string) {
  const current = mapFor(fingers)[slot]
  gesture.value = { fingers, slot, label, draft: current ? clone(current) : null }
}

function saveGesture() {
  const g = gesture.value
  if (!g || gestureProblem.value) return
  mapFor(g.fingers)[g.slot] = g.draft
  gesture.value = null
}

function forget() {
  disconnect(true)
  emit('close')
}

function reset() {
  resetSettings()
  confirmReset.value = false
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const times = (v: number) => `${v.toFixed(1)}×`
</script>

<template>
  <Sheet title="Settings" full @close="emit('close')">
    <section class="card">
      <div class="flex items-center gap-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="truncate text-[16px] font-semibold">{{ state.hostName || 'Mac' }}</div>
          <div class="text-[13px] text-muted">
            CmdPalm {{ state.hostVersion }} · {{ state.status === 'connected' ? `${state.latency || '<1'} ms` : 'offline' }}
          </div>
        </div>
        <span class="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium" :class="secure ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'">
          <Lock v-if="secure" :size="12" /><LockOpen v-else :size="12" />
          {{ secure ? 'Encrypted' : 'Not encrypted' }}
        </span>
      </div>
      <p v-if="!secure" class="pb-2 text-[13px] leading-snug text-muted">
        Others on this Wi-Fi could see what you type. To set up the encrypted connection, open CmdPalm’s settings on the Mac and
        choose <b>Phone Setup → Encrypted Connection</b>. Dictation and some phone features need it too.
      </p>
    </section>

    <Toggle v-model="settings.showAdvanced" label="Show advanced settings" class="px-1" />

    <h3 class="section">Trackpad</h3>
    <section class="card">
      <RangeRow v-model="settings.pointerSpeed" label="Pointer speed" :min="0.2" :max="4" :step="0.05" :format="times" />
      <RangeRow v-if="settings.showAdvanced" v-model="settings.pointerAcceleration" label="Acceleration" :min="0" :max="1" :format="pct" />
      <Toggle v-model="settings.tapToClick" label="Tap to click" />
      <Toggle v-model="settings.twoFingerTapRightClick" label="Two-finger tap to right-click" />
      <Toggle v-model="settings.clickButtons" label="Click buttons" hint="Buttons under the trackpad. Hold one and move another finger to drag." />
      <template v-if="settings.showAdvanced">
        <Segmented
          v-model="settings.longPress"
          label="Touch and hold"
          :options="[
            { value: 'drag', label: 'Drag' },
            { value: 'rightClick', label: 'Right-click' },
            { value: 'off', label: 'Nothing' },
          ]"
        />
        <Toggle v-model="settings.tapAndDrag" label="Tap, then drag" hint="Tap and quickly touch again to start a drag." />
        <Toggle v-model="settings.dragLock" label="Drag lock" hint="Drags continue after lifting your finger until you tap." />
        <Toggle v-model="settings.showTouches" label="Show touches" />
      </template>
    </section>

    <h3 class="section">Scrolling & zoom</h3>
    <section class="card">
      <RangeRow v-model="settings.scrollSpeed" label="Scroll speed" :min="0.2" :max="4" :step="0.05" :format="times" />
      <Toggle v-model="settings.naturalScroll" label="Natural scrolling" hint="Content moves with your fingers." />
      <Toggle v-model="settings.momentum" label="Momentum" hint="Keep scrolling after a flick." />
      <Toggle v-model="settings.pinchToZoom" label="Pinch to zoom" hint="Sends ⌘+ and ⌘−." />
      <Segmented
        v-if="settings.showAdvanced"
        v-model="settings.scrollRail"
        label="Scroll strip"
        :options="[
          { value: 'right', label: 'Right' },
          { value: 'left', label: 'Left' },
          { value: 'off', label: 'Off' },
        ]"
      />
    </section>

    <template v-if="settings.showAdvanced">
      <h3 class="section">Gestures</h3>
      <section v-for="fingers in [3, 4] as const" :key="fingers" class="card mb-3">
        <div class="pt-2 pb-1 text-[13px] font-medium text-muted">{{ fingers === 3 ? 'Three' : 'Four' }} fingers</div>
        <button
          v-for="s in SLOTS"
          :key="s.slot"
          type="button"
          class="flex min-h-11 w-full items-center gap-2 border-t border-line text-left first-of-type:border-t-0"
          @click="editGesture(fingers, s.slot, `${fingers === 3 ? 'Three' : 'Four'}-finger ${s.label.toLowerCase()}`)"
        >
          <span class="flex-1 text-[15px]">{{ s.label }}</span>
          <span class="max-w-[55%] truncate text-[14px] text-muted">{{ describe(mapFor(fingers)[s.slot], labels, appNames) }}</span>
          <ChevronRight :size="16" class="shrink-0 text-faint" />
        </button>
      </section>
    </template>

    <h3 class="section">Keyboard & typing</h3>
    <section class="card">
      <Segmented
        v-model="settings.keyboard"
        label="Keyboard"
        :options="[
          { value: 'auto', label: 'Automatic' },
          { value: 'mac', label: 'Mac' },
          { value: 'custom', label: 'Custom' },
          { value: 'phone', label: 'Type' },
        ]"
      />
      <Segmented
        v-model="settings.functionRow"
        label="Top row keys"
        :options="[
          { value: 'media', label: 'Media & brightness' },
          { value: 'function', label: 'F1 – F12' },
        ]"
      />
      <Toggle v-model="settings.keyRepeat" label="Key repeat" hint="Holding a key repeats it, using the Mac’s repeat speed." />
      <Toggle v-model="settings.liveTyping" label="Live typing" hint="Text appears on the Mac as you type, including autocorrect." />
      <Segmented
        v-if="settings.showAdvanced"
        v-model="settings.textMode"
        label="Send text as"
        :options="[
          { value: 'unicode', label: 'Characters' },
          { value: 'keystrokes', label: 'Key presses' },
          { value: 'paste', label: 'Paste' },
        ]"
      />
      <p v-if="settings.showAdvanced" class="pb-2 text-[13px] leading-snug text-muted">
        Characters works almost everywhere. Use Key presses for games and remote desktops, or Paste for very long text.
      </p>
    </section>

    <h3 class="section">This {{ deviceModel() }}</h3>
    <section class="card">
      <div v-if="!display.standalone" class="border-b border-line py-3">
        <p class="text-[13px] leading-snug text-muted">{{ installHint() }}</p>
        <div v-if="display.installable || canFullscreen()" class="mt-2 flex gap-2">
          <button v-if="display.installable" type="button" class="pill" @click="install"><Download :size="15" /> Install app</button>
          <button v-if="canFullscreen()" type="button" class="pill" @click="toggleFullscreen">
            <Minimize v-if="display.fullscreen" :size="15" /><Maximize v-else :size="15" />
            {{ display.fullscreen ? 'Exit full screen' : 'Full screen' }}
          </button>
        </div>
      </div>
      <label class="block py-2">
        <span class="text-[15px]">Name</span>
        <input
          v-model="settings.deviceName"
          :placeholder="deviceModel()"
          maxlength="40"
          class="mt-2 h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
        />
        <span class="mt-1 block text-[13px] text-muted">Shown on the Mac. Takes effect next time you connect.</span>
      </label>
      <Segmented
        v-model="settings.theme"
        label="Appearance"
        :options="[
          { value: 'system', label: 'Automatic' },
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ]"
      />
      <Toggle v-if="hapticsSupported" v-model="settings.haptics" label="Haptic feedback" />
      <Toggle
        v-model="settings.keepAwake"
        label="Keep screen on"
        :hint="wakeLockSupported ? 'While connected to the Mac.' : secure ? 'Not available in this browser.' : 'Needs the encrypted connection.'"
        :disabled="!wakeLockSupported"
      />
      <Toggle v-model="settings.rememberDevice" label="Remember this device" hint="Turn off on shared devices. Applies on the next connection." />
    </section>

    <section class="mt-5 flex flex-col gap-2">
      <button type="button" class="action" @click="showCopy = true"><Copy :size="17" /> Copy settings from another device</button>
      <button type="button" class="action" @click="((confirmReset = !confirmReset), (confirmForget = false))">
        <RotateCcw :size="17" /> Reset settings on this device
      </button>
      <button v-if="confirmReset" type="button" class="action bg-bad! text-white!" @click="reset">Reset all settings to defaults</button>
      <button type="button" class="action" @click="(disconnect(false), emit('close'))"><Unplug :size="17" /> Disconnect</button>
      <button type="button" class="action text-bad!" @click="((confirmForget = !confirmForget), (confirmReset = false))">
        <LogOut :size="17" /> Forget this Mac
      </button>
      <button v-if="confirmForget" type="button" class="action bg-bad! text-white!" @click="forget">Forget — you’ll need to pair again</button>
    </section>

    <p class="py-6 text-center text-[12px] text-faint">
      <a href="https://cmdpalm.app" target="_blank" rel="noopener" class="underline-offset-2 hover:underline">CmdPalm</a>
      is free and open source under the
      <a href="https://github.com/rahatsagor/CmdPalm/blob/main/LICENSE" target="_blank" rel="noopener" class="underline-offset-2 hover:underline">GNU AGPL v3</a>.
    </p>

    <CopySettingsSheet v-if="showCopy" @close="showCopy = false" />

    <Sheet v-if="gesture" :title="gesture.label" @close="gesture = null">
      <template #actions>
        <button
          type="button"
          class="h-8 rounded-full bg-accent px-4 text-[14px] font-semibold text-accent-text disabled:opacity-40"
          :disabled="!!gestureProblem"
          @click="saveGesture"
        >
          Save
        </button>
      </template>
      <Toggle
        :model-value="gesture.draft !== null"
        label="Enabled"
        @update:model-value="(on) => gesture && (gesture.draft = on ? { kind: 'system', name: 'missionControl' } : null)"
      />
      <ActionEditor v-if="gesture.draft" v-model="gesture.draft" class="mt-2" />
      <p v-if="gestureProblem" class="mt-2 text-[13px] text-bad">{{ gestureProblem }}</p>
    </Sheet>
  </Sheet>
</template>

<style scoped>
@reference '../style.css';
.section {
  @apply mt-5 mb-1.5 px-1 text-[13px] font-medium tracking-wide text-muted uppercase;
}
.card {
  @apply rounded-2xl bg-surface-2 px-4;
}
.action {
  @apply flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[15px] font-medium;
}
.pill {
  @apply flex h-9 items-center gap-1.5 rounded-full bg-surface-3 px-3.5 text-[14px] font-medium;
}
</style>
