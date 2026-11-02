<script setup lang="ts">
import { computed } from 'vue'
import { holdPointer, keyHaptic } from '@/lib/haptics'
import { useHeldPointers } from '@/lib/heldPointers'
import { modifiers } from '@/lib/input'
import HapticSwitch from './HapticSwitch.vue'

const props = defineProps<{ mod: number; code: number; symbol: string; label?: string; align?: 'left' | 'right' | 'center' }>()
const status = computed(() => modifiers.status(props.mod))

const fingers = useHeldPointers((id) => modifiers.cancel(id))

function down(event: PointerEvent) {
  holdPointer(event, true)
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  modifiers.press(event.pointerId, props.mod, props.code)
  fingers.hold(event.pointerId)
  keyHaptic()
}

function up(event: PointerEvent, cancelled: boolean) {
  fingers.lift(event.pointerId)
  if (cancelled) modifiers.cancel(event.pointerId)
  else modifiers.release(event.pointerId)
}

/** Not a real pointer id, so it never meets a finger's. */
const KEYBOARD_POINTER = -1

/** From a keyboard or screen reader: a quick tap, which latches the modifier. */
function activate() {
  modifiers.press(KEYBOARD_POINTER, props.mod, props.code)
  modifiers.release(KEYBOARD_POINTER)
}

// As for other keys, only a click with no press before it (a detail of 0)
// comes from a screen reader; the hidden switch's copy is ignored.
function onClick(event: MouseEvent) {
  if (event.detail === 0 && !(event.target instanceof HTMLInputElement)) activate()
}
</script>

<template>
  <label
    role="button"
    class="key relative flex h-full w-full touch-none flex-col justify-between overflow-hidden rounded-[9px] px-2 py-1.5 text-muted transition-colors"
    :class="{
      'bg-accent text-accent-text': status === 'locked',
      'bg-accent-soft text-accent ring-1 ring-accent/70 ring-inset': status === 'latched',
      'bg-key-down text-text': status === 'held',
      'bg-key': status === 'off',
      'items-start': align === 'left',
      'items-end': align === 'right',
      'items-center justify-center': !align || align === 'center',
    }"
    tabindex="0"
    :aria-label="label ?? symbol"
    :aria-pressed="status !== 'off'"
    @pointerdown="down"
    @pointerup="up($event, false)"
    @pointercancel="up($event, true)"
    @click="onClick"
    @keydown.enter.prevent="activate"
    @keydown.space.prevent="activate"
    @contextmenu.prevent
  >
    <span class="text-[15px] leading-none">{{ symbol }}</span>
    <span v-if="label && align" class="text-[10px] leading-none">{{ label }}</span>
    <span v-if="status === 'locked'" class="absolute top-1 right-1 size-1.5 rounded-full bg-accent-text/80" />
    <HapticSwitch />
  </label>
</template>

<style scoped>
.key {
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
}
</style>
