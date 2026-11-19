<script setup lang="ts">
import { Check } from '@lucide/vue'
import { computed } from 'vue'
import { state } from '@/lib/connection'
import { releaseAll } from '@/lib/input'
import { settings, type Settings } from '@/lib/settings'
import RangeRow from './RangeRow.vue'
import Segmented from './Segmented.vue'

withDefaults(defineProps<{ showLayout?: boolean }>(), { showLayout: true })
const emit = defineEmits<{ quality: [value: Settings['displayQuality']] }>()
const mode = computed({
  get: () => settings.displayControls,
  set: (value) => {
    releaseAll()
    settings.displayControls = value
  },
})
const qualities = [
  { value: 'auto', label: 'Automatic', detail: 'Smooth motion that adjusts to your connection.' },
  { value: 'battery', label: 'Save battery', detail: 'Less bandwidth and a lower frame rate.' },
  { value: 'sharp', label: 'Sharper text', detail: 'More detail for reading and typing.' },
  { value: 'original', label: 'HD text · lossless', detail: 'Original detail up to 4K. Updates up to 4× a second and uses more bandwidth.' },
] as const
</script>

<template>
  <Segmented
    v-if="showLayout"
    v-model="mode"
    label="Controls with the display"
    :options="[
      { value: 'view', label: 'View only' },
      { value: 'trackpad', label: 'Trackpad' },
      { value: 'keyboard', label: 'Keyboard' },
    ]"
  />
  <fieldset class="mt-3 min-w-0">
    <legend class="mb-2 text-[15px] font-medium">Viewing quality</legend>
    <button
      v-for="choice in qualities"
      :key="choice.value"
      type="button"
      class="mb-2 flex min-h-16 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left disabled:opacity-50"
      :class="settings.displayQuality === choice.value ? 'border-accent bg-accent-soft' : 'border-transparent bg-surface-2'"
      :disabled="choice.value === 'original' && !state.features.displayOriginal"
      :aria-pressed="settings.displayQuality === choice.value"
      @click="emit('quality', choice.value)"
    >
      <span class="min-w-0 flex-1">
        <span class="block text-[15px] font-medium">{{ choice.label }}</span>
        <span class="mt-0.5 block text-[13px] leading-snug text-muted">{{ choice.detail }}</span>
        <span v-if="choice.value === 'original' && !state.features.displayOriginal" class="mt-1 block text-[12px] text-muted">
          Unavailable with this Mac’s current setup.
        </span>
      </span>
      <Check v-if="settings.displayQuality === choice.value" :size="19" class="shrink-0 text-accent" aria-hidden="true" />
    </button>
  </fieldset>
  <RangeRow
    v-if="settings.displayControls !== 'view'"
    v-model="settings.displaySplit"
    label="Preview space"
    :min="0.3"
    :max="0.7"
    :step="0.01"
    :format="(value) => `${Math.round(value * 100)}%`"
  />
  <p class="mt-3 text-[13px] leading-relaxed text-muted">
    Pinch or drag a zoomed preview to look around. Use the trackpad or keyboard to control the Mac.
  </p>
</template>
