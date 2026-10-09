<script setup lang="ts">
import { settings } from '@/lib/settings'
import { selectTab, TABS } from '@/lib/tabs'
</script>

<template>
  <!-- The home indicator needs less room than the full inset reserves. -->
  <nav class="tab-bar safe-x shrink-0 border-t border-line bg-bg" aria-label="Sections">
    <div class="mx-auto flex h-[52px] max-w-xl" role="tablist">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="settings.tab === tab.id"
        class="flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors"
        :class="settings.tab === tab.id ? 'text-accent' : 'text-faint'"
        @click="selectTab(tab.id)"
      >
        <component :is="tab.icon" :size="22" :stroke-width="settings.tab === tab.id ? 2.2 : 1.8" />
        <span class="text-[10px] font-medium">{{ tab.label }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.tab-bar {
  padding-bottom: max(calc(env(safe-area-inset-bottom) - 14px), 4px);
}
</style>
