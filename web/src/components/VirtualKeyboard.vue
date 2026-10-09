<script setup lang="ts">
import { Globe } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { labels, runAction } from '@/lib/connection'
import { MEDIA, SYSTEM } from '@/lib/actions'
import { haptic } from '@/lib/haptics'
import { keyDown, keyUp, modifiers, pressMedia } from '@/lib/input'
import { Key, keyboardRows, type KeySpec } from '@/lib/keys'
import { Mod } from '@/lib/protocol'
import { settings } from '@/lib/settings'
import { symbol } from '@/lib/symbols'
import { useTouchKeys } from '@/lib/touchKeys'

const props = withDefaults(defineProps<{ functionRow?: boolean }>(), { functionRow: true })

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

const rows = computed(() => keyboardRows(labels.value.iso))

type FnSpec = Extract<KeySpec, { kind: 'fn' }>
type ArrowSpec = { kind: 'arrow'; code: number; glyph: string; name: string }

/** Every pressable key by its code (the `data-key` value). */
const specs = computed(() => {
  const map = new Map<number, Exclude<KeySpec, { kind: 'arrows' }> | ArrowSpec>()
  for (const row of rows.value) for (const spec of row) if (spec.kind !== 'arrows') map.set(spec.code, spec)
  for (const arrow of ARROWS) map.set(arrow.code, arrow)
  return map
})

const ARROWS: ArrowSpec[] = [
  { kind: 'arrow', code: Key.Left, glyph: '◀', name: 'left' },
  { kind: 'arrow', code: Key.Up, glyph: '▲', name: 'up' },
  { kind: 'arrow', code: Key.Down, glyph: '▼', name: 'down' },
  { kind: 'arrow', code: Key.Right, glyph: '▶', name: 'right' },
]
const arrow = (code: number) => ARROWS.find((a) => a.code === code)!

const UNITS = 15
const metrics = computed(() => {
  const { width, height } = size.value
  const gap = width / UNITS < 44 ? 4 : 6
  const unit = (width - gap * 14) / UNITS
  const rowsTall = 5 + (props.functionRow ? 0.72 : 0)
  const rowCount = props.functionRow ? 6 : 5
  const rowHeight = (height - gap * (rowCount - 1)) / rowsTall
  return { gap, unit, rowHeight, compact: unit < 44 }
})

const vars = computed(() => {
  const { gap, unit, rowHeight } = metrics.value
  // Labels follow the key's smaller side so narrow portrait keys stay legible.
  const side = Math.min(rowHeight, unit * 1.25)
  const clamp = (v: number, lo: number, hi: number) => `${Math.round(Math.min(hi, Math.max(lo, v)))}px`
  return {
    '--gap': `${gap}px`,
    '--radius': clamp(side * 0.15, 5, 9),
    '--f-main': clamp(side * 0.42, 13, 25),
    '--f-dual': clamp(side * 0.3, 10, 17),
    '--f-sym': clamp(side * 0.34, 12, 19),
    '--f-word': clamp(side * 0.22, 9, 12),
    '--f-fn': clamp(side * 0.24, 9, 12),
  }
})

/** Pointer id → what that finger holds. */
const held = reactive(new Map<number, { code: number; mod?: boolean; release?: () => void }>())
const down = computed(() => new Set([...held.values()].map((h) => h.code)))

const showMedia = computed(() => (settings.functionRow === 'media') !== ((modifiers.active & Mod.Fn) !== 0))

function pressFn(spec: FnSpec, pointerId: number) {
  if (showMedia.value && (spec.media || spec.system)) {
    modifiers.consume()
    if (spec.media) held.set(pointerId, { code: spec.code, release: pressMedia(spec.media) })
    else {
      held.set(pointerId, { code: spec.code, release: () => {} })
      void runAction({ kind: 'system', name: spec.system! })
    }
    return
  }
  held.set(pointerId, { code: spec.code })
  keyDown(pointerId, spec.code)
}

useTouchKeys(root, {
  down(key, pointerId) {
    const spec = specs.value.get(Number(key))
    if (!spec) return
    haptic('select')
    if (spec.kind === 'mod') {
      modifiers.press(pointerId, spec.mod, spec.code)
      held.set(pointerId, { code: spec.code, mod: true })
    } else if (spec.kind === 'fn') {
      pressFn(spec, pointerId)
    } else {
      held.set(pointerId, { code: spec.code })
      keyDown(pointerId, spec.code)
    }
  },
  up(pointerId, cancelled) {
    const h = held.get(pointerId)
    if (!h) return
    held.delete(pointerId)
    if (h.mod) {
      if (cancelled) modifiers.cancel(pointerId)
      else modifiers.release(pointerId)
    } else if (h.release) h.release()
    // keyUp ignores pointers that never pressed a key on the Mac.
    else keyUp(pointerId)
  },
})

const caps = computed(() => {
  const map = new Map<number, { main: string; alt: string }>()
  const mods = modifiers.active
  for (const row of rows.value) {
    for (const spec of row) {
      if (spec.kind !== 'char') continue
      const set = labels.value.labels(spec.code)
      // Digits and punctuation show their shifted symbol above, like a real key.
      const alt =
        set && !(mods & (Mod.Shift | Mod.Option)) && set.shift && set.shift.toLowerCase() !== set.base.toLowerCase()
          ? labels.value.label(spec.code, Mod.Shift)
          : ''
      map.set(spec.code, { main: labels.value.label(spec.code, mods), alt })
    }
  }
  return map
})

const WORDS: Record<number, string> = {
  [Key.Escape]: 'esc', [Key.Tab]: 'tab', [Key.CapsLock]: 'caps lock', [Key.Delete]: 'delete',
  [Key.Return]: 'return', [Key.Shift]: 'shift', [Key.RightShift]: 'shift', [Key.Control]: 'control',
  [Key.Option]: 'option', [Key.RightOption]: 'option', [Key.Command]: 'command', [Key.RightCommand]: 'command',
}

function modClass(spec: Extract<KeySpec, { kind: 'mod' }>) {
  switch (modifiers.status(spec.mod)) {
    case 'locked':
      return 'is-locked'
    case 'latched':
      return 'is-latched'
    case 'held':
      return 'is-down'
    default:
      return ''
  }
}

function fnIcon(spec: FnSpec) {
  if (spec.media) return symbol(MEDIA[spec.media].symbol)
  if (spec.system) return symbol(SYSTEM[spec.system].symbol)
  return null
}

const flex = (width = 1) => ({ flex: `${width} 1 0%` })
const rowStyle = (r: number) => ({ flex: r === 0 ? '0.72 1 0%' : '1 1 0%' })
</script>

<template>
  <div ref="root" class="keyboard flex h-full w-full touch-none flex-col select-none" :style="vars" role="group" aria-label="Mac keyboard">
    <template v-for="(row, r) in rows" :key="r">
      <div v-if="r > 0 || functionRow" class="row flex min-h-0" :style="rowStyle(r)">
        <template v-for="(spec, i) in row" :key="i">
          <div
            v-if="spec.kind === 'char'"
            :data-key="spec.code"
            role="button"
            class="key"
            :class="down.has(spec.code) && 'is-down'"
            :style="flex(spec.width)"
            :aria-label="caps.get(spec.code)?.main || 'key'"
          >
            <template v-if="caps.get(spec.code)?.alt">
              <span class="dual">{{ caps.get(spec.code)?.alt }}</span>
              <span class="dual">{{ caps.get(spec.code)?.main }}</span>
            </template>
            <span v-else class="main">{{ caps.get(spec.code)?.main }}</span>
          </div>

          <div
            v-else-if="spec.kind === 'mod'"
            :data-key="spec.code"
            role="button"
            class="key"
            :class="[modClass(spec), !metrics.compact && spec.align ? `wide align-${spec.align}` : '']"
            :style="flex(spec.width)"
            :aria-label="spec.label"
            :aria-pressed="modifiers.status(spec.mod) !== 'off'"
          >
            <template v-if="spec.mod === Mod.Fn">
              <template v-if="metrics.compact">
                <span class="word">fn</span>
              </template>
              <template v-else>
                <span class="word self-end">fn</span>
                <Globe class="self-start" :size="14" :stroke-width="1.6" />
              </template>
            </template>
            <template v-else-if="metrics.compact || !spec.align">
              <span class="sym">{{ spec.symbol }}</span>
            </template>
            <template v-else>
              <span class="sym-small">{{ spec.symbol }}</span>
              <span class="word">{{ WORDS[spec.code] }}</span>
            </template>
            <span v-if="modifiers.status(spec.mod) === 'locked'" class="lock-dot" />
          </div>

          <div
            v-else-if="spec.kind === 'special'"
            :data-key="spec.code"
            role="button"
            class="key"
            :class="[down.has(spec.code) && 'is-down', !metrics.compact && spec.align ? `wide align-${spec.align}` : '']"
            :style="flex(spec.width)"
            :aria-label="spec.label || (spec.code === Key.Space ? 'space' : '')"
          >
            <template v-if="spec.code === Key.Space" />
            <template v-else-if="metrics.compact || !spec.align">
              <span v-if="spec.symbol" class="sym">{{ spec.symbol }}</span>
              <span v-else class="word">{{ spec.label }}</span>
            </template>
            <template v-else>
              <span v-if="spec.symbol" class="sym-small">{{ spec.symbol }}</span>
              <span v-else />
              <span class="word">{{ WORDS[spec.code] ?? spec.label }}</span>
            </template>
          </div>

          <div
            v-else-if="spec.kind === 'fn'"
            :data-key="spec.code"
            role="button"
            class="key fn"
            :class="down.has(spec.code) && 'is-down'"
            :style="flex(1)"
            :aria-label="showMedia ? spec.mediaLabel : spec.label"
          >
            <component :is="fnIcon(spec)!" v-if="showMedia && fnIcon(spec)" class="fn-icon" :stroke-width="1.7" />
            <span class="fn-label" :class="!(showMedia && fnIcon(spec)) && 'only'">{{ spec.label }}</span>
          </div>

          <!-- Arrows, laid out like a MacBook: tall ◀ ▶, half-height ▲ ▼ -->
          <div v-else-if="spec.kind === 'arrows'" class="arrows flex min-w-0" :style="flex(3)">
            <div :data-key="Key.Left" role="button" class="key arrow" :class="down.has(Key.Left) && 'is-down'" aria-label="left">
              {{ arrow(Key.Left).glyph }}
            </div>
            <div class="flex min-w-0 flex-1 flex-col">
              <div :data-key="Key.Up" role="button" class="key arrow" :class="down.has(Key.Up) && 'is-down'" aria-label="up">
                {{ arrow(Key.Up).glyph }}
              </div>
              <div :data-key="Key.Down" role="button" class="key arrow" :class="down.has(Key.Down) && 'is-down'" aria-label="down">
                {{ arrow(Key.Down).glyph }}
              </div>
            </div>
            <div :data-key="Key.Right" role="button" class="key arrow" :class="down.has(Key.Right) && 'is-down'" aria-label="right">
              {{ arrow(Key.Right).glyph }}
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.keyboard,
.row,
.arrows,
.arrows > div {
  gap: var(--gap);
}

.key {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--radius);
  background: linear-gradient(to bottom, var(--key-top), var(--key));
  box-shadow:
    inset 0 0.5px 0 rgb(255 255 255 / 0.07),
    0 1px 0 rgb(0 0 0 / 0.5);
  color: var(--text);
  line-height: 1;
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

.main {
  font-size: var(--f-main);
  font-weight: 400;
}
.dual {
  font-size: var(--f-dual);
}
.dual + .dual {
  margin-top: 0.22em;
}
.sym {
  font-size: var(--f-sym);
  opacity: 0.9;
}
.sym-small {
  font-size: calc(var(--f-sym) * 0.82);
  opacity: 0.9;
}
.word {
  font-size: var(--f-word);
  letter-spacing: 0.01em;
  opacity: 0.88;
}

/* Wide modifier and special keys: symbol in the top corner, word below, on
   the side facing away from the letters, as printed on Apple keyboards. */
.key.wide {
  justify-content: space-between;
  padding: calc(var(--radius) * 0.9) calc(var(--radius) + 2px);
}
.key.wide.align-left {
  align-items: flex-start;
}
.key.wide.align-right {
  align-items: flex-end;
}

.key.fn {
  gap: 0.25em;
  color: var(--muted);
}
.fn-icon {
  width: calc(var(--f-fn) * 1.35);
  height: calc(var(--f-fn) * 1.35);
}
.fn-label {
  font-size: calc(var(--f-fn) * 0.8);
  opacity: 0.75;
}
.fn-label.only {
  font-size: var(--f-fn);
  opacity: 1;
}

.arrow {
  flex: 1 1 0%;
  font-size: calc(var(--f-word) * 0.9);
  color: var(--muted);
}
.arrows > div:nth-child(2) .arrow {
  min-height: 0;
}

.lock-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.8;
}
</style>
