<script setup lang="ts">
import { AppWindow } from '@lucide/vue'
import { ref, watch } from 'vue'
import { state } from '@/lib/connection'
import { appIcon, loadAppIcon } from '@/lib/icons'

const props = withDefaults(defineProps<{ id: string; size?: number }>(), { size: 48 })
const failed = ref(false)
const src = ref<string>()
watch(
  () => [props.id, props.size, state.sessionKey] as const,
  ([id, size, key]) => {
    failed.value = false
    src.value = undefined
    if (!id || !key) return
    src.value = appIcon(id, size)
    if (src.value) return
    const current = () => props.id === id && props.size === size && state.sessionKey === key
    loadAppIcon(id, size).then(
      (url) => {
        if (current()) src.value = url
      },
      () => {
        if (current()) failed.value = true
      },
    )
  },
  { immediate: true },
)
</script>

<template>
  <img
    v-if="!failed && src"
    :src="src"
    :width="size"
    :height="size"
    alt=""
    draggable="false"
    class="pointer-events-none select-none"
    @error="failed = true"
  />
  <span v-else-if="!failed && id && state.sessionKey" :style="{ width: `${size}px`, height: `${size}px` }" />
  <span v-else class="grid place-items-center rounded-[22%] bg-surface-3 text-muted" :style="{ width: `${size}px`, height: `${size}px` }">
    <AppWindow :size="size * 0.5" />
  </span>
</template>
