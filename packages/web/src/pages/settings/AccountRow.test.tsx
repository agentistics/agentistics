import React from 'react'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountPlans, FirstDetectionNotice, type AccountPlansProps } from './AccountRow'
import type { BillingAccount } from './accountBilling'

const g = globalThis as { window?: unknown }
const hadWindow = 'window' in g
beforeAll(() => { if (!hadWindow) g.window = { innerWidth: 1280 } })
afterAll(() => { if (!hadWindow) delete g.window })

const acc = (id: string, o: Partial<BillingAccount> = {}): BillingAccount => ({
  id, harness: 'claude', key: id, label: `${id}@private.io`, root: null, available: true, ...o,
})
const base = (harness: AccountPlansProps['harness'], accounts: BillingAccount[]): AccountPlansProps => ({
  lang: 'en', harness, accounts, billing: { profiles: {} }, limits: null, now: 1, today: '2026-10-16',
  pendingIds: new Set(), failedIds: new Set(), selectedId: null, onToggle: () => {}, onEdit: () => {},
})

describe('AccountPlans', () => {
  test('two accounts of one harness: one row, one availability switch and one edit action each', () => {
    const h = renderToStaticMarkup(<AccountPlans {...base('claude', [acc('c1'), acc('c2', { nickname: 'Work' })])} />)
    expect(h).toContain('data-billing-account="c1"')
    expect(h).toContain('data-billing-account="c2"')
    expect((h.match(/Edit plan/g) ?? []).length).toBe(2)
    expect((h.match(/role="switch"/g) ?? []).length).toBe(2)
  })

  test('a nickname stands where the e-mail would be', () => {
    const h = renderToStaticMarkup(<AccountPlans {...base('claude', [acc('c2', { nickname: 'Work', label: 'me@private.io' })])} />)
    expect(h).toContain('Work')
  })

  test('a harness with no limits reader says so; antigravity says it keeps one account', () => {
    expect(renderToStaticMarkup(<AccountPlans {...base('gemini', [acc('g1', { harness: 'gemini' })])} />)).toContain('does not report its usage limits')
    expect(renderToStaticMarkup(<AccountPlans {...base('antigravity', [acc('y1', { harness: 'antigravity' })])} />)).toContain('single account')
    expect(renderToStaticMarkup(<AccountPlans {...base('claude', [acc('c1')])} />)).not.toContain('does not report its usage limits')
  })

  test('no accounts, no block', () => {
    expect(renderToStaticMarkup(<AccountPlans {...base('claude', [])} />)).toBe('')
  })
})

describe('FirstDetectionNotice', () => {
  test('asks which plan, names the account by nickname, offers confirm and dismiss', () => {
    const h = renderToStaticMarkup(<FirstDetectionNotice lang="en" account={acc('c2', { nickname: 'Work', label: 'me@private.io' })} onAnswer={() => {}} onDismiss={() => {}} />)
    expect(h).toContain('New Claude Code account detected (Work). Which plan is it?')
    expect(h).not.toContain('me@private.io')
    expect(h).toContain('Confirm plan')
    expect(h).toContain('Not sure yet')
  })
})
