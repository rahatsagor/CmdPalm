<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, reactive, ref, watch } from 'vue'
import { pointer, runAction, state } from '@/lib/connection'
import { GestureRecognizer, type Direction, type GestureHandler } from '@/lib/gestures'
import { haptic } from '@/lib/haptics'
import { beginPointerGesture, buttonDown, buttonUp, click, tap } from '@/lib/input'
import { Key } from '@/lib/keys'
import { Mod, ScrollPhase } from '@/lib/protocol'
import { settings, type GestureMap } from '@/lib/settings'

const surface = ref<HTMLElement>()
const touches = reactive(new Map<number, { x: number; y: number }>())
const dragging = ref(false)

/**
 * Pointer acceleration: slow movements stay precise, fast flicks cross the
 * screen. Speed is in CSS px per ms, smoothed over ~25 ms: touch samples
 * arrive with uneven timing, and raw per-sample speed makes the gain (and
 * so the cursor) jitter even when the finger moves steadily.
 */
let smoothedSpeed = -1
function gain(dx: number, dy: number, dt: number): number {
  const instant = Math.hypot(dx, dy) / dt
  smoothedSpeed = smoothedSpeed < 0 ? instant : smoothedSpeed + (instant - smoothedSpeed) * (1 - Math.exp(-dt / 25))
  const speed = smoothedSpeed
  const accel = settings.pointerAcceleration
  const boost = Math.min(Math.max((speed - 0.08) / 0.9, 0), 2.2)
  return settings.pointerSpeed * (0.8 + accel * boost * 1.4 + (1 - accel) * 0.25)
}

const scrollScale = () => settings.scrollSpeed * 1.6
// Natural scrolling: content follows the fingers.
const scrollSign = () => (settings.naturalScroll ? 1 : -1)

function runGesture(map: GestureMap, slot: keyof GestureMap) {
  const action = map[slot]
  if (!action) return
  void runAction(action).then((result) => {
    if (!result.ok && result.message) haptic('heavy')
  })
}

const handler: GestureHandler = {
  touch: () => {
    smoothedSpeed = -1
    pointer.touch()
  },
  begin: () => beginPointerGesture(),
  move: (dx, dy, dt) => {
    const g = gain(dx, dy, dt)
    pointer.move(dx * g, dy * g)
  },
  scroll: (phase, dx, dy) => {
    const k = scrollScale() * scrollSign()
    pointer.scroll(phase, dx * k, dy * k)
  },
  fling: (vx, vy) => {
    const k = scrollScale() * scrollSign()
    pointer.fling(vx * k, vy * k)
  },
  click: (button) => {
    click(button)
    haptic('light')
  },
  buttonDown: (button) => {
    buttonDown(button)
    dragging.value = true
  },
  buttonUp: (button) => {
    buttonUp(button)
    dragging.value = false
  },
  swipe: (fingers: number, direction: Direction) => runGesture(fingers >= 4 ? settings.fourFinger : settings.threeFinger, direction),
  multiTap: (fingers) => runGesture(fingers >= 4 ? settings.fourFinger : settings.threeFinger, 'tap'),
  pinch: (direction) => tap(direction > 0 ? Key.Equal : Key.Minus, Mod.Command),
  feedback: (kind) => haptic(kind),
}

const options = computed(() => ({
  tapToClick: settings.tapToClick,
  twoFingerTap: settings.twoFingerTapRightClick,
  longPress: settings.longPress,
  tapAndDrag: settings.tapAndDrag,
  dragLock: settings.dragLock,
  pinch: settings.pinchToZoom,
  momentum: settings.momentum,
}))

const recognizer = new GestureRecognizer(handler, options.value)
watch(options, (value) => (recognizer.options = value))
watch(
  () => state.status,
  (status) => {
    if (status !== 'connected') {
      recognizer.reset()
      dragging.value = false
      touches.clear()
    }
  },
)
onBeforeUnmount(() => recognizer.reset())
// A finger down when the tab changes never reports lifting; without this it
// would count as a second finger on return, turning pointing into scrolling.
onDeactivated(() => {
  recognizer.reset()
  dragging.value = false
  touches.clear()
})

function local(event: PointerEvent) {
  const rect = surface.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function onDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  surface.value?.setPointerCapture(event.pointerId)
  const p = local(event)
  touches.set(event.pointerId, p)
  recognizer.down(event.pointerId, event.clientX, event.clientY, event.timeStamp)
}

function onMove(event: PointerEvent) {
  if (!touches.has(event.pointerId)) return
  // Re-rendering the touch dots is the only reason to update the reactive map.
  if (settings.showTouches) touches.set(event.pointerId, local(event))
  const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
  for (const e of events.length ? events : [event]) {
    recognizer.move(event.pointerId, e.clientX, e.clientY, e.timeStamp)
  }
}

function onUp(event: PointerEvent) {
  if (!touches.delete(event.pointerId)) return
  recognizer.up(event.pointerId, event.timeStamp)
}

function onCancel(event: PointerEvent) {
  if (!touches.delete(event.pointerId)) return
  recognizer.cancel(event.pointerId)
}
</script>

<template>
  <div
    ref="surface"
    class="trackpad relative h-full w-full touch-none overflow-hidden rounded-[22px] bg-pad"
    :class="dragging && 'ring-2 ring-accent/60'"
    role="application"
    aria-label="Trackpad. Move one finger to move the pointer, tap to click, two fingers to scroll."
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onCancel"
    @lostpointercapture="onCancel"
    @contextmenu.prevent
  >
    <div class="grain pointer-events-none absolute inset-0" />
    <template v-if="settings.showTouches">
      <span
        v-for="[id, t] in touches"
        :key="id"
        class="touch-dot pointer-events-none absolute size-14 -translate-x-1/2 -translate-y-1/2 rounded-full"
        :style="{ left: `${t.x}px`, top: `${t.y}px` }"
      />
    </template>
    <slot />
  </div>
</template>

<style scoped>
.trackpad {
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.04),
    inset 0 0 0 1px var(--line);
}
.grain {
  background-image: radial-gradient(rgb(255 255 255 / 0.035) 1px, transparent 1px);
  background-size: 18px 18px;
  mask-image: radial-gradient(ellipse at center, black 40%, transparent 85%);
}
:root[data-theme='light'] .grain {
  background-image: radial-gradient(rgb(0 0 0 / 0.05) 1px, transparent 1px);
}
.touch-dot {
  background: radial-gradient(circle, rgb(255 255 255 / 0.18), rgb(255 255 255 / 0.04) 60%, transparent 70%);
}
:root[data-theme='light'] .touch-dot {
  background: radial-gradient(circle, rgb(0 0 0 / 0.12), rgb(0 0 0 / 0.03) 60%, transparent 70%);
}
</style>
