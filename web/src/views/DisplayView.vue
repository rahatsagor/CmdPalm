<script setup lang="ts">
import { LocateFixed, Maximize, Minimize, Monitor, Play, RefreshCw, RotateCcw, Settings2, Square, ZoomIn, ZoomOut } from '@lucide/vue'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import DisplayPreferences from '@/components/DisplayPreferences.vue'
import ScrollRail from '@/components/ScrollRail.vue'
import Segmented from '@/components/Segmented.vue'
import Sheet from '@/components/Sheet.vue'
import TrackpadSurface from '@/components/TrackpadSurface.vue'
import { state as connection } from '@/lib/connection'
import { releaseAll } from '@/lib/input'
import { activateScreen, cancelAccessRequest, deactivateScreen, focusDisplay, playViewing, refreshDisplays, requestScreenAccess, screen, selectedDisplay, startViewing, stopViewing } from '@/lib/screen'
import { settings } from '@/lib/settings'
import KeyboardView from './KeyboardView.vue'

const video = ref<HTMLVideoElement>()
const picture = ref<HTMLCanvasElement>()
const displayArea = ref<HTMLElement>()
const body = ref<HTMLElement>()
const preview = ref<HTMLElement>()
const options = ref(false)
const fullView = ref(false)
const size = reactive({ width: 0, height: 0 })
const zoom = ref(1)
const pan = reactive({ x: 0, y: 0 })
let observer: ResizeObserver | undefined
const pointers = new Map<number, { x: number; y: number }>()
let gesture: { distance: number; zoom: number; x: number; y: number } | undefined
let fullscreenOpener: HTMLElement | null = null
let fullscreenObserver: MutationObserver | undefined
const outsideFullscreen = new Map<HTMLElement, string | null>()

const streaming = computed(() => screen.status === 'connecting' || screen.status === 'live')
const live = computed(() => screen.status === 'live')
const wide = computed(() => size.width >= 640 && size.width > size.height * 1.3)
const display = computed(selectedDisplay)
const previewLength = computed(() => {
  const available = wide.value ? size.width : size.height
  const controls = wide.value ? (settings.displayControls === 'keyboard' ? 260 : 120) : (settings.displayControls === 'keyboard' ? 176 : 96)
  return Math.max(0, Math.min(available - 48, Math.max(64, Math.min(available * settings.displaySplit, available - controls - 8))))
})
const previewStyle = computed(() => settings.displayControls === 'view' ? { flex: '1 1 0%' } : { flex: `0 0 ${previewLength.value}px` })
const controlsHeight = computed(() => wide.value ? size.height : Math.max(0, size.height - previewLength.value - 8))
const compactPreview = computed(() => !fullView.value && settings.displayControls !== 'view' && (wide.value ? size.height : previewLength.value) < 140)
const media = reactive({ width: 0, height: 0 })
const previewSize = reactive({ width: 0, height: 0 })
const maxZoom = computed(() => {
  const floor = screen.original ? 8 : 4
  const ceiling = screen.original ? 12 : 8
  if (!media.width || !media.height || !previewSize.width || !previewSize.height) return floor
  const fit = Math.min(previewSize.width / media.width, previewSize.height / media.height)
  if (!Number.isFinite(fit) || fit <= 0) return floor
  return Math.max(floor, Math.min(ceiling, Math.round((4 / fit) * 10) / 10))
})
const mode = computed({ get: () => settings.displayControls, set: value => { releaseAll(); settings.displayControls = value } })
const placeholder = computed(() => {
  if (screen.status === 'loading') return 'Finding displays…'
  if (screen.needsPlay) return 'Tap to show the display'
  if (screen.status === 'connecting') return screen.original ? 'Connecting HD view…' : 'Connecting video…'
  if (screen.message) return screen.message
  if (display.value) return 'Start viewing to see this display.'
  return 'Choose a display to start viewing.'
})

function activate() { if (video.value) activateScreen(video.value, picture.value) }
function restoreInert(element: HTMLElement, previous: string | null) {
  if (previous === null) element.removeAttribute('inert')
  else element.setAttribute('inert', previous)
}
function isolateFullscreen() {
  if (!fullView.value || !displayArea.value || !screen.active) return
  // Responsive navigation can be replaced while rotating. Do not retain
  // detached controls or leave cached elements inert when they return.
  for (const [element, previous] of outsideFullscreen) {
    if (!element.isConnected) { restoreInert(element, previous); outsideFullscreen.delete(element) }
  }
  let branch: HTMLElement = displayArea.value
  while (branch.parentElement && branch !== document.body) {
    for (const sibling of branch.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling !== branch && !outsideFullscreen.has(sibling)) {
        outsideFullscreen.set(sibling, sibling.getAttribute('inert'))
        sibling.setAttribute('inert', '')
      }
    }
    branch = branch.parentElement
  }
}
function enterFullscreen() {
  if (fullView.value) return
  releaseAll()
  fullscreenOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  fullView.value = true
  options.value = false
  const element = displayArea.value
  // Also dismiss a phone keyboard and keep focus out of controls hidden by
  // the viewport fallback, where the browser does not isolate fullscreen.
  element?.focus({ preventScroll: true })
  void nextTick(() => {
    if (!fullView.value || !element || !screen.active) return
    isolateFullscreen()
    fullscreenObserver = new MutationObserver(isolateFullscreen)
    fullscreenObserver.observe(document.body, { childList: true, subtree: true })
  })
  if (element?.requestFullscreen && document.fullscreenEnabled) {
    void element.requestFullscreen().then(() => {
      if (!fullView.value || !screen.active || !streaming.value) {
        if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {})
      }
    }).catch(() => {})
  }
}
function leaveFullscreen(restoreFocus = true) {
  const wasFull = fullView.value
  fullView.value = false
  fullscreenObserver?.disconnect(); fullscreenObserver = undefined
  for (const [element, previous] of outsideFullscreen) restoreInert(element, previous)
  outsideFullscreen.clear()
  if (document.fullscreenElement === displayArea.value) void document.exitFullscreen().catch(() => {})
  if (wasFull && restoreFocus && fullscreenOpener?.isConnected) fullscreenOpener.focus({ preventScroll: true })
  fullscreenOpener = null
}
function fullscreenChanged() { if (!document.fullscreenElement) leaveFullscreen() }
function fullscreenKeys(event: KeyboardEvent) {
  if (!fullView.value) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); leaveFullscreen() }
  else if (['Enter', ' ', 'Tab'].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && event.target instanceof Element && displayArea.value?.contains(event.target) && event.target.closest('button')) {
    // Explicitly focused viewer buttons use the browser's keyboard actions.
    // Other hardware keyboard input can still be sent to the Mac.
    event.stopPropagation()
  }
}
onMounted(() => {
  observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const target = entry.target === preview.value ? previewSize : size
      target.width = entry.contentRect.width
      target.height = entry.contentRect.height
    }
    clampPan()
  })
  if (body.value) observer.observe(body.value)
  if (preview.value) observer.observe(preview.value)
  document.addEventListener('fullscreenchange', fullscreenChanged)
  addEventListener('keydown', fullscreenKeys, true)
  activate()
})
onActivated(activate)
onDeactivated(() => { options.value = false; leaveFullscreen(false); deactivateScreen() })
onBeforeUnmount(() => {
  leaveFullscreen(false); observer?.disconnect(); deactivateScreen()
  document.removeEventListener('fullscreenchange', fullscreenChanged)
  removeEventListener('keydown', fullscreenKeys, true)
})

function resetZoom() { zoom.value = 1; pan.x = 0; pan.y = 0; pointers.clear(); gesture = undefined }
watch(() => [settings.displayId, settings.displayQuality], () => { stopViewing(); resetZoom() }, { flush: 'sync' })
watch(() => screen.status, status => { if (status !== 'live') resetZoom(); if (!streaming.value) leaveFullscreen() })
watch(fullView, () => { void nextTick(clampPan) })
watch(() => [settings.displayControls, settings.displaySplit], () => { void nextTick(clampPan) })

function chooseDisplay(id: string) {
  if (id === settings.displayId) return
  const resume = streaming.value
  settings.displayId = id
  if (resume) void startViewing()
}
function quality(value: typeof settings.displayQuality) {
  const resume = streaming.value && value !== settings.displayQuality
  settings.displayQuality = value
  options.value = false
  if (resume) void startViewing()
}

function clampPan() {
  const element = preview.value
  const width = screen.original ? picture.value?.width : video.value?.videoWidth
  const height = screen.original ? picture.value?.height : video.value?.videoHeight
  media.width = width || 0
  media.height = height || 0
  if (!element || !width || !height) { pan.x = 0; pan.y = 0; return }
  if (zoom.value > maxZoom.value) zoom.value = maxZoom.value
  const fit = Math.min(element.clientWidth / width, element.clientHeight / height)
  const x = Math.max(0, (width * fit * zoom.value - element.clientWidth) / 2)
  const y = Math.max(0, (height * fit * zoom.value - element.clientHeight) / 2)
  pan.x = Math.min(x, Math.max(-x, pan.x))
  pan.y = Math.min(y, Math.max(-y, pan.y))
}

function changeZoom(value: number) { zoom.value = Math.max(1, Math.min(maxZoom.value, value)); clampPan() }
function beginGesture() {
  const points = [...pointers.values()]
  const a = points[0]
  const b = points[1]
  if (a && b) gesture = { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), zoom: zoom.value, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  else gesture = undefined
}
function down(event: PointerEvent) {
  if (!live.value || (event.target as HTMLElement).closest('button')) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  beginGesture()
}
function move(event: PointerEvent) {
  const previous = pointers.get(event.pointerId)
  if (!previous) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  const [a, b] = [...pointers.values()]
  if (gesture && a && b) {
    const x = (a.x + b.x) / 2
    const y = (a.y + b.y) / 2
    const bounds = preview.value!.getBoundingClientRect()
    const centerX = bounds.left + bounds.width / 2
    const centerY = bounds.top + bounds.height / 2
    const nextZoom = Math.max(1, Math.min(maxZoom.value, gesture.zoom * Math.hypot(b.x - a.x, b.y - a.y) / gesture.distance))
    // Keep the content under the pinch midpoint in place as zoom changes.
    pan.x = x - centerX - (gesture.x - centerX - pan.x) * nextZoom / zoom.value
    pan.y = y - centerY - (gesture.y - centerY - pan.y) * nextZoom / zoom.value
    zoom.value = nextZoom
    gesture.x = x
    gesture.y = y
  } else if (zoom.value > 1) {
    pan.x += event.clientX - previous.x
    pan.y += event.clientY - previous.y
  }
  clampPan()
}
function up(event: PointerEvent) { pointers.delete(event.pointerId); beginGesture() }
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2 px-2 pt-1 pb-2">
    <div class="flex shrink-0 items-center gap-1.5">
      <Monitor :size="19" class="ml-1 shrink-0 text-muted" aria-hidden="true" />
      <select
        v-if="screen.displays.length > 1 || (screen.displays.length && !display)"
        :value="display ? settings.displayId : ''"
        class="h-11 min-w-0 flex-1 rounded-xl bg-surface-2 px-2 text-[14px] font-medium"
        aria-label="Mac display"
        @change="chooseDisplay(($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!display" value="" disabled>Choose a display</option>
        <option v-for="source in screen.displays" :key="source.id" :value="source.id">{{ source.name }} · {{ source.width }} × {{ source.height }}</option>
      </select>
      <span v-else class="min-w-0 flex-1 truncate px-1 text-[14px] font-medium">{{ display?.name || 'Display' }}</span>
      <button
        type="button"
        class="grid size-11 shrink-0 place-items-center rounded-xl text-muted active:bg-surface-3 disabled:opacity-40"
        :disabled="screen.status === 'loading' || connection.status !== 'connected'"
        aria-label="Refresh displays"
        @click="refreshDisplays"
      ><RefreshCw :size="17" :class="{ 'animate-spin': screen.status === 'loading' }" /></button>
      <button
        v-if="streaming"
        type="button"
        class="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-surface-3 px-3 text-[13px] font-semibold"
        @click="stopViewing()"
      ><Square :size="14" />Stop</button>
      <button
        v-else
        type="button"
        class="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-[13px] font-semibold text-accent-text disabled:opacity-40"
        :disabled="!display || screen.status === 'loading' || connection.paused || connection.status !== 'connected'"
        @click="startViewing"
      ><Play :size="15" />View</button>
    </div>

    <div class="flex shrink-0 items-center gap-2">
      <Segmented
        v-model="mode"
        class="min-w-0 flex-1 py-0!"
        label=""
        :options="[{ value: 'view', label: 'View' }, { value: 'trackpad', label: 'Trackpad' }, { value: 'keyboard', label: 'Keyboard' }]"
        aria-label="Controls below the display"
        :keyboard-navigation="false"
      />
      <button v-if="live" type="button" class="grid size-11 shrink-0 place-items-center rounded-xl text-muted active:bg-surface-3" aria-label="Fullscreen display" @click="enterFullscreen" @keydown.enter.prevent="enterFullscreen" @keydown.space.prevent="enterFullscreen"><Maximize :size="19" /></button>
      <button type="button" class="grid size-11 shrink-0 place-items-center rounded-xl text-muted active:bg-surface-3" aria-label="Display options" @click="options = true"><Settings2 :size="19" /></button>
    </div>

    <div ref="body" class="flex min-h-0 flex-1 gap-2" :class="wide ? 'flex-row' : 'flex-col'">
      <div
        ref="displayArea"
        tabindex="-1"
        role="region"
        :aria-label="fullView ? 'Fullscreen Mac display' : 'Mac display preview'"
        class="display-preview relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-black"
        :class="fullView ? 'fixed! inset-0 z-[100] px-2 pt-[calc(env(safe-area-inset-top)+52px)] pb-[env(safe-area-inset-bottom)]' : 'rounded-2xl'"
        :style="fullView ? undefined : previewStyle"
      >
        <div v-if="fullView" class="absolute inset-x-2 top-[env(safe-area-inset-top)] flex h-12 items-center justify-between gap-2 text-white">
          <span class="min-w-0 truncate px-2 text-[13px]">{{ display?.name }}{{ screen.original ? ' · HD text · lossless' : '' }}</span>
          <button type="button" class="flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[13px]" @click="stopViewing()"><Square :size="15" />Stop</button>
          <button type="button" class="flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[13px]" @click="leaveFullscreen()"><Minimize :size="17" />Exit</button>
        </div>
        <div
          ref="preview"
          class="relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden"
          @pointerdown="down"
          @pointermove="move"
          @pointerup="up"
          @pointercancel="up"
          @lostpointercapture="up"
          @contextmenu.prevent
        >
        <video
          ref="video"
          v-show="streaming && !screen.original"
          autoplay
          muted
          playsinline
          disablepictureinpicture
          class="h-full w-full object-contain"
          :class="{ 'opacity-0': !live }"
          :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }"
          aria-label="Live view of the selected Mac display"
          @loadedmetadata="clampPan"
        />
        <canvas
          ref="picture"
          v-show="live && screen.original"
          role="img"
          aria-label="Lossless HD view of the selected Mac display"
          class="h-full w-full object-contain"
          :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }"
          @load="clampPan"
        />
        <div v-if="!live" class="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto px-5 py-3 text-center text-[#d7dce2]" role="status" aria-live="polite">
          <Monitor :size="28" :class="{ 'animate-pulse': screen.status === 'connecting' || screen.status === 'loading' }" class="shrink-0 opacity-50" aria-hidden="true" />
          <p class="max-w-sm text-[13px] leading-relaxed">{{ placeholder }}</p>
          <template v-if="screen.canRequest && connection.status === 'connected' && !connection.paused">
            <button type="button" class="min-h-11 rounded-full bg-accent px-4 text-[13px] font-semibold text-accent-text disabled:opacity-50" :disabled="screen.accessState === 'pending'" @click="requestScreenAccess">{{ screen.accessState === 'pending' ? 'Waiting for the Mac…' : 'Ask Mac to allow viewing' }}</button>
            <p v-if="screen.accessMessage" class="max-w-sm text-[12px] leading-relaxed">{{ screen.accessMessage }}</p>
            <button v-if="screen.accessState === 'pending'" type="button" class="min-h-11 px-3 text-[12px]" @click="cancelAccessRequest">Cancel request</button>
          </template>
          <button v-if="screen.needsPlay" type="button" class="flex min-h-11 items-center gap-2 rounded-full bg-accent px-4 text-[13px] font-semibold text-accent-text" @click="playViewing"><Play :size="16" />Show display</button>
        </div>
        <p v-if="live && screen.message" class="absolute top-2 right-2 left-2 rounded-lg bg-black/75 px-3 py-2 text-center text-[12px] text-white" role="status">{{ screen.message }}</p>
        </div>
        <div v-if="live && !compactPreview" class="flex shrink-0 items-center justify-between gap-1 px-2 py-1">
          <button
            type="button"
            class="flex min-h-11 items-center gap-1.5 rounded-xl bg-black/70 px-2.5 text-[12px] text-white disabled:opacity-40"
            :disabled="!connection.features.permission"
            aria-label="Move the Mac pointer to this display"
            @click="focusDisplay"
          ><LocateFixed :size="16" /><span class="pointer-label">Pointer here</span></button>
          <div class="flex items-center rounded-xl bg-black/70 text-white">
            <button type="button" class="grid size-11 place-items-center disabled:opacity-30" aria-label="Zoom out preview" :disabled="zoom <= 1" @click="changeZoom(zoom / 1.4)"><ZoomOut :size="17" /></button>
            <button type="button" class="grid h-11 min-w-10 place-items-center text-[12px] tabular-nums" aria-label="Fit display in preview" @click="resetZoom"><RotateCcw v-if="zoom > 1" :size="16" /><span v-else>Fit</span></button>
            <button type="button" class="grid size-11 place-items-center disabled:opacity-30" aria-label="Zoom in preview" :disabled="zoom >= maxZoom" @click="changeZoom(zoom * 1.4)"><ZoomIn :size="17" /></button>
          </div>
        </div>
      </div>

      <TrackpadSurface v-if="settings.displayControls === 'trackpad'" class="min-h-0 min-w-0 flex-1" :edge="!wide || settings.scrollStripSide === 'right'">
        <ScrollRail v-if="settings.scrollStrip !== 'off'" />
      </TrackpadSurface>
      <KeyboardView v-else-if="settings.displayControls === 'keyboard'" embedded :compact="controlsHeight < 240" class="min-h-0 min-w-0 flex-1" />
    </div>

    <Sheet v-if="options" title="Display options" @close="options = false">
      <div v-if="live && compactPreview" class="mb-4 flex items-center justify-between gap-2 rounded-2xl bg-surface-2 p-2">
        <button type="button" class="flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-[12px] disabled:opacity-40" :disabled="!connection.features.permission" @click="focusDisplay(); options = false"><LocateFixed :size="16" />Pointer here</button>
        <div class="flex items-center">
          <button type="button" class="grid size-11 place-items-center disabled:opacity-30" aria-label="Zoom out preview" :disabled="zoom <= 1" @click="changeZoom(zoom / 1.4)"><ZoomOut :size="17" /></button>
          <button type="button" class="grid h-11 min-w-10 place-items-center text-[12px]" aria-label="Fit display in preview" @click="resetZoom">Fit</button>
          <button type="button" class="grid size-11 place-items-center disabled:opacity-30" aria-label="Zoom in preview" :disabled="zoom >= maxZoom" @click="changeZoom(zoom * 1.4)"><ZoomIn :size="17" /></button>
        </div>
      </div>
      <DisplayPreferences :show-layout="false" @quality="quality" />
    </Sheet>
  </div>
</template>

<style scoped>
.display-preview { container-type: inline-size; }
.pointer-label { display: none; }
@container (min-width: 300px) {
  .pointer-label { display: inline; }
}
</style>
