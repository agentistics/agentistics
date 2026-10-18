import React from 'react'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { plansForHarness } from '@agentistics/core'
import { AccountPlans, BillingAccountsView, FirstDetectionNotice, type AccountPlansProps } from './AccountRow'
import { matchDetectedPlan } from './accountBilling'
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
    expect(h).not.toContain('me@private.io')
  })

  test('the e-mail is not drawn on the phone either, nickname or not as the title', () => {
    g.window = { innerWidth: 390 }
    try {
      const h = renderToStaticMarkup(<AccountPlans {...base('claude', [acc('c2', { nickname: 'Work', label: 'me@private.io' })])} />)
      expect(h).toContain('Work')
      expect(h).not.toContain('me@private.io')
    } finally { g.window = { innerWidth: 1280 } }
  })

  test('a harness with no limits reader says so; antigravity says it keeps one account', () => {
    expect(renderToStaticMarkup(<AccountPlans {...base('gemini', [acc('g1', { harness: 'gemini' })])} />)).toContain('does not report its usage limits')
    expect(renderToStaticMarkup(<AccountPlans {...base('antigravity', [acc('y1', { harness: 'antigravity' })])} />)).toContain('single account')
    expect(renderToStaticMarkup(<AccountPlans {...base('claude', [acc('c1')])} />)).not.toContain('does not report its usage limits')
  })

  test('a harness that does not say who is signed in tells the reader to use one folder per account', () => {
    const h = renderToStaticMarkup(<AccountPlans {...base('gemini', [acc('g1', { harness: 'gemini' })])} />)
    expect(h).toContain('does not report which account is signed in; use one folder per account')
    expect(renderToStaticMarkup(<AccountPlans {...base('claude', [acc('c1')])} />)).not.toContain('one folder per account')
  })

  test('no accounts, no block', () => {
    expect(renderToStaticMarkup(<AccountPlans {...base('claude', [])} />)).toBe('')
  })
})

test('Billing agent toggles align with the padded account title', () => {
  for (const width of [390, 1440]) {
    g.window = { innerWidth: width }
    try {
      const html = renderToStaticMarkup(<AccountPlans {...base('claude', [acc('c1')])} />)
      expect(html).toContain('<div style="padding:0 12px"><button type="button" role="switch"')
      expect(html).toContain('padding:0 2px')
    } finally { g.window = { innerWidth: 1280 } }
  }
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

describe('BillingAccountsView (the collapsed per-assistant rows)', () => {
  const view = (open: AccountPlansProps['harness'] | null) => renderToStaticMarkup(
    <BillingAccountsView {...base('claude', [])} accounts={[acc('c1'), acc('c2'), acc('g1', { harness: 'gemini' })]}
      harnesses={['claude', 'gemini']} openHarness={open} onOpen={() => {}} />,
  )
  test('one collapsed row per assistant with its account count; the rows sit in the panel', () => {
    const h = view(null)
    expect(h).toContain('data-billing-harness="claude"')
    expect(h).toContain('data-billing-harness="gemini"')
    expect(h).toContain('2 accounts')
    expect(h).toContain('1 account')
    expect(h).toContain('aria-expanded="false"')
    expect(h).toContain('0 of 2 with a plan')
  })
  test('only the open assistant is expanded', () => {
    const h = view('claude')
    expect((h.match(/aria-expanded="true"/g) ?? []).length).toBe(1)
  })
})

describe('FirstDetectionNotice states', () => {
  const render = (status?: 'saving' | 'failed') => renderToStaticMarkup(
    <FirstDetectionNotice lang="en" account={acc('c2', { nickname: 'Work' })} status={status} onAnswer={() => {}} onDismiss={() => {}} />)
  test('saving disables the answer; failed explains and keeps the buttons usable', () => {
    expect(render('saving')).toContain('Saving…')
    expect(render('saving')).toMatch(/disabled/)
    const failed = render('failed')
    expect(failed).toContain('Could not save the answer')
    expect(failed).toContain('Confirm plan')
  })
  test('Portuguese: sentence, search placeholder wired, no English fallback in the trigger', () => {
    const h = renderToStaticMarkup(<FirstDetectionNotice lang="pt" account={acc('c2', { nickname: 'Trabalho' })} onAnswer={() => {}} onDismiss={() => {}} />)
    expect(h).toContain('Nova conta do')
    expect(h).toContain('Não sei agora')
    expect(readFileSync(new URL('./AccountRow.tsx', import.meta.url), 'utf8')).toContain('searchPlaceholder={t.searchPlans}')
  })
  test('a harness-reported plan prefills the picker; an unrecognised one leaves it empty', () => {
    const first = plansForHarness('claude')[0]!
    expect(matchDetectedPlan('claude', first.label)).toBe(first.id)
    expect(matchDetectedPlan('claude', 'nonsense')).toBe('')
  })
})

for (const width of [390, 1440]) for (const lang of ['pt', 'en'] as const) test(`expanded Billing shows limits once at ${width}px in ${lang}`, () => {
  const previous = g.window
  g.window = { innerWidth: width }
  try {
    const account = acc('primary', { nickname: 'Principal' })
    const props = base('claude', [account])
    props.lang = lang
    props.limits = [{ harness: 'claude', account: account.id, plan: 'max5x', source: 'codex-rollout', updatedAt: 1,
      windows: [{ kind: '5h', usedPct: 12, resetsAt: 1_000_000 }, { kind: 'week', usedPct: 34, resetsAt: 2_000_000 }] }]
    props.billing = { profiles: { claude: { periods: [{ id: 'default', mode: 'subscription', planId: 'anthropic-pro', price: { amount: 20, currency: 'USD' }, from: '2026-01-01' }] } } }
    const html = renderToStaticMarkup(<BillingAccountsView {...props} accounts={[account]} harnesses={['claude']} openHarness="claude" onOpen={() => {}} />)
    expect(html.match(/12% ·/g)).toHaveLength(1)
    expect(html.match(/34% ·/g)).toHaveLength(1)
    expect(html).toContain(lang === 'pt' ? 'Plano do assistente (padrão)' : 'Assistant plan (default)')
    expect(html).not.toContain('Claude Pro')
    const collapsed = renderToStaticMarkup(<BillingAccountsView {...props} accounts={[account]} harnesses={['claude']} openHarness={null} onOpen={() => {}} />)
    const header = collapsed.slice(0, collapsed.indexOf('</button>'))
    expect(header).toContain('Claude Code')
    expect(header.match(/role="meter"/g)).toHaveLength(2)
  } finally { g.window = previous }
})
