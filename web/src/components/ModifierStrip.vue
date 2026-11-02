<script setup lang="ts">
import { holdPointer, keyHaptic } from '@/lib/haptics'
import { useHeldPointers } from '@/lib/heldPointers'
import { keyDown, keyUp, tap } from '@/lib/input'
import { Key, MOD_ORDER } from '@/lib/keys'
import HapticSwitch from './HapticSwitch.vue'
import ModKey from './ModKey.vue'

withDefaults(defineProps<{ extras?: boolean; vertical?: boolean }>(), { extras: true, vertical: false })

const extraKeys = [
  { code: Key.Escape, label: 'esc', name: 'Escape' },
  { code: Key.Tab, label: '⇥', name: 'Tab' },
]

const fingers = useHeldPointers(keyUp)

function down(code: number, event: PointerEvent) {
  holdPointer(event, true)
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  keyDown(event.pointerId, code)
  fingers.hold(event.pointerId)
  keyHaptic()
}

function up(event: PointerEvent) {
  fingers.lift(event.pointerId)
  keyUp(event.pointerId)
}

// Fingers press on pointerdown, and their click has a detail of 1 or more. A
// screen reader's click has none, so it taps the key here. The hidden
// switch's own copy of the click is ignored.
function onClick(code: number, event: MouseEvent) {
  if (event.detail === 0 && !(event.target instanceof HTMLInputElement)) tap(code)
}
</script>

<template>
  <div class="flex gap-1.5" :class="vertical ? 'w-14 shrink-0 flex-col' : 'h-11'">
    <template v-if="extras">
      <label
        v-for="key in extraKeys"
        :key="key.code"
        role="button"
        class="key-btn relative grid touch-none place-items-center rounded-[9px] bg-key text-[14px] text-muted active:bg-key-down"
        :class="vertical ? 'min-h-0 flex-1' : 'w-12 shrink-0'"
        tabindex="0"
        :aria-label="key.name"
        @pointerdown="down(key.code, $event)"
        @pointerup="up"
        @pointercancel="up"
        @click="onClick(key.code, $event)"
        @keydown.enter.prevent="tap(key.code)"
        @keydown.space.prevent="tap(key.code)"
        @contextmenu.prevent
      >
        <span>{{ key.label }}</span>
        <HapticSwitch />
      </label>
    </template>
    <div v-for="m in MOD_ORDER.slice(0, 4)" :key="m.mod" class="min-h-0 min-w-0 flex-1">
      <ModKey :mod="m.mod" :code="m.code" :symbol="m.symbol" :label="m.name" />
    </div>
    <slot />
  </div>
</template>

<style scoped>
.key-btn {
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
}
</style>
