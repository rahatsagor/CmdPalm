<script setup lang="ts">
import { X } from '@lucide/vue'
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(defineProps<{ title?: string; full?: boolean; closable?: boolean }>(), { closable: true })
const emit = defineEmits<{ close: [] }>()

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.closable) emit('close')
}
onMounted(() => addEventListener('keydown', onKey))
onBeforeUnmount(() => removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-[2px]" @click="closable && emit('close')" />
      <section
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        class="sheet relative flex w-full flex-col overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl sm:max-w-lg sm:rounded-3xl"
        :class="full ? 'h-[92dvh]' : 'max-h-[88dvh]'"
      >
        <header v-if="title || $slots.actions" class="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
          <h2 class="flex-1 truncate text-[17px] font-semibold">{{ title }}</h2>
          <slot name="actions" />
          <button
            v-if="closable"
            class="grid size-8 place-items-center rounded-full bg-surface-3 text-muted active:scale-95"
            aria-label="Close"
            @click="emit('close')"
          >
            <X :size="17" />
          </button>
        </header>
        <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <slot />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet {
  animation: rise 220ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
@keyframes rise {
  from {
    transform: translateY(24px);
    opacity: 0;
  }
}
</style>
