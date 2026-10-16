import React from 'react'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountsView, type AccountsViewProps } from './AccountsSection'
import type { AccountRowData } from './accountsSummary'

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
const html = (p: Partial<AccountsViewProps> = {}) => renderToStaticMarkup(<AccountsView {...base} {...p} />)

describe('AccountsView', () => {
  test('collapsed by default: one aria-expanded=false button per harness, no account rows', () => {
    const h = html()
    expect((h.match(/aria-expanded="false"/g) ?? []).length).toBe(3)
    expect(h).not.toContain('data-account-row')
    expect(h).toContain('2 accounts · 1 with Agents')
    expect(h).toContain('1 hidden')
  })
  test('open harness shows its accounts in place; the others stay shut', () => {
    const h = html({ initialOpen: 'claude' })
    expect((h.match(/aria-expanded="true"/g) ?? []).length).toBe(1)
    expect((h.match(/data-account-row/g) ?? []).length).toBe(2)
    expect(h).toContain('Hidden from agents')
    expect(h).toContain('role="switch"')
  })
  test('an unnamed account never reads "Conta padrão" and says the assistant cannot tell', () => {
    const h = html({ initialOpen: 'gemini' })
    expect(h).not.toContain('Conta padrão')
    expect(h).toContain('Gemini CLI account')
    expect(h).toContain('does not say which account')
  })
  test('Add account: absent without onAdd, present with it, a sentence for Antigravity', () => {
    expect(html({ initialOpen: 'claude' })).not.toContain('Add account')
    expect(html({ initialOpen: 'claude', onAdd: () => {} })).toContain('Add account')
    const agy = html({ initialOpen: 'antigravity', onAdd: () => {} })
    expect(agy).not.toContain('>Add account<')
    expect(agy).toContain('cannot keep a second account apart')
  })
})
