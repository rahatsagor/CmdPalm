<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, ref } from 'vue'
import { haptic, holdPointer } from '@/lib/haptics'
import { onPageHidden } from '@/lib/heldPointers'
import { buttonDown, buttonUp, click } from '@/lib/input'
import type { MouseButton } from '@/lib/protocol'
import HapticSwitch from './HapticSwitch.vue'

withDefaults(defineProps<{ vertical?: boolean }>(), { vertical: false })

// Physical-style buttons: hold one with a thumb and move with another finger
// to drag.
const held = ref<Record<string, number | null>>({ left: null, right: null })

function down(button: MouseButton, event: PointerEvent) {
  holdPointer(event)
  if (held.value[button] != null) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  held.value[button] = event.pointerId
  buttonDown(button)
  haptic('light')
}

function up(button: MouseButton, event: PointerEvent) {
  if (held.value[button] !== event.pointerId) return
  held.value[button] = null
  buttonUp(button)
}

// Hidden or removed while held, the button would never see its finger lift.
function letGo() {
  for (const button of ['left', 'right'] as const) {
    if (held.value[button] == null) continue
    held.value[button] = null
    buttonUp(button)
  }
}
onDeactivated(letGo)
onBeforeUnmount(letGo)
onPageHidden(letGo)

// A screen reader's click has no press before it (a detail of 0), so it
// clicks here. The hidden switch's own copy of the click is ignored.
function onClick(button: MouseButton, event: MouseEvent) {
  if (event.detail === 0 && !(event.target instanceof HTMLInputElement)) click(button)
}
</script>

<template>
  <div class="grid gap-1.5" :class="vertical ? 'w-24 shrink-0 grid-rows-[3fr_2fr]' : 'h-14 grid-cols-[3fr_2fr]'">
    <label
      v-for="button in ['left', 'right'] as const"
      :key="button"
      role="button"
      class="grid touch-none place-items-center rounded-2xl border border-line text-[13px] font-medium text-muted transition-colors"
      :class="held[button] != null ? 'bg-key-down text-text' : 'bg-pad'"
      tabindex="0"
      :aria-label="`${button} mouse button`"
      @pointerdown="down(button, $event)"
      @pointerup="up(button, $event)"
      @pointercancel="up(button, $event)"
      @click="onClick(button, $event)"
      @keydown.enter.prevent="click(button)"
      @keydown.space.prevent="click(button)"
      @contextmenu.prevent
    >
      <span>{{ button === 'left' ? 'Click' : 'Right-click' }}</span>
      <HapticSwitch />
    </label>
  </div>
</template>
