<script setup lang="ts">
import { ArrowLeft, ArrowRight, Minus, Plus, Trash2 } from '@lucide/vue'
import { ref } from 'vue'
import { LIMITS } from '@/lib/deck'
import type { DeckPage } from '@/lib/protocol'
import Sheet from './Sheet.vue'

const props = defineProps<{ page: DeckPage; index: number; count: number }>()
const emit = defineEmits<{
  save: [values: { name: string; columns: number }]
  move: [by: number]
  remove: []
  close: []
}>()

const name = ref(props.page.name)
const columns = ref(props.page.columns)
const confirming = ref(false)

function save() {
  emit('save', { name: name.value.trim().slice(0, LIMITS.label) || 'Page', columns: columns.value })
}
</script>

<template>
  <Sheet title="Page" @close="save">
    <label class="block py-2">
      <span class="text-[13px] text-muted">Name</span>
      <input
        v-model="name"
        :maxlength="LIMITS.label"
        class="mt-1 h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
        @keydown.enter="save"
      />
    </label>

    <div class="flex items-center justify-between py-3">
      <span class="text-[15px]">Columns</span>
      <div class="flex items-center gap-3">
        <button type="button" class="grid size-9 place-items-center rounded-full bg-surface-3 disabled:opacity-40" :disabled="columns <= 1" aria-label="Fewer columns" @click="columns--">
          <Minus :size="16" />
        </button>
        <span class="w-5 text-center text-[17px] font-semibold tabular-nums">{{ columns }}</span>
        <button type="button" class="grid size-9 place-items-center rounded-full bg-surface-3 disabled:opacity-40" :disabled="columns >= 8" aria-label="More columns" @click="columns++">
          <Plus :size="16" />
        </button>
      </div>
    </div>

    <div class="flex gap-2 py-3">
      <button type="button" class="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] disabled:opacity-40" :disabled="index === 0" @click="emit('move', -1)">
        <ArrowLeft :size="16" /> Move left
      </button>
      <button
        type="button"
        class="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] disabled:opacity-40"
        :disabled="index === count - 1"
        @click="emit('move', 1)"
      >
        Move right <ArrowRight :size="16" />
      </button>
    </div>

    <button
      v-if="count > 1"
      type="button"
      class="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[14px] font-medium"
      :class="confirming ? 'bg-bad text-white' : 'bg-surface-2 text-bad'"
      @click="confirming ? emit('remove') : (confirming = true)"
    >
      <Trash2 :size="16" />
      {{ confirming ? `Delete “${page.name}” and its ${page.tiles.length} buttons` : 'Delete page' }}
    </button>

    <button type="button" class="mt-4 h-12 w-full rounded-2xl bg-accent text-[16px] font-semibold text-accent-text" @click="save">Done</button>
  </Sheet>
</template>
