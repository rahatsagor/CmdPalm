<script setup lang="ts">
import { Check, LoaderCircle, Pencil, Plus } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import PageEditor from '@/components/PageEditor.vue'
import TileEditor from '@/components/TileEditor.vue'
import TileFace from '@/components/TileFace.vue'
import { notify, runAction, state } from '@/lib/connection'
import { LIMITS, clone, newId, newPage, newTile, saveDeck } from '@/lib/deck'
import { haptic } from '@/lib/haptics'
import type { Deck, Tile } from '@/lib/protocol'
import { settings } from '@/lib/settings'

const deck = computed(() => state.deck)
const pages = computed(() => deck.value?.pages ?? [])
const index = computed(() => Math.max(0, pages.value.findIndex((p) => p.id === settings.deckPage)))
const page = computed(() => pages.value[index.value])

const editing = ref(false)
const tileEdit = ref<{ tile: Tile; index: number | null } | null>(null)
const pageEdit = ref(false)
const scroller = ref<HTMLElement>()

function mutate(change: (deck: Deck) => void) {
  if (!deck.value) return
  const next = clone(deck.value)
  change(next)
  saveDeck(next)
}

function selectPage(i: number, smooth = true) {
  const target = pages.value[i]
  if (!target) return
  settings.deckPage = target.id
  const el = scroller.value
  if (el && !editing.value) el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? 'smooth' : 'instant' })
}

let scrollTimer: ReturnType<typeof setTimeout> | undefined
function onScroll() {
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    const el = scroller.value
    if (!el || editing.value) return
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
    const target = pages.value[i]
    if (target && target.id !== settings.deckPage) {
      settings.deckPage = target.id
      haptic('select')
    }
  }, 60)
}

watch(
  () => [pages.value.length, editing.value],
  async () => {
    await nextTick()
    selectPage(index.value, false)
  },
  { immediate: true },
)

const status = reactive(new Map<string, 'running' | 'failed'>())

async function run(tile: Tile) {
  haptic('light')
  const slow = setTimeout(() => status.set(tile.id, 'running'), 250)
  const result = await runAction(tile.action)
  clearTimeout(slow)
  if (result.ok) {
    status.delete(tile.id)
    return
  }
  status.set(tile.id, 'failed')
  haptic('heavy')
  if (result.message) notify(result.message, 'error')
  setTimeout(() => status.delete(tile.id), 600)
}

interface Press {
  pointerId: number
  index: number
  x: number
  y: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  moved: boolean
  longPressed: boolean
}
const press = ref<Press | null>(null)
const ghost = ref({ x: 0, y: 0 })
let longTimer: ReturnType<typeof setTimeout> | undefined

function onTileDown(i: number, event: PointerEvent) {
  if (press.value || (event.pointerType === 'mouse' && event.button !== 0)) return
  const el = event.currentTarget as HTMLElement
  el.setPointerCapture(event.pointerId)
  const rect = el.getBoundingClientRect()
  press.value = {
    pointerId: event.pointerId,
    index: i,
    x: event.clientX,
    y: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    moved: false,
    longPressed: false,
  }
  ghost.value = { x: rect.left, y: rect.top }
  clearTimeout(longTimer)
  if (!editing.value) {
    longTimer = setTimeout(() => {
      if (!press.value || press.value.moved) return
      press.value.longPressed = true
      haptic('medium')
      editing.value = true
    }, 550)
  }
}

function onTileMove(event: PointerEvent) {
  const p = press.value
  if (!p || p.pointerId !== event.pointerId) return
  if (!p.moved && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8) {
    p.moved = true
    clearTimeout(longTimer)
  }
  if (!editing.value || !p.moved) return
  ghost.value = { x: event.clientX - p.offsetX, y: event.clientY - p.offsetY }
  const over = document
    .elementsFromPoint(event.clientX, event.clientY)
    .map((el) => (el as HTMLElement).closest<HTMLElement>('[data-tile-index]'))
    .find((el) => el && Number(el.dataset.tileIndex) !== p.index)
  const target = over ? Number(over.dataset.tileIndex) : -1
  if (target < 0 || !page.value || !deck.value) return
  // Reorder locally while dragging; save once on release.
  const tiles = page.value.tiles
  const [moved] = tiles.splice(p.index, 1)
  tiles.splice(target, 0, moved!)
  p.index = target
  haptic('select')
}

function onTileUp(event: PointerEvent, cancelled = false) {
  const p = press.value
  if (!p || p.pointerId !== event.pointerId) return
  clearTimeout(longTimer)
  press.value = null
  const tile = page.value?.tiles[p.index]
  if (editing.value && p.moved) {
    // The tiles were already reordered locally.
    if (deck.value) saveDeck(deck.value)
    return
  }
  if (!tile || cancelled || p.moved) return
  if (p.longPressed) {
    tileEdit.value = { tile, index: p.index }
    return
  }
  if (editing.value) tileEdit.value = { tile, index: p.index }
  else void run(tile)
}

function onLostCapture(event: PointerEvent) {
  // A tile being dragged can lose capture when the reorder moves it in the
  // DOM; the drag still ends on the next lift (see onStrayUp).
  if (editing.value && press.value?.moved) return
  onTileUp(event, true)
}

// A lift that no tile saw (it landed outside the grid after capture was
// lost) must still end the press, or no tile would respond again.
function onStrayUp(event: PointerEvent) {
  if (press.value?.pointerId === event.pointerId) onTileUp(event, true)
}

function endPress() {
  clearTimeout(longTimer)
  press.value = null
}

onMounted(() => {
  document.addEventListener('pointerup', onStrayUp)
  document.addEventListener('pointercancel', onStrayUp)
})
onDeactivated(endPress)
onBeforeUnmount(() => {
  endPress()
  document.removeEventListener('pointerup', onStrayUp)
  document.removeEventListener('pointercancel', onStrayUp)
})

function addTile() {
  if (!page.value || page.value.tiles.length >= LIMITS.tiles) return
  tileEdit.value = { tile: newTile({ kind: 'keys', code: 0x08, mods: 1, char: 'c' }), index: null }
}

function saveTile(tile: Tile) {
  const edit = tileEdit.value
  tileEdit.value = null
  const pageId = page.value?.id
  mutate((d) => {
    const target = d.pages.find((p) => p.id === pageId)
    if (!target) return
    if (edit?.index == null) target.tiles.push(tile)
    else target.tiles[edit.index] = tile
  })
}

function removeTile() {
  const edit = tileEdit.value
  tileEdit.value = null
  if (edit?.index == null) return
  const pageId = page.value?.id
  mutate((d) => d.pages.find((p) => p.id === pageId)?.tiles.splice(edit.index!, 1))
}

function duplicateTile() {
  const edit = tileEdit.value
  tileEdit.value = null
  if (edit?.index == null || !page.value || page.value.tiles.length >= LIMITS.tiles) return
  const pageId = page.value.id
  mutate((d) => {
    const target = d.pages.find((p) => p.id === pageId)
    const source = target?.tiles[edit.index!]
    if (target && source) target.tiles.splice(edit.index! + 1, 0, { ...clone(source), id: newId() })
  })
}

function addPage() {
  if (pages.value.length >= LIMITS.pages) return
  const created = newPage(`Page ${pages.value.length + 1}`)
  mutate((d) => d.pages.push(created))
  settings.deckPage = created.id
  pageEdit.value = true
}

function savePage(values: { name: string; columns: number }) {
  pageEdit.value = false
  const id = page.value?.id
  mutate((d) => {
    const target = d.pages.find((p) => p.id === id)
    if (target) Object.assign(target, values)
  })
}

function movePage(by: number) {
  const i = index.value
  mutate((d) => {
    const j = i + by
    if (j < 0 || j >= d.pages.length) return
    ;[d.pages[i], d.pages[j]] = [d.pages[j]!, d.pages[i]!]
  })
}

function removePage() {
  pageEdit.value = false
  const i = index.value
  mutate((d) => {
    if (d.pages.length > 1) d.pages.splice(i, 1)
  })
  settings.deckPage = pages.value[Math.max(0, i - 1)]?.id ?? ''
}

function tileStyle(tile: Tile) {
  return tile.color ? { background: `color-mix(in srgb, ${tile.color} 20%, var(--surface))`, color: tile.color } : {}
}

const dragged = computed(() => (press.value?.moved && editing.value ? page.value?.tiles[press.value.index] : undefined))
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 px-3 pt-1 pb-2">
      <div class="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist">
        <button
          v-for="(p, i) in pages"
          :key="p.id"
          type="button"
          role="tab"
          :aria-selected="i === index"
          class="h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors"
          :class="i === index ? 'bg-text text-bg' : 'text-muted'"
          @click="i === index && editing ? (pageEdit = true) : selectPage(i)"
        >
          {{ p.name || 'Page' }}
          <Pencil v-if="editing && i === index" :size="11" class="ml-1 inline align-[-1px]" />
        </button>
        <button
          v-if="editing && pages.length < LIMITS.pages"
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-full text-muted"
          aria-label="Add page"
          @click="addPage"
        >
          <Plus :size="17" />
        </button>
      </div>
      <button
        type="button"
        class="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors"
        :class="editing ? 'bg-accent text-accent-text' : 'bg-surface-3 text-muted'"
        @click="editing = !editing"
      >
        <Check v-if="editing" :size="15" />
        <Pencil v-else :size="14" />
        {{ editing ? 'Done' : 'Edit' }}
      </button>
    </div>

    <div v-if="!deck" class="grid flex-1 place-items-center text-muted"><LoaderCircle class="animate-spin" /></div>

    <div
      v-else
      ref="scroller"
      class="no-scrollbar flex min-h-0 flex-1 snap-x snap-mandatory"
      :class="editing ? 'overflow-hidden' : 'overflow-x-auto'"
      @scroll.passive="onScroll"
    >
      <section
        v-for="(p, pi) in pages"
        v-show="!editing || pi === index"
        :key="p.id"
        class="no-scrollbar h-full w-full shrink-0 snap-start overflow-y-auto overscroll-contain px-3 pb-3"
        role="tabpanel"
        :aria-label="p.name"
      >
        <div class="grid gap-2.5" :style="{ gridTemplateColumns: `repeat(${p.columns}, minmax(0, 1fr))` }">
          <button
            v-for="(tile, ti) in p.tiles"
            :key="tile.id"
            type="button"
            :data-tile-index="pi === index ? ti : undefined"
            class="tile relative aspect-square rounded-[22px] border border-line transition-[transform,opacity,background-color] duration-150 active:scale-[0.96]"
            :class="[
              !tile.color && 'bg-surface',
              // Outside edit mode the page must still scroll under a finger.
              editing && 'wiggle touch-none',
              dragged?.id === tile.id && 'opacity-25',
              status.get(tile.id) === 'failed' && 'shake border-bad',
            ]"
            :style="tileStyle(tile)"
            :aria-label="tile.label || undefined"
            @pointerdown="onTileDown(ti, $event)"
            @pointermove="onTileMove"
            @pointerup="onTileUp($event)"
            @pointercancel="onTileUp($event, true)"
            @lostpointercapture="onLostCapture"
            @contextmenu.prevent
          >
            <TileFace :tile="tile" :compact="p.columns >= 5" />
            <span v-if="status.get(tile.id) === 'running'" class="absolute inset-0 grid place-items-center rounded-[22px] bg-bg/50">
              <LoaderCircle class="animate-spin" :size="20" />
            </span>
          </button>
          <button
            v-if="editing && p.tiles.length < LIMITS.tiles"
            type="button"
            class="grid aspect-square place-items-center rounded-[22px] border border-dashed border-line-strong text-muted"
            aria-label="Add button"
            @click="addTile"
          >
            <Plus :size="26" />
          </button>
        </div>
        <div v-if="p.tiles.length === 0 && !editing" class="flex flex-col items-center gap-3 py-16 text-center text-muted">
          <p class="text-[15px]">No buttons on this page yet.</p>
          <button type="button" class="h-10 rounded-full bg-surface-3 px-4 text-[14px] font-medium text-text" @click="((editing = true), addTile())">
            Add a button
          </button>
        </div>
        <p v-if="editing" class="pt-4 text-center text-[12px] text-faint">Tap a button to edit it. Drag to reorder.</p>
      </section>
    </div>

    <div
      v-if="dragged && press"
      class="pointer-events-none fixed z-30 rounded-[22px] border border-line-strong shadow-2xl"
      :class="!dragged.color && 'bg-surface-2'"
      :style="{ left: `${ghost.x}px`, top: `${ghost.y}px`, width: `${press.width}px`, height: `${press.height}px`, transform: 'scale(1.06)', ...tileStyle(dragged) }"
    >
      <TileFace :tile="dragged" :compact="(page?.columns ?? 4) >= 5" />
    </div>

    <TileEditor
      v-if="tileEdit"
      :tile="tileEdit.tile"
      :is-new="tileEdit.index === null"
      @save="saveTile"
      @remove="removeTile"
      @duplicate="duplicateTile"
      @close="tileEdit = null"
    />
    <PageEditor v-if="pageEdit && page" :page="page" :index="index" :count="pages.length" @save="savePage" @move="movePage" @remove="removePage" @close="pageEdit = false" />
  </div>
</template>

<style scoped>
.tile {
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.25);
}
.wiggle {
  animation: wiggle 260ms ease-in-out infinite alternate;
}
.wiggle:nth-child(2n) {
  animation-delay: -130ms;
}
@keyframes wiggle {
  from {
    transform: rotate(-0.8deg);
  }
  to {
    transform: rotate(0.8deg);
  }
}
.shake {
  animation: shake 300ms ease;
}
@keyframes shake {
  25% {
    transform: translateX(-4px);
  }
  75% {
    transform: translateX(4px);
  }
}
</style>
