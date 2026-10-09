<script setup lang="ts">
import { CircleAlert, Info, TriangleAlert } from '@lucide/vue'
import { dismiss, state } from '@/lib/connection'
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.25rem)] z-50 flex flex-col items-center gap-2 px-4"
    role="status"
    aria-live="polite"
  >
    <TransitionGroup name="toast">
      <button
        v-for="notice in state.notices"
        :key="notice.id"
        class="pointer-events-auto flex max-w-md items-start gap-2.5 rounded-2xl border border-line bg-surface-2/95 px-4 py-3 text-left text-[14px] leading-snug shadow-xl backdrop-blur"
        @click="dismiss(notice.id)"
      >
        <CircleAlert v-if="notice.level === 'error'" :size="18" class="mt-px shrink-0 text-bad" />
        <TriangleAlert v-else-if="notice.level === 'warning'" :size="18" class="mt-px shrink-0 text-warn" />
        <Info v-else :size="18" class="mt-px shrink-0 text-muted" />
        <span>{{ notice.message }}</span>
      </button>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 200ms ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
