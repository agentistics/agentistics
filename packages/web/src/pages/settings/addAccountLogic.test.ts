import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ADD_COPY, addAccountView, addErrorText, anyResolved, loginTarget, pendingRoots, type RootRowView } from './addAccountLogic'

const root = (o: Partial<RootRowView>): RootRowView => ({ harness: 'claude', root: '/r', status: 'pending', pendingId: 'p1', ...o })

describe('addAccountView', () => {
  test('flag off: no button, only the pointer line', () => {
    expect(addAccountView(false, ['claude', 'codex'])).toEqual({ kind: 'off' })
  })
  test('flag on: assistants that can keep a second login get the button', () => {
    expect(addAccountView(true, ['claude', 'codex'])).toEqual({ kind: 'on', addable: ['claude', 'codex'], unsupported: [] })
  })
  test('antigravity never gets a button, it gets a sentence', () => {
    const v = addAccountView(true, ['claude', 'antigravity'])
    expect(v).toEqual({ kind: 'on', addable: ['claude'], unsupported: ['antigravity'] })
  })
})

describe('pending roots', () => {
  test('only pending roots are listed', () => {
    expect(pendingRoots([root({}), root({ status: 'bound', pendingId: 'p2' }), root({ status: 'retired', pendingId: 'p3' })]).length).toBe(1)
  })
  test('a pending root that left pending means the account list must reload', () => {
    expect(anyResolved([root({})], [root({ status: 'bound' })])).toBe(true)
    expect(anyResolved([root({})], [])).toBe(true)
    expect(anyResolved([root({})], [root({})])).toBe(false)
    expect(anyResolved([], [root({})])).toBe(false)
  })
  test('login target needs a session id', () => {
    expect(loginTarget(root({ loginSessionId: 'abc' }))).toBe('/sessions/abc')
    expect(loginTarget(root({}))).toBeNull()
  })
})

describe('addErrorText', () => {
  test('shows the server message, never the code', () => {
    const text = addErrorText({ error: 'login_unavailable', message: 'claude is not installed.' }, false)
    expect(text).toBe('claude is not installed.')
    expect(text).not.toContain('login_unavailable')
  })
  test('falls back to a fixed sentence in both languages', () => {
    expect(addErrorText(null, true)).toContain('Tente de novo')
    expect(addErrorText({ error: 'x' }, false)).toContain('Try again')
  })
})

describe('copy', () => {
  test('pending row and flag-off line exist in both languages', () => {
    expect(ADD_COPY(true).waiting).toBe('Aguardando login')
    expect(ADD_COPY(false).waiting).toBe('Waiting for sign-in')
    expect(ADD_COPY(true).flagOff).toBe('Várias contas é uma função experimental e está desligada neste computador.')
    expect(ADD_COPY(false).flagOff).toContain('turned off')
    for (const pt of [true, false]) expect(ADD_COPY(pt).flagOff).not.toMatch(/Configura|Settings|Experimental →/)
  })
})

describe('wiring', () => {
  const page = readFileSync(new URL('./BillingSettings.tsx', import.meta.url), 'utf8')
  const comp = readFileSync(new URL('./AddAccount.tsx', import.meta.url), 'utf8')
  test('the page mounts AddAccount and reloads accounts when a login binds', () => {
    expect(page).toContain('<AddAccount')
    expect(page).toContain('onBound={reloadAccounts}')
  })
  test('the component reuses the app pieces and hand-rolls no modal', () => {
    for (const piece of ['ConfirmModal', 'dialogButtonStyle', 'Pill', 'StatusDot', 'MetricNote']) expect(comp).toContain(piece)
    expect(comp).not.toContain('position: \'fixed\'')
    expect(comp).toContain("'/api/accounts/roots'")
    expect(comp).toContain("method: 'DELETE'")
  })
})
