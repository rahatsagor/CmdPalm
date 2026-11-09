import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { localStorage.clear(); vi.resetModules() })
afterEach(() => { document.body.innerHTML = '' })

describe('device backup review', () => {
  it('previews a file before replacing any device settings', async () => {
    const { settings } = await import('../src/lib/settings')
    const { exportBackup } = await import('../src/lib/backup')
    settings.theme = 'dark'
    const json = exportBackup()
    settings.theme = 'light'
    const { default: BackupSheet } = await import('../src/components/BackupSheet.vue')
    const view = mount(BackupSheet, { attachTo: document.body })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [{ size: json.length, text: async () => json }] })
    input.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(settings.theme).toBe('light')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Ready to restore')
    const restore = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === 'Restore backup')!
    restore.click()
    await flushPromises()
    expect(settings.theme).toBe('dark')
    expect(view.emitted('close')).toHaveLength(1)
    view.unmount()
  })

  it('shows file errors without presenting a restore action', async () => {
    const { default: BackupSheet } = await import('../src/components/BackupSheet.vue')
    const view = mount(BackupSheet, { attachTo: document.body })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [{ size: 1, text: async () => '{' }] })
    input.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('readable JSON')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Restore backup')
    view.unmount()
  })
})
