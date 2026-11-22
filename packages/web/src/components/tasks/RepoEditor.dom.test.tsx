import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

// R3: a refused repository edit that the Vault can answer offers the SAME "Abrir o Cofre" action the browser padlock does.
let createRoot: typeof import('react-dom/client').createRoot
let RepoEditor: typeof import('./TaskChips').RepoEditor
const realFetch = globalThis.fetch
const oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  RepoEditor = (await import('./TaskChips')).RepoEditor
})
afterAll(async () => { globalThis.fetch = realFetch; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

async function mount(body: Record<string, unknown>) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<RepoEditor id="t-1" task={{ repo: '' } as never} lang="pt" onChanged={() => {}} />) })
  const input = host.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'o/r')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { (host.querySelector('button.ag-tap') as HTMLButtonElement).click() })
  return host
}
const vaultButton = (h: HTMLElement) => Array.from(h.querySelectorAll('button')).find(b => b.textContent === 'Abrir o Cofre')

test('owner_proof_unavailable shows the sentence AND the Open-the-Vault action, which goes to /vault', async () => {
  const host = await mount({ error: 'owner_proof_unavailable', message: 'Abra o Cofre e crie uma senha.', action: { kind: 'open-vault', path: '/vault' } })
  expect(host.querySelector('[data-repo-refusal]')!.textContent).toContain('O cofre só tem proteção silenciosa')
  const b = vaultButton(host)
  expect(b).toBeDefined()
  let pops = 0
  window.addEventListener('popstate', () => { pops++ })
  await act(async () => { b!.click() })
  expect(pops).toBe(1) // the same client-side jump to /vault the padlock's button makes
})

test('a person-only refusal has no Vault action (nothing for the Vault to fix)', async () => {
  const host = await mount({ error: 'repo_person_only', message: 'Só a pessoa define o repositório.' })
  expect(host.querySelector('[data-repo-refusal]')!.textContent).toContain('Só a pessoa')
  expect(vaultButton(host)).toBeUndefined()
})
