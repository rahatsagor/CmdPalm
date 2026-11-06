<script setup lang="ts">
import { Check, Pencil, Plus, RotateCcwSquare, RotateCwSquare } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BoardEditor from '@/components/BoardEditor.vue'
import Composer from '@/components/Composer.vue'
import CustomKeyboard from '@/components/CustomKeyboard.vue'
import GroupTabs from '@/components/GroupTabs.vue'
import ScrollRail from '@/components/ScrollRail.vue'
import Segmented from '@/components/Segmented.vue'
import Sheet from '@/components/Sheet.vue'
import TrackpadSurface from '@/components/TrackpadSurface.vue'
import VirtualKeyboard from '@/components/VirtualKeyboard.vue'
import { activeBoard, addBoard, blankBoard, copyBoard, keyboards, LIMITS, presets, removeBoard, type CustomKeyboard as Board } from '@/lib/customKeyboards'
import { isTablet } from '@/lib/device'
import { haptic } from '@/lib/haptics'
import { layout } from '@/lib/layout'
import { settings } from '@/lib/settings'

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

type Mode = 'mac' | 'custom' | 'phone'

// "Auto" picks the full Mac keyboard where it fits (tablets, landscape
// phones) and the phone's own keyboard on narrow screens.
const mode = computed<Mode>(() => {
  if (settings.keyboard !== 'auto') return settings.keyboard
  return isTablet() || settings.sidewaysKeyboard || size.value.width >= 560 ? 'mac' : 'phone'
})

const upright = computed(() => size.value.height > size.value.width)
const sideways = computed(() => settings.sidewaysKeyboard && upright.value)
// Laid out at the screen's height and width, then turned to fill it. Touches
// still find their keys: hit testing follows the turn.
const sidewaysStyle = computed(() => ({
  width: `${size.value.height}px`,
  height: `${size.value.width}px`,
  transform: `translate(-50%, -50%) rotate(${settings.sidewaysTurn === 'left' ? 90 : -90}deg)`,
}))

const choice = computed({
  get: () => mode.value,
  set: (value: Mode) => (settings.keyboard = value),
})

// Rows about 1.6 key-widths tall (capped), so portrait phones get keys that
// can actually be hit; what is left goes to a trackpad above, like a laptop.
const macLayout = computed(() => {
  const { width, height } = size.value
  const usable = Math.min(width, 1100)
  const unit = usable / 15.5
  const wanted = 5.72 * Math.min(unit * 1.6, 64) + 5 * 6
  const keys = Math.min(wanted, height * 0.62)
  const pad = height - keys - 8 >= 150
  return { pad, height: pad ? `${Math.round(keys)}px` : '100%' }
})

const board = computed(() => activeBoard())
const editing = ref(false)
const editingBoard = ref(false)
const choosing = ref(false)

watch(mode, () => (editing.value = false))

function select(b: Board) {
  if (b.id === keyboards.active) {
    if (editing.value) editingBoard.value = true
    return
  }
  keyboards.active = b.id
  haptic('select')
}

function selectBoard(id: string) {
  const target = keyboards.boards.find((b) => b.id === id)
  if (target) select(target)
}

function reorderBoards(ids: string[]) {
  const order = new Map(ids.map((id, i) => [id, i]))
  keyboards.boards.sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length))
}

function create(template: Board) {
  choosing.value = false
  if (!addBoard(template)) return
  editing.value = true
  editingBoard.value = template.keys.length === 0
}

function duplicate() {
  editingBoard.value = false
  addBoard(copyBoard(board.value))
}

function remove() {
  editingBoard.value = false
  removeBoard(board.value.id)
}

// Keys and trackpad share the space; keys keep roughly square cells.
const customLayout = computed(() => {
  const { width, height } = size.value
  const { cols, rows, trackpad } = board.value
  if (!trackpad) return { direction: 'col' as const, style: { flex: '1 1 0%' } }
  if (width > height * 1.2) {
    const keys = Math.min(width * 0.6, (height / rows) * cols)
    return { direction: 'row' as const, style: { width: `${Math.round(keys)}px` } }
  }
  const keys = Math.min(height * 0.6, (width / cols) * rows)
  return { direction: 'col' as const, style: { height: `${Math.round(keys)}px` } }
})
</script>

<template>
  <div class="flex h-full flex-col gap-2 px-2 pb-2" :class="layout.compact ? 'pt-0' : 'pt-1'">
    <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      <div class="flex w-full max-w-xs items-center gap-2">
        <Segmented
          v-model="choice"
          class="min-w-0 flex-1 py-0!"
          :options="[
            { value: 'mac', label: 'Mac' },
            { value: 'custom', label: 'Custom' },
            { value: 'phone', label: 'Type' },
          ]"
        />
        <button
          v-if="mode === 'mac' && upright"
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-full transition-colors"
          :class="settings.sidewaysKeyboard ? 'bg-accent text-accent-text' : 'bg-surface-3 text-muted'"
          :aria-pressed="settings.sidewaysKeyboard"
          aria-label="Sideways keyboard"
          @click="settings.sidewaysKeyboard = !settings.sidewaysKeyboard"
        >
          <RotateCcwSquare v-if="settings.sidewaysTurn === 'left'" :size="17" />
          <RotateCwSquare v-else :size="17" />
        </button>
      </div>
      <div v-if="mode === 'custom'" class="flex min-w-0 flex-1 basis-60 items-center gap-2">
        <GroupTabs :items="keyboards.boards" :active="board.id" :editing="editing" label="Custom keyboards" @select="selectBoard" @reorder="reorderBoards">
          <button
            v-if="editing && keyboards.boards.length < LIMITS.boards"
            type="button"
            class="grid size-8 shrink-0 place-items-center rounded-full text-muted"
            aria-label="New keyboard"
            @click="choosing = true"
          >
            <Plus :size="17" />
          </button>
        </GroupTabs>
        <button
          type="button"
          class="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors"
          :class="editing ? 'bg-accent text-accent-text' : 'bg-surface-3 text-muted'"
          @click="editing = !editing"
        >
          <Check v-if="editing" :size="15" />
          <Pencil v-else :size="14" />
          {{ editing ? 'Done' : 'Edit' }}
        </button>
      </div>
    </div>

    <div ref="root" class="flex min-h-0 flex-1 flex-col gap-2">
      <div v-if="mode === 'mac' && sideways" class="relative min-h-0 flex-1 overflow-hidden">
        <div class="absolute top-1/2 left-1/2" :style="sidewaysStyle">
          <VirtualKeyboard />
        </div>
      </div>
      <template v-else-if="mode === 'mac'">
        <TrackpadSurface v-if="macLayout.pad" class="min-h-0 flex-1">
          <ScrollRail v-if="settings.scrollStrip !== 'off'" />
        </TrackpadSurface>
        <div class="mx-auto w-full max-w-[1100px] shrink-0" :style="{ height: macLayout.height }">
          <VirtualKeyboard />
        </div>
      </template>

      <template v-else-if="mode === 'custom'">
        <div class="flex min-h-0 flex-1 gap-2" :class="customLayout.direction === 'row' ? 'flex-row' : 'flex-col'">
          <TrackpadSurface
            v-if="board.trackpad"
            class="min-h-0 min-w-0 flex-1"
            :edge="customLayout.direction === 'col' || settings.scrollStripSide === 'left'"
          >
            <ScrollRail v-if="settings.scrollStrip !== 'off'" />
          </TrackpadSurface>
          <div class="min-h-0 min-w-0 shrink-0" :style="customLayout.style">
            <CustomKeyboard :board="board" :editing="editing" />
          </div>
        </div>
        <p v-if="editing" class="shrink-0 text-center text-[12px] text-faint">
          Drag tabs to reorder keyboards. Tap the selected tab to edit it. Tap a key to change it, or drag keys to move them.
        </p>
      </template>

      <div v-else class="flex min-h-0 flex-1 flex-col justify-end">
        <TrackpadSurface class="mb-2 min-h-24 flex-1">
          <ScrollRail v-if="settings.scrollStrip !== 'off'" />
        </TrackpadSurface>
        <Composer />
      </div>
    </div>

    <BoardEditor v-if="editingBoard" :board="board" @duplicate="duplicate" @remove="remove" @close="editingBoard = false" />

    <Sheet v-if="choosing" title="New keyboard" @close="choosing = false">
      <button type="button" class="mb-2 flex min-h-14 w-full items-center gap-3 rounded-2xl bg-surface-2 px-4 text-left" @click="create(blankBoard())">
        <Plus :size="18" class="text-accent" />
        <span class="flex-1">
          <span class="block text-[15px]">Blank</span>
          <span class="block text-[13px] text-muted">An empty grid to fill with your own keys</span>
        </span>
      </button>
      <h3 class="pt-3 pb-1 text-[13px] font-medium tracking-wide text-muted uppercase">Start from</h3>
      <button
        v-for="p in presets()"
        :key="p.name"
        type="button"
        class="mb-2 flex min-h-14 w-full items-center gap-3 rounded-2xl bg-surface-2 px-4 text-left"
        @click="create(p)"
      >
        <span class="flex-1">
          <span class="block text-[15px]">{{ p.name }}</span>
          <span class="block text-[13px] text-muted">{{ p.keys.length }} keys{{ p.trackpad ? ' and a trackpad' : '' }}</span>
        </span>
      </button>
    </Sheet>
  </div>
</template>
