<script setup lang="ts">
import { ChevronRight, LoaderCircle, MonitorSmartphone, Smartphone, Tablet } from '@lucide/vue'
import { onMounted, ref } from 'vue'
import type { SettingsSource } from '@/lib/protocol'
import { ago, copier, copyFrom, listDevices } from '@/lib/settingsSync'
import Sheet from './Sheet.vue'

const emit = defineEmits<{ close: [] }>()

const chosen = ref<SettingsSource | null>(null)

onMounted(listDevices)

function icon(model: string) {
  if (/iPad|tablet/i.test(model)) return Tablet
  if (/iPhone|iPod|phone/i.test(model)) return Smartphone
  return MonitorSmartphone
}

async function replace() {
  const device = chosen.value
  if (!device || copier.copying) return
  if (await copyFrom(device)) emit('close')
}
</script>

<template>
  <Sheet title="Copy settings" @close="emit('close')">
    <template v-if="chosen">
      <div class="rounded-2xl bg-surface-2 p-4">
        <p class="text-[16px] font-semibold">Replace this device’s settings with {{ chosen.name }}’s?</p>
        <p class="mt-1.5 text-[14px] leading-snug text-muted">
          Trackpad, keyboard, gestures, appearance and custom keyboards are replaced. This device’s name stays the same.
        </p>
      </div>
      <div class="mt-4 flex gap-2">
        <button type="button" class="action flex-1" :disabled="!!copier.copying" @click="chosen = null">Cancel</button>
        <button type="button" class="action flex-1 bg-accent! text-accent-text! disabled:opacity-60" :disabled="!!copier.copying" @click="replace">
          <LoaderCircle v-if="copier.copying" :size="17" class="animate-spin" />
          Replace
        </button>
      </div>
    </template>

    <div v-else-if="copier.loading && !copier.devices" class="flex flex-col items-center gap-3 py-10 text-muted" aria-live="polite">
      <LoaderCircle :size="24" class="animate-spin" />
      <span class="text-[14px]">Looking for devices…</span>
    </div>

    <div v-else-if="copier.failed" class="py-8 text-center">
      <p class="text-[15px] font-medium">Couldn’t get the list from the Mac.</p>
      <p class="mt-1 text-[14px] text-muted">Check the connection, then try again.</p>
      <button type="button" class="mt-4 h-10 rounded-full bg-surface-3 px-5 text-[14px] font-medium" @click="listDevices">Try again</button>
    </div>

    <div v-else-if="!copier.devices?.length" class="py-8 text-center">
      <MonitorSmartphone :size="30" class="mx-auto text-faint" />
      <p class="mt-3 text-[15px] font-medium">No other devices to copy from</p>
      <p class="mx-auto mt-1 max-w-xs text-[14px] leading-snug text-muted">
        Settings from your other phones and tablets appear here once they’ve connected to this Mac and changed a setting.
      </p>
    </div>

    <template v-else>
      <p class="pb-3 text-[14px] leading-snug text-muted">Choose a device paired with this Mac to use its settings here.</p>
      <ul class="rounded-2xl bg-surface-2 px-4">
        <li v-for="device in copier.devices" :key="device.id" class="border-t border-line first:border-t-0">
          <button type="button" class="flex min-h-14 w-full items-center gap-3 py-2 text-left" @click="chosen = device">
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
  @apply flex h-12 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[15px] font-medium disabled:opacity-60;
}
</style>
