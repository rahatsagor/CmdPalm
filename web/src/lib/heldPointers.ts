import { onBeforeUnmount, onDeactivated } from 'vue'

/**
 * Fingers a component is holding something with. When the component hides
 * (a tab switch) or unmounts, its elements never hear those fingers lift, so
 * `release` runs for each of them instead.
 */
export function useHeldPointers(release: (pointerId: number) => void) {
  const ids = new Set<number>()
  const releaseAll = () => {
    for (const id of ids) release(id)
    ids.clear()
  }
  onDeactivated(releaseAll)
  onBeforeUnmount(releaseAll)
  return {
    hold: (pointerId: number) => ids.add(pointerId),
    lift: (pointerId: number) => ids.delete(pointerId),
  }
}
