<script setup lang="ts">
import { Download, FileJson, Upload } from '@lucide/vue'
import { ref } from 'vue'
import { exportBackup, MAX_BACKUP_BYTES, readBackup, restoreBackup, type DeviceBackup } from '@/lib/backup'
import { notify } from '@/lib/connection'
import Sheet from './Sheet.vue'

const emit = defineEmits<{ close: [] }>()
const picker = ref<HTMLInputElement>()
const preview = ref<DeviceBackup | null>(null)
const error = ref('')
const reading = ref(false)

function download() {
  error.value = ''
  try {
    const url = URL.createObjectURL(new Blob([exportBackup()], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `cmdpalm-device-${new Date().toISOString().slice(0, 10)}.json`
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Couldn’t export this setup.'
  }
}

async function choose(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || reading.value) return
  error.value = ''
  preview.value = null
  reading.value = true
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('This backup is too large to open.')
    preview.value = readBackup(await file.text())
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Couldn’t read this backup.'
  } finally {
    reading.value = false
  }
}

function restore() {
  if (!preview.value) return
  try {
    if (!restoreBackup(preview.value)) return
    notify('Restored this device’s settings and custom keyboards.', 'info', 'settings')
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Couldn’t restore this backup.'
  }
}
</script>

<template>
  <Sheet title="Device backup" @close="emit('close')">
    <p class="text-[14px] leading-relaxed text-muted">Save your trackpad, keyboard, gesture and appearance settings, together with all your custom keyboards. You can restore the file on this device or another phone or tablet.</p>
    <div class="mt-4 flex flex-col gap-2">
      <button type="button" class="action" @click="download"><Download :size="18" /> Export device backup</button>
      <button type="button" class="action" :disabled="reading" @click="picker?.click()"><Upload :size="18" /> {{ reading ? 'Reading backup…' : 'Choose a backup to restore' }}</button>
      <input ref="picker" class="hidden" type="file" accept=".json,application/json" aria-label="Device backup file" @change="choose" />
    </div>
    <p v-if="error" role="alert" class="mt-3 text-[14px] text-bad">{{ error }}</p>

    <section v-if="preview" class="mt-5 rounded-2xl border border-line bg-surface-2 p-4">
      <div class="flex items-center gap-2 text-[15px] font-semibold"><FileJson :size="20" /> Ready to restore</div>
      <p v-if="preview.exportedAt" class="mt-1 text-[13px] text-muted">Saved {{ new Date(preview.exportedAt).toLocaleDateString() }}</p>
      <p class="mt-3 text-[14px] leading-relaxed">This replaces this device’s settings and its {{ preview.setup.keyboards.length }} {{ preview.setup.keyboards.length === 1 ? 'keyboard' : 'keyboards' }}. Export your current setup first if you want to keep a copy.</p>
      <ul class="mt-2 list-inside list-disc text-[13px] text-muted">
        <li v-for="board in preview.setup.keyboards" :key="board.id">{{ board.name }}</li>
      </ul>
      <button type="button" class="action mt-4 w-full bg-accent! text-accent-text!" @click="restore">Restore backup</button>
      <button type="button" class="mt-2 h-10 w-full text-[14px] text-muted" @click="preview = null">Cancel restore</button>
    </section>
    <p class="mt-4 text-[13px] leading-relaxed text-muted">Your device name and pairing stay as they are. Backups don’t contain pairing tokens. Deck pages are shared by the Mac; export those from CmdPalm Settings → Deck on the Mac.</p>
  </Sheet>
</template>

<style scoped>
@reference '../style.css';
.action {
  @apply flex min-h-12 items-center justify-center gap-2 rounded-xl bg-surface-2 px-3 text-[15px] font-medium disabled:opacity-40;
}
</style>
