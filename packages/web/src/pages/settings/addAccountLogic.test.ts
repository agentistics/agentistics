import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ADD_COPY, MANUAL_SIGN_IN, addAccountView, addErrorText, anyResolved, failureText, offeredHarnesses, pendingRoots, signInOutcome, type RootRowView } from './addAccountLogic'

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

})

describe('addErrorText', () => {
  test('maps the reason code to the user\'s language, never the raw code', () => {
    const pt = addErrorText({ error: 'root_in_use', message: 'A session is still running in this account. End it first.' }, true)
    expect(pt).toContain('Ainda há uma sessão')
    expect(pt).not.toContain('root_in_use')
    expect(addErrorText({ error: 'unsupported' }, false)).toContain('single login')
  })
  test('an unknown code shows the server sentence in English and a fixed line in Portuguese', () => {
    expect(addErrorText({ error: 'zzz', message: 'claude is not installed.' }, false)).toBe('claude is not installed.')
    expect(addErrorText({ error: 'zzz', message: 'claude is not installed.' }, true)).toContain('Tente de novo')
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

describe('copy details', () => {
  test('modal and row say the same thing, in both languages', () => {
    for (const pt of [true, false]) {
      const c = ADD_COPY(pt)
      expect(c.confirm).toBe(c.openLogin)
      expect(c.workingNote).toMatch(pt ? /aguardando/ : /waiting/)
      expect(c.workingNote).not.toMatch(/segundos|seconds/)
    }
  })
  test('buttons are named by assistant, without repeating the verb', () => {
    expect(readFileSync(new URL('./AddAccount.tsx', import.meta.url), 'utf8')).toContain('{label(h)}')
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
    // RecordCard's bordered action footer was the grey bar the owner rejected (CONTAS.LOGIN r2): the
    // pending card is one compact row with the app's own button styles instead.
    for (const piece of ['AccountLoginModal', 'dialogButtonStyle', 'MetricNote']) expect(comp).toContain(piece)
    expect(comp).not.toContain('position: \'fixed\'')
    expect(comp).toContain("'/api/accounts/roots'")
    expect(comp).toContain("method: 'DELETE'")
  })
})

describe('CONTAS.LOGIN r3: a failed attempt says what the assistant said', () => {
  test('the sentence plus the CLI quote, in both languages; no quote when nothing was captured', () => {
    expect(failureText({ error: 'login_failed', detail: 'Login failed: Request failed with status code 400' }, true))
      .toBe('O login não foi concluído. Comece de novo. O assistente respondeu: “Login failed: Request failed with status code 400”')
    expect(failureText({ error: 'login_failed', detail: 'OAuth error' }, false)).toBe('Sign-in did not finish. Start again. The assistant said: “OAuth error”')
    expect(failureText({ error: 'login_failed' }, false)).toBe('Sign-in did not finish. Start again.')
  })
})

describe('HARNESS.LOGIN.TODOS: an installed assistant is always offered, and "Entrar" never goes silent', () => {
  const ALL = ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'antigravity'] as const
  test('every installed assistant is offered even with no sessions and no account', () => {
    for (const h of ALL) expect(offeredHarnesses([], [h])).toContain(h)
    expect(offeredHarnesses(['claude'], ['codex'])).toEqual(['claude', 'codex'])
    expect(offeredHarnesses([], [])).toEqual([])
  })
  test('the matrix: what "Entrar" does for each assistant', () => {
    // installed here, nothing else known about it
    for (const h of ALL.filter(x => x !== 'antigravity')) expect(signInOutcome(true, h, [], [h])).toEqual({ kind: 'begin' })
    // listed (has sessions) counts too
    expect(signInOutcome(true, 'codex', ['codex'], [])).toEqual({ kind: 'begin' })
    // not found anywhere → a notice that offers "look again", never nothing
    for (const h of ALL.filter(x => x !== 'antigravity')) expect(signInOutcome(true, h, [], [])).toEqual({ kind: 'notice', reason: 'not-found' })
    // no recipe → says how to sign in by hand; the flag off wins over everything
    expect(signInOutcome(true, 'antigravity', ['antigravity'], ['antigravity'])).toEqual({ kind: 'notice', reason: 'no-recipe' })
    for (const h of ALL) expect(signInOutcome(false, h, [h], [h])).toEqual({ kind: 'notice', reason: 'flag-off' })
  })
  test('antigravity explains how to sign in, in both languages; not-found names the assistant and an action', () => {
    expect(MANUAL_SIGN_IN.antigravity!.pt).toContain('agy')
    expect(MANUAL_SIGN_IN.antigravity!.en).toContain('agy')
    expect(ADD_COPY(true).notFound('Codex')).toContain('Codex')
    expect(ADD_COPY(false).rescan).toBe('Look again')
  })
})
