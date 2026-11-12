import { onBeforeUnmount, onDeactivated, watch } from 'vue'
import { state } from './connection'

/** Runs `fn` when the page is hidden or control is paused on the Mac. */
export function onPageHidden(fn: () => void) {
  watch(
    () => [state.status, state.paused] as const,
    ([status, paused]) => {
      if (status !== 'connected' || paused) fn()
    },
  )
  if (typeof document === 'undefined') return
  const listener = () => {
    if (document.visibilityState === 'hidden') fn()
  }
  document.addEventListener('visibilitychange', listener)
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', listener))
}

/**
 * Fingers a component is holding something with. When the component hides
 * (a tab switch), control pauses, or the component unmounts, its elements
 * never hear those fingers lift, so `release` runs for each of them instead.
 */
export function useHeldPointers(release: (pointerId: number) => void) {
  const ids = new Set<number>()
  const releaseAll = () => {
    for (const id of ids) release(id)
    ids.clear()
  }
  onDeactivated(releaseAll)
  onBeforeUnmount(releaseAll)
  onPageHidden(releaseAll)
  return {
    hold: (pointerId: number) => ids.add(pointerId),
    lift: (pointerId: number) => ids.delete(pointerId),
  }
}
