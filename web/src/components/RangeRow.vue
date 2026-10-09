<script setup lang="ts">
import { computed } from 'vue'

const model = defineModel<number>({ required: true })
const props = withDefaults(defineProps<{ label: string; min: number; max: number; step?: number; format?: (v: number) => string }>(), {
  step: 0.05,
})
const fill = computed(() => `${((model.value - props.min) / (props.max - props.min)) * 100}%`)
</script>

<template>
  <label class="block py-2">
    <span class="flex items-baseline justify-between text-[15px]">
      <span>{{ label }}</span>
      <span class="text-[13px] text-muted tabular-nums">{{ format ? format(model) : model.toFixed(1) }}</span>
    </span>
    <input
      v-model.number="model"
      class="slider mt-1"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :style="{ '--fill': fill }"
    />
  </label>
</template>
