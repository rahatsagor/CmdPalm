import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import CustomKeyboard from '../src/components/CustomKeyboard.vue'
import { actionProblem } from '../src/lib/deck'
import type { CustomKeyboard as Board } from '../src/lib/customKeyboards'

const board: Board = {
  id: 'b',
  name: 'Test',
  cols: 2,
  rows: 1,
  trackpad: false,
  keys: [{ id: 'k', x: 1, y: 0, w: 1, h: 1, action: { kind: 'key', code: 0x31, mods: 0 } }],
}

function click(el: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

describe('CustomKeyboard', () => {
  // A click on a label is passed on to its first control, the "Add key here"
  // button, which would turn a tap on a key into adding a new one.
  it('keeps taps on keys and gaps from reaching the add button while editing', () => {
    const view = mount(CustomKeyboard, { props: { board, editing: true }, attachTo: document.body })
    expect(click(view.find('.key').element).defaultPrevented).toBe(true)
    expect(click(view.find('label').element).defaultPrevented).toBe(true)
    expect(click(view.find('button[aria-label="Add key here"]').element).defaultPrevented).toBe(false)
    view.unmount()
  })
})

describe('CustomKeyboard while the page hides', () => {
  // A finger lift after the page hides never arrives.
  it('stops showing a held key as pressed', async () => {
    const view = mount(CustomKeyboard, { props: { board, editing: false }, attachTo: document.body })
    view.find('.key').element.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', bubbles: true, cancelable: true }))
    await nextTick()
    expect(view.find('.key').classes()).toContain('is-down')

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Reflect.deleteProperty(document, 'visibilityState')
    await nextTick()
    expect(view.find('.key').classes()).not.toContain('is-down')
    view.unmount()
  })
})

describe('actionProblem', () => {
  it('refuses shortcut names longer than the Mac accepts', () => {
    expect(actionProblem({ kind: 'shortcut', name: 'é'.repeat(256) })).toBe('')
    expect(actionProblem({ kind: 'shortcut', name: 'é'.repeat(257) })).toBe('The shortcut name is too long.')
  })

  it('asks for a key when a keys action has none', () => {
    expect(actionProblem({ kind: 'keys' } as Parameters<typeof actionProblem>[0])).toBe('Pick a key.')
  })
})
