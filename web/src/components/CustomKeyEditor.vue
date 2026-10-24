<script setup lang="ts">
import { Minus, Plus, Trash2 } from '@lucide/vue'
import { computed, ref } from 'vue'
import { MEDIA } from '@/lib/actions'
import { labels } from '@/lib/connection'
import { actionLabel, fits, LIMITS, type CustomAction, type CustomKey, type CustomKeyboard } from '@/lib/customKeyboards'
import { Key, MOD_ORDER, RIGHT_MODS } from '@/lib/keys'
import type { MediaKey, MouseButton } from '@/lib/protocol'
import { symbol } from '@/lib/symbols'
import Segmented from './Segmented.vue'
import Sheet from './Sheet.vue'
import ShortcutField from './ShortcutField.vue'

const props = defineProps<{ board: CustomKeyboard; keyDef: CustomKey; isNew: boolean }>()
const emit = defineEmits<{ save: [key: CustomKey]; remove: []; close: [] }>()

const draft = ref<CustomKey>(JSON.parse(JSON.stringify(props.keyDef)) as CustomKey)

type Kind = CustomAction['kind']
const kind = computed<Kind>({
  get: () => draft.value.action.kind,
  set: (value) => {
    if (value === draft.value.action.kind) return
    draft.value.action =
      value === 'key'
        ? { kind: 'key', code: Key.Space, mods: 0 }
        : value === 'mod'
          ? { kind: 'mod', mod: MOD_ORDER[2]!.mod }
          : value === 'media'
            ? { kind: 'media', key: 'playPause' }
            : { kind: 'mouse', button: 'left' }
  },
})

const shortcut = computed({
  get: () => (draft.value.action.kind === 'key' ? { code: draft.value.action.code, mods: draft.value.action.mods } : { code: Key.Space, mods: 0 }),
  set: (value: { code: number; mods: number }) => {
    draft.value.action = { kind: 'key', code: value.code, mods: value.mods }
  },
})

const mediaKeys = Object.keys(MEDIA) as MediaKey[]
const mouseButtons: { value: MouseButton; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'middle', label: 'Middle' },
]

const room = computed(() => fits(props.board, draft.value, draft.value.id))
const preview = computed(() => draft.value.label?.trim() || actionLabel(draft.value.action, labels.value))

function grow(axis: 'w' | 'h', by: number) {
  const max = axis === 'w' ? props.board.cols - draft.value.x : props.board.rows - draft.value.y
  draft.value[axis] = Math.min(max, Math.max(1, draft.value[axis] + by))
}

function save() {
  if (!room.value) return
  const key = draft.value
  const label = key.label?.trim().slice(0, LIMITS.label)
  if (label) key.label = label
  else delete key.label
  emit('save', key)
}
</script>

<template>
  <Sheet :title="isNew ? 'New key' : 'Edit key'" full @close="emit('close')">
    <template #actions>
      <button
        type="button"
        class="h-8 rounded-full bg-accent px-4 text-[14px] font-semibold text-accent-text disabled:opacity-40"
        :disabled="!room"
        @click="save"
      >
        {{ isNew ? 'Add' : 'Save' }}
      </button>
    </template>

    <div class="flex items-center gap-4 pb-4">
      <div class="grid size-20 shrink-0 place-items-center rounded-2xl border border-line bg-key px-1 text-center text-[17px] leading-tight break-all">
        {{ preview }}
      </div>
      <label class="min-w-0 flex-1">
        <span class="text-[13px] text-muted">Label (optional)</span>
        <input
          v-model="draft.label"
          :maxlength="LIMITS.label"
          :placeholder="actionLabel(draft.action, labels)"
          class="mt-1 h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
        />
      </label>
    </div>

    <section class="border-t border-line py-4">
      <h3 class="mb-1 text-[13px] font-medium tracking-wide text-muted uppercase">Sends</h3>
      <Segmented
        v-model="kind"
        :options="[
          { value: 'key', label: 'Key' },
          { value: 'mod', label: 'Modifier' },
          { value: 'media', label: 'Media' },
          { value: 'mouse', label: 'Mouse' },
        ]"
      />
      <div class="mt-2">
        <template v-if="draft.action.kind === 'key'">
          <ShortcutField v-model="shortcut" />
          <p class="mt-2 text-[13px] text-faint">Held down for as long as you touch it. Turn on modifiers above to send a combination.</p>
        </template>

        <template v-else-if="draft.action.kind === 'mod'">
          <div class="grid grid-cols-5 gap-1.5">
            <button
              v-for="m in [...MOD_ORDER, ...RIGHT_MODS]"
              :key="m.mod"
              type="button"
              class="flex h-12 flex-col items-center justify-center rounded-xl text-[18px] leading-none transition-colors"
              :class="draft.action.mod === m.mod ? 'bg-accent text-accent-text' : 'bg-surface-3 text-muted'"
              :aria-label="m.name"
              @click="draft.action = { kind: 'mod', mod: m.mod }"
            >
              {{ m.symbol }}
              <span v-if="RIGHT_MODS.includes(m)" class="mt-0.5 text-[10px]">right</span>
            </button>
          </div>
          <p class="mt-2 text-[13px] text-faint">
            Pressed on the Mac while you hold it, so it combines with other keys on this keyboard. The bottom row uses the keys on the right side,
            which some apps treat differently, such as a hyper key set to right ⌘.
          </p>
        </template>

        <div v-else-if="draft.action.kind === 'media'" class="grid grid-cols-2 gap-1.5">
          <button
            v-for="media in mediaKeys"
            :key="media"
            type="button"
            class="flex h-11 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors"
            :class="draft.action.key === media ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-text'"
            @click="draft.action = { kind: 'media', key: media }"
          >
            <component :is="symbol(MEDIA[media].symbol)" :size="16" class="shrink-0" />
            <span class="truncate">{{ MEDIA[media].label }}</span>
          </button>
        </div>

        <template v-else>
          <Segmented
            :model-value="draft.action.button"
            :options="mouseButtons"
            @update:model-value="(button: MouseButton) => (draft.action = { kind: 'mouse', button })"
          />
          <p class="text-[13px] text-faint">The button stays down while you hold the key, so you can drag on the trackpad.</p>
        </template>
      </div>
    </section>

    <section class="border-t border-line py-4">
      <h3 class="mb-2 text-[13px] font-medium tracking-wide text-muted uppercase">Size</h3>
      <div class="grid grid-cols-2 gap-3">
        <div v-for="axis in ['w', 'h'] as const" :key="axis" class="flex items-center justify-between rounded-xl bg-surface-2 px-2 py-1.5">
          <button type="button" class="grid size-9 place-items-center rounded-lg text-muted active:bg-surface-3" :aria-label="`Smaller ${axis === 'w' ? 'width' : 'height'}`" @click="grow(axis, -1)">
            <Minus :size="17" />
          </button>
          <span class="text-[14px] tabular-nums">{{ axis === 'w' ? 'Width' : 'Height' }} {{ draft[axis] }}</span>
          <button type="button" class="grid size-9 place-items-center rounded-lg text-muted active:bg-surface-3" :aria-label="`Larger ${axis === 'w' ? 'width' : 'height'}`" @click="grow(axis, 1)">
            <Plus :size="17" />
          </button>
        </div>
      </div>
      <p v-if="!room" class="mt-2 text-[13px] text-bad">Another key is in the way. Make this key smaller, or move the other key first.</p>
      <p v-else class="mt-2 text-[13px] text-faint">To move a key, drag it on the keyboard while editing.</p>
    </section>

    <section v-if="!isNew" class="border-t border-line pt-4">
      <button type="button" class="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] text-bad" @click="emit('remove')">
        <Trash2 :size="16" /> Delete key
      </button>
    </section>
  </Sheet>
</template>
