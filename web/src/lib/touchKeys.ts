// Multi-touch for on-screen keys.
//
// One listener on the container handles every finger instead of one per key:
//  * a finger that lands in the gap between keys still hits the nearest key
//    (with per-key handlers it hit nothing, and Safari could start a page
//    gesture that cancelled the other fingers mid-combo);
//  * each finger keeps the key it landed on until it lifts, even if it slides;
//  * touchstart is cancelled so iOS never shows the magnifier, text selection
//    or callout, and never zooms, no matter how many fingers are down.
//
// Keys are elements with a `data-key` attribute.

import { onBeforeUnmount, onDeactivated, onMounted, type Ref } from 'vue'

export interface TouchKeyHandlers {
  /** A finger landed on the key with this `data-key` value. */
  down(key: string, pointerId: number, event: PointerEvent): void
  /** The finger lifted (`cancelled` when the browser took it away). */
  up(pointerId: number, cancelled: boolean): void
  /** Return false to let events through (e.g. while editing). */
  enabled?(): boolean
}

/** How far outside every key a touch may land and still count, in CSS px. */
const REACH = 24

export function useTouchKeys(root: Ref<HTMLElement | undefined>, handlers: TouchKeyHandlers) {
  const active = new Set<number>()
  let rects: { key: string; rect: DOMRect }[] | null = null
  let observer: ResizeObserver | undefined

  const enabled = () => handlers.enabled?.() ?? true

  function keyAt(x: number, y: number): string | undefined {
    const el = root.value
    if (!el) return undefined
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-key]')
    if (hit && el.contains(hit)) return hit.dataset.key
    rects ??= [...el.querySelectorAll<HTMLElement>('[data-key]')].map((k) => ({ key: k.dataset.key!, rect: k.getBoundingClientRect() }))
    let best: string | undefined
    let bestDistance = REACH
    for (const { key, rect } of rects) {
      const dx = Math.max(rect.left - x, 0, x - rect.right)
      const dy = Math.max(rect.top - y, 0, y - rect.bottom)
      const distance = Math.hypot(dx, dy)
      if (distance < bestDistance) {
        bestDistance = distance
        best = key
      }
    }
    return best
  }

  function onDown(event: PointerEvent) {
    if (!enabled()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const key = keyAt(event.clientX, event.clientY)
    if (key === undefined) return
    event.preventDefault()
    try {
      root.value?.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is already gone.
    }
    active.add(event.pointerId)
    handlers.down(key, event.pointerId, event)
  }

  function finish(event: PointerEvent, cancelled: boolean) {
    if (!active.delete(event.pointerId)) return
    handlers.up(event.pointerId, cancelled)
  }
  const onUp = (event: PointerEvent) => finish(event, false)
  const onCancel = (event: PointerEvent) => finish(event, true)
  const onTouchStart = (event: TouchEvent) => {
    if (enabled() && event.cancelable) event.preventDefault()
  }
  const onContextMenu = (event: Event) => event.preventDefault()

  onMounted(() => {
    const el = root.value
    if (!el) return
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    el.addEventListener('lostpointercapture', onUp)
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('contextmenu', onContextMenu)
    observer = new ResizeObserver(() => (rects = null))
    observer.observe(el)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    releaseAll()
  })
  // Switching tabs keeps views alive; a finger still down must not stay held.
  onDeactivated(() => releaseAll())

  /** Lift every finger, e.g. when the view hides or the layout changes. */
  function releaseAll() {
    for (const id of active) {
      active.delete(id)
      handlers.up(id, true)
    }
  }

  return {
    releaseAll,
    /** Forget cached key positions after the keys move without a resize. */
    invalidate: () => (rects = null),
  }
}
