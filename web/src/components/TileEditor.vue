<script setup lang="ts">
import { Ban, Copy, Trash2 } from '@lucide/vue'
import { computed, ref } from 'vue'
import { appNames } from '@/lib/apps'
import { describe } from '@/lib/actions'
import { labels } from '@/lib/connection'
import { COLORS, LIMITS, actionProblem, clone } from '@/lib/deck'
import type { Tile, TileIcon } from '@/lib/protocol'
import { SYMBOLS, symbol } from '@/lib/symbols'
import ActionEditor from './ActionEditor.vue'
import Segmented from './Segmented.vue'
import Sheet from './Sheet.vue'
import TileFace from './TileFace.vue'

const props = defineProps<{ tile: Tile; isNew: boolean }>()
const emit = defineEmits<{ save: [tile: Tile]; remove: []; duplicate: []; close: [] }>()

const draft = ref<Tile>(clone(props.tile))
const problem = computed(() => actionProblem(draft.value.action))

type IconMode = 'auto' | 'symbol' | 'emoji'
const iconMode = computed<IconMode>({
  get: () => (!draft.value.icon || draft.value.icon.kind === 'app' ? 'auto' : draft.value.icon.kind),
  set: (mode) => {
    if (mode === 'auto') draft.value.icon = undefined
    else if (mode === 'symbol') draft.value.icon = { kind: 'symbol', name: 'zap' }
    else draft.value.icon = { kind: 'emoji', text: '⭐️' }
  },
})

function setIcon(icon: TileIcon) {
  draft.value.icon = icon
}

function onEmoji(event: Event) {
  const value = (event.target as HTMLInputElement).value
  // Keep the last emoji/character typed (one grapheme).
  const segments = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter().segment(value), (s) => s.segment) : Array.from(value)
  const last = segments.at(-1)
  if (last) setIcon({ kind: 'emoji', text: last })
}

const placeholder = computed(() => describe(draft.value.action, labels.value, appNames.value))
const symbolNames = Object.keys(SYMBOLS)

function save() {
  if (problem.value) return
  const tile = clone(draft.value)
  tile.label = tile.label.trim().slice(0, LIMITS.label)
  if (!tile.color) delete tile.color
  if (!tile.icon) delete tile.icon
  emit('save', tile)
}
</script>

<template>
  <Sheet :title="isNew ? 'New button' : 'Edit button'" full @close="emit('close')">
    <template #actions>
      <button
        type="button"
        class="h-8 rounded-full bg-accent px-4 text-[14px] font-semibold text-accent-text disabled:opacity-40"
        :disabled="!!problem"
        @click="save"
      >
        {{ isNew ? 'Add' : 'Save' }}
      </button>
    </template>

    <div class="flex items-center gap-4 pb-4">
      <div
        class="tile size-24 shrink-0 rounded-[22px] border border-line"
        :style="draft.color ? { background: `color-mix(in srgb, ${draft.color} 22%, var(--surface-2))`, color: draft.color } : {}"
        :class="!draft.color && 'bg-surface-2'"
      >
        <TileFace :tile="draft" compact />
      </div>
      <label class="min-w-0 flex-1">
        <span class="text-[13px] text-muted">Label</span>
        <input
          v-model="draft.label"
          :maxlength="LIMITS.label"
          :placeholder="placeholder"
          class="mt-1 h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
        />
      </label>
    </div>

    <section class="border-t border-line py-4">
      <h3 class="mb-2 text-[13px] font-medium tracking-wide text-muted uppercase">Action</h3>
      <ActionEditor v-model="draft.action" />
      <p v-if="problem" class="mt-2 text-[13px] text-bad">{{ problem }}</p>
    </section>

    <section class="border-t border-line py-4">
      <h3 class="mb-1 text-[13px] font-medium tracking-wide text-muted uppercase">Look</h3>
      <Segmented
        v-model="iconMode"
        :options="[
          { value: 'auto', label: 'Automatic' },
          { value: 'symbol', label: 'Symbol' },
          { value: 'emoji', label: 'Emoji' },
        ]"
      />
      <div v-if="iconMode === 'symbol'" class="mt-2 grid max-h-52 grid-cols-8 gap-1 overflow-y-auto overscroll-contain rounded-2xl bg-surface-2 p-2">
        <button
          v-for="name in symbolNames"
          :key="name"
          type="button"
          class="grid aspect-square place-items-center rounded-lg"
          :class="draft.icon?.kind === 'symbol' && draft.icon.name === name ? 'bg-accent text-accent-text' : 'text-muted'"
          :aria-label="name"
          @click="setIcon({ kind: 'symbol', name })"
        >
          <component :is="symbol(name)" :size="18" />
        </button>
      </div>
      <label v-else-if="iconMode === 'emoji'" class="mt-2 block">
        <input
          :value="draft.icon?.kind === 'emoji' ? draft.icon.text : ''"
          class="h-12 w-full rounded-xl border border-line bg-surface-2 text-center text-[26px] outline-none focus:border-accent"
          aria-label="Emoji"
          @input="onEmoji"
        />
      </label>

      <div class="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
        <button
          type="button"
          role="radio"
          :aria-checked="!draft.color"
          class="grid size-9 place-items-center rounded-full border border-line-strong text-muted"
          :class="!draft.color && 'ring-2 ring-text ring-offset-2 ring-offset-surface'"
          aria-label="No color"
          @click="draft.color = undefined"
        >
          <Ban :size="16" />
        </button>
        <button
          v-for="color in COLORS"
          :key="color"
          type="button"
          role="radio"
          :aria-checked="draft.color === color"
          class="size-9 rounded-full"
          :class="draft.color === color && 'ring-2 ring-text ring-offset-2 ring-offset-surface'"
          :style="{ background: color }"
          :aria-label="color"
          @click="draft.color = color"
        />
      </div>
    </section>

    <section v-if="!isNew" class="flex gap-2 border-t border-line pt-4">
      <button type="button" class="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px]" @click="emit('duplicate')">
        <Copy :size="16" /> Duplicate
      </button>
      <button type="button" class="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] text-bad" @click="emit('remove')">
        <Trash2 :size="16" /> Delete
      </button>
    </section>
  </Sheet>
</template>
