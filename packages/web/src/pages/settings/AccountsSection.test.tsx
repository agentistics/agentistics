import React from 'react'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountsView, type AccountsViewProps } from './AccountsSection'
import { nextOpen, type AccountRowData } from './accountsSummary'

const g = globalThis as { window?: unknown }
const hadWindow = 'window' in g
beforeAll(() => { if (!hadWindow) g.window = { innerWidth: 1280 } })
afterAll(() => { if (!hadWindow) delete g.window })

const acc = (o: Partial<AccountRowData> & { id: string }): AccountRowData => ({
  harness: 'claude', key: o.id, label: 'a@b.c', root: null, available: true, ...o,
})
const base: AccountsViewProps = {
  lang: 'en', now: 1, limits: null, pendingIds: new Set(), failedIds: new Set(),
  onToggle: () => {}, onDetail: () => {}, noSecondAccount: new Set(['antigravity']),
  accounts: [
    acc({ id: 'c1' }), acc({ id: 'c2', available: false }),
    acc({ id: 'g1', harness: 'gemini', label: 'Conta padrão' }),
    acc({ id: 'y1', harness: 'antigravity', label: 'Conta padrão' }),
  ],
}
/** The markup of one harness panel (mounted even when shut, then `hidden`). */
const panel = (h: string, id: string) => {
  const i = h.indexOf(`id="accounts-panel-${id}"`)
  const j = h.indexOf('data-accounts-harness=', i)
  return h.slice(i, j === -1 ? undefined : j)
}
/** Everything a person can see: shut panels (hidden) removed. */
const visible = (h: string) => ['claude', 'gemini', 'antigravity', 'codex'].reduce(
  (acc, id) => (panel(h, id).includes(' hidden=""') && h.includes(`id="accounts-panel-${id}"`) ? acc.replace(panel(h, id), '') : acc), h)
const html = (p: Partial<AccountsViewProps> = {}) => renderToStaticMarkup(<AccountsView {...base} {...p} />)

describe('AccountsView', () => {
  test('collapsed by default: one aria-expanded=false button per harness, no account rows', () => {
    const h = html()
    expect((h.match(/aria-expanded="false"/g) ?? []).length).toBe(3)
    expect(visible(h)).not.toContain('data-account-row')
    expect(h).toContain('2 accounts · 1 with Agents')
    expect(h).toContain('1 hidden')
  })
  test('open harness shows its accounts in place; the others stay shut', () => {
    const h = html({ initialOpen: 'claude' })
    expect((h.match(/aria-expanded="true"/g) ?? []).length).toBe(1)
    expect((visible(h).match(/data-account-row/g) ?? []).length).toBe(2)
    expect(visible(h)).toContain('Hidden from agents')
    expect(visible(h)).toContain('role="switch"')
  })
  test('an unnamed account never reads "Conta padrão" and says the assistant cannot tell', () => {
    const h = visible(html({ initialOpen: 'gemini' }))
    expect(h).not.toContain('Conta padrão')
    expect(h).toContain('Gemini CLI account')
    expect(h).toContain('does not say which account')
  })
  test('Add account: absent without onAdd, present with it, a sentence for Antigravity', () => {
    expect(html({ initialOpen: 'claude' })).not.toContain('Add account')
    expect(html({ initialOpen: 'claude', onAdd: () => {} })).toContain('Add account')
    const agy = panel(html({ initialOpen: 'antigravity', onAdd: () => {} }), 'antigravity')
    expect(agy).not.toContain('>Add account<')
    expect(agy).toContain('cannot keep a second account apart')
  })
  test('collapsed panels stay mounted and hidden so aria-controls resolves', () => {
    const h = html()
    for (const id of ['claude', 'gemini', 'antigravity']) {
      expect(h).toContain(`aria-controls="accounts-panel-${id}"`)
      expect(h).toMatch(new RegExp(`id="accounts-panel-${id}"[^>]*hidden`))
    }
  })
  test('the header is a native button: Enter/Space/click go through the same toggle', () => {
    const tree = (AccountsView as unknown as (p: AccountsViewProps) => React.ReactElement)
    expect(typeof tree).toBe('function')
    const h = html()
    expect(h).toMatch(/<button type="button" aria-expanded="false"/)
    expect(nextOpen(null, 'claude')).toBe('claude')
    expect(nextOpen('claude', 'claude')).toBeNull()
  })
  test('unidentified accounts: "Not confirmed", no switch, no "Signed in", distinct rows', () => {
    const h = html({
      initialOpen: 'gemini',
      accounts: [acc({ id: '', harness: 'gemini', label: 'Conta padrão' }), acc({ id: '', harness: 'codex', label: 'Conta padrão' })],
    })
    expect(h).toContain('Not confirmed')
    expect(h).not.toContain('Signed in')
    expect(h).not.toContain('All good')
    expect(h).not.toContain('role="switch"')
    expect(h).toContain('data-account-row="unidentified:gemini"')
    expect(h).toContain('0 with Agents')
  })
  test('a failed toggle shows an alert naming the account on its row', () => {
    const h = html({ initialOpen: 'claude', failedIds: new Set(['c1']) })
    expect(h).toContain('role="alert"')
    expect(h).toContain('Could not save the account “a@b.c”')
    expect(html({ initialOpen: 'claude', failedIds: new Set(['c1']), lang: 'pt' })).toContain('Não foi possível salvar a conta “a@b.c”')
  })
  test('worst bar on the collapsed row uses crossed maxima', () => {
    const l = (account: string, f: number, w: number) => ({
      harness: 'claude' as const, account, updatedAt: 1, source: 'claude-stream' as const,
      windows: [{ kind: '5h' as const, usedPct: f, resetsAt: 9e9 }, { kind: 'week' as const, usedPct: w, resetsAt: 9e9 }],
    })
    const h = html({ limits: [l('c1', 95, 10), l('c2', 20, 94)] })
    expect(h).toContain('95%')
    expect(h).toContain('94%')
  })

  test('R4: never the e-mail beside a nickname, in the expanded row', () => {
    const h = html({ accounts: [acc({ id: 'n1', nickname: 'Work', label: 'me@private.io' })] })
    expect(h).toContain('Work')
    expect(h).not.toContain('me@private.io')
  })
})
