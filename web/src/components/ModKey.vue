<script setup lang="ts">
import { computed } from 'vue'
import { haptic } from '@/lib/haptics'
import { useHeldPointers } from '@/lib/heldPointers'
import { modifiers } from '@/lib/input'

const props = defineProps<{ mod: number; code: number; symbol: string; label?: string; align?: 'left' | 'right' | 'center' }>()
const status = computed(() => modifiers.status(props.mod))

const fingers = useHeldPointers((id) => modifiers.cancel(id))

function down(event: PointerEvent) {
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  modifiers.press(event.pointerId, props.mod, props.code)
  fingers.hold(event.pointerId)
  haptic('select')
}

function up(event: PointerEvent, cancelled: boolean) {
  fingers.lift(event.pointerId)
  if (cancelled) modifiers.cancel(event.pointerId)
  else modifiers.release(event.pointerId)
}
</script>

<template>
  <button
    type="button"
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
    :aria-label="label ?? symbol"
    :aria-pressed="status !== 'off'"
    @pointerdown="down"
    @pointerup="up($event, false)"
    @pointercancel="up($event, true)"
    @contextmenu.prevent
  >
    <span class="text-[15px] leading-none">{{ symbol }}</span>
    <span v-if="label && align" class="text-[10px] leading-none">{{ label }}</span>
    <span v-if="status === 'locked'" class="absolute top-1 right-1 size-1.5 rounded-full bg-accent-text/80" />
  </button>
</template>

<style scoped>
.key {
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
}
</style>
