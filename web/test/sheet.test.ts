import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import Segmented from '../src/components/Segmented.vue'
import Sheet from '../src/components/Sheet.vue'

enableAutoUnmount(afterEach)
afterEach(() => {
  document.body.innerHTML = ''
})

describe('sheet keyboard navigation', () => {
  it('wraps focus through tabbable choices without entering unselected radio buttons', () => {
    mount(Sheet, {
      props: { title: 'Choices' },
      slots: {
        default: () =>
          h(Segmented, {
            modelValue: 'one',
            label: 'Choice',
            options: [
              { value: 'one', label: 'One' },
              { value: 'two', label: 'Two' },
            ],
          }),
      },
      attachTo: document.body,
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    // happy-dom has no layout; these controls are visible in a browser.
    for (const item of dialog.querySelectorAll('button')) Object.defineProperty(item, 'offsetParent', { configurable: true, value: document.body })
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!
    const choice = dialog.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')!
    choice.focus()
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    choice.dispatchEvent(forward)
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)

    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    close.dispatchEvent(backward)
    expect(backward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(choice)
  })

  it('consumes Escape in the top dialog without dismissing its parent or reaching other handlers', () => {
    const parentClose = vi.fn()
    const childClose = vi.fn()
    mount(Sheet, {
      props: { title: 'Parent', onClose: parentClose },
      slots: { default: () => h(Sheet, { title: 'Child', onClose: childClose }) },
      attachTo: document.body,
    })
    const outside = vi.fn()
    window.addEventListener('keydown', outside)
    try {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      document.querySelector('[aria-label="Child"]')!.dispatchEvent(event)
      expect(childClose).toHaveBeenCalledOnce()
      expect(parentClose).not.toHaveBeenCalled()
      expect(outside).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(true)
    } finally {
      window.removeEventListener('keydown', outside)
    }
  })
})
