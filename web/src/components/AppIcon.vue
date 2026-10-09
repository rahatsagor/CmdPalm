<script setup lang="ts">
import { AppWindow } from '@lucide/vue'
import { ref, watch } from 'vue'
import { iconUrl, state } from '@/lib/connection'

const props = withDefaults(defineProps<{ id: string; size?: number }>(), { size: 48 })
const failed = ref(false)
watch(() => [props.id, state.sessionKey], () => (failed.value = false))
</script>

<template>
  <img
    v-if="!failed && id && state.sessionKey"
    :src="iconUrl(id, size)"
    :width="size"
    :height="size"
    alt=""
    draggable="false"
    class="pointer-events-none select-none"
    @error="failed = true"
  />
  <span v-else class="grid place-items-center rounded-[22%] bg-surface-3 text-muted" :style="{ width: `${size}px`, height: `${size}px` }">
    <AppWindow :size="size * 0.5" />
  </span>
</template>
