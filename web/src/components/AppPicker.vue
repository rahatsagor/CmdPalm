<script setup lang="ts">
import { Check, LoaderCircle, Search } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { loadApps } from '@/lib/apps'
import { state } from '@/lib/connection'
import AppIcon from './AppIcon.vue'

defineProps<{ selected?: string }>()
const emit = defineEmits<{ select: [id: string, name: string] }>()

const query = ref('')
onMounted(() => loadApps())

const apps = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q ? state.apps.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : state.apps
  return [...list].sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
})
</script>

<template>
  <div>
    <label class="flex h-10 items-center gap-2 rounded-xl bg-surface-3 px-3 text-muted">
      <Search :size="16" />
      <input v-model="query" class="min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none" placeholder="Search apps" />
    </label>
    <div v-if="!state.appsLoaded" class="grid place-items-center py-8 text-muted"><LoaderCircle class="animate-spin" :size="22" /></div>
    <ul v-else class="mt-2 max-h-72 overflow-y-auto overscroll-contain">
      <li v-for="app in apps" :key="app.id">
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left active:bg-surface-3"
          @click="emit('select', app.id, app.name)"
        >
          <AppIcon :id="app.id" :size="30" />
          <span class="min-w-0 flex-1 truncate text-[15px]">{{ app.name }}</span>
          <span v-if="app.running" class="size-1.5 rounded-full bg-muted" aria-label="running" />
          <Check v-if="app.id === selected" :size="18" class="text-accent" />
        </button>
      </li>
      <li v-if="apps.length === 0" class="py-6 text-center text-[14px] text-muted">No apps match “{{ query }}”.</li>
    </ul>
  </div>
</template>
