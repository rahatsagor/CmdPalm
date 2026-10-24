<script setup lang="ts">
import { computed, ref } from 'vue'
import { labels } from '@/lib/connection'
import { MOD_ORDER, SPECIAL_KEYS, comboLabel, fromDomCode, keyName } from '@/lib/keys'
import { Mod } from '@/lib/protocol'

const model = defineModel<{ code: number; mods: number; char?: string }>({ required: true })

const input = ref<HTMLInputElement>()
const listening = ref(false)
const preview = computed(() => comboLabel(model.value.code, model.value.mods, labels.value))
/** A typed key (a letter, digit or symbol) has no button below, so the field shows it as chosen. */
const typedKey = computed(() => (SPECIAL_KEYS.some((k) => k.code === model.value.code) ? '' : keyName(model.value.code, labels.value)))
const prompt = computed(() => {
  if (listening.value) return 'Press a key…'
  return typedKey.value ? `${typedKey.value} · tap to change` : 'Tap, then type a key'
})

function toggleMod(mod: number) {
  model.value = { ...model.value, mods: model.value.mods ^ mod }
}

function setKey(code: number, extraMods = 0, char?: string) {
  model.value = { code, mods: model.value.mods | extraMods, ...(char ? { char } : {}) }
}

// Hardware keyboards (iPad) report the key position and modifiers directly.
function onKeydown(event: KeyboardEvent) {
  const code = fromDomCode(event.code)
  if (code === undefined) return
  event.preventDefault()
  const mods =
    (event.metaKey ? Mod.Command : 0) | (event.shiftKey ? Mod.Shift : 0) | (event.altKey ? Mod.Option : 0) | (event.ctrlKey ? Mod.Control : 0)
  model.value = { code, mods: mods || model.value.mods }
  input.value?.blur()
}

// Software keyboards only report the character; find the key that types it.
function onInput(event: Event) {
  const target = event.target as HTMLInputElement
  const ch = [...target.value].at(-1)
  target.value = ''
  if (!ch) return
  const key = labels.value.forChar(ch)
  if (key) setKey(key.code, key.mods, ch)
  input.value?.blur()
}
</script>

<template>
  <div>
    <div class="flex items-center gap-3">
      <div class="grid h-14 min-w-24 flex-1 place-items-center rounded-2xl border border-line bg-surface-2 font-mono text-[22px] tracking-wide">
        {{ preview }}
      </div>
    </div>

    <div class="mt-3 grid grid-cols-5 gap-1.5">
      <button
        v-for="m in MOD_ORDER"
        :key="m.mod"
        type="button"
        class="h-11 rounded-xl text-[17px] transition-colors"
        :class="model.mods & m.mod ? 'bg-accent text-accent-text' : 'bg-surface-3 text-muted'"
        :aria-label="m.name"
        :aria-pressed="(model.mods & m.mod) !== 0"
        @click="toggleMod(m.mod)"
      >
        {{ m.symbol }}
      </button>
    </div>

    <label class="mt-3 block">
      <input
        ref="input"
        class="h-11 w-full rounded-xl border px-3 text-center text-[15px] outline-none focus:border-accent"
        :class="
          typedKey && !listening
            ? 'border-accent/60 bg-accent-soft font-medium placeholder:text-accent'
            : 'border-dashed border-line-strong bg-transparent placeholder:text-muted'
        "
        :placeholder="prompt"
        :aria-label="typedKey ? `Key: ${typedKey}. Tap, then type a different key` : 'Tap, then type a key'"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        @focus="listening = true"
        @blur="listening = false"
        @keydown="onKeydown"
        @input="onInput"
      />
    </label>

    <div class="mt-2 flex flex-wrap gap-1.5">
      <button
        v-for="key in SPECIAL_KEYS"
        :key="key.code"
        type="button"
        class="h-8 rounded-lg px-2.5 text-[12px] font-medium transition-colors"
        :class="model.code === key.code ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted'"
        @click="setKey(key.code)"
      >
        {{ key.label }}
      </button>
    </div>
  </div>
</template>
