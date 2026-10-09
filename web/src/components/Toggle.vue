<script setup lang="ts">
const model = defineModel<boolean>({ required: true })
defineProps<{ label: string; hint?: string; disabled?: boolean }>()
</script>

<template>
  <label class="flex min-h-12 items-center gap-3 py-2" :class="disabled && 'opacity-50'">
    <span class="flex-1">
      <span class="block text-[15px]">{{ label }}</span>
      <span v-if="hint" class="mt-0.5 block text-[13px] leading-snug text-muted">{{ hint }}</span>
    </span>
    <button
      type="button"
      role="switch"
      :aria-checked="model"
      :disabled="disabled"
      class="relative h-[30px] w-[50px] shrink-0 rounded-full transition-colors"
      :class="model ? 'bg-good' : 'bg-surface-3'"
      @click="model = !model"
    >
      <span
        class="absolute top-[2px] left-[2px] size-[26px] rounded-full bg-white shadow transition-transform"
        :class="model && 'translate-x-5'"
      />
    </button>
  </label>
</template>
