<script setup lang="ts">
import { Check, Hand, Pause, Settings, ShieldAlert } from '@lucide/vue'
import { state } from '@/lib/connection'
import { modifiers } from '@/lib/input'
import { explainPermission, online, panic, released, stuck } from '@/lib/status'

const emit = defineEmits<{ settings: [] }>()
</script>

<template>
  <header class="safe-top safe-x shrink-0 bg-bg">
    <div class="flex h-12 items-center gap-2 px-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span
          role="img"
          class="size-2 shrink-0 rounded-full transition-colors"
          :class="online ? 'bg-good' : 'animate-pulse bg-warn'"
          :aria-label="online ? 'Connected' : 'Reconnecting'"
        />
        <span class="truncate text-[15px] font-semibold">{{ state.hostName || 'Mac' }}</span>
        <span v-if="online && state.latency" class="shrink-0 text-[12px] text-faint tabular-nums">{{ state.latency }} ms</span>
        <span v-else-if="!online" class="shrink-0 text-[12px] text-warn">Reconnecting…</span>
      </div>

      <span v-if="state.paused" class="flex items-center gap-1 rounded-full bg-warn/15 px-2.5 py-1 text-[12px] font-medium text-warn">
        <Pause :size="12" fill="currentColor" /> Paused
      </span>
      <button
        v-else-if="!state.features.permission"
        type="button"
        class="flex items-center gap-1 rounded-full bg-bad/15 px-2.5 py-1 text-[12px] font-medium text-bad"
        aria-label="CmdPalm needs Accessibility permission on the Mac"
        @click="explainPermission"
      >
        <ShieldAlert :size="13" /> Permission
      </button>

      <button
        v-if="stuck"
        type="button"
        class="h-8 rounded-full bg-accent-soft px-3 text-[13px] font-semibold text-accent"
        :aria-label="`Modifiers on: ${stuck}. Tap to turn off.`"
        @click="modifiers.reset(true)"
      >
        {{ stuck }}
      </button>

      <button
        type="button"
        class="grid size-9 place-items-center rounded-full transition-[color,background-color,scale] duration-150 active:scale-90 active:bg-surface-3"
        :class="released ? 'bg-good/15 text-good' : 'text-muted'"
        aria-label="Release all keys and buttons"
        title="Release all keys and buttons"
        @click="panic"
      >
        <Check v-if="released" :size="19" :stroke-width="2.4" />
        <Hand v-else :size="19" />
      </button>
      <button type="button" class="grid size-9 place-items-center rounded-full text-muted transition-[scale] duration-150 active:scale-90 active:bg-surface-3" aria-label="Settings" @click="emit('settings')">
        <Settings :size="19" />
      </button>
    </div>
  </header>
</template>
