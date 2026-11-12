<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, reactive, ref, watch } from 'vue'
import { pointer, runAction } from '@/lib/connection'
import { GestureRecognizer, type Direction, type GestureHandler } from '@/lib/gestures'
import { haptic, holdPointer } from '@/lib/haptics'
import { onPageHidden } from '@/lib/heldPointers'
import { beginPointerGesture, buttonDown, buttonUp, click, tap } from '@/lib/input'
import { Key } from '@/lib/keys'
import { layout } from '@/lib/layout'
import { PointerGain } from '@/lib/pointerGain'
import { GestureKind, Mod, ScrollPhase } from '@/lib/protocol'
import { settings, type GestureMap } from '@/lib/settings'
import HapticSwitch from './HapticSwitch.vue'

/** `edge`: the scroll strip's side of the trackpad is at the screen edge. */
const props = withDefaults(defineProps<{ edge?: boolean }>(), { edge: true })

const surface = ref<HTMLElement>()

// Reaching the edge, the trackpad covers the views' side padding there.
// Landscape phones keep the tab rail on the left.
const reach = computed(() => {
  const side = settings.scrollStripSide
  if (!props.edge || settings.scrollStrip === 'off' || !settings.scrollStripEdge || (layout.compact && side === 'left')) return {}
  const name = side === 'left' ? 'Left' : 'Right'
  return { [`margin${name}`]: '-0.5rem', [`borderTop${name}Radius`]: '0px', [`borderBottom${name}Radius`]: '0px' }
})
const touches = reactive(new Map<number, { x: number; y: number }>())
const dragging = ref(false)

const acceleration = new PointerGain()
const gain = (dx: number, dy: number, dt: number) =>
  acceleration.gain(dx, dy, dt, { speed: settings.pointerSpeed, acceleration: settings.pointerAcceleration })

const scrollScale = () => settings.scrollSpeed * 1.6
// Natural scrolling: content follows the fingers.
const scrollSign = () => (settings.naturalScroll ? 1 : -1)

function runGesture(map: GestureMap, slot: keyof GestureMap) {
  const action = map[slot]
  if (!action) return
  void runAction(action).then((result) => {
    if (!result.ok && result.message) haptic('error')
  })
}

const handler: GestureHandler = {
  touch: () => {
    acceleration.reset()
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
  click: (button) => click(button),
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
  multiPinch: (fingers, inward) => runGesture(fingers >= 4 ? settings.fourFinger : settings.threeFinger, inward ? 'pinchIn' : 'pinchOut'),
  pinch: (direction) => tap(direction > 0 ? Key.Equal : Key.Minus, Mod.Command),
  zoom: (phase, delta) => pointer.gesture(GestureKind.Zoom, phase, delta),
  rotate: (phase, degrees) => pointer.gesture(GestureKind.Rotate, phase, degrees),
  smartZoom: () => pointer.gesture(GestureKind.SmartZoom, ScrollPhase.None, 0),
  feedback: (kind) => haptic(kind),
}

const options = computed(() => ({
  tapToClick: settings.tapToClick,
  twoFingerTap: settings.twoFingerTapRightClick,
  longPress: settings.longPress,
  tapAndDrag: settings.tapAndDrag,
  dragLock: settings.dragLock,
  pinch: settings.pinchToZoom,
  zoomKeys: settings.pinchStyle === 'keys',
  rotate: settings.rotateGesture,
  smartZoom: settings.smartZoom,
  threeFingerDrag: settings.threeFingerDrag,
  momentum: settings.momentum,
}))

const recognizer = new GestureRecognizer(handler, options.value)
watch(options, (value) => (recognizer.options = value))
function resetSurface() {
  recognizer.reset()
  dragging.value = false
  touches.clear()
}
onBeforeUnmount(() => recognizer.reset())
// A finger down when the tab changes, control pauses, or the page hides never
// reports lifting; without this it would count as a second finger on return,
// turning pointing into scrolling, or leave drag lock visually stuck.
onDeactivated(resetSurface)
onPageHidden(resetSurface)

function local(event: PointerEvent) {
  const rect = surface.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function onDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  holdPointer(event)
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
  <!-- A label, so a tap on it can play a haptic on iPhone (see HapticSwitch). -->
  <label
    ref="surface"
    class="trackpad relative block h-full w-full touch-none overflow-hidden rounded-[22px] bg-pad"
    :class="dragging && 'ring-2 ring-accent/60'"
    :style="reach"
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
        class="touch-dot pointer-events-none absolute top-0 left-0 size-14 -translate-x-1/2 -translate-y-1/2 rounded-full"
        :style="{ transform: `translate3d(${t.x}px, ${t.y}px, 0)` }"
      />
    </template>
    <slot />
    <HapticSwitch />
  </label>
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
  /* Moved on every finger movement: a transform skips layout and repaint. */
  will-change: transform;
  background: radial-gradient(circle, rgb(255 255 255 / 0.18), rgb(255 255 255 / 0.04) 60%, transparent 70%);
}
:root[data-theme='light'] .touch-dot {
  background: radial-gradient(circle, rgb(0 0 0 / 0.12), rgb(0 0 0 / 0.03) 60%, transparent 70%);
}
</style>
