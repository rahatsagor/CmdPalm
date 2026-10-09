<script setup lang="ts">
import { Mouse, Plus } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { MEDIA } from '@/lib/actions'
import { labels } from '@/lib/connection'
import { actionLabel, actionName, emptyCells, fits, newId, type CustomKey, type CustomKeyboard } from '@/lib/customKeyboards'
import { haptic } from '@/lib/haptics'
import { buttonDown, buttonUp, keyDown, keyUp, modifiers, pressMedia } from '@/lib/input'
import { Key, MOD_ORDER } from '@/lib/keys'
import { symbol } from '@/lib/symbols'
import { useTouchKeys } from '@/lib/touchKeys'
import CustomKeyEditor from './CustomKeyEditor.vue'

const props = defineProps<{ board: CustomKeyboard; editing: boolean }>()

const root = ref<HTMLElement>()
const size = ref({ width: 0, height: 0 })
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const GAP = 6
const cell = computed(() => {
  const { cols, rows } = props.board
  return {
    width: (size.value.width - GAP * (cols - 1)) / cols,
    height: (size.value.height - GAP * (rows - 1)) / rows,
  }
})
const vars = computed(() => {
  const side = Math.min(cell.value.width, cell.value.height)
  const clamp = (v: number, lo: number, hi: number) => `${Math.round(Math.min(hi, Math.max(lo, v)))}px`
  return { '--gap': `${GAP}px`, '--f-key': clamp(side * 0.3, 12, 30), '--f-small': clamp(side * 0.17, 10, 15) }
})

const place = (rect: Pick<CustomKey, 'x' | 'y' | 'w' | 'h'>) => ({
  gridColumn: `${rect.x + 1} / span ${rect.w}`,
  gridRow: `${rect.y + 1} / span ${rect.h}`,
})

function face(key: CustomKey): { text: string; icon?: unknown; caption?: string } {
  const action = key.action
  const custom = key.label?.trim()
  if (action.kind === 'media') {
    return { text: custom ?? '', icon: symbol(MEDIA[action.key].symbol), caption: custom ? undefined : MEDIA[action.key].label }
  }
  if (action.kind === 'mouse') return { text: custom || actionLabel(action, labels.value), icon: Mouse }
  if (action.kind === 'mod') {
    const mod = MOD_ORDER.find((m) => m.mod === action.mod)
    return { text: custom || (mod?.symbol ?? '?'), caption: custom ? undefined : mod?.name.toLowerCase() }
  }
  if (custom) return { text: custom, caption: actionLabel(action, labels.value) }
  const text = actionLabel(action, labels.value)
  return { text: [...text].length === 1 ? text.toUpperCase() : text }
}

function modClass(key: CustomKey) {
  if (key.action.kind !== 'mod') return ''
  const status = modifiers.status(key.action.mod)
  return status === 'locked' ? 'is-locked' : status === 'latched' ? 'is-latched' : status === 'held' ? 'is-down' : ''
}

/** Pointer id → the key it holds and how to let it go. */
const held = reactive(new Map<number, { id: string; release: (cancelled: boolean) => void }>())
const down = computed(() => new Set([...held.values()].map((h) => h.id)))

function press(key: CustomKey, pointerId: number) {
  const action = key.action
  switch (action.kind) {
    case 'key':
      keyDown(pointerId, action.code, action.mods)
      return () => keyUp(pointerId)
    case 'mod':
      modifiers.press(pointerId, action.mod)
      return (cancelled: boolean) => (cancelled ? modifiers.cancel(pointerId) : modifiers.release(pointerId))
    case 'media': {
      modifiers.consume()
      const stop = pressMedia(action.key)
      return () => stop()
    }
    case 'mouse':
      buttonDown(action.button)
      return () => buttonUp(action.button)
  }
}

const touch = useTouchKeys(root, {
  enabled: () => !props.editing,
  down(id, pointerId) {
    const key = props.board.keys.find((k) => k.id === id)
    if (!key) return
    haptic('select')
    held.set(pointerId, { id, release: press(key, pointerId) })
  },
  up(pointerId, cancelled) {
    const h = held.get(pointerId)
    if (!h) return
    held.delete(pointerId)
    h.release(cancelled)
  },
})

// A different board or edit mode must not leave keys down on the Mac, or a
// drag half done.
watch(
  () => [props.board.id, props.editing],
  () => {
    touch.releaseAll()
    touch.invalidate()
    drag.value = null
  },
)
watch(
  () => props.board.keys.map((k) => `${k.x},${k.y},${k.w},${k.h}`).join(' ') + `${props.board.cols}x${props.board.rows}`,
  () => touch.invalidate(),
)

const editingKey = ref<{ key: CustomKey; isNew: boolean } | null>(null)
const empty = computed(() => (props.editing ? emptyCells(props.board) : []))

interface Drag {
  pointerId: number
  key: CustomKey
  startX: number
  startY: number
  /** Which cell of the key the finger grabbed. */
  grabX: number
  grabY: number
  moved: boolean
  target: { x: number; y: number }
}
const drag = ref<Drag | null>(null)

function cellAt(clientX: number, clientY: number) {
  const rect = root.value!.getBoundingClientRect()
  const { cols, rows } = props.board
  const col = Math.floor(((clientX - rect.left + GAP / 2) / (rect.width + GAP)) * cols)
  const row = Math.floor(((clientY - rect.top + GAP / 2) / (rect.height + GAP)) * rows)
  return { x: Math.min(cols - 1, Math.max(0, col)), y: Math.min(rows - 1, Math.max(0, row)) }
}

function onEditDown(key: CustomKey, event: PointerEvent) {
  if (drag.value || (event.pointerType === 'mouse' && event.button !== 0)) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  const at = cellAt(event.clientX, event.clientY)
  drag.value = {
    pointerId: event.pointerId,
    key,
    startX: event.clientX,
    startY: event.clientY,
    grabX: Math.min(key.w - 1, Math.max(0, at.x - key.x)),
    grabY: Math.min(key.h - 1, Math.max(0, at.y - key.y)),
    moved: false,
    target: { x: key.x, y: key.y },
  }
}

function onEditMove(event: PointerEvent) {
  const d = drag.value
  if (!d || d.pointerId !== event.pointerId) return
  if (!d.moved && Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < 8) return
  d.moved = true
  const at = cellAt(event.clientX, event.clientY)
  const target = {
    x: Math.min(props.board.cols - d.key.w, Math.max(0, at.x - d.grabX)),
    y: Math.min(props.board.rows - d.key.h, Math.max(0, at.y - d.grabY)),
  }
  if (target.x !== d.target.x || target.y !== d.target.y) {
    d.target = target
    haptic('select')
  }
}

function onEditUp(event: PointerEvent, cancelled = false) {
  const d = drag.value
  if (!d || d.pointerId !== event.pointerId) return
  drag.value = null
  if (cancelled) return
  if (!d.moved) {
    editingKey.value = { key: d.key, isNew: false }
    return
  }
  if (dropFits(d)) Object.assign(d.key, d.target)
  else haptic('heavy')
}

const dropFits = (d: Drag) => fits(props.board, { ...d.target, w: d.key.w, h: d.key.h }, d.key.id)

function addAt(x: number, y: number) {
  editingKey.value = { key: { id: newId(), x, y, w: 1, h: 1, action: { kind: 'key', code: Key.Space, mods: 0 } }, isNew: true }
}

function saveKey(key: CustomKey) {
  const edit = editingKey.value
  editingKey.value = null
  if (!edit) return
  const index = props.board.keys.findIndex((k) => k.id === key.id)
  if (index >= 0) props.board.keys[index] = key
  else props.board.keys.push(key)
}

function removeKey() {
  const edit = editingKey.value
  editingKey.value = null
  if (!edit) return
  const index = props.board.keys.findIndex((k) => k.id === edit.key.id)
  if (index >= 0) props.board.keys.splice(index, 1)
}
</script>

<template>
  <div
    ref="root"
    class="board grid h-full w-full touch-none select-none"
    :style="{ ...vars, gridTemplateColumns: `repeat(${board.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${board.rows}, minmax(0, 1fr))` }"
    role="group"
    :aria-label="board.name"
  >
    <button
      v-for="c in empty"
      :key="`${c.x},${c.y}`"
      type="button"
      class="grid place-items-center rounded-xl border border-dashed border-line-strong text-faint active:bg-surface-2"
      :style="place({ ...c, w: 1, h: 1 })"
      aria-label="Add key here"
      @click="addAt(c.x, c.y)"
    >
      <Plus :size="20" />
    </button>

    <div
      v-for="key in board.keys"
      :key="key.id"
      :data-key="editing ? undefined : key.id"
      role="button"
      class="key"
      :class="[
        down.has(key.id) && 'is-down',
        modClass(key),
        editing && 'is-editing',
        drag?.moved && drag.key.id === key.id && 'opacity-25',
      ]"
      :style="place(key)"
      :aria-label="key.label || actionName(key.action) || actionLabel(key.action, labels)"
      @pointerdown="editing && onEditDown(key, $event)"
      @pointermove="editing && onEditMove($event)"
      @pointerup="onEditUp($event)"
      @pointercancel="onEditUp($event, true)"
      @lostpointercapture="onEditUp($event, true)"
    >
      <component :is="face(key).icon" v-if="face(key).icon" class="icon" :stroke-width="1.7" />
      <span v-if="face(key).text" class="text">{{ face(key).text }}</span>
      <span v-if="face(key).caption" class="caption">{{ face(key).caption }}</span>
      <span v-if="key.action.kind === 'mod' && modifiers.status(key.action.mod) === 'locked'" class="lock-dot" />
    </div>

    <div
      v-if="drag?.moved"
      class="drop pointer-events-none rounded-xl border-2"
      :class="dropFits(drag) ? 'border-accent bg-accent-soft' : 'border-bad bg-bad/15'"
      :style="place({ ...drag.target, w: drag.key.w, h: drag.key.h })"
    />

    <p v-if="!editing && board.keys.length === 0" class="col-span-full row-span-full self-center text-center text-[15px] text-muted">
      No keys yet. Tap Edit to add some.
    </p>
  </div>

  <CustomKeyEditor
    v-if="editingKey"
    :board="board"
    :key-def="editingKey.key"
    :is-new="editingKey.isNew"
    @save="saveKey"
    @remove="removeKey"
    @close="editingKey = null"
  />
</template>

<style scoped>
.board {
  gap: var(--gap);
}

.key {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.3em;
  overflow: hidden;
  padding: 4px;
  border-radius: 12px;
  background: linear-gradient(to bottom, var(--key-top), var(--key));
  box-shadow:
    inset 0 0.5px 0 rgb(255 255 255 / 0.07),
    0 1px 0 rgb(0 0 0 / 0.5);
  color: var(--text);
  line-height: 1.1;
  text-align: center;
  transition: background-color 60ms;
}
:root[data-theme='light'] .key {
  box-shadow:
    0 0 0 0.5px rgb(0 0 0 / 0.08),
    0 1px 0 rgb(0 0 0 / 0.18);
}
.key.is-down {
  background: var(--key-down);
  transform: translateY(0.5px);
}
.key.is-latched {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent);
}
.key.is-locked {
  background: var(--accent);
  color: var(--accent-text);
}
.key.is-editing {
  outline: 1px dashed var(--line-strong);
  outline-offset: -1px;
  cursor: grab;
}

.text {
  max-width: 100%;
  font-size: var(--f-key);
  overflow-wrap: anywhere;
}
.caption {
  max-width: 100%;
  overflow: hidden;
  font-size: var(--f-small);
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icon {
  width: calc(var(--f-key) * 1.1);
  height: calc(var(--f-key) * 1.1);
  flex-shrink: 0;
}

.drop {
  z-index: 1;
}

.lock-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.8;
}
</style>
