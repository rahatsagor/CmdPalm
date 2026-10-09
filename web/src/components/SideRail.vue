<script setup lang="ts">
import { Check, Hand, Pause, Settings, ShieldAlert } from '@lucide/vue'
import { state } from '@/lib/connection'
import { modifiers } from '@/lib/input'
import { settings } from '@/lib/settings'
import { online, panic, released, stuck } from '@/lib/status'
import { selectTab, TABS } from '@/lib/tabs'

const emit = defineEmits<{ settings: [] }>()
</script>

<template>
  <!-- Landscape phones: status, sections and actions in one column, so the
       content gets the full height of the screen. -->
  <nav class="side-rail no-scrollbar flex w-14 shrink-0 flex-col items-center overflow-y-auto py-2" aria-label="Sections">
    <div class="flex flex-col items-center gap-1 pb-1" :title="state.hostName">
      <span
        class="size-2 rounded-full transition-colors"
        :class="online ? 'bg-good' : 'animate-pulse bg-warn'"
        :aria-label="online ? `Connected to ${state.hostName}` : 'Reconnecting'"
      />
      <span class="text-[9px] leading-none text-faint tabular-nums">{{ online ? (state.latency ? `${state.latency}ms` : '') : '…' }}</span>
    </div>
    <span v-if="state.paused" class="grid size-7 place-items-center rounded-full bg-warn/15 text-warn" aria-label="Paused on the Mac">
      <Pause :size="12" fill="currentColor" />
    </span>
    <span
      v-else-if="!state.features.permission"
      class="grid size-7 place-items-center rounded-full bg-bad/15 text-bad"
      aria-label="CmdPalm needs Accessibility permission on the Mac"
    >
      <ShieldAlert :size="14" />
    </span>
    <button
      v-if="stuck"
      type="button"
      class="mt-1 rounded-full bg-accent-soft px-1.5 py-1 text-[11px] font-semibold text-accent"
      :aria-label="`Modifiers on: ${stuck}. Tap to turn off.`"
      @click="modifiers.reset(true)"
    >
      {{ stuck }}
    </button>

    <div class="my-auto flex flex-col items-center gap-0.5 py-1" role="tablist">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="settings.tab === tab.id"
        :aria-label="tab.label"
        class="grid size-11 place-items-center rounded-xl transition-colors"
        :class="settings.tab === tab.id ? 'bg-accent-soft text-accent' : 'text-faint'"
        @click="selectTab(tab.id)"
      >
        <component :is="tab.icon" :size="21" :stroke-width="settings.tab === tab.id ? 2.2 : 1.8" />
      </button>
    </div>

    <button
      type="button"
      class="grid size-10 shrink-0 place-items-center rounded-full transition-[color,background-color,scale] duration-150 active:scale-90 active:bg-surface-3"
      :class="released ? 'bg-good/15 text-good' : 'text-muted'"
      aria-label="Release all keys and buttons"
      title="Release all keys and buttons"
      @click="panic"
    >
      <Check v-if="released" :size="18" :stroke-width="2.4" />
      <Hand v-else :size="18" />
    </button>
    <button
      type="button"
      class="grid size-10 shrink-0 place-items-center rounded-full text-muted transition-[scale] duration-150 active:scale-90 active:bg-surface-3"
      aria-label="Settings"
      @click="emit('settings')"
    >
      <Settings :size="18" />
    </button>
  </nav>
</template>

<style scoped>
.side-rail {
  margin-left: env(safe-area-inset-left);
  padding-bottom: max(calc(env(safe-area-inset-bottom) - 8px), 8px);
}
</style>
