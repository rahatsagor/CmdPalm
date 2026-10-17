<script setup lang="ts">
import { ChevronDown, ChevronUp } from '@lucide/vue'
import { onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { pointer, state } from '@/lib/connection'
import { haptic } from '@/lib/haptics'
import { beginPointerGesture } from '@/lib/input'
import { ScrollPhase } from '@/lib/protocol'
import { settings } from '@/lib/settings'

// A one-finger scroll handle along the edge of the trackpad. Dragging it
// scrolls with the finger. Holding it against either end keeps scrolling,
// faster the further the finger goes past the end.

/** Finger speed, in px per second, once the handle reaches an end. */
const HOLD_SPEED = 360
/** Extra speed for each px the finger is past the end. */
const HOLD_GAIN = 14
const HOLD_MAX = 2400
const HOLD_TICK_MS = 16

const track = ref<HTMLElement>()
const handle = ref<HTMLElement>()
const active = ref<number | null>(null)
/** How far the handle has moved from the middle, in px. */
const offset = ref(0)
/** -1 or 1 while holding against the top or bottom end. */
const holding = ref(0)
let startY = 0
let lastY = 0
let travel = 0
let past = 0
let samples: { t: number; dy: number }[] = []
let began = false
let holdTimer: ReturnType<typeof setInterval> | undefined
let lastTick = 0

const scale = () => settings.scrollSpeed * 1.6 * (settings.naturalScroll ? 1 : -1)

function scrollBy(dy: number) {
  if (!began) {
    beginPointerGesture()
    began = true
    pointer.scroll(ScrollPhase.Began, 0, dy * scale())
  } else {
    pointer.scroll(ScrollPhase.Changed, 0, dy * scale())
  }
}

function tick() {
  const now = performance.now()
  // Timers are throttled in Low Power Mode, so scroll by the time that passed.
  const seconds = Math.min(0.1, (now - lastTick) / 1000)
  lastTick = now
  if (seconds > 0) scrollBy(holding.value * Math.min(HOLD_MAX, HOLD_SPEED + past * HOLD_GAIN) * seconds)
}

function stopHold() {
  clearInterval(holdTimer)
  holdTimer = undefined
  holding.value = 0
}

function updateHold(along: number) {
  past = Math.abs(along) - travel
  const direction = settings.scrollHold && along !== 0 && past >= 0 ? Math.sign(along) : 0
  if (direction === holding.value) return
  stopHold()
  if (!direction) return
  holding.value = direction
  lastTick = performance.now()
  holdTimer = setInterval(tick, HOLD_TICK_MS)
  haptic('select')
}

function down(event: PointerEvent) {
  if (active.value !== null) return
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  active.value = event.pointerId
  startY = lastY = event.clientY
  // Layout sizes, unaffected by the handle's transform while it springs back.
  travel = Math.max(0, ((track.value?.clientHeight ?? 0) - (handle.value?.clientHeight ?? 0)) / 2)
  offset.value = 0
  samples = []
  began = false
  pointer.touch()
}

function move(event: PointerEvent) {
  if (event.pointerId !== active.value) return
  const dy = event.clientY - lastY
  lastY = event.clientY
  const along = event.clientY - startY
  offset.value = Math.max(-travel, Math.min(travel, along))
  updateHold(along)
  if (dy === 0) return
  scrollBy(dy)
  samples.push({ t: event.timeStamp, dy })
  samples = samples.filter((s) => s.t > event.timeStamp - 90)
}

function up(event: PointerEvent, cancelled = false) {
  if (event.pointerId !== active.value) return
  const held = holding.value !== 0
  stopHold()
  active.value = null
  offset.value = 0
  if (!began) return
  pointer.scroll(cancelled ? ScrollPhase.Cancelled : ScrollPhase.Ended, 0, 0)
  const last = samples.at(-1)
  if (held || cancelled || !settings.momentum || !last || event.timeStamp - last.t > 55 || samples.length < 2) return
  const span = Math.max(16, last.t - samples[0]!.t)
  const vy = (samples.reduce((a, s) => a + s.dy, 0) / span) * 1000
  if (Math.abs(vy) > 140) pointer.fling(0, vy * scale())
}

function abandon() {
  stopHold()
  if (active.value === null) return
  active.value = null
  offset.value = 0
  if (began) pointer.scroll(ScrollPhase.Cancelled, 0, 0)
}

const onVisibility = () => {
  if (document.hidden) abandon()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibility))
watch(
  () => state.status,
  (status) => {
    if (status !== 'connected') abandon()
  },
)
onDeactivated(abandon)
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  abandon()
})
</script>

<template>
  <div ref="track" class="pointer-events-none absolute inset-y-3 w-9" :class="settings.scrollRail === 'left' ? 'left-1.5' : 'right-1.5'">
    <div
      ref="handle"
      class="pointer-events-auto absolute inset-x-0 top-1/2 flex h-24 max-h-full touch-none flex-col items-center justify-between rounded-full py-2"
      :class="[active !== null ? 'bg-text/10' : 'bg-text/[0.05] transition-[transform,background-color] duration-200']"
      :style="{ transform: `translateY(calc(-50% + ${offset}px))` }"
      aria-label="Scroll strip"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up($event)"
      @pointercancel="up($event, true)"
      @lostpointercapture="up($event, true)"
    >
      <ChevronUp :size="15" :stroke-width="2.2" class="transition-colors" :class="holding < 0 ? 'text-text/70' : 'text-text/30'" />
      <ChevronDown :size="15" :stroke-width="2.2" class="transition-colors" :class="holding > 0 ? 'text-text/70' : 'text-text/30'" />
    </div>
  </div>
</template>
