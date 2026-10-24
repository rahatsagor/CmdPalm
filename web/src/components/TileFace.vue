<script setup lang="ts">
import { computed } from 'vue'
import { appNames } from '@/lib/apps'
import { actionSymbol, describe } from '@/lib/actions'
import { labels } from '@/lib/connection'
import type { Tile } from '@/lib/protocol'
import { symbol } from '@/lib/symbols'
import AppIcon from './AppIcon.vue'

// The visual part of a deck button, shared by the deck and the editor preview.
// `size` is the button's width in CSS px, when known, to scale the face.
const props = withDefaults(defineProps<{ tile: Tile; compact?: boolean; size?: number }>(), { compact: false, size: 0 })

const icon = computed(() => {
  const explicit = props.tile.icon
  if (explicit) return explicit
  if (props.tile.action.kind === 'app' && props.tile.action.id) return { kind: 'app' as const, id: props.tile.action.id }
  return { kind: 'symbol' as const, name: actionSymbol(props.tile.action) }
})

const label = computed(() => props.tile.label || describe(props.tile.action, labels.value, appNames.value))
/** Narrower buttons show only their icon; their label stays the button's name. */
const ICON_ONLY = 60
const showLabel = computed(() => !props.size || props.size >= ICON_ONLY)
const iconSize = computed(() => {
  if (!props.size) return props.compact ? 26 : 34
  if (!showLabel.value) return Math.round(props.size * 0.56)
  // 34 px on a phone's four-column page, 26 px at five columns.
  return Math.round(Math.min(44, Math.max(24, props.size * 0.4)))
})
const tight = computed(() => props.size > 0 && props.size < 80)
// Small enough that a word like "Screenshot" fits on a five-column page.
const labelSize = computed(() => (props.size ? `${Math.round(Math.min(13, Math.max(10, props.size / 7)))}px` : undefined))
</script>

<template>
  <div class="flex h-full w-full flex-col items-center justify-center overflow-hidden" :class="tight ? 'gap-1 p-1' : 'gap-1.5 p-2'">
    <AppIcon v-if="icon.kind === 'app'" :id="icon.id" :size="iconSize + 8" />
    <span v-else-if="icon.kind === 'emoji'" class="leading-none" :style="{ fontSize: `${iconSize}px` }">{{ icon.text }}</span>
    <component :is="symbol(icon.name)" v-else :size="iconSize - 6" :stroke-width="1.75" />
    <span
      class="line-clamp-2 max-w-full text-center text-[12px] leading-tight font-medium break-words"
      :class="[!showLabel && 'sr-only', tight && 'tracking-tight']"
      :style="labelSize && { fontSize: labelSize }"
      >{{ label }}</span
    >
  </div>
</template>
