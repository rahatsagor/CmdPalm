<script setup lang="ts">
import { Keyboard, KeyboardOff } from '@lucide/vue'
import { nextTick, ref } from 'vue'
import ClickBar from '@/components/ClickBar.vue'
import Composer from '@/components/Composer.vue'
import ModifierStrip from '@/components/ModifierStrip.vue'
import ScrollRail from '@/components/ScrollRail.vue'
import TrackpadSurface from '@/components/TrackpadSurface.vue'
import { layout } from '@/lib/layout'
import { settings } from '@/lib/settings'

const typing = ref(false)
const composer = ref<InstanceType<typeof Composer>>()
const touched = ref(false)

async function toggleTyping() {
  typing.value = !typing.value
  if (typing.value) {
    await nextTick()
    composer.value?.focus()
  }
}
</script>

<template>
  <div class="flex h-full flex-col gap-2 px-2 pt-1 pb-2" :class="layout.compact && 'pt-2'">
    <!-- Landscape phones put the keys and buttons beside the trackpad. -->
    <div class="flex min-h-0 flex-1 gap-2" :class="!layout.compact && 'flex-col'">
      <ModifierStrip v-if="!typing" :vertical="layout.compact">
        <button
          type="button"
          class="key grid shrink-0 place-items-center rounded-[9px] bg-key text-muted active:bg-key-down"
          :class="layout.compact ? 'min-h-0 flex-1' : 'w-12'"
          aria-label="Type on the Mac"
          @click="toggleTyping"
        >
          <Keyboard :size="19" />
        </button>
      </ModifierStrip>

      <TrackpadSurface class="min-h-0 min-w-0 flex-1" @pointerdown.capture="touched = true">
        <ScrollRail v-if="settings.scrollRail !== 'off'" />
        <div
          v-if="!touched"
          class="pointer-events-none absolute inset-0 grid place-items-center px-10 text-center text-[13px] leading-relaxed text-faint transition-opacity"
        >
          <p>
            One finger points · Tap to click<br />
            Two fingers scroll · Two-finger tap right-clicks
          </p>
        </div>
      </TrackpadSurface>

      <ClickBar v-if="settings.clickButtons && !typing" :vertical="layout.compact" />
    </div>

    <div v-if="typing">
      <Composer ref="composer" />
      <button
        type="button"
        class="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[13px] font-medium text-muted"
        @click="toggleTyping"
      >
        <KeyboardOff :size="16" /> Hide typing
      </button>
    </div>
  </div>
</template>

<style scoped>
.key {
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
}
</style>
