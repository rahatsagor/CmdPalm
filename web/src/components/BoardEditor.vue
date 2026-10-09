<script setup lang="ts">
import { Copy, Minus, Plus, Trash2 } from '@lucide/vue'
import { computed, ref } from 'vue'
import { canResize, keyboards, LIMITS, type CustomKeyboard } from '@/lib/customKeyboards'
import Sheet from './Sheet.vue'
import Toggle from './Toggle.vue'

const props = defineProps<{ board: CustomKeyboard }>()
const emit = defineEmits<{ duplicate: []; remove: []; close: [] }>()

const name = ref(props.board.name)
const confirming = ref(false)
const blocked = ref<'cols' | 'rows' | null>(null)

const steppers = computed(() => [
  { axis: 'cols' as const, label: 'Columns', value: props.board.cols, min: LIMITS.minCols, max: LIMITS.maxCols },
  { axis: 'rows' as const, label: 'Rows', value: props.board.rows, min: LIMITS.minRows, max: LIMITS.maxRows },
])

function step(axis: 'cols' | 'rows', by: number) {
  const cols = axis === 'cols' ? props.board.cols + by : props.board.cols
  const rows = axis === 'rows' ? props.board.rows + by : props.board.rows
  if (!canResize(props.board, cols, rows)) {
    blocked.value = axis
    return
  }
  blocked.value = null
  props.board.cols = cols
  props.board.rows = rows
}

function close() {
  props.board.name = name.value.trim().slice(0, LIMITS.name) || 'Keyboard'
  emit('close')
}
</script>

<template>
  <Sheet title="Keyboard" @close="close">
    <label class="block py-2">
      <span class="text-[13px] text-muted">Name</span>
      <input
        v-model="name"
        :maxlength="LIMITS.name"
        class="mt-1 h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
        @keydown.enter="close"
      />
    </label>

    <div v-for="s in steppers" :key="s.axis" class="flex items-center justify-between py-3">
      <span class="text-[15px]">{{ s.label }}</span>
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="grid size-9 place-items-center rounded-full bg-surface-3 disabled:opacity-40"
          :disabled="s.value <= s.min"
          :aria-label="`Fewer ${s.label.toLowerCase()}`"
          @click="step(s.axis, -1)"
        >
          <Minus :size="16" />
        </button>
        <span class="w-5 text-center text-[17px] font-semibold tabular-nums">{{ s.value }}</span>
        <button
          type="button"
          class="grid size-9 place-items-center rounded-full bg-surface-3 disabled:opacity-40"
          :disabled="s.value >= s.max"
          :aria-label="`More ${s.label.toLowerCase()}`"
          @click="step(s.axis, 1)"
        >
          <Plus :size="16" />
        </button>
      </div>
    </div>
    <p v-if="blocked" class="pb-2 text-[13px] text-bad">
      Move or delete the keys in the last {{ blocked === 'cols' ? 'column' : 'row' }} first.
    </p>

    <Toggle v-model="board.trackpad" label="Trackpad" hint="Show a trackpad beside the keys, for moving the pointer while you hold them." />

    <div class="flex gap-2 py-3">
      <button
        type="button"
        class="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] disabled:opacity-40"
        :disabled="keyboards.boards.length >= LIMITS.boards"
        @click="emit('duplicate')"
      >
        <Copy :size="16" /> Duplicate
      </button>
      <button
        v-if="keyboards.boards.length > 1"
        type="button"
        class="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-[14px] font-medium"
        :class="confirming ? 'bg-bad text-white' : 'bg-surface-2 text-bad'"
        @click="confirming ? emit('remove') : (confirming = true)"
      >
        <Trash2 :size="16" />
        {{ confirming ? 'Tap again to delete' : 'Delete' }}
      </button>
    </div>

    <button type="button" class="mt-2 h-12 w-full rounded-2xl bg-accent text-[16px] font-semibold text-accent-text" @click="close">Done</button>
  </Sheet>
</template>
