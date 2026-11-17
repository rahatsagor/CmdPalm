<script setup lang="ts">
import { useId } from 'vue'

const model = defineModel<boolean>({ required: true })
defineProps<{ label: string; hint?: string; disabled?: boolean }>()
const hintId = useId()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-label="label"
    :aria-describedby="hint ? hintId : undefined"
    :aria-checked="model"
    :disabled="disabled"
    class="flex min-h-12 w-full items-center gap-3 py-3 text-left disabled:opacity-50"
    @click="model = !model"
  >
    <span class="min-w-0 flex-1">
      <span class="block text-[15px]">{{ label }}</span>
      <span v-if="hint" :id="hintId" class="mt-0.5 block text-[13px] leading-snug text-muted">{{ hint }}</span>
    </span>
    <span
      aria-hidden="true"
      class="relative h-[30px] w-[50px] shrink-0 rounded-full transition-colors"
      :class="model ? 'bg-good' : 'bg-surface-3'"
    >
      <span
        class="absolute top-[2px] left-[2px] size-[26px] rounded-full bg-white shadow transition-transform"
        :class="model && 'translate-x-5'"
      />
    </span>
  </button>
</template>
