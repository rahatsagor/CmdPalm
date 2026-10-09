<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, ref } from 'vue'
import { pointer } from '@/lib/connection'
import { beginPointerGesture } from '@/lib/input'
import { ScrollPhase } from '@/lib/protocol'
import { settings } from '@/lib/settings'

// A one-finger scroll strip along the edge of the trackpad.
const active = ref<number | null>(null)
let lastY = 0
let samples: { t: number; dy: number }[] = []
let began = false

const scale = () => settings.scrollSpeed * 1.6 * (settings.naturalScroll ? 1 : -1)

function down(event: PointerEvent) {
  if (active.value !== null) return
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  active.value = event.pointerId
  lastY = event.clientY
  samples = []
  began = false
  pointer.touch()
}

function move(event: PointerEvent) {
  if (event.pointerId !== active.value) return
  const dy = event.clientY - lastY
  lastY = event.clientY
  if (dy === 0) return
  if (!began) {
    beginPointerGesture()
    began = true
    pointer.scroll(ScrollPhase.Began, 0, dy * scale())
  } else {
    pointer.scroll(ScrollPhase.Changed, 0, dy * scale())
  }
  samples.push({ t: event.timeStamp, dy })
  samples = samples.filter((s) => s.t > event.timeStamp - 90)
}

function up(event: PointerEvent, cancelled = false) {
  if (event.pointerId !== active.value) return
  active.value = null
  if (!began) return
  pointer.scroll(cancelled ? ScrollPhase.Cancelled : ScrollPhase.Ended, 0, 0)
  const last = samples.at(-1)
  if (cancelled || !settings.momentum || !last || event.timeStamp - last.t > 55 || samples.length < 2) return
  const span = Math.max(16, last.t - samples[0]!.t)
  const vy = (samples.reduce((a, s) => a + s.dy, 0) / span) * 1000
  if (Math.abs(vy) > 140) pointer.fling(0, vy * scale())
}

function abandon() {
  if (active.value === null) return
  active.value = null
  if (began) pointer.scroll(ScrollPhase.Cancelled, 0, 0)
}
onDeactivated(abandon)
onBeforeUnmount(abandon)
</script>

<template>
  <div
    class="rail absolute inset-y-3 w-9 touch-none rounded-full transition-colors"
    :class="[settings.scrollRail === 'left' ? 'left-1.5' : 'right-1.5', active !== null ? 'bg-text/10' : 'bg-text/[0.035]']"
    aria-label="Scroll strip"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up($event)"
    @pointercancel="up($event, true)"
  >
    <div class="absolute inset-x-0 top-1/2 mx-auto flex w-1 -translate-y-1/2 flex-col gap-1.5">
      <span v-for="i in 3" :key="i" class="h-1 w-1 rounded-full bg-text/25" />
    </div>
  </div>
</template>
