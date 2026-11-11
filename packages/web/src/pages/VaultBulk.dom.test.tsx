import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let fixture: typeof import('../../e2e/vault-bulk-fixture')
const originalFetch = globalThis.fetch
beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 844 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  fixture = await import('../../e2e/vault-bulk-fixture')
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}
for (const partial of [false, true]) test(`select 3 and move with per-item results (partial=${partial})`, async () => {
  const fake = fixture.fakeVaultFetch(partial)
  globalThis.fetch = fake.fetcher
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(createElement(fixture.VaultBulkFixture, { mobile: true })) })
    await click(host.querySelector('[data-vault-select]'))
    // Four personal entries; the system secret never gets a checkbox.
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(5)
    for (const row of Array.from(host.querySelectorAll('[role="checkbox"]')).slice(1, 4)) await click(row)
    await click(host.querySelector('[data-vault-batch-move]'))
    const sheet = document.querySelector('[role="dialog"]')!
    await click(Array.from(sheet.querySelectorAll('button')).find(b => b.textContent?.includes('Sem grupo')))
    await click(Array.from(document.querySelectorAll('[role="option"]')).find(b => b.textContent?.includes('Equipe')))
    await click(Array.from(sheet.querySelectorAll('button')).find(b => b.textContent === 'Mover 3 segredos'))
    expect(fake.calls.map(c => c.id)).toEqual(['pi_demo0', 'pi_demo1', 'pi_demo2'])
    expect(fake.stored[3]!.groupId).toBeNull()
    const result = host.querySelector('[data-vault-move-result]')?.textContent
    if (partial) {
      expect(result).toContain('2 movidos, 1 falharam')
      expect(result).toContain('Demo Beta (Atualizado em outra janela)')
      expect(host.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(1)
    } else {
      expect(result).toBe('3 movidos.')
      expect(fake.stored.slice(0, 3).every(m => m.groupId === fixture.fakeGroup.id)).toBe(true)
      expect(host.querySelector('[data-vault-batchbar]')).toBeNull()
    }
  } finally {
    await act(() => root.unmount()); host.remove()
  }
})
