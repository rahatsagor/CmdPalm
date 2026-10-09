<script setup lang="ts">
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2, TriangleAlert } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { appNames, loadApps } from '@/lib/apps'
import { ACTION_KINDS, MEDIA, SYSTEM, defaultAction, describe } from '@/lib/actions'
import { labels, state } from '@/lib/connection'
import { LIMITS } from '@/lib/deck'
import type { Action, AppOp, MediaKey, MouseButton, SystemAction } from '@/lib/protocol'
import { settings } from '@/lib/settings'
import { symbol } from '@/lib/symbols'
import AppIcon from './AppIcon.vue'
import AppPicker from './AppPicker.vue'
import Segmented from './Segmented.vue'
import ShortcutField from './ShortcutField.vue'
import Toggle from './Toggle.vue'

const model = defineModel<Action>({ required: true })
const props = withDefaults(defineProps<{ depth?: number; exclude?: Action['kind'][] }>(), { depth: 0, exclude: () => [] })

const kinds = computed(() =>
  ACTION_KINDS.filter((k) => {
    if (k.kind === model.value.kind) return true
    if (props.exclude.includes(k.kind)) return false
    if (k.kind === 'sequence' && props.depth >= LIMITS.depth - 1) return false
    if (k.kind === 'shell' && !state.features.shell) return false
    return !k.advanced || settings.showAdvanced
  }),
)

function setKind(kind: Action['kind']) {
  if (kind !== model.value.kind) model.value = defaultAction(kind)
}

function patch(values: Record<string, unknown>) {
  model.value = { ...model.value, ...values } as Action
}

function groups<K extends string>(meta: Record<K, { label: string; group: string; symbol: string }>) {
  const out = new Map<string, { value: K; label: string; symbol: string }[]>()
  for (const [value, m] of Object.entries(meta) as [K, { label: string; group: string; symbol: string }][]) {
    if (!out.has(m.group)) out.set(m.group, [])
    out.get(m.group)!.push({ value, label: m.label, symbol: m.symbol })
  }
  return out
}
const systemGroups = groups(SYSTEM)
const mediaGroups = groups(MEDIA)

const pickingApp = ref(false)
// App names come from the Mac; fetch them when an app action is shown.
onMounted(() => model.value.kind === 'app' && loadApps())
watch(() => model.value.kind, (kind) => kind === 'app' && loadApps())
const appName = computed(() => (model.value.kind === 'app' ? (appNames.value.get(model.value.id) ?? model.value.id) : ''))

const steps = computed(() => (model.value.kind === 'sequence' ? model.value.steps : []))
const openStep = ref<number | null>(null)

function setSteps(next: Action[]) {
  model.value = { kind: 'sequence', steps: next }
}
function updateStep(index: number, step: Action) {
  const next = [...steps.value]
  next[index] = step
  setSteps(next)
}
function addStep() {
  setSteps([...steps.value, { kind: 'keys', code: 0x08, mods: 1, char: 'c' }])
  openStep.value = steps.value.length - 1
}
function removeStep(index: number) {
  setSteps(steps.value.filter((_, i) => i !== index))
  openStep.value = null
}
function moveStep(index: number, by: number) {
  const next = [...steps.value]
  const target = index + by
  if (target < 0 || target >= next.length) return
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  setSteps(next)
  openStep.value = target
}

const kindOf = (step: Action) => ACTION_KINDS.find((k) => k.kind === step.kind)
</script>

<template>
  <div>
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="k in kinds"
        :key="k.kind"
        type="button"
        class="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors"
        :class="model.kind === k.kind ? 'bg-accent text-accent-text' : 'bg-surface-3 text-muted'"
        @click="setKind(k.kind)"
      >
        <component :is="symbol(k.symbol)" :size="15" />
        {{ k.label }}
      </button>
    </div>

    <div class="mt-3">
      <ShortcutField
        v-if="model.kind === 'keys'"
        :model-value="{ code: model.code, mods: model.mods, char: model.char }"
        @update:model-value="(v) => (model = { kind: 'keys', ...v })"
      />

      <div v-else-if="model.kind === 'system'" class="space-y-3">
        <div v-for="[group, items] in systemGroups" :key="group">
          <div class="mb-1.5 text-[12px] font-medium tracking-wide text-muted uppercase">{{ group }}</div>
          <div class="grid grid-cols-2 gap-1.5">
            <button
              v-for="item in items"
              :key="item.value"
              type="button"
              class="flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[13px] transition-colors"
              :class="model.name === item.value ? 'bg-accent-soft text-accent' : 'bg-surface-2'"
              @click="patch({ name: item.value as SystemAction })"
            >
              <component :is="symbol(item.symbol)" :size="16" class="shrink-0" />
              <span class="truncate">{{ item.label }}</span>
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="model.kind === 'media'" class="space-y-3">
        <div v-for="[group, items] in mediaGroups" :key="group">
          <div class="mb-1.5 text-[12px] font-medium tracking-wide text-muted uppercase">{{ group }}</div>
          <div class="grid grid-cols-2 gap-1.5">
            <button
              v-for="item in items"
              :key="item.value"
              type="button"
              class="flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[13px] transition-colors"
              :class="model.key === item.value ? 'bg-accent-soft text-accent' : 'bg-surface-2'"
              @click="patch({ key: item.value as MediaKey })"
            >
              <component :is="symbol(item.symbol)" :size="16" class="shrink-0" />
              <span class="truncate">{{ item.label }}</span>
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="model.kind === 'app'">
        <button
          v-if="model.id && !pickingApp"
          type="button"
          class="flex w-full items-center gap-3 rounded-2xl bg-surface-2 p-3 text-left"
          @click="pickingApp = true"
        >
          <AppIcon :id="model.id" :size="36" />
          <span class="min-w-0 flex-1 truncate text-[15px]">{{ appName }}</span>
          <span class="text-[13px] text-accent">Change</span>
        </button>
        <AppPicker
          v-else
          :selected="model.id"
          @select="
            (id) => {
              patch({ id })
              pickingApp = false
            }
          "
        />
        <Segmented
          class="mt-2"
          label="When tapped"
          :model-value="model.op ?? 'toggle'"
          :options="[
            { value: 'toggle', label: 'Show / hide' },
            { value: 'open', label: 'Open' },
            { value: 'quit', label: 'Quit' },
          ]"
          @update:model-value="(op: AppOp) => patch({ op })"
        />
      </div>

      <div v-else-if="model.kind === 'text'">
        <textarea
          :value="model.text"
          rows="4"
          :maxlength="LIMITS.text"
          placeholder="Text to type on the Mac"
          class="w-full resize-none rounded-xl border border-line bg-surface-2 p-3 text-[15px] outline-none focus:border-accent"
          @input="patch({ text: ($event.target as HTMLTextAreaElement).value })"
        />
        <Toggle :model-value="!!model.enter" label="Press Return afterwards" @update:model-value="(enter) => patch({ enter })" />
      </div>

      <label v-else-if="model.kind === 'url'" class="block">
        <input
          :value="model.url"
          type="url"
          inputmode="url"
          autocapitalize="off"
          autocorrect="off"
          placeholder="https://example.com"
          class="h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
          @input="patch({ url: ($event.target as HTMLInputElement).value })"
        />
        <span class="mt-1.5 block text-[13px] text-muted">Opens in the Mac’s default app for the link. App links like <code>obsidian://</code> work too.</span>
      </label>

      <label v-else-if="model.kind === 'shortcut'" class="block">
        <input
          :value="model.name"
          placeholder="Shortcut name"
          class="h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
          @input="patch({ name: ($event.target as HTMLInputElement).value })"
        />
        <span class="mt-1.5 block text-[13px] text-muted">The exact name of a shortcut in the Mac’s Shortcuts app.</span>
      </label>

      <div v-else-if="model.kind === 'shell'">
        <textarea
          :value="model.command"
          rows="3"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="open -a Terminal ~/Projects"
          class="w-full resize-none rounded-xl border border-line bg-surface-2 p-3 font-mono text-[14px] outline-none focus:border-accent"
          @input="patch({ command: ($event.target as HTMLTextAreaElement).value })"
        />
        <p class="mt-1.5 flex gap-2 text-[13px] leading-snug text-warn">
          <TriangleAlert :size="15" class="mt-px shrink-0" />
          Runs with your user’s permissions through zsh. Only add commands you understand.
        </p>
      </div>

      <div v-else-if="model.kind === 'mouse'">
        <Segmented
          label="Button"
          :model-value="model.button"
          :options="[
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
            { value: 'middle', label: 'Middle' },
            { value: 'back', label: 'Back' },
            { value: 'forward', label: 'Forward' },
          ]"
          @update:model-value="(button: MouseButton) => patch({ button })"
        />
        <Segmented
          label="Clicks"
          :model-value="String(model.clicks ?? 1)"
          :options="[
            { value: '1', label: 'Single' },
            { value: '2', label: 'Double' },
            { value: '3', label: 'Triple' },
          ]"
          @update:model-value="(clicks: string) => patch({ clicks: Number(clicks) })"
        />
      </div>

      <label v-else-if="model.kind === 'delay'" class="block py-2">
        <span class="flex justify-between text-[15px]">
          <span>Wait</span>
          <span class="text-muted tabular-nums">{{ model.ms < 1000 ? `${model.ms} ms` : `${(model.ms / 1000).toFixed(1)} s` }}</span>
        </span>
        <input
          class="slider mt-1"
          type="range"
          min="50"
          max="5000"
          step="50"
          :value="model.ms"
          :style="{ '--fill': `${((model.ms - 50) / 4950) * 100}%` }"
          @input="patch({ ms: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <div v-else-if="model.kind === 'sequence'" class="space-y-1.5">
        <p class="pb-1 text-[13px] text-muted">Steps run in order. Add short waits between steps for apps that need time to react.</p>
        <div v-for="(step, i) in steps" :key="i" class="overflow-hidden rounded-2xl border border-line bg-surface-2">
          <div class="flex items-center gap-2 px-3 py-2">
            <span class="w-5 text-[12px] text-faint tabular-nums">{{ i + 1 }}</span>
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" @click="openStep = openStep === i ? null : i">
              <component :is="symbol(kindOf(step)?.symbol)" :size="15" class="shrink-0 text-muted" />
              <span class="truncate text-[14px]">{{ describe(step, labels, appNames) }}</span>
              <ChevronDown :size="15" class="shrink-0 text-faint transition-transform" :class="openStep === i && 'rotate-180'" />
            </button>
            <button type="button" class="grid size-7 place-items-center text-muted disabled:opacity-30" :disabled="i === 0" aria-label="Move up" @click="moveStep(i, -1)">
              <ArrowUp :size="15" />
            </button>
            <button
              type="button"
              class="grid size-7 place-items-center text-muted disabled:opacity-30"
              :disabled="i === steps.length - 1"
              aria-label="Move down"
              @click="moveStep(i, 1)"
            >
              <ArrowDown :size="15" />
            </button>
            <button type="button" class="grid size-7 place-items-center text-bad" aria-label="Remove step" @click="removeStep(i)">
              <Trash2 :size="15" />
            </button>
          </div>
          <div v-if="openStep === i" class="border-t border-line p-3">
            <ActionEditor :model-value="step" :depth="depth + 1" @update:model-value="(v) => updateStep(i, v)" />
          </div>
        </div>
        <button
          type="button"
          class="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong text-[14px] text-muted disabled:opacity-40"
          :disabled="steps.length >= LIMITS.steps"
          @click="addStep"
        >
          <Plus :size="16" /> Add step
        </button>
      </div>
    </div>
  </div>
</template>
