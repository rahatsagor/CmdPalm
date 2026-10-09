<script setup lang="ts" generic="T extends string">
const model = defineModel<T>({ required: true })
defineProps<{ options: { value: T; label: string }[]; label?: string }>()
</script>

<template>
  <div class="py-2">
    <div v-if="label" class="mb-2 text-[15px]">{{ label }}</div>
    <div class="flex rounded-xl bg-surface-3 p-0.5" role="radiogroup" :aria-label="label">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="radio"
        :aria-checked="model === option.value"
        class="min-h-9 flex-1 rounded-[10px] px-2 text-[13px] font-medium transition-colors"
        :class="model === option.value ? 'bg-surface text-text shadow-sm' : 'text-muted'"
        @click="model = option.value"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>
