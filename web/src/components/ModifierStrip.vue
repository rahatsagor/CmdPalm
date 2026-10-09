<script setup lang="ts">
import { haptic } from '@/lib/haptics'
import { useHeldPointers } from '@/lib/heldPointers'
import { keyDown, keyUp } from '@/lib/input'
import { Key, MOD_ORDER } from '@/lib/keys'
import ModKey from './ModKey.vue'

withDefaults(defineProps<{ extras?: boolean; vertical?: boolean }>(), { extras: true, vertical: false })

const extraKeys = [
  { code: Key.Escape, label: 'esc' },
  { code: Key.Tab, label: '⇥' },
]

const fingers = useHeldPointers(keyUp)

function down(code: number, event: PointerEvent) {
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  keyDown(event.pointerId, code)
  fingers.hold(event.pointerId)
  haptic('light')
}

function up(event: PointerEvent) {
  fingers.lift(event.pointerId)
  keyUp(event.pointerId)
}
</script>

<template>
  <div class="flex gap-1.5" :class="vertical ? 'w-14 shrink-0 flex-col' : 'h-11'">
    <template v-if="extras">
      <button
        v-for="key in extraKeys"
        :key="key.code"
        type="button"
        class="key-btn touch-none rounded-[9px] bg-key text-[14px] text-muted active:bg-key-down"
        :class="vertical ? 'min-h-0 flex-1' : 'w-12 shrink-0'"
        @pointerdown="down(key.code, $event)"
        @pointerup="up"
        @pointercancel="up"
        @contextmenu.prevent
      >
        {{ key.label }}
      </button>
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
