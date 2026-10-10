<script setup lang="ts">
import { LaptopMinimal, LoaderCircle, ShieldCheck } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { connect, disconnect, state } from '@/lib/connection'
import { deviceModel, token } from '@/lib/device'
import { takePairingCode } from '@/lib/pairing'
import { settings } from '@/lib/settings'
import Toggle from '@/components/Toggle.vue'

const pin = ref('')
const input = ref<HTMLInputElement>()
const macName = ref('')
const mode = ref<'pin' | 'approve' | 'pair'>('pin')

onMounted(async () => {
  const code = takePairingCode()
  if (code) {
    mode.value = 'pair'
    connect({ method: 'pair', code })
  }
  try {
    const info = (await (await fetch('/api/info', { cache: 'no-store' })).json()) as { name?: string }
    macName.value = info.name ?? ''
  } catch {
    // Offline: the form still works once the Mac is reachable.
  }
  if (!code) input.value?.focus()
})

const incompatible = computed(() => state.status === 'denied' && state.denied?.reason === 'incompatible')
const reload = () => location.reload()
const busy = computed(() => state.status === 'connecting' || state.status === 'pending')
const mac = computed(() => macName.value || 'your Mac')
// Disconnected from the Mac while still paired.
const canReconnect = computed(() => state.status === 'idle' && !!token.get())
const disconnected = computed(() => (canReconnect.value && !state.byeReason ? 'Disconnected from the Mac.' : ''))

const error = computed(() => {
  if (state.status === 'idle' && state.byeReason) return state.byeReason
  if (state.status !== 'denied' || !state.denied) return ''
  switch (state.denied.reason) {
    case 'wrongPin':
      return 'That PIN didn’t match. Check the PIN in the CmdPalm menu on the Mac.'
    case 'expiredCode':
      return 'That pairing code expired or was already used. Scan the new QR code, or enter the PIN.'
    case 'rejected':
      return mode.value === 'pin'
        ? 'PIN pairing is turned off on the Mac.'
        : 'The Mac didn’t allow this device. Approval may be turned off in CmdPalm’s Phone Setup settings.'
    case 'pinClosed':
      return 'Open the CmdPalm menu on the Mac to show the PIN, then try again.'
    case 'blocked':
      return `Too many attempts. Try again in ${state.denied.retryAfter ?? 30} seconds.`
    case 'busy':
      return 'The Mac is already handling a request from this device.'
    case 'incompatible':
      return 'This page doesn’t match the CmdPalm version on the Mac. Reload the page.'
    default:
      return 'Couldn’t connect.'
  }
})

function submitPin() {
  if (pin.value.length !== 6 || busy.value) return
  mode.value = 'pin'
  connect({ method: 'pin', pin: pin.value })
}

function cancel() {
  disconnect(false)
  nextTick(() => input.value?.focus())
}

function requestApproval() {
  mode.value = 'approve'
  connect({ method: 'approve' })
}

function onPinInput(event: Event) {
  const target = event.target as HTMLInputElement
  pin.value = target.value.replace(/\D/g, '').slice(0, 6)
  target.value = pin.value
  if (pin.value.length === 6) submitPin()
}

watch(
  () => state.status,
  async (status) => {
    if (status === 'denied' && state.denied?.reason === 'wrongPin') {
      pin.value = ''
      await nextTick()
      input.value?.focus()
    }
  },
)
</script>

<template>
  <main class="safe-top safe-bottom safe-x flex h-full flex-col items-center overflow-y-auto">
    <div class="flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-10">
      <div class="mb-8 flex flex-col items-center text-center">
        <img src="/icon.svg" alt="" class="mb-5 size-16 rounded-[22%] shadow-lg" />
        <h1 class="text-[26px] font-semibold tracking-tight">Connect to {{ mac }}</h1>
        <p class="mt-2 text-[15px] leading-relaxed text-muted">
          Open the CmdPalm menu on the Mac and scan the QR code, or enter the PIN shown there.
        </p>
      </div>

      <div v-if="busy" class="flex flex-col items-center gap-4 rounded-3xl border border-line bg-surface p-6 text-center" aria-live="polite">
        <template v-if="state.status === 'pending'">
          <LaptopMinimal :size="32" class="text-accent" />
          <div>
            <div class="text-[17px] font-semibold">Waiting for approval</div>
            <p class="mt-1 text-[14px] text-muted">Click <b>Allow</b> on {{ mac }} to let this {{ deviceModel() }} connect.</p>
          </div>
          <button type="button" class="h-11 w-full rounded-2xl text-[15px] font-medium text-accent" @click="cancel">Cancel</button>
        </template>
        <template v-else>
          <LoaderCircle :size="28" class="animate-spin text-muted" />
          <div class="text-[15px] text-muted">{{ mode === 'pair' ? 'Pairing…' : 'Connecting…' }}</div>
        </template>
      </div>

      <form v-else class="rounded-3xl border border-line bg-surface p-5" @submit.prevent="submitPin">
        <label for="pin" class="mb-3 block text-center text-[13px] font-medium tracking-wide text-muted uppercase">PIN</label>
        <div class="relative" @click="input?.focus()">
          <input
            id="pin"
            ref="input"
            :value="pin"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]*"
            maxlength="6"
            aria-label="Six-digit PIN"
            class="absolute inset-0 z-10 h-full w-full opacity-0"
            @input="onPinInput"
          />
          <div class="grid grid-cols-6 gap-2" aria-hidden="true">
            <div
              v-for="i in 6"
              :key="i"
              class="grid aspect-[4/5] place-items-center rounded-xl border bg-surface-2 font-mono text-[26px] font-semibold tabular-nums transition-colors"
              :class="pin.length === i - 1 ? 'border-accent' : 'border-line'"
            >
              {{ pin[i - 1] ?? '' }}
            </div>
          </div>
        </div>
        <p v-if="error" class="mt-4 text-center text-[14px] leading-snug text-bad" role="alert">{{ error }}</p>
        <p v-else-if="disconnected" class="mt-4 text-center text-[14px] leading-snug text-muted" role="status">{{ disconnected }}</p>
        <button
          v-if="incompatible"
          type="button"
          class="mt-3 h-11 w-full rounded-2xl text-[15px] font-medium text-accent"
          @click="reload"
        >
          Reload
        </button>
        <button
          v-if="canReconnect"
          type="button"
          class="mt-3 h-11 w-full rounded-2xl text-[15px] font-medium text-accent"
          @click="connect()"
        >
          Reconnect
        </button>
        <button
          type="submit"
          class="mt-5 h-12 w-full rounded-2xl bg-accent text-[16px] font-semibold text-accent-text disabled:opacity-40"
          :disabled="pin.length !== 6"
        >
          Connect
        </button>
        <button type="button" class="mt-2 h-11 w-full rounded-2xl text-[15px] font-medium text-accent" @click="requestApproval">
          Ask the Mac to approve instead
        </button>
      </form>

      <div class="mt-6 rounded-2xl px-1">
        <Toggle v-model="settings.rememberDevice" label="Remember this device" hint="Reconnect automatically next time. Turn off on shared devices." />
        <label class="mt-1 block py-2">
          <span class="text-[15px]">Device name</span>
          <input
            v-model="settings.deviceName"
            :placeholder="deviceModel()"
            maxlength="40"
            class="mt-2 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-accent"
          />
        </label>
      </div>

      <p class="mt-6 flex items-start gap-2 text-[13px] leading-relaxed text-faint">
        <ShieldCheck :size="16" class="mt-0.5 shrink-0" />
        Everything stays on your local network. Nothing is sent to the internet.
      </p>
    </div>
  </main>
</template>
