import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import GroupTabs from '../src/components/GroupTabs.vue'

enableAutoUnmount(afterEach)
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

function groups(editable = true) {
  const items = ref(['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() })))
  const active = ref('b')
  const editing = ref(editable)
  const reordered = vi.fn((ids: string[]) => { items.value = ids.map((id) => items.value.find((item) => item.id === id)!) })
  const selected = vi.fn((id: string) => { active.value = id })
  const view = mount(defineComponent({ render: () => h(GroupTabs, { items: items.value, active: active.value, editing: editing.value, label: 'Groups', onReorder: reordered, onSelect: selected }) }), { attachTo: document.body })
  const strip = view.find('[role="tablist"]').element as HTMLElement
  strip.setPointerCapture = vi.fn()
  strip.hasPointerCapture = () => false
  strip.getBoundingClientRect = () => new DOMRect(0, 0, 300, 32)
  for (const tab of view.findAll('[role="tab"]')) {
    const el = tab.element as HTMLElement
    el.getBoundingClientRect = () => new DOMRect(Array.from(strip.children).indexOf(el) * 100 - strip.scrollLeft, 0, 100, 32)
  }
  const tab = (id: string) => view.find(`[data-group-id="${id}"]`).element as HTMLElement
  return { view, items, active, editing, reordered, selected, strip, tab }
}

function pointer(el: HTMLElement, type: string, x: number) {
  el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 16, bubbles: true, cancelable: true }))
}

describe('editable group tabs', () => {
  it('previews a touch drag, saves once on release, and keeps the active group by id', async () => {
    const { view, items, active, reordered, selected, strip, tab } = groups()
    pointer(tab('a'), 'pointerdown', 50)
    pointer(strip, 'pointermove', 280)
    await nextTick()
    expect(view.findAll('[role="tab"]').map((item) => item.attributes('data-group-id'))).toEqual(['b', 'c', 'a'])
    expect(items.value.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(reordered).not.toHaveBeenCalled()
    pointer(strip, 'pointerup', 280)
    await nextTick()
    expect(reordered).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a'])
    expect(active.value).toBe('b')
    tab('a').dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
    expect(selected).not.toHaveBeenCalled()
  })

  it('still selects a tab with a tap in edit mode', () => {
    const { tab, strip, selected } = groups()
    pointer(tab('a'), 'pointerdown', 50)
    pointer(tab('a'), 'pointerup', 50)
    tab('a').click()
    expect(strip.setPointerCapture).not.toHaveBeenCalled()
    expect(selected).toHaveBeenCalledWith('a')
  })

  it('leaves normal horizontal swipes alone outside edit mode', () => {
    const { tab, strip, reordered } = groups(false)
    pointer(tab('a'), 'pointerdown', 50)
    pointer(strip, 'pointermove', 280)
    pointer(strip, 'pointerup', 280)
    expect(strip.setPointerCapture).not.toHaveBeenCalled()
    expect(reordered).not.toHaveBeenCalled()
  })

  it('supports keyboard reorder and keeps focus on the moved tab', async () => {
    const { view, active, reordered, tab } = groups()
    tab('b').focus()
    tab('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }))
    await nextTick()
    expect(reordered).toHaveBeenCalledExactlyOnceWith(['b', 'a', 'c'])
    expect(document.activeElement).toBe(tab('b'))
    expect(active.value).toBe('b')
    expect(view.find('[aria-selected="true"]').attributes('data-group-id')).toBe('b')
    tab('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }))
    expect(reordered).toHaveBeenCalledTimes(1)
  })

  it('cancels a drag when another device changes the list', async () => {
    const { items, reordered, strip, tab } = groups()
    pointer(tab('a'), 'pointerdown', 50)
    pointer(strip, 'pointermove', 280)
    await nextTick()
    items.value = [...items.value].reverse()
    await nextTick()
    pointer(strip, 'pointerup', 280)
    expect(reordered).not.toHaveBeenCalled()
    expect(items.value.map((item) => item.id)).toEqual(['c', 'b', 'a'])
  })

  it('saves a reordered list when Done ends a drag, but cancels pointer cancellation', async () => {
    const { editing, reordered, strip, tab } = groups()
    pointer(tab('a'), 'pointerdown', 50)
    pointer(strip, 'pointermove', 280)
    editing.value = false
    await nextTick()
    expect(reordered).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a'])
    editing.value = true
    await nextTick()
    pointer(tab('a'), 'pointerdown', 250)
    pointer(strip, 'pointermove', 10)
    pointer(strip, 'pointercancel', 10)
    await nextTick()
    expect(reordered).toHaveBeenCalledTimes(1)
  })

  it('scrolls a crowded strip while a tab is held at an edge', async () => {
    const { strip, tab, reordered } = groups()
    strip.getBoundingClientRect = () => new DOMRect(0, 0, 180, 32)
    pointer(tab('a'), 'pointerdown', 50)
    pointer(strip, 'pointermove', 175)
    await nextTick()
    vi.advanceTimersByTime(100)
    expect(strip.scrollLeft).toBeGreaterThan(0)
    pointer(strip, 'pointerup', 175)
    expect(reordered).toHaveBeenCalledTimes(1)
  })
})
