<script setup lang="ts">
import {
  FastForward, Lightbulb, LightbulbOff, Pause, Play, Rewind, SkipBack, SkipForward, Sun, SunDim, Volume1, Volume2, VolumeX,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { send, state } from '@/lib/connection'
import { haptic } from '@/lib/haptics'
import { onPageHidden } from '@/lib/heldPointers'
import { pressMedia } from '@/lib/input'
import type { MediaKey } from '@/lib/protocol'

// Media keys act on whatever the Mac's Now Playing app is.
const held = ref<MediaKey | null>(null)
let release: (() => void) | null = null

function down(key: MediaKey, event: PointerEvent) {
  event.preventDefault()
  if (held.value) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  held.value = key
  release = pressMedia(key)
  haptic('light')
}
function up(key: MediaKey) {
  if (held.value !== key) return
  held.value = null
  release?.()
  release = null
}
function letGo() {
  held.value = null
  release?.()
  release = null
}
// The finger may still be down when the tab changes; its lift never arrives.
onDeactivated(letGo)
onBeforeUnmount(letGo)
onPageHidden(letGo)

// The slider shows our own value while dragging, then follows the Mac.
const dragging = ref(false)
const local = ref(state.volume?.value ?? 0.5)
watch(
  () => state.volume?.value,
  (value) => {
    if (!dragging.value && value !== undefined) local.value = value
  },
)
let sendTimer: ReturnType<typeof setTimeout> | undefined
let lastSent = 0
function setVolume(value: number) {
  local.value = value
  const now = performance.now()
  clearTimeout(sendTimer)
  const flush = () => {
    lastSent = performance.now()
    send({ t: 'volume', value: local.value, muted: false })
  }
  if (now - lastSent > 60) flush()
  else sendTimer = setTimeout(flush, 60)
}
onBeforeUnmount(() => clearTimeout(sendTimer))

const muted = computed(() => state.volume?.muted ?? false)
const VolumeIcon = computed(() => (muted.value || local.value === 0 ? VolumeX : local.value < 0.5 ? Volume1 : Volume2))

function toggleMute() {
  send({ t: 'volume', muted: !muted.value })
  haptic('light')
}

const transport = [
  { key: 'previous' as const, icon: SkipBack, label: 'Previous track', size: 26 },
  { key: 'playPause' as const, icon: null, label: 'Play or pause', size: 34 },
  { key: 'next' as const, icon: SkipForward, label: 'Next track', size: 26 },
]

const extra = [
  { key: 'rewind' as const, icon: Rewind, label: 'Rewind', name: 'Rewind' },
  { key: 'fastForward' as const, icon: FastForward, label: 'Forward', name: 'Fast forward' },
  { key: 'brightnessDown' as const, icon: SunDim, label: 'Dimmer', name: 'Display brightness down' },
  { key: 'brightnessUp' as const, icon: Sun, label: 'Brighter', name: 'Display brightness up' },
  { key: 'illuminationDown' as const, icon: LightbulbOff, label: 'Backlight −', name: 'Keyboard backlight down' },
  { key: 'illuminationUp' as const, icon: Lightbulb, label: 'Backlight +', name: 'Keyboard backlight up' },
]
</script>

<template>
  <div class="no-scrollbar flex h-full flex-col items-center overflow-y-auto px-5 pt-2 pb-6">
    <div class="flex w-full max-w-md flex-1 flex-col justify-center gap-8">
      <div class="flex items-center justify-center gap-6">
        <button
          v-for="item in transport"
          :key="item.key"
          type="button"
          class="grid touch-none place-items-center rounded-full transition-all active:scale-95"
          :class="[
            item.key === 'playPause' ? 'size-24 bg-text text-bg' : 'size-16 bg-surface-3 text-text',
            held === item.key && 'scale-95 opacity-80',
          ]"
          :aria-label="item.label"
          @pointerdown="down(item.key, $event)"
          @pointerup="up(item.key)"
          @pointercancel="up(item.key)"
        >
          <span v-if="!item.icon" class="flex items-center">
            <Play :size="22" fill="currentColor" /><Pause :size="22" fill="currentColor" />
          </span>
          <component :is="item.icon" v-else :size="item.size" fill="currentColor" />
        </button>
      </div>

      <div class="rounded-3xl border border-line bg-surface p-4">
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="grid size-10 shrink-0 place-items-center rounded-full"
            :class="muted ? 'bg-bad/15 text-bad' : 'bg-surface-3 text-text'"
            :aria-label="muted ? 'Unmute' : 'Mute'"
            :aria-pressed="muted"
            @click="toggleMute"
          >
            <component :is="VolumeIcon" :size="20" />
          </button>
          <input
            v-if="state.volume"
            class="slider flex-1"
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="local"
            :style="{ '--fill': `${local * 100}%` }"
            aria-label="Volume"
            @pointerdown="dragging = true"
            @pointerup="dragging = false"
            @pointercancel="dragging = false"
            @input="setVolume(Number(($event.target as HTMLInputElement).value))"
          />
          <div v-else class="flex flex-1 gap-2">
            <button
              v-for="key in ['volumeDown', 'volumeUp'] as const"
              :key="key"
              type="button"
              class="h-10 flex-1 touch-none rounded-xl bg-surface-3 text-[18px]"
              :aria-label="key === 'volumeUp' ? 'Volume up' : 'Volume down'"
              @pointerdown="down(key, $event)"
              @pointerup="up(key)"
              @pointercancel="up(key)"
            >
              {{ key === 'volumeUp' ? '+' : '−' }}
            </button>
          </div>
          <span v-if="state.volume" class="w-9 text-right text-[13px] text-muted tabular-nums">{{ Math.round(local * 100) }}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="item in extra"
          :key="item.key"
          type="button"
          class="flex h-14 touch-none items-center gap-3 rounded-2xl border border-line px-4 text-left text-[14px] transition-colors"
          :class="held === item.key ? 'bg-surface-3' : 'bg-surface'"
          :aria-label="item.name"
          @pointerdown="down(item.key, $event)"
          @pointerup="up(item.key)"
          @pointercancel="up(item.key)"
        >
          <component :is="item.icon" :size="19" class="shrink-0 text-muted" />
          {{ item.label }}
        </button>
      </div>
    </div>
  </div>
</template>
