import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

describe('preference controls', () => {
  it('exposes a labelled switch and updates only when enabled', async () => {
    const { default: Toggle } = await import('../src/components/Toggle.vue')
    const view = mount(Toggle, { props: { modelValue: false, label: 'Tap to click', hint: 'Tap the trackpad.' }, attachTo: document.body })
    const toggle = view.get('[role="switch"]')
    expect(toggle.attributes('aria-label')).toBe('Tap to click')
    expect(document.getElementById(toggle.attributes('aria-describedby')!)?.textContent).toBe('Tap the trackpad.')
    expect(view.text()).toContain('Tap the trackpad.')

    await view.get('span span').trigger('click')
    expect(view.emitted('update:modelValue')).toEqual([[true]])

    await view.setProps({ disabled: true })
    await toggle.trigger('click')
    expect(view.emitted('update:modelValue')).toHaveLength(1)
    view.unmount()
  })

  it('keeps one radio tabbable and supports wrapping and endpoint keys', async () => {
    const { default: Segmented } = await import('../src/components/Segmented.vue')
    const view = mount(Segmented, {
      props: {
        modelValue: 'one',
        label: 'Choice',
        options: [
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
          { value: 'three', label: 'Three' },
        ],
      },
      attachTo: document.body,
    })
    const radios = view.findAll('[role="radio"]')
    expect(view.get('[role="radiogroup"]').attributes('aria-label')).toBe('Choice')
    expect(radios.map((radio) => radio.attributes('tabindex'))).toEqual(['0', '-1', '-1'])

    ;(radios[0]!.element as HTMLElement).focus()
    await radios[0]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['three'])
    expect(document.activeElement).toBe(radios[2]!.element)
    expect(radios.map((radio) => radio.attributes('tabindex'))).toEqual(['-1', '-1', '0'])

    await radios[2]!.trigger('keydown', { key: 'Home' })
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['one'])
    expect(document.activeElement).toBe(radios[0]!.element)
    await radios[0]!.trigger('keydown', { key: 'End' })
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['three'])
    expect(document.activeElement).toBe(radios[2]!.element)

    const updates = view.emitted('update:modelValue')!.length
    await radios[2]!.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    await radios[2]!.trigger('keydown', { key: 'Enter' })
    expect(view.emitted('update:modelValue')).toHaveLength(updates)
    view.unmount()
  })

  it('labels range inputs and exposes their formatted value', async () => {
    const { default: RangeRow } = await import('../src/components/RangeRow.vue')
    const view = mount(RangeRow, {
      props: { modelValue: 1.25, label: 'Pointer speed', min: 0.2, max: 4, format: (value: number) => `${value.toFixed(2)}×` },
    })
    const input = view.get('input[type="range"]')
    expect(input.attributes('aria-label')).toBe('Pointer speed')
    expect(input.attributes('aria-valuetext')).toBe('1.25×')
    view.unmount()
  })

  it('leaves hardware keys available to the Mac on remote-control surfaces', async () => {
    const { default: Segmented } = await import('../src/components/Segmented.vue')
    const view = mount(Segmented, {
      props: {
        modelValue: 'one',
        keyboardNavigation: false,
        options: [
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ],
      },
    })
    const radios = view.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.attributes('tabindex'))).toEqual(['0', '0'])
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })
    radios[0]!.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(view.emitted('update:modelValue')).toBeUndefined()
    view.unmount()
  })
})
