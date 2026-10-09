<script setup lang="ts">
import { computed } from 'vue'
import { appNames } from '@/lib/apps'
import { actionSymbol, describe } from '@/lib/actions'
import { labels } from '@/lib/connection'
import type { Tile } from '@/lib/protocol'
import { symbol } from '@/lib/symbols'
import AppIcon from './AppIcon.vue'

// The visual part of a deck button, shared by the deck and the editor preview.
const props = withDefaults(defineProps<{ tile: Tile; compact?: boolean }>(), { compact: false })

const icon = computed(() => {
  const explicit = props.tile.icon
  if (explicit) return explicit
  if (props.tile.action.kind === 'app' && props.tile.action.id) return { kind: 'app' as const, id: props.tile.action.id }
  return { kind: 'symbol' as const, name: actionSymbol(props.tile.action) }
})

const label = computed(() => props.tile.label || describe(props.tile.action, labels.value, appNames.value))
const iconSize = computed(() => (props.compact ? 26 : 34))
</script>

<template>
  <div class="flex h-full w-full flex-col items-center justify-center gap-1.5 overflow-hidden p-2">
    <AppIcon v-if="icon.kind === 'app'" :id="icon.id" :size="iconSize + 8" />
    <span v-else-if="icon.kind === 'emoji'" class="leading-none" :style="{ fontSize: `${iconSize}px` }">{{ icon.text }}</span>
    <component :is="symbol(icon.name)" v-else :size="iconSize - 6" :stroke-width="1.75" />
    <span class="line-clamp-2 max-w-full text-center text-[12px] leading-tight font-medium break-words">{{ label }}</span>
  </div>
</template>
