<script lang="ts">
/** Open sheets, newest last: keys only go to the top one. */
const stack: symbol[] = []
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
</script>

<script setup lang="ts">
import { X } from '@lucide/vue'
import { onBeforeMount, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ title?: string; full?: boolean; closable?: boolean }>(), { closable: true })
const emit = defineEmits<{ close: [] }>()

const dialog = ref<HTMLElement>()
const id = Symbol('sheet')

function onKey(event: KeyboardEvent) {
  if (stack.at(-1) !== id || !dialog.value) return
  if (event.key === 'Escape') {
    if (props.closable) emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const items = Array.from(dialog.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
  const first = items[0]
  const last = items.at(-1)
  const active = document.activeElement
  if (!first || !last) {
    event.preventDefault()
  } else if (event.shiftKey ? active === first || active === dialog.value : active === last) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (!dialog.value.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

// Before children mount, so a nested sheet stacks above its parent and the
// opener isn't a field inside this sheet that took focus on mount.
let opener: Element | null = null
onBeforeMount(() => {
  stack.push(id)
  opener = document.activeElement
})
onMounted(() => {
  // A field inside may already have taken focus.
  if (!dialog.value?.contains(document.activeElement)) dialog.value?.focus({ preventScroll: true })
  addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  stack.splice(stack.indexOf(id), 1)
  removeEventListener('keydown', onKey)
  if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-[2px]" @click="closable && emit('close')" />
      <section
        ref="dialog"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        class="sheet relative flex w-full outline-none flex-col overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl sm:max-w-lg sm:rounded-3xl"
        :class="full ? 'h-[92dvh]' : 'max-h-[88dvh]'"
      >
        <header v-if="title || $slots.actions" class="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
          <h2 class="flex-1 truncate text-[17px] font-semibold">{{ title }}</h2>
          <slot name="actions" />
          <button
            v-if="closable"
            type="button"
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
