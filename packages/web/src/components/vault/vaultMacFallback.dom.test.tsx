import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { EnrolWizard } from './VaultFlows'
import type { VaultView } from '../../lib/vaultApi'

beforeAll(() => { GlobalRegistrator.register({ width: 390, height: 844 }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
afterAll(async () => { await GlobalRegistrator.unregister(); delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT })
const tick = async () => { await new Promise(r => setTimeout(r, 0)) }

test('Mac recovery failure offers password fallback even with a fixed Touch ID choice; it requires password AND new words', async () => {
  const view = { state: 'open', wrappers: ['keychain'], presence: false, presenceAvailable: ['touchid', 'password'],
    unlockMethods: [{ id: 'touchid', advanced: false, gestures: { enroll: 1, unlock: 1 } }, { id: 'password', advanced: false, gestures: { enroll: 0, unlock: 0 } }],
    recoveryCreatedAt: null, autoLockMinutes: 30, gates: {}, setupCode: { owed: false }, loopback: true,
  } as unknown as VaultView
  const calls: { path: string; body: Record<string, unknown>; password: string | null }[] = []
  let confirmed = false, begins = 0
  const fetchBefore = globalThis.fetch
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ path, body, password: new Headers(init?.headers).get('x-vault-password') })
    let result: unknown = { ok: true }
    if (path === '/api/vault') result = confirmed ? { ...view, wrappers: ['password', 'recovery'], presence: true } : view
    if (path.endsWith('/enroll')) result = { ok: true, removed: [], recoveryOwed: true }
    if (path.endsWith('/begin')) { begins++; result = { ok: true, words: Array(24).fill(begins === 1 ? 'abandon' : 'ability'), positions: [1, 2, 3] } }
    if (path.endsWith('/confirm')) {
      if (begins === 1) result = { ok: false, code: 'rekey-verify-failed', sentence: 'Não foi possível conferir a nova cópia de um item do cofre.' }
      else confirmed = true
    }
    return Response.json(result)
  }) as typeof fetch
  const host = document.createElement('div'); document.body.append(host)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  const button = (text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(text))!
  const click = async (b: HTMLButtonElement) => { expect(b).toBeDefined(); await act(async () => { b.click(); await tick() }) }
  const submit = async () => { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick() }) }
  const fill = async (inputs: NodeListOf<HTMLInputElement>, value: string) => {
    await act(async () => {
      for (const input of Array.from(inputs)) {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await tick()
    })
  }
  try {
    await act(async () => { root.render(<EnrolWizard lang="pt" isMobile initial={view} steps={['presence', 'recovery']} fixedKind="touchid" onClose={() => {}} />); await tick() })
    await submit() // native enrol
    await submit() // show words
    await click(button('Já anotei'))
    await fill(host.querySelectorAll('input'), 'abandon')
    await submit() // injected failure
    expect(button('Continuar sem Touch ID')).toBeDefined()
    await click(button('Continuar sem Touch ID'))
    expect(host.querySelectorAll('input[type="password"]').length).toBe(2)
    expect(host.textContent).not.toContain('abandon')
    expect(calls.filter(c => c.path.endsWith('/enroll'))).toHaveLength(1) // clicking fallback grants nothing
    await fill(host.querySelectorAll('input[type="password"]'), 'Test-Only!Pw9')
    await submit()
    const passwordCall = calls.filter(c => c.path.endsWith('/enroll')).at(-1)!
    expect(passwordCall.body.protector).toBe('password')
    expect(passwordCall.password).toBe('Test-Only!Pw9')
    expect(confirmed).toBe(false)
    await submit(); await click(button('Já anotei'))
    await fill(host.querySelectorAll('input'), 'ability'); await submit()
    expect(confirmed).toBe(true)
    expect(begins).toBe(2)
    expect(host.textContent).toContain('Pronto')
  } finally {
    await act(async () => root.unmount()); host.remove(); globalThis.fetch = fetchBefore
  }
})
