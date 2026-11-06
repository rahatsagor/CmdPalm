<script setup lang="ts">
import { GripVertical, Pencil } from '@lucide/vue'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { haptic } from '@/lib/haptics'

const props = defineProps<{ items: { id: string; name: string }[]; active: string; editing: boolean; label: string }>()
const emit = defineEmits<{ select: [id: string]; reorder: [ids: string[]] }>()
const strip = ref<HTMLElement>()
const drag = ref<{ pointer: number; id: string; startX: number; startY: number; x: number; moved: boolean; ids: string[] } | null>(null)
let frame = 0
let suppressClick = false

const items = computed(() => {
  if (!drag.value) return props.items
  const byId = new Map(props.items.map((item) => [item.id, item]))
  return drag.value.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
})

async function revealSelected() {
  await nextTick()
  if (!drag.value) strip.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
}
watch(() => props.active, revealSelected, { immediate: true })
onActivated(revealSelected)

function down(id: string, event: PointerEvent) {
  suppressClick = false
  if (!props.editing || props.items.length < 2 || drag.value || (event.pointerType === 'mouse' && event.button !== 0) || event.isPrimary === false) return
  drag.value = { pointer: event.pointerId, id, startX: event.clientX, startY: event.clientY, x: event.clientX, moved: false, ids: props.items.map((item) => item.id) }
  window.addEventListener('pointerup', released)
  window.addEventListener('pointercancel', cancelled)
  document.addEventListener('visibilitychange', hidden)
}

function reorderAtPointer() {
  const current = drag.value
  if (!current?.moved || !strip.value) return
  const others = Array.from(strip.value.querySelectorAll<HTMLElement>('[data-group-id]')).filter((el) => el.dataset.groupId !== current.id)
  const at = others.filter((el) => {
    const rect = el.getBoundingClientRect()
    return current.x > rect.left + rect.width / 2
  }).length
  const ids = current.ids.filter((id) => id !== current.id)
  ids.splice(at, 0, current.id)
  if (ids.join('\0') !== current.ids.join('\0')) {
    current.ids = ids
    haptic('select')
  }
}

function autoScroll() {
  const el = strip.value
  const current = drag.value
  if (!el || !current?.moved) return
  const rect = el.getBoundingClientRect()
  const edge = 36
  const speed = current.x < rect.left + edge ? -Math.min(10, (rect.left + edge - current.x) / 3) : current.x > rect.right - edge ? Math.min(10, (current.x - rect.right + edge) / 3) : 0
  if (speed) {
    el.scrollLeft += speed
    reorderAtPointer()
  }
  frame = requestAnimationFrame(autoScroll)
}

function move(event: PointerEvent) {
  const current = drag.value
  if (!current || current.pointer !== event.pointerId) return
  current.x = event.clientX
  if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 7) {
    current.moved = true
    // Capture only once dragging starts, so a tap still clicks its tab.
    // The strip stays in place when its tabs move in the DOM.
    strip.value?.setPointerCapture(event.pointerId)
    haptic('light')
    frame = requestAnimationFrame(autoScroll)
  }
  if (current.moved) {
    event.preventDefault()
    reorderAtPointer()
  }
}

function finish(save: boolean) {
  const current = drag.value
  drag.value = null
  cancelAnimationFrame(frame)
  window.removeEventListener('pointerup', released)
  window.removeEventListener('pointercancel', cancelled)
  document.removeEventListener('visibilitychange', hidden)
  if (!current) return
  suppressClick = current.moved
  if (strip.value?.hasPointerCapture(current.pointer)) strip.value.releasePointerCapture(current.pointer)
  if (save && current.moved && current.ids.join('\0') !== props.items.map((item) => item.id).join('\0')) emit('reorder', current.ids)
}

function up(event: PointerEvent, save: boolean) {
  if (drag.value?.pointer === event.pointerId) finish(save)
}

const released = (event: PointerEvent) => up(event, true)
const cancelled = (event: PointerEvent) => up(event, false)
const hidden = () => { if (document.visibilityState === 'hidden') finish(true) }

function select(id: string, event: MouseEvent) {
  if (suppressClick && event.detail !== 0) {
    suppressClick = false
    return
  }
  emit('select', id)
}

async function moveWithKeys(id: string, event: KeyboardEvent) {
  if (!props.editing || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const ids = props.items.map((item) => item.id)
  const from = ids.indexOf(id)
  const to = from + (event.key === 'ArrowLeft' ? -1 : 1)
  if (to < 0 || to >= ids.length) return
  ;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
  emit('reorder', ids)
  haptic('select')
  await nextTick()
  Array.from(strip.value?.querySelectorAll<HTMLElement>('[data-group-id]') ?? []).find((el) => el.dataset.groupId === id)?.focus()
}

// Another device can change the deck while it is being dragged. Keep that
// newer list instead of committing a stale order over it.
watch(() => props.items.map((item) => item.id).join('\0'), () => {
  finish(false)
  void revealSelected()
})
watch(() => props.editing, (editing) => { if (!editing) finish(true) })
onDeactivated(() => finish(true))
onBeforeUnmount(() => finish(false))
</script>

<template>
  <div
    ref="strip"
    class="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto"
    role="tablist"
    :aria-label="label"
    @pointermove="move"
    @pointerup="up($event, true)"
    @pointercancel="up($event, false)"
    @lostpointercapture="up($event, false)"
  >
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="tab"
      :data-group-id="item.id"
      :aria-selected="item.id === active"
      :title="editing ? 'Drag to reorder. Alt + Left or Right also moves this tab.' : undefined"
      class="flex h-8 shrink-0 items-center gap-1 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors"
      :class="[
        item.id === active ? 'bg-text text-bg' : 'text-muted',
        editing && 'touch-none select-none',
        drag?.moved && drag.id === item.id && 'ring-2 ring-accent ring-inset opacity-60',
      ]"
      @pointerdown="down(item.id, $event)"
      @click="select(item.id, $event)"
      @keydown="moveWithKeys(item.id, $event)"
      @contextmenu="editing && $event.preventDefault()"
    >
      <GripVertical v-if="editing && items.length > 1" :size="12" class="-ml-1 opacity-60" />
      {{ item.name || 'Untitled' }}
      <Pencil v-if="editing && item.id === active" :size="11" />
    </button>
    <slot />
  </div>
</template>
