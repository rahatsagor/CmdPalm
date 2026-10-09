<script setup lang="ts">
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, CornerDownLeft, Delete, Eraser, Mic, Send, Square } from '@lucide/vue'
import { computed, onBeforeUnmount, onDeactivated, ref } from 'vue'
import { send, state } from '@/lib/connection'
import { haptic } from '@/lib/haptics'
import { useHeldPointers } from '@/lib/heldPointers'
import { edit, keyDown, keyUp, modifiers, tap, tapChar, typeText } from '@/lib/input'
import { Key } from '@/lib/keys'
import { settings } from '@/lib/settings'
import { diff, graphemes } from '@/lib/text'
import { startVoice, stopVoice, voice, voiceSupported } from '@/lib/voice'
import ModifierStrip from './ModifierStrip.vue'

withDefaults(defineProps<{ autofocus?: boolean }>(), { autofocus: false })

const field = ref<HTMLTextAreaElement>()
const text = ref('')
/** What the Mac has received from this field in live mode. */
let sent = ''
let composing = false

const live = computed(() => settings.liveTyping)
// Long sessions would make every diff slower and Delete key bursts larger.
const MAX_LIVE = 2000

function syncLive() {
  if (!live.value || composing) return
  const next = text.value
  const change = diff(sent, next)
  if (change.delete === 0 && !change.insert) return
  // A waiting one-shot modifier turns a single typed character into a shortcut.
  if (modifiers.pending() && change.delete === 0 && graphemes(change.insert).length === 1 && tapChar(change.insert)) {
    text.value = sent
    return
  }
  modifiers.clearLatched()
  edit(change.delete, change.insert)
  sent = next
  if (graphemes(sent).length > MAX_LIVE) reset()
}

function reset() {
  text.value = ''
  sent = ''
}

function onBeforeInput(event: InputEvent) {
  if (!live.value) return
  // Delete / Return on an empty field still reach the Mac.
  if (event.inputType === 'deleteContentBackward' && text.value === '') {
    event.preventDefault()
    tap(Key.Delete)
  } else if ((event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') && !composing) {
    event.preventDefault()
    tap(Key.Return)
    reset()
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || composing) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (live.value) {
      tap(Key.Return)
      reset()
    } else submit()
  } else if (event.key === 'Backspace' && text.value === '' && live.value) {
    event.preventDefault()
    tap(Key.Delete)
  }
}

function submit(withReturn = false) {
  const value = text.value
  if (value) typeText(value)
  if (withReturn) tap(Key.Return)
  reset()
  haptic('light')
}

function toggleLive() {
  settings.liveTyping = !settings.liveTyping
  // Whatever is in the field goes to the Mac now; after that the field
  // starts fresh in either mode.
  if (settings.liveTyping) {
    sent = ''
    syncLive()
  }
  reset()
}

function onCompositionEnd() {
  composing = false
  syncLive()
}

const voiceOk = computed(() => state.features.voice && voiceSupported())

async function toggleVoice() {
  if (voice.active) {
    await stopVoice()
    return
  }
  haptic('medium')
  await startVoice((phrase) => {
    const spaced = text.value && !/\s$/.test(text.value) ? ` ${phrase}` : phrase
    text.value += spaced
    if (live.value) syncLive()
  })
}

// Also cancels a start still waiting for the microphone.
const endVoice = () => void stopVoice()
// Views stay alive when switching tabs; the microphone must not.
onDeactivated(endVoice)
onBeforeUnmount(endVoice)

function pasteFromPhone() {
  navigator.clipboard
    ?.readText()
    .then((value) => {
      if (value) send({ t: 'text', text: value, mode: 'paste' })
    })
    .catch(() => field.value?.focus())
}

const arrows = [
  { code: Key.Left, icon: ArrowLeft, label: 'Left' },
  { code: Key.Down, icon: ArrowDown, label: 'Down' },
  { code: Key.Up, icon: ArrowUp, label: 'Up' },
  { code: Key.Right, icon: ArrowRight, label: 'Right' },
  { code: Key.Delete, icon: Delete, label: 'Delete' },
  { code: Key.Return, icon: CornerDownLeft, label: 'Return' },
]

const fingers = useHeldPointers(keyUp)

function down(code: number, event: PointerEvent) {
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  keyDown(event.pointerId, code)
  fingers.hold(event.pointerId)
  haptic('select')
}

function up(event: PointerEvent) {
  fingers.lift(event.pointerId)
  keyUp(event.pointerId)
}

defineExpose({ focus: () => field.value?.focus() })
</script>

<template>
  <div class="flex flex-col gap-2">
    <ModifierStrip />
    <div class="flex h-11 gap-1.5">
      <button
        v-for="key in arrows"
        :key="key.code"
        type="button"
        class="key grid min-w-0 flex-1 touch-none place-items-center rounded-[9px] bg-key text-muted active:bg-key-down"
        :aria-label="key.label"
        @pointerdown="down(key.code, $event)"
        @pointerup="up"
        @pointercancel="up"
        @contextmenu.prevent
      >
        <component :is="key.icon" :size="18" />
      </button>
    </div>

    <div class="rounded-2xl border border-line bg-surface-2 focus-within:border-accent/60">
      <div v-if="voice.active || voice.partial || voice.error" class="flex items-center gap-2 px-3 pt-2.5 text-[13px]" aria-live="polite">
        <span v-if="voice.active" class="size-2 shrink-0 rounded-full bg-bad" :style="{ transform: `scale(${1 + voice.level * 2.5})` }" />
        <span v-if="voice.error" class="text-bad">{{ voice.error }}</span>
        <span v-else class="truncate text-muted">{{ voice.partial || 'Listening…' }}</span>
      </div>
      <textarea
        ref="field"
        v-model="text"
        :autofocus="autofocus"
        rows="2"
        enterkeyhint="send"
        autocapitalize="sentences"
        autocomplete="off"
        spellcheck="true"
        :placeholder="live ? 'Type here — it appears on the Mac as you type' : 'Type, then send to the Mac'"
        class="block max-h-40 min-h-16 w-full resize-none bg-transparent px-3 py-2.5 text-[16px] leading-snug outline-none placeholder:text-faint"
        aria-label="Text to type on the Mac"
        @input="syncLive"
        @beforeinput="onBeforeInput"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="onCompositionEnd"
      />
      <div class="flex items-center gap-1 px-1.5 pb-1.5">
        <button
          type="button"
          class="h-8 rounded-full px-3 text-[12px] font-medium transition-colors"
          :class="live ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted'"
          :aria-pressed="live"
          @click="toggleLive"
        >
          Live
        </button>
        <button type="button" class="grid size-8 place-items-center rounded-full text-muted" aria-label="Paste the phone clipboard on the Mac" @click="pasteFromPhone">
          <ClipboardPaste :size="17" />
        </button>
        <button v-if="text" type="button" class="grid size-8 place-items-center rounded-full text-muted" aria-label="Clear the field (keeps the Mac’s text)" @click="reset">
          <Eraser :size="17" />
        </button>
        <span class="flex-1" />
        <button
          v-if="voiceOk"
          type="button"
          class="grid size-9 place-items-center rounded-full transition-colors"
          :class="voice.active ? 'bg-bad text-white' : 'bg-surface-3 text-text'"
          :aria-label="voice.active ? 'Stop dictation' : 'Dictate'"
          @click="toggleVoice"
        >
          <Square v-if="voice.active" :size="14" fill="currentColor" />
          <Mic v-else :size="18" />
        </button>
        <button
          v-if="!live"
          type="button"
          class="grid size-9 place-items-center rounded-full bg-accent text-accent-text disabled:opacity-40"
          :disabled="!text"
          aria-label="Type on the Mac"
          @click="submit()"
        >
          <Send :size="17" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.key {
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
}
</style>
