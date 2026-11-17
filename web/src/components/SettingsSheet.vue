<script setup lang="ts">
import {
  ChevronRight,
  Copy,
  Download,
  Hand,
  Keyboard,
  LayoutGrid,
  LogOut,
  Maximize,
  Minimize,
  Monitor,
  RotateCcw,
  Touchpad,
  Unplug,
  Wifi,
} from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import { appNames } from '@/lib/apps'
import { describe } from '@/lib/actions'
import { disconnect, labels, notify, state } from '@/lib/connection'
import { actionProblem, clone } from '@/lib/deck'
import { deviceModel } from '@/lib/device'
import { canFullscreen, display, install, installHint, toggleFullscreen } from '@/lib/display'
import { hapticsSupported, switchOnly } from '@/lib/haptics'
import type { Action } from '@/lib/protocol'
import { lazy } from '@/lib/reload'
import { screen, startViewing } from '@/lib/screen'
import { DECK_SIZE, resetSettings, settings, type GestureMap, type GestureSlot, type Settings } from '@/lib/settings'
import { wakeLockSupported } from '@/lib/wakeLock'
import ActionEditor from './ActionEditor.vue'
import DisplayPreferences from './DisplayPreferences.vue'
import RangeRow from './RangeRow.vue'
import Segmented from './Segmented.vue'
import Sheet from './Sheet.vue'
import Toggle from './Toggle.vue'

const CopySettingsSheet = lazy(() => import('./CopySettingsSheet.vue'))
const BackupSheet = lazy(() => import('./BackupSheet.vue'))
const emit = defineEmits<{ close: [] }>()
const secure = computed(() => location.protocol === 'https:')
const confirmForget = ref(false)
const confirmReset = ref(false)
const showCopy = ref(false)
const showBackup = ref(false)
const sheet = ref<InstanceType<typeof Sheet>>()
const features = [
  { id: 'trackpad', label: 'Trackpad', icon: Touchpad },
  { id: 'gestures', label: 'Gestures', icon: Hand },
  { id: 'keyboard', label: 'Keyboard', icon: Keyboard },
  { id: 'display', label: 'Display', icon: Monitor },
  { id: 'deck', label: 'Deck', icon: LayoutGrid },
] as const
type Feature = (typeof features)[number]['id']
const feature = ref<Feature>(features.some((item) => item.id === settings.tab) ? (settings.tab as Feature) : 'trackpad')
const gestureFingers = ref<'3' | '4'>('3')
const fingers = computed(() => (gestureFingers.value === '3' ? 3 : 4))

async function selectFeature(id: Feature) {
  feature.value = id
  confirmForget.value = false
  confirmReset.value = false
  await nextTick()
  sheet.value?.resetScroll()
}
function featureKey(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  let next: number
  if (event.key === 'ArrowRight') next = (index + 1) % features.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + features.length) % features.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = features.length - 1
  else return
  event.preventDefault()
  void selectFeature(features[next]!.id)
  const tabs = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  tabs?.[next]?.focus()
}
function quality(value: Settings['displayQuality']) {
  const resume = screen.active && (screen.status === 'connecting' || screen.status === 'live') && value !== settings.displayQuality
  settings.displayQuality = value
  if (resume) void startViewing()
}

const SLOTS: { slot: GestureSlot; label: string }[] = [
  { slot: 'up', label: 'Swipe up' },
  { slot: 'down', label: 'Swipe down' },
  { slot: 'left', label: 'Swipe left' },
  { slot: 'right', label: 'Swipe right' },
  { slot: 'tap', label: 'Tap' },
  { slot: 'pinchIn', label: 'Pinch together' },
  { slot: 'pinchOut', label: 'Spread apart' },
]
const gesture = ref<{ fingers: 3 | 4; slot: GestureSlot; label: string; draft: Action | null } | null>(null)
const gestureProblem = computed(() => (gesture.value?.draft ? actionProblem(gesture.value.draft) : ''))
function mapFor(count: 3 | 4): GestureMap {
  return count === 3 ? settings.threeFinger : settings.fourFinger
}
function editGesture(count: 3 | 4, slot: GestureSlot, label: string) {
  const current = mapFor(count)[slot]
  gesture.value = { fingers: count, slot, label, draft: current ? clone(current) : null }
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
  notify('Settings reset to defaults.')
}
const pct = (v: number) => `${Math.round(v * 100)}%`
const times = (v: number) => `${v.toFixed(1)}×`
</script>

<template>
  <Sheet ref="sheet" title="Settings" full @close="emit('close')">
    <section class="card">
      <div class="flex items-center gap-3 py-3">
        <div class="min-w-0 flex-1">
          <div class="truncate text-[16px] font-semibold">{{ state.hostName || 'Mac' }}</div>
          <div class="text-[13px] text-muted">
            CmdPalm {{ state.hostVersion }} · {{ state.status === 'connected' ? `${state.latency || '<1'} ms` : 'offline' }}
          </div>
        </div>
        <span class="flex shrink-0 items-center gap-1 rounded-full bg-surface-3 px-2.5 py-1 text-[12px] font-medium text-muted">
          <Wifi :size="12" />
          {{ state.status === 'connected' ? 'Connected' : 'Reconnecting…' }}
        </span>
      </div>
    </section>

    <div>
      <div class="sticky top-0 z-10 -mx-1 mt-3 bg-surface px-1 py-2">
        <div class="grid grid-cols-5 rounded-2xl bg-surface-2 p-1" role="tablist" aria-label="Feature settings">
          <button
            v-for="(item, index) in features"
            :id="`settings-tab-${item.id}`"
            :key="item.id"
            type="button"
            role="tab"
            :aria-selected="feature === item.id"
            aria-controls="settings-feature-panel"
            :tabindex="feature === item.id ? 0 : -1"
            class="flex min-h-13 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-2 text-[11px] font-medium transition-colors"
            :class="feature === item.id ? 'bg-surface text-text shadow-sm' : 'text-muted'"
            @click="selectFeature(item.id)"
            @keydown="featureKey($event, index)"
          >
            <component :is="item.icon" :size="18" :class="feature === item.id && 'text-accent'" aria-hidden="true" />
            {{ item.label }}
          </button>
        </div>
      </div>
      <p class="mb-3 mt-1 text-center text-[12px] text-muted">Changes save automatically on this device.</p>
      <section id="settings-feature-panel" role="tabpanel" :aria-labelledby="`settings-tab-${feature}`">
        <template v-if="feature === 'trackpad'">
          <h3 class="section mt-0!">Point & click</h3>
          <section class="card">
            <RangeRow v-model="settings.pointerSpeed" label="Pointer speed" :min="0.2" :max="4" :step="0.05" :format="times" />
            <Toggle v-model="settings.tapToClick" label="Tap to click" />
            <Toggle v-model="settings.twoFingerTapRightClick" label="Two-finger tap to right-click" />
            <Toggle
              v-model="settings.clickButtons"
              label="Show click buttons"
              hint="Click and Right-click buttons under the trackpad. Hold one and move another finger to drag."
            />
          </section>
          <h3 class="section">Pointer & dragging</h3>
          <section class="card">
            <RangeRow v-model="settings.pointerAcceleration" label="Acceleration" :min="0" :max="1" :format="pct" />
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
          </section>
          <h3 class="section">Scrolling</h3>
          <section class="card">
            <RangeRow v-model="settings.scrollSpeed" label="Scroll speed" :min="0.2" :max="4" :step="0.05" :format="times" />
            <Toggle v-model="settings.naturalScroll" label="Natural scrolling" hint="Content moves with your fingers." />
            <Toggle v-model="settings.momentum" label="Momentum" hint="Keep scrolling after a flick." />
            <Segmented
              v-model="settings.scrollStrip"
              label="Scroll strip"
              :options="[
                { value: 'short', label: 'Short' },
                { value: 'long', label: 'Long' },
                { value: 'off', label: 'Hide' },
              ]"
            />
          </section>
          <template v-if="settings.scrollStrip !== 'off'">
            <h3 class="section">Scroll strip options</h3>
            <section class="card">
              <Segmented
                v-model="settings.scrollStripWidth"
                label="Width"
                :options="[
                  { value: 'normal', label: 'Normal' },
                  { value: 'wide', label: 'Wide' },
                  { value: 'wider', label: 'Extra wide' },
                ]"
              />
              <Segmented
                v-model="settings.scrollStripSide"
                label="Side"
                :options="[
                  { value: 'right', label: 'Right' },
                  { value: 'left', label: 'Left' },
                ]"
              />
              <Toggle
                v-model="settings.scrollStripEdge"
                label="At the screen edge"
                hint="Slide a finger along the side of the phone, or its case, to scroll without looking."
              />
              <Toggle
                v-if="settings.scrollStrip === 'short'"
                v-model="settings.scrollHold"
                label="Hold to keep scrolling"
                hint="Drag the scroll strip’s handle to the top or bottom and hold it there."
              />
            </section>
          </template>
        </template>

        <template v-else-if="feature === 'gestures'">
          <h3 class="section">Two fingers</h3>
          <section class="card">
            <Toggle
              v-model="settings.pinchToZoom"
              label="Pinch to zoom"
              :hint="settings.pinchStyle === 'keys' ? 'Sends ⌘+ and ⌘−.' : 'Zooms photos, maps, PDFs and web pages smoothly.'"
            />
            <Toggle v-model="settings.rotateGesture" label="Rotate" hint="Turn two fingers to rotate photos, maps and PDFs." />
            <Toggle
              v-model="settings.smartZoom"
              label="Smart zoom"
              hint="Double-tap with two fingers to zoom in on a web page or PDF, and again to zoom back out. Right-clicks wait a moment longer."
            />
          </section>
          <template v-if="settings.pinchToZoom">
            <h3 class="section">Zoom method</h3>
            <section class="card">
              <Segmented
                v-model="settings.pinchStyle"
                label="Pinching"
                :options="[
                  { value: 'smooth', label: 'Smooth zoom' },
                  { value: 'keys', label: '⌘+ and ⌘− keys' },
                ]"
              />
            </section>
          </template>
          <h3 class="section">Three & four fingers</h3>
          <section class="card">
            <Toggle
              v-model="settings.threeFingerDrag"
              label="Three-finger drag"
              hint="Move three fingers to drag windows and select text. This replaces three-finger swipes; four-finger gestures still work."
            />
          </section>
          <Segmented
            v-model="gestureFingers"
            aria-label="Customize gestures for"
            :options="[
              { value: '3', label: 'Three fingers' },
              { value: '4', label: 'Four fingers' },
            ]"
            class="mt-3"
          />
          <p class="mb-3 text-[13px] text-muted">Tap an action to change it or turn it off.</p>
          <p v-if="fingers === 3 && settings.threeFingerDrag" class="mb-3 text-[13px] leading-snug text-warn">
            Three-finger drag is on. Turn it off above to use three-finger swipe actions.
          </p>
          <section class="card">
            <button
              v-for="s in SLOTS"
              :key="s.slot"
              type="button"
              class="flex min-h-13 w-full items-center gap-2 border-t border-line py-2 text-left first:border-t-0"
              @click="editGesture(fingers, s.slot, `${fingers === 3 ? 'Three' : 'Four'}-finger ${s.label.toLowerCase()}`)"
            >
              <span class="flex-1 text-[15px]">{{ s.label }}</span>
              <span class="max-w-[55%] text-right text-[13px] leading-snug text-muted">
                {{ describe(mapFor(fingers)[s.slot], labels, appNames) }}
              </span>
              <ChevronRight :size="16" class="shrink-0 text-muted" aria-hidden="true" />
            </button>
          </section>
        </template>

        <template v-else-if="feature === 'keyboard'">
          <h3 class="section">Keyboard layout</h3>
          <section class="card">
            <Segmented
              v-model="settings.keyboard"
              label="Keyboard"
              :options="[
                { value: 'auto', label: 'Auto' },
                { value: 'mac', label: 'Mac' },
                { value: 'custom', label: 'Custom' },
                { value: 'phone', label: 'Type' },
              ]"
            />
            <p class="pb-2 text-[13px] leading-snug text-muted">
              Auto uses the phone keyboard on small screens and the Mac layout where it fits. Create your own layouts in Keyboard → Custom.
            </p>
            <Segmented
              v-model="settings.functionRow"
              label="Top row keys"
              :options="[
                { value: 'media', label: 'Media & brightness' },
                { value: 'function', label: 'F1 – F12' },
              ]"
            />
            <Toggle
              v-model="settings.sidewaysKeyboard"
              label="Sideways keyboard"
              hint="Fill an upright phone’s screen with the Mac keyboard turned on its side, even with rotation locked."
            />
            <Segmented
              v-if="settings.sidewaysKeyboard"
              v-model="settings.sidewaysTurn"
              label="Turn the phone"
              :options="[
                { value: 'left', label: 'To the left' },
                { value: 'right', label: 'To the right' },
              ]"
            />
            <Toggle v-model="settings.keyRepeat" label="Key repeat" hint="Holding a key repeats it, using the Mac’s repeat speed." />
          </section>
          <h3 class="section">Typing</h3>
          <section class="card">
            <Toggle
              v-model="settings.liveTyping"
              label="Live typing"
              hint="Text appears on the Mac as you type, including autocorrect. Turn off to compose text before sending."
            />
          </section>
          <h3 class="section">Dictation setup</h3>
          <section class="card py-3">
            <p class="text-[13px] leading-relaxed text-muted">
              Use the microphone in the typing panel to dictate. Set it up on your Mac in CmdPalm Settings → Phone Setup → Encrypted Connection.
            </p>
          </section>
          <h3 class="section">Text compatibility</h3>
          <section class="card">
            <Segmented
              v-model="settings.textMode"
              label="Send text as"
              :options="[
                { value: 'unicode', label: 'Characters' },
                { value: 'keystrokes', label: 'Key presses' },
                { value: 'paste', label: 'Paste' },
              ]"
            />
            <p class="pb-3 text-[13px] leading-snug text-muted">
              Characters works almost everywhere. Use Key presses for games and remote desktops, or Paste for very long text.
            </p>
          </section>
        </template>

        <template v-else-if="feature === 'display'">
          <p class="intro">Choose how to view your Mac screen. Start viewing and choose a monitor in the Display tab.</p>
          <DisplayPreferences @quality="quality" />
        </template>

        <template v-else-if="feature === 'deck'">
          <p class="intro">Make shortcut buttons comfortable to tap on this device.</p>
          <section class="card">
            <RangeRow v-model="settings.deckButtonSize" label="Button size" :min="DECK_SIZE.min" :max="DECK_SIZE.max" :step="0.1" :format="pct" />
            <p class="pb-3 text-[13px] leading-snug text-muted">
              Smaller buttons fit more on a page. Wider screens, like a phone turned sideways, show more columns.
            </p>
          </section>
          <p class="mt-4 text-[13px] leading-relaxed text-muted">
            To add or arrange shortcuts, open Deck and tap Edit. Deck pages are shared across devices paired with this Mac; button size is set
            separately here.
          </p>
        </template>
      </section>
    </div>
    <h3 class="section">This {{ deviceModel() }}</h3>
    <section class="card">
      <div v-if="!display.standalone" class="border-b border-line py-3">
        <p class="text-[13px] leading-snug text-muted">{{ installHint() }}</p>
        <div v-if="display.installable || canFullscreen()" class="mt-2 flex flex-wrap gap-2">
          <button v-if="display.installable" type="button" class="pill" @click="install">
            <Download :size="15" />
            Install app
          </button>
          <button v-if="canFullscreen()" type="button" class="pill" @click="toggleFullscreen">
            <Minimize v-if="display.fullscreen" :size="15" />
            <Maximize v-else :size="15" />
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
          autocomplete="off"
          aria-label="Name shown on the Mac"
          class="mt-2 h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[16px] outline-none focus:border-accent"
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
      <template v-if="hapticsSupported">
        <Toggle
          v-model="settings.haptics"
          label="Haptic feedback"
          :hint="switchOnly ? 'iPhone plays haptics when you tap, not while you swipe or hold.' : undefined"
        />
        <Toggle
          v-if="settings.haptics"
          v-model="settings.keyHaptics"
          label="Key press haptics"
          hint="Feel each key on the keyboards and the modifier keys."
        />
      </template>
      <Toggle
        v-model="settings.keepAwake"
        label="Keep screen on"
        :hint="wakeLockSupported ? 'While connected to the Mac.' : secure ? 'Not available in this browser.' : 'Needs the encrypted connection.'"
        :disabled="!wakeLockSupported"
      />
      <Toggle v-model="settings.rememberDevice" label="Remember this device" hint="Turn off on shared devices. Applies on the next connection." />
    </section>

    <h3 class="section">Saved setup</h3>
    <section class="flex flex-col gap-2">
      <button type="button" class="action" @click="showCopy = true">
        <Copy :size="18" />
        <span class="flex-1">Copy settings from another device</span>
        <ChevronRight :size="16" />
      </button>
      <button type="button" class="action" @click="showBackup = true">
        <Download :size="18" />
        <span class="flex-1">Back up or restore this device</span>
        <ChevronRight :size="16" />
      </button>
    </section>
    <h3 class="section">Reset & disconnect</h3>
    <section class="flex flex-col gap-2">
      <button type="button" class="action" :aria-expanded="confirmReset" @click="((confirmReset = !confirmReset), (confirmForget = false))">
        <RotateCcw :size="18" />
        Reset settings on this device
      </button>
      <div v-if="confirmReset" class="rounded-2xl border border-bad/30 bg-bad/5 p-4">
        <p class="text-[15px] font-semibold">Reset settings to defaults?</p>
        <p class="mt-1 text-[13px] leading-relaxed text-muted">Your device name, custom keyboards, Deck and pairing are kept.</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" class="pill bg-bad! text-white!" @click="reset">Reset to defaults</button>
          <button type="button" class="pill" @click="confirmReset = false">Cancel</button>
        </div>
      </div>
      <button type="button" class="action" @click="(disconnect(false), emit('close'))">
        <Unplug :size="18" />
        Disconnect
      </button>
      <button
        type="button"
        class="action text-bad!"
        :aria-expanded="confirmForget"
        @click="((confirmForget = !confirmForget), (confirmReset = false))"
      >
        <LogOut :size="18" />
        Forget this Mac
      </button>
      <div v-if="confirmForget" class="rounded-2xl border border-bad/30 bg-bad/5 p-4">
        <p class="text-[15px] font-semibold">Forget this Mac?</p>
        <p class="mt-1 text-[13px] leading-relaxed text-muted">
          Disconnect and remove this device’s saved pairing. You’ll need to pair again to reconnect.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" class="pill bg-bad! text-white!" @click="forget">Forget and disconnect</button>
          <button type="button" class="pill" @click="confirmForget = false">Cancel</button>
        </div>
      </div>
    </section>
    <p class="py-6 text-center text-[12px] leading-relaxed text-muted">
      <a href="https://cmdpalm.app" target="_blank" rel="noopener" class="underline underline-offset-2">CmdPalm</a>
      is free and open source under the
      <a href="https://github.com/rahatsagor/CmdPalm/blob/main/LICENSE" target="_blank" rel="noopener" class="underline underline-offset-2">
        GNU AGPL v3.
      </a>
    </p>

    <CopySettingsSheet v-if="showCopy" @close="showCopy = false" />
    <BackupSheet v-if="showBackup" @close="showBackup = false" />
    <Sheet v-if="gesture" :title="gesture.label" @close="gesture = null">
      <template #actions>
        <button
          type="button"
          class="h-11 rounded-full bg-accent px-4 text-[14px] font-semibold text-accent-text disabled:opacity-40"
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
.intro {
  @apply mb-4 text-[13px] leading-relaxed text-muted;
}
.section {
  @apply mt-5 mb-2 px-1 text-[13px] font-medium text-muted;
}
.intro + .section {
  @apply mt-0;
}
.card {
  @apply rounded-2xl bg-surface-2 px-4;
}
.action {
  @apply flex min-h-13 w-full items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-left text-[14px] font-medium;
}
.action > svg {
  @apply shrink-0;
}
.pill {
  @apply flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-surface-3 px-3.5 py-2 text-[14px] font-medium;
}
</style>
