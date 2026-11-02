import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import BoardEditor from '../src/components/BoardEditor.vue'
import Sheet from '../src/components/Sheet.vue'
import ShortcutField from '../src/components/ShortcutField.vue'
import { blankBoard } from '../src/lib/customKeyboards'
import { Key } from '../src/lib/keys'
import { Mod } from '../src/lib/protocol'

// A failed test must not leave its sheet behind for the next one to type into.
enableAutoUnmount(afterEach)

type Shortcut = { code: number; mods: number; char?: string }

/** A shortcut field in a sheet, as the button and key editors show it. */
function shortcutSheet() {
  const model = ref<Shortcut>({ code: Key.A, mods: 0 })
  const closed = ref(0)
  const view = mount(
    defineComponent({
      render: () =>
        h(Sheet, { title: 'Key', onClose: () => closed.value++ }, () =>
          h(ShortcutField, { modelValue: model.value, 'onUpdate:modelValue': (value: Shortcut) => (model.value = value) }),
        ),
    }),
    { attachTo: document.body },
  )
  const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!
  const press = (code: string) => field().dispatchEvent(new KeyboardEvent('keydown', { key: code, code, bubbles: true, cancelable: true }))
  const type = async (ch: string) => {
    field().value = ch
    field().dispatchEvent(new Event('input'))
    await nextTick()
  }
  return { model, closed, view, press, type }
}

describe('ShortcutField', () => {
  it('records Escape instead of closing the sheet around it', async () => {
    const { model, closed, press } = shortcutSheet()
    press('Escape')
    await nextTick()
    expect(model.value.code).toBe(Key.Escape)
    expect(closed.value).toBe(0)
  })

  it('lets Tab move on to the next control', async () => {
    const { model, press } = shortcutSheet()
    press('Tab')
    await nextTick()
    expect(model.value.code).toBe(Key.A)
  })

  it('drops the Shift a typed "?" needed once another key is typed, but keeps chosen modifiers', async () => {
    const { model, type } = shortcutSheet()
    await type('?')
    expect(model.value).toMatchObject({ code: Key.Slash, mods: Mod.Shift })
    await type('c')
    expect(model.value).toMatchObject({ code: Key.C, mods: 0 })

    document.querySelector<HTMLButtonElement>('[aria-label="Command"]')!.click()
    await nextTick()
    await type('?')
    await type('c')
    expect(model.value).toMatchObject({ code: Key.C, mods: Mod.Command })
  })
})

describe('BoardEditor', () => {
  it('keeps a name typed just before Duplicate', async () => {
    const board = reactive(blankBoard())
    const view = mount(BoardEditor, { props: { board }, attachTo: document.body })
    const name = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    name.value = 'WASD'
    name.dispatchEvent(new Event('input'))
    await nextTick()
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((b) => b.textContent?.includes('Duplicate'))!
      .click()
    expect(board.name).toBe('WASD')
    expect(view.emitted('duplicate')).toHaveLength(1)
  })
})
