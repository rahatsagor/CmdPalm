<script setup lang="ts">
// Put inside a <label> to make a tap on it play the haptic the tap asked
// for on iPhone and iPad (see lib/haptics.ts). Renders nothing elsewhere.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { switchOnly, tapZone } from '@/lib/haptics'

const control = ref<HTMLInputElement>()
let label: HTMLLabelElement | null = null

// Lifts are heard by lib/haptics.ts itself, even after this label is gone.
const down = (event: PointerEvent) => tapZone.down(event.pointerId)
function click(event: MouseEvent) {
  if (event.target === control.value) return
  // Toggling the switch is what plays the haptic; a cancelled click leaves it alone.
  if (!tapZone.claim()) event.preventDefault()
}
// The label passes its click on to the switch; that copy must not reach the
// control's own click handlers a second time.
const stop = (event: Event) => event.stopPropagation()

onMounted(() => {
  label = control.value?.closest('label') ?? null
  if (!label) return
  label.addEventListener('pointerdown', down, true)
  label.addEventListener('click', click)
})
onBeforeUnmount(() => {
  label?.removeEventListener('pointerdown', down, true)
  label?.removeEventListener('click', click)
  label = null
})
</script>

<template>
  <!-- Never under the finger: WebKit claims a touch that starts on a switch, which stops the page from scrolling. -->
  <input v-if="switchOnly" ref="control" type="checkbox" switch tabindex="-1" aria-hidden="true" class="haptic-switch" @click="stop" />
</template>

<style scoped>
.haptic-switch {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  visibility: hidden;
  pointer-events: none;
}
</style>
