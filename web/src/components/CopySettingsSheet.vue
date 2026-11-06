<script setup lang="ts">
import { ArrowLeft, ChevronRight, LoaderCircle, MonitorSmartphone, Smartphone, Tablet } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { keyboards } from '@/lib/customKeyboards'
import type { SettingsSource } from '@/lib/protocol'
import { ago, cancelCopy, copier, COPY_CATEGORIES, copyFrom, listDevices, requestCopy, type CopyCategory, type CopyPreview } from '@/lib/settingsSync'
import Sheet from './Sheet.vue'

const emit = defineEmits<{ close: [] }>()
const chosen = ref<SettingsSource | null>(null)
const preview = ref<CopyPreview | null>(null)
const categories = ref<CopyCategory[]>([])
const boards = ref<string[]>([])
const available = computed(() => COPY_CATEGORIES.filter((category) => category.keys.some((key) => Object.hasOwn(preview.value?.settings ?? {}, key))))
const selectedCount = computed(() => categories.value.length + boards.value.length)

onMounted(listDevices)
onBeforeUnmount(cancelCopy)

function icon(model: string) {
  if (/iPad|tablet/i.test(model)) return Tablet
  if (/iPhone|iPod|phone/i.test(model)) return Smartphone
  return MonitorSmartphone
}

async function choose(device: SettingsSource) {
  chosen.value = device
  preview.value = null
  categories.value = []
  boards.value = []
  const result = await requestCopy(device)
  if (chosen.value?.id === device.id) preview.value = result
}

function back() {
  cancelCopy()
  chosen.value = null
  preview.value = null
}

function copySelected() {
  if (preview.value && copyFrom(preview.value, { categories: categories.value, keyboards: boards.value })) emit('close')
}

function selectAll() {
  const all = selectedCount.value === available.value.length + (preview.value?.keyboards.length ?? 0)
  categories.value = all ? [] : available.value.map((category) => category.id)
  boards.value = all ? [] : (preview.value?.keyboards.map((board) => board.id) ?? [])
}
</script>

<template>
  <Sheet title="Copy from device" @close="emit('close')">
    <template v-if="chosen">
      <button type="button" class="mb-3 flex min-h-10 items-center gap-1.5 text-[14px] font-medium text-muted" @click="back"><ArrowLeft :size="16" /> Devices</button>
      <p class="text-[16px] font-semibold break-words">Choose what to copy from {{ chosen.name }}</p>
      <p class="mt-1.5 text-[14px] leading-snug text-muted">Only your selection changes here. Everything else in your setup stays as it is.</p>

      <div v-if="copier.copying" class="flex items-center justify-center gap-3 py-10 text-muted" aria-live="polite">
        <LoaderCircle :size="20" class="animate-spin" /> Reading saved setup…
      </div>
      <div v-else-if="!preview" class="py-6 text-center">
        <p class="text-[14px] text-muted">Couldn’t read this device’s setup. Check the connection and try again.</p>
        <button type="button" class="action mt-4 w-full" @click="choose(chosen)">Try again</button>
      </div>
      <template v-else>
        <div class="mt-3 flex min-h-10 items-center justify-between">
          <span class="text-[13px] text-muted">{{ selectedCount ? `${selectedCount} selected` : 'Select the items you need' }}</span>
          <button v-if="available.length || preview.keyboards.length" type="button" class="px-2 py-2 text-[13px] font-medium text-accent" @click="selectAll">
            {{ selectedCount === available.length + preview.keyboards.length ? 'Deselect all' : 'Select all' }}
          </button>
        </div>
        <div v-if="available.length" class="rounded-2xl bg-surface-2 px-4">
          <label v-for="category in available" :key="category.id" class="choice border-t border-line first:border-t-0">
            <span class="min-w-0 flex-1">
              <span class="block text-[15px] font-medium">{{ category.label }}</span>
              <span class="block text-[13px] leading-snug text-muted">{{ category.hint }}</span>
            </span>
            <input v-model="categories" type="checkbox" :value="category.id" :aria-label="category.label" />
          </label>
        </div>

        <template v-if="preview.keyboards.length">
          <p class="mt-5 text-[15px] font-semibold">Custom keyboards</p>
          <p class="mt-1 mb-3 text-[13px] leading-snug text-muted">New keyboards are added. Previously copied keyboards are updated in place; other keyboards stay here.</p>
          <div class="rounded-2xl bg-surface-2 px-4">
            <label v-for="board in preview.keyboards" :key="board.id" class="choice border-t border-line first:border-t-0">
              <span class="min-w-0 flex-1">
                <span class="block text-[15px] font-medium break-words">{{ board.name }}</span>
                <span class="block text-[13px] text-muted">{{ keyboards.boards.some((b) => b.id === board.id) ? 'Update existing' : 'Add keyboard' }} · {{ board.cols }} × {{ board.rows }} · {{ board.keys.length }} {{ board.keys.length === 1 ? 'key' : 'keys' }}</span>
              </span>
              <input v-model="boards" type="checkbox" :value="board.id" :aria-label="`Copy ${board.name}`" />
            </label>
          </div>
        </template>
        <p class="mt-4 text-[13px] leading-snug text-muted">Deck pages and buttons are already shared by all devices paired with this Mac. They don’t need to be copied.</p>
        <p v-if="!available.length && !preview.keyboards.length" class="py-4 text-[14px] text-muted">No saved options to copy from this device.</p>
        <div class="sticky -bottom-5 -mx-5 mt-4 bg-surface px-5 pt-2 pb-5">
          <button type="button" class="action w-full bg-accent! text-accent-text!" :disabled="!selectedCount" @click="copySelected">Copy selected</button>
        </div>
      </template>
    </template>

    <div v-else-if="copier.loading" class="flex flex-col items-center gap-3 py-10 text-muted" aria-live="polite">
      <LoaderCircle :size="24" class="animate-spin" />
      <span class="text-[14px]">Looking for devices…</span>
    </div>
    <div v-else-if="copier.failed" class="py-8 text-center">
      <p class="text-[15px] font-medium">Couldn’t get the list from the Mac.</p>
      <p class="mt-1 text-[14px] text-muted">Check the connection, then try again.</p>
      <button type="button" class="action mt-4 w-full" @click="listDevices">Try again</button>
    </div>
    <div v-else-if="!copier.devices?.length" class="py-8 text-center">
      <MonitorSmartphone :size="30" class="mx-auto text-faint" />
      <p class="mt-3 text-[15px] font-medium">No other devices to copy from</p>
      <p class="mx-auto mt-1 max-w-xs text-[14px] leading-snug text-muted">Settings from your other phones and tablets appear here once they’ve connected to this Mac and changed a setting.</p>
    </div>
    <template v-else>
      <p class="pb-3 text-[14px] leading-snug text-muted">Choose a paired device, then select which settings or custom keyboards to copy.</p>
      <ul class="rounded-2xl bg-surface-2 px-4">
        <li v-for="device in copier.devices" :key="device.id" class="border-t border-line first:border-t-0">
          <button type="button" class="flex min-h-14 w-full items-center gap-3 py-2 text-left" @click="choose(device)">
            <component :is="icon(device.model)" :size="20" class="shrink-0 text-muted" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[15px] font-medium">{{ device.name }}</span>
              <span class="block truncate text-[13px] text-muted">{{ device.model }} · Updated {{ ago(device.updatedAt) }}</span>
            </span>
            <ChevronRight :size="16" class="shrink-0 text-faint" />
          </button>
        </li>
      </ul>
    </template>
  </Sheet>
</template>

<style scoped>
@reference '../style.css';
.action {
  @apply flex h-12 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[15px] font-medium disabled:opacity-40;
}
.choice {
  @apply flex min-h-16 cursor-pointer items-center gap-3 py-3;
}
.choice input {
  @apply size-5 shrink-0 accent-accent;
}
</style>
