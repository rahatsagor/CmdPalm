<script setup lang="ts">
import { Check, LoaderCircle, Pencil, Plus, Redo2, Undo2 } from '@lucide/vue'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import PageEditor from '@/components/PageEditor.vue'
import GroupTabs from '@/components/GroupTabs.vue'
import TileEditor from '@/components/TileEditor.vue'
import HapticSwitch from '@/components/HapticSwitch.vue'
import TileFace from '@/components/TileFace.vue'
import { notify, runAction, state } from '@/lib/connection'
import { LIMITS, clone, deckHistory, newId, newPage, newTile, redoDeck, saveDeck, undoDeck } from '@/lib/deck'
import { REFERENCE_WIDTH, deckColumns, tileWidth } from '@/lib/deckGrid'
import { haptic } from '@/lib/haptics'
import type { Deck, DeckPage, Tile } from '@/lib/protocol'
import { settings } from '@/lib/settings'
import { equalJson } from '@/lib/value'

const deck = computed(() => state.deck)
const pages = computed(() => deck.value?.pages ?? [])
const index = computed(() => Math.max(0, pages.value.findIndex((p) => p.id === settings.deckPage)))
const page = computed(() => pages.value[index.value])
const pageById = (id: string) => pages.value.find((p) => p.id === id)

const editing = ref(false)
const tileEdit = ref<{ tile: Tile; pageId: string; isNew: boolean } | null>(null)
/** The id of the page being edited. */
const pageEdit = ref<string | null>(null)
const editedPage = computed(() => (pageEdit.value ? pageById(pageEdit.value) : undefined))
const scroller = ref<HTMLElement>()

/** Width inside a page's padding (px-3 on each side). */
const gridWidth = ref(0)
let resizer: ResizeObserver | undefined
watch(scroller, (el, old) => {
  if (old) resizer?.unobserve(old)
  if (!el) return
  resizer ??= new ResizeObserver(([entry]) => {
    if (entry) gridWidth.value = Math.max(0, entry.contentRect.width - 24)
  })
  resizer.observe(el)
})
onBeforeUnmount(() => resizer?.disconnect())

const columns = (p: DeckPage) => deckColumns(p.columns, gridWidth.value, settings.deckButtonSize)
const tileSize = (p: DeckPage) => tileWidth(columns(p), gridWidth.value || REFERENCE_WIDTH)

async function mutate(change: (deck: Deck) => void): Promise<boolean> {
  if (!deck.value || deckHistory.saving) return false
  const next = clone(deck.value)
  change(next)
  if (equalJson(deck.value, next)) return true
  return saveDeck(next)
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

// Runs on every deck change, as the getter returns a new array each time:
// another device can also reorder the pages.
watch(
  () => [pages.value.length, editing.value],
  async () => {
    await nextTick()
    selectPage(index.value, false)
  },
  { immediate: true },
)

// The page strip loses its scroll position while another tab is open.
onActivated(() => {
  selectPage(index.value, false)
})

function selectGroup(id: string) {
  if (id === page.value?.id && editing.value) pageEdit.value = id
  else selectPage(pages.value.findIndex((p) => p.id === id))
}

function reorderPages(ids: string[]) {
  const order = new Map(ids.map((id, i) => [id, i]))
  mutate((d) => d.pages.sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length)))
}

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
  haptic('error')
  if (result.message) notify(result.message, 'error')
  setTimeout(() => status.delete(tile.id), 600)
}

interface Press {
  pointerId: number
  pageId: string
  index: number
  tile: Tile
  x: number
  y: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  moved: boolean
  /** Tiles were reordered on screen, not yet on the Mac. */
  reordered: boolean
  longPressed: boolean
}
const press = ref<Press | null>(null)
const ghost = ref({ x: 0, y: 0 })
let longTimer: ReturnType<typeof setTimeout> | undefined

function onTileDown(pageId: string, i: number, event: PointerEvent) {
  if (press.value || (editing.value && deckHistory.saving) || (event.pointerType === 'mouse' && event.button !== 0)) return
  const tile = pageById(pageId)?.tiles[i]
  if (!tile) return
  const el = event.currentTarget as HTMLElement
  el.setPointerCapture(event.pointerId)
  const rect = el.getBoundingClientRect()
  press.value = {
    pointerId: event.pointerId,
    pageId,
    index: i,
    tile: clone(tile),
    x: event.clientX,
    y: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    moved: false,
    reordered: false,
    longPressed: false,
  }
  ghost.value = { x: rect.left, y: rect.top }
  clearTimeout(longTimer)
  if (!editing.value) {
    longTimer = setTimeout(() => {
      if (!press.value || press.value.moved) return
      press.value.longPressed = true
      haptic('medium')
      // Edit mode shows only the selected page, so select the one held.
      settings.deckPage = press.value.pageId
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
  const tiles = pageById(p.pageId)?.tiles
  if (target < 0 || !tiles) return
  const from = tiles.findIndex((tile) => tile.id === p.tile.id)
  if (from < 0) return
  // Reorder locally while dragging; save once on release.
  const [moved] = tiles.splice(from, 1)
  tiles.splice(target, 0, moved!)
  p.index = target
  p.reordered = true
  haptic('select')
}

function onTileUp(event: PointerEvent, cancelled = false) {
  const p = press.value
  if (!p || p.pointerId !== event.pointerId) return
  endPress()
  const tile = pageById(p.pageId)?.tiles.find((tile) => tile.id === p.tile.id)
  if (!tile || cancelled || p.moved) return
  if (JSON.stringify(tile.action) !== JSON.stringify(p.tile.action)) return
  if (editing.value || p.longPressed) tileEdit.value = { tile, pageId: p.pageId, isNew: false }
  else void run(tile)
}

/** A button pressed from a keyboard, or by a screen reader. */
function activate(pageId: string, tile: Tile) {
  if (editing.value) tileEdit.value = { tile, pageId, isNew: false }
  else void run(tile)
}

// Taps run on pointerup and give their click a detail of 1 or more; a
// screen reader's click has none. The hidden switch's own copy of the
// click is ignored.
function onTileClick(pageId: string, tile: Tile, event: MouseEvent) {
  if (event.detail === 0 && !(event.target instanceof HTMLInputElement)) activate(pageId, tile)
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

function endPress(save = true) {
  clearTimeout(longTimer)
  const p = press.value
  press.value = null
  // Keep the new order even when the drag ends early (Done tapped or the tab
  // switched mid-drag): otherwise it shows here but never reaches the Mac.
  if (save && p?.reordered && deck.value) void saveDeck(deck.value)
}

// A remote save replaces the draft being dragged. End that drag without
// saving its earlier positions back over the newer deck.
watch(deck, () => { if (press.value?.reordered) endPress(false) })

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

function addTile(target: DeckPage) {
  if (target.tiles.length >= LIMITS.tiles) return
  settings.deckPage = target.id
  tileEdit.value = { tile: newTile({ kind: 'keys', code: 0x08, mods: 1, char: 'c' }), pageId: target.id, isNew: true }
}

// Tiles are found by id, not position: another device can change the page
// while the editor is open. The editor stays open when the change can't be
// saved, so nothing typed into it is lost.
async function editTile(change: (tiles: Tile[], at: number) => void, removing = false): Promise<boolean> {
  const edit = tileEdit.value
  if (!edit || !deck.value || deckHistory.saving) return false
  if (!pageById(edit.pageId)) {
    if (removing) {
      tileEdit.value = null
      return true
    }
    const fallback = page.value
    if (fallback) edit.pageId = fallback.id
    notify(
      fallback
        ? `This button’s page was deleted on another device. Save again to add it to “${fallback.name}”.`
        : 'This button’s page was deleted on another device.',
      'warning',
      'deck',
    )
    return false
  }
  const saved = await mutate((d) => {
    const target = d.pages.find((p) => p.id === edit.pageId)
    if (target) change(target.tiles, target.tiles.findIndex((t) => t.id === edit.tile.id))
  })
  if (saved && tileEdit.value === edit) tileEdit.value = null
  return saved
}

function saveTile(tile: Tile) {
  if (pageById(tileEdit.value?.pageId ?? '')?.tiles.length === LIMITS.tiles && !pageById(tileEdit.value?.pageId ?? '')?.tiles.some((t) => t.id === tile.id)) {
    notify('This page already has the maximum of 64 buttons.', 'warning', 'deck')
    return
  }
  void editTile((tiles, at) => {
    if (at < 0) tiles.push(tile)
    else tiles[at] = tile
  })
}

function removeTile() {
  void editTile((tiles, at) => at >= 0 && tiles.splice(at, 1), true)
}

async function duplicateTile(tile: Tile) {
  const target = pageById(tileEdit.value?.pageId ?? '')
  if (target && target.tiles.length >= LIMITS.tiles && !target.tiles.some((t) => t.id === tile.id)) {
    notify('This page already has the maximum of 64 buttons.', 'warning', 'deck')
    return
  }
  let full = false
  const saved = await editTile((tiles, at) => {
    const i = at < 0 ? tiles.push(tile) - 1 : at
    tiles[i] = tile
    full = tiles.length >= LIMITS.tiles
    if (!full) tiles.splice(i + 1, 0, { ...clone(tile), id: newId() })
  })
  if (saved && full) notify('This page is full, so the button was saved but not duplicated.', 'warning')
}

async function addPage() {
  if (pages.value.length >= LIMITS.pages) return
  const created = newPage(`Page ${pages.value.length + 1}`)
  if (!(await mutate((d) => d.pages.push(created)))) return
  settings.deckPage = created.id
  pageEdit.value = created.id
}

// Like tiles, the edited page is found by id, and the editor closes by
// itself if another device removes the page.
async function savePage(values: { name: string; columns: number }) {
  const id = pageEdit.value
  const current = id ? pageById(id) : undefined
  if (!current || (current.name === values.name && current.columns === values.columns)) { pageEdit.value = null; return }
  const saved = await mutate((d) => {
    const target = d.pages.find((p) => p.id === id)
    if (target) Object.assign(target, values)
  })
  if (saved && pageEdit.value === id) pageEdit.value = null
}

function movePage(by: number) {
  const id = pageEdit.value
  mutate((d) => {
    const i = d.pages.findIndex((p) => p.id === id)
    const j = i + by
    if (i < 0 || j < 0 || j >= d.pages.length) return
    ;[d.pages[i], d.pages[j]] = [d.pages[j]!, d.pages[i]!]
  })
}

async function removePage() {
  const id = pageEdit.value
  const i = pages.value.findIndex((p) => p.id === id)
  if (i < 0) return
  const removed = await mutate((d) => {
    if (d.pages.length > 1) d.pages.splice(i, 1)
  })
  if (removed) {
    pageEdit.value = null
    settings.deckPage = pages.value[Math.max(0, i - 1)]?.id ?? ''
  }
}

function tileStyle(tile: Tile) {
  return tile.color ? { background: `color-mix(in srgb, ${tile.color} 20%, var(--surface))`, color: tile.color } : {}
}

const dragged = computed(() => (press.value?.moved && editing.value ? pageById(press.value.pageId)?.tiles.find((tile) => tile.id === press.value!.tile.id) : undefined))
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 px-3 pt-1 pb-2">
      <GroupTabs :items="pages" :active="page?.id ?? ''" :editing="editing && !deckHistory.saving" label="Deck pages" @select="selectGroup" @reorder="reorderPages">
        <button
          v-if="editing && pages.length < LIMITS.pages"
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-full text-muted"
          aria-label="Add page"
          :disabled="deckHistory.saving"
          @click="addPage"
        >
          <Plus :size="17" />
        </button>
      </GroupTabs>
      <template v-if="editing">
        <button
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-full text-muted disabled:opacity-30"
          aria-label="Undo last Deck edit"
          title="Undo"
          :disabled="!deckHistory.undo || deckHistory.saving"
          @click="undoDeck"
          @keydown.enter.prevent="undoDeck"
          @keydown.space.prevent="undoDeck"
        ><Undo2 :size="17" /></button>
        <button
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-full text-muted disabled:opacity-30"
          aria-label="Redo Deck edit"
          title="Redo"
          :disabled="!deckHistory.redo || deckHistory.saving"
          @click="redoDeck"
          @keydown.enter.prevent="redoDeck"
          @keydown.space.prevent="redoDeck"
        ><Redo2 :size="17" /></button>
      </template>
      <button
        type="button"
        class="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors"
        :class="editing ? 'bg-accent text-accent-text' : 'bg-surface-3 text-muted'"
        :disabled="deckHistory.saving"
        @click="editing = !editing"
      >
        <LoaderCircle v-if="deckHistory.saving" :size="15" class="animate-spin" />
        <Check v-else-if="editing" :size="15" />
        <Pencil v-else :size="14" />
        {{ deckHistory.saving ? 'Saving…' : editing ? 'Done' : 'Edit' }}
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
        <div class="grid gap-2.5" :style="{ gridTemplateColumns: `repeat(${columns(p)}, minmax(0, 1fr))` }">
          <label
            v-for="(tile, ti) in p.tiles"
            :key="tile.id"
            role="button"
            tabindex="0"
            :data-tile-index="pi === index ? ti : undefined"
            class="tile relative block aspect-square rounded-[22px] border border-line transition-[transform,opacity,background-color] duration-150 active:scale-[0.96]"
            :class="[
              !tile.color && 'bg-surface',
              // Outside edit mode the page must still scroll under a finger.
              editing && 'wiggle touch-none',
              dragged?.id === tile.id && 'opacity-25',
              status.get(tile.id) === 'failed' && 'shake border-bad',
            ]"
            :style="tileStyle(tile)"
            :aria-label="tile.label || undefined"
            @pointerdown="onTileDown(p.id, ti, $event)"
            @pointermove="onTileMove"
            @pointerup="onTileUp($event)"
            @pointercancel="onTileUp($event, true)"
            @lostpointercapture="onLostCapture"
            @click="onTileClick(p.id, tile, $event)"
            @keydown.enter.prevent="activate(p.id, tile)"
            @keydown.space.prevent="activate(p.id, tile)"
            @contextmenu.prevent
          >
            <TileFace :tile="tile" :size="tileSize(p)" />
            <span v-if="status.get(tile.id) === 'running'" class="absolute inset-0 grid place-items-center rounded-[22px] bg-bg/50">
              <LoaderCircle class="animate-spin" :size="20" />
            </span>
            <HapticSwitch />
          </label>
          <button
            v-if="editing && p.tiles.length < LIMITS.tiles"
            type="button"
            class="grid aspect-square place-items-center rounded-[22px] border border-dashed border-line-strong text-muted"
            aria-label="Add button"
            :disabled="deckHistory.saving"
            @click="addTile(p)"
          >
            <Plus :size="26" />
          </button>
        </div>
        <div v-if="p.tiles.length === 0 && !editing" class="flex flex-col items-center gap-3 py-16 text-center text-muted">
          <p class="text-[15px]">No buttons on this page yet.</p>
          <button type="button" class="h-10 rounded-full bg-surface-3 px-4 text-[14px] font-medium text-text" @click="(addTile(p), (editing = true))">
            Add a button
          </button>
        </div>
        <p v-if="editing" class="pt-4 text-center text-[12px] text-faint">Drag tabs or buttons to reorder. Tap the selected tab to edit the page.</p>
      </section>
    </div>

    <div
      v-if="dragged && press"
      class="pointer-events-none fixed z-30 rounded-[22px] border border-line-strong shadow-2xl"
      :class="!dragged.color && 'bg-surface-2'"
      :style="{ left: `${ghost.x}px`, top: `${ghost.y}px`, width: `${press.width}px`, height: `${press.height}px`, transform: 'scale(1.06)', ...tileStyle(dragged) }"
    >
      <TileFace :tile="dragged" :size="page ? tileSize(page) : 0" />
    </div>

    <TileEditor
      v-if="tileEdit"
      :tile="tileEdit.tile"
      :is-new="tileEdit.isNew"
      :busy="deckHistory.saving"
      @save="saveTile"
      @remove="removeTile"
      @duplicate="duplicateTile"
      @close="tileEdit = null"
    />
    <PageEditor
      v-if="editedPage"
      :page="editedPage"
      :index="pages.indexOf(editedPage)"
      :count="pages.length"
      :busy="deckHistory.saving"
      @save="savePage"
      @move="movePage"
      @remove="removePage"
      @close="pageEdit = null"
    />
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
