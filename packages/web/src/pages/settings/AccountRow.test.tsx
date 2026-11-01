import React from 'react'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlanLimits } from '@agentistics/core'
import { BillingAccountList, type BillingAccountListProps, type BillingRowView } from './AccountRow'
import * as store from '../../lib/planLimits'
const { __setPlanLimitsFailureForTest, __setPlanLimitsForTest } = store
import { usageColors } from '../../lib/usageColors'
import { billingRows, type BillingAccount } from './accountBilling'

const g = globalThis as { window?: unknown }
const hadWindow = 'window' in g
beforeAll(() => { if (!hadWindow) g.window = { innerWidth: 1280 } })
afterAll(() => { if (!hadWindow) delete g.window })

const L = (h: string) => ({ claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI', antigravity: 'Antigravity' } as Record<string, string>)[h] ?? h
const acc = (id: string, o: Partial<BillingAccount> = {}): BillingAccount => ({
  id, harness: 'claude', key: id, label: `${id}@private.io`, root: null, available: true, ...o,
})
const reading = (account: string): PlanLimits => ({
  harness: 'claude', account, source: 'claude-usage-api', updatedAt: 1,
  windows: [{ kind: '5h', usedPct: 47, resetsAt: 9e12 }, { kind: 'week', usedPct: 58, resetsAt: 9e12 }],
})
const view = (accounts: BillingAccount[], harnesses = ['claude'], extra: (r: BillingRowView) => Partial<BillingRowView> = () => ({})): BillingAccountListProps => ({
  lang: 'en', now: 1, pendingIds: new Set(), failedIds: new Set(), selectedKey: null, onToggle: () => {}, onEdit: () => {},
  rows: billingRows(accounts, { profiles: {} }, harnesses as never, L as never, false).map(r => ({
    ...r, plan: { name: 'Claude Max 5x', price: '$ 100/mo', mode: 'subscription' as const }, problem: false, limits: r.account ? reading(r.account.id) : null, ...extra(r as BillingRowView),
  })),
})
/** What a reader SEES: the markup with its tags (and their aria labels) removed. */
const text = (h: string) => h.replace(/<[^>]*>/g, ' ')
const count = (h: string, s: string | RegExp) => (h.match(typeof s === 'string' ? new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : s) ?? []).length

describe('BillingAccountList — every fact once', () => {
  for (const width of [1280, 390]) {
    test(`one account (${width}px): one meter, the login once, the plan once, one switch, one edit`, () => {
      g.window = { innerWidth: width }
      try {
        const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1', { label: 'me@private.io' })])} />)
        expect(count(h, 'data-plan-limits=')).toBe(1)
        expect(count(text(h), 'me@private.io')).toBe(1)
        expect(count(text(h), 'Claude Max 5x')).toBe(1)
        expect(count(text(h), 'Claude Code')).toBe(1)
        expect(count(h, /role="switch"/g)).toBe(1)
        expect(count(h, 'aria-label="Edit · me@private.io"')).toBe(1)
        expect(count(h, 'data-usage-ring=')).toBe(2)
        expect(h).toContain('lucide-pencil')
        expect(h).not.toContain('(default)')
      } finally { g.window = { innerWidth: 1280 } }
    })
  }

  test('three accounts on two assistants: three rows, three meters, no assistant summary row', () => {
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1'), acc('c2', { nickname: 'Work' }), acc('x1', { harness: 'codex' })], ['claude', 'codex'])} />)
    expect(count(h, 'data-billing-row=')).toBe(3)
    expect(count(h, 'data-plan-limits=')).toBe(3)
    expect(h).toContain('3 of 3 with a plan')
  })

  test('no plan: the state and the action, never a zero', () => {
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1')], ['claude'], () => ({ plan: null }))} />)
    expect(h).toContain('No plan')
    expect(h).toContain('Set plan')
    expect(h).toContain('0 of 1 with a plan')
  })

  test('unknown billing is not counted as a plan in either language or layout', () => {
    for (const width of [1440, 390]) {
      g.window = { innerWidth: width }
      try {
        const props = view(Array.from({ length: 6 }, (_, i) => acc(`c${i}`)), ['claude'], r =>
          Number(r.key.slice('claude:c'.length)) < 2 ? {} : { plan: { name: 'Cobrança desconhecida', price: null, mode: 'unknown' } })
        expect(renderToStaticMarkup(<BillingAccountList {...props} lang="pt" />)).toContain('2 de 6 com plano informado · 4 sem informar')
        expect(renderToStaticMarkup(<BillingAccountList {...props} lang="en" />)).toContain('2 of 6 with a plan · 4 not set')
      } finally { g.window = { innerWidth: 1280 } }
    }
  })

  test('an assistant with no identified account is one row with no Agents switch', () => {
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('', { harness: 'gemini', label: 'Conta padrão' })], ['gemini'])} />)
    expect(h).toContain('data-billing-row="harness:gemini"')
    expect(count(h, /role="switch"/g)).toBe(0)
    expect(h).toContain('Not reported')
  })

  test('OpenCode states it has no plan quota, in both languages — never a percentage or "waiting"', () => {
    const props = view([acc('', { harness: 'opencode', label: 'Conta padrão' })], ['opencode'])
    const en = renderToStaticMarkup(<BillingAccountList {...props} lang="en" />)
    expect(en).toContain('No plan quota for OpenCode')
    expect(en).not.toContain('Not reported')
    expect(renderToStaticMarkup(<BillingAccountList {...props} lang="pt" />)).toContain('Sem cota de plano no OpenCode')
  })

  test('a broken timeline says so on the row and offers Review', () => {
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1')], ['claude'], () => ({ problem: true }))} />)
    expect(h).toContain('Periods need fixing')
    expect(h).toContain('Review')
    expect(h).not.toContain('Claude Max 5x')
  })
})

for (const width of [1440, 390]) test(`a renewed Codex window is one ring whose tooltip says so at ${width}px`, () => {
  g.window = { innerWidth: width }
  try {
    const limits: PlanLimits = { ...reading('x1'), harness: 'codex', source: 'codex-rollout', windows: [{ kind: '5h', usedPct: 70, resetsAt: 1 }] }
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('x1', { harness: 'codex' })], ['codex'], () => ({ limits }))} now={100000} lang="pt" />)
    const usage = h.slice(h.indexOf('data-billing-usage'))
    expect(count(usage, 'data-usage-ring=')).toBe(1)
    expect(usage).toMatch(/title="Sessão 5 h: \d+% · renovado/)
  } finally { g.window = { innerWidth: 1280 } }
})

test('the row keeps full plan names and logins, never an ellipsis', () => {
  g.window = { innerWidth: 1440 }
  const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1', { label: 'principal@exemplo.com' })], ['claude'], () => ({ plan: { name: 'Cobrança desconhecida', price: null, mode: 'unknown' } }))} lang="pt" />)
  expect(h).toContain('Cobrança desconhecida')
  expect(h).toContain('principal@exemplo.com')
  expect(h).not.toContain('text-overflow:ellipsis')
})

for (const width of [1440, 390]) test(`a nicknamed row: the name, then the assistant and plan muted, the login on hover (${width}px)`, () => {
  g.window = { innerWidth: width }
  try {
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1', { nickname: 'Principal', label: 'principal@exemplo.com' })], ['claude'])} lang="pt" />)
    expect(h).toContain('>Principal</b>')
    expect(h).toContain('data-billing-subtitle')
    expect(text(h).replace(/\s+/g, ' ')).toContain('Claude Code · Claude Max 5x · $ 100/mo')
    expect(h).toContain('title="Claude Code\nprincipal@exemplo.com"')
  } finally { g.window = { innerWidth: 1280 } }
})

test('at 390px the row wraps instead of scrolling and its controls are 44px targets', () => {
  g.window = { innerWidth: 390 }
  try {
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1')])} lang="pt" />)
    expect(h).toContain('flex-wrap:wrap')
    expect(h).toContain('flex:1 1 220px')
    expect(h).toContain('width:44px;height:44px')
    expect(h).toContain('min-height:44px')
    expect(h).not.toContain('<table')
  } finally { g.window = { innerWidth: 1280 } }
})

for (const width of [1440, 390]) test(`an Antigravity scoped limit shows both model-group bars at ${width}px`, () => {
  g.window = { innerWidth: width }
  try {
    const scope = (id: string, label: string) => ({ id, label, models: [id], providers: [id] })
    const limits: PlanLimits = { harness: 'antigravity', account: 'default', source: 'antigravity-quota-api', updatedAt: 1,
      windows: [{ kind: 'week', usedPct: 62, resetsAt: 9e12, scope: scope('google', 'Gemini models') }, { kind: 'week', usedPct: 4, resetsAt: 9e12, scope: scope('anthropic+openai', 'Claude and GPT models') }] } as PlanLimits
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('default', { harness: 'antigravity', label: 'Antigravity' })], ['antigravity'], r => ({ limits: r.account ? limits : null }))} />)
    const usage = h.slice(h.indexOf('data-billing-usage'))
    expect(usage).toContain('Gemini')
    expect(usage).toContain('Claude and GPT')
    expect(h).not.toContain('Not reported')
  } finally { g.window = { innerWidth: 1280 } }
})


test('row markers use the charts’ full account palette, independent of visible row order', () => {
  const readings = ['claude:archived', 'claude:c1', 'codex:x1'].map(key => {
    const [harness, account] = key.split(':')
    return { harness: harness as 'claude' | 'codex', account: account!, points: [{ at: 1, weekPct: 10, fiveHourPct: 5 }] }
  })
  __setPlanLimitsForTest([], 1, [], [], readings)
  try {
    const props = view([acc('x1', { harness: 'codex' }), acc('c1')], ['claude', 'codex'])
    const expected = usageColors(readings.map(r => `${r.harness}:${r.account}`))
    for (const rows of [props.rows, [...props.rows].reverse(), [props.rows[0]!]]) {
      const html = renderToStaticMarkup(<BillingAccountList {...props} rows={rows} />)
      for (const row of rows) {
        const identity = `${row.harness}:${row.account!.id}`
        const marker = html.match(new RegExp(`data-account-color="${identity}"[^>]*`))![0]
        expect(marker).toContain(`background:${expected.get(identity)}`)
      }
    }
  } finally { __setPlanLimitsForTest(null) }
})


test('accounts without limit readings use neutral markers instead of an unrelated chart colour', () => {
  __setPlanLimitsForTest([], 1, [], [], [])
  try {
    const html = renderToStaticMarkup(<BillingAccountList {...view([acc('empty')])} />)
    const marker = html.match(/data-account-color="claude:empty"[^>]*/)![0]
    expect(marker).toContain('background:#94a3b8')
  } finally { __setPlanLimitsForTest(null) }
})

describe('CONTAS.LOGIN: an assistant with no login on this computer', () => {
  for (const lang of ['en', 'pt'] as const) test(`says "not connected" (${lang}), never a placeholder account`, () => {
    const signedOut: BillingAccount = { id: '', harness: 'claude', key: 'default', label: 'Conta padrão', root: null, available: true, signedOut: true }
    const rows = billingRows([signedOut], { profiles: {} }, ['claude'] as never, L as never, lang === 'pt')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.signedOut).toBe(true)
    const h = renderToStaticMarkup(<BillingAccountList {...{ ...view([signedOut]), lang }} rows={rows.map(r => ({ ...r, plan: null, problem: false, limits: null }))} />)
    expect(text(h)).toContain(lang === 'pt' ? 'Claude Code instalado, sem login' : 'Claude Code is installed, not signed in')
    expect(text(h)).not.toContain(lang === 'pt' ? 'Não conectado' : 'Not connected')
    expect(text(h)).not.toContain(lang === 'pt' ? 'Sem plano' : 'No plan')
    expect(text(h)).not.toContain(lang === 'pt' ? 'Sem leitura ainda' : 'No reading yet')
    expect(h).toContain('data-signed-out')
  })
})

describe('CONTAS.LOGIN r3: an assistant with no login is a closable notice, not an account', () => {
  const signedOut: BillingAccount = { id: '', harness: 'claude', key: 'default', label: 'Conta padrão', root: null, available: true, signedOut: true }
  const asView = (rows: ReturnType<typeof billingRows>) => rows.map(r => ({ ...r, plan: null, problem: false, limits: null }))
  for (const lang of ['en', 'pt'] as const) test(`offers Sign in and ×, and is outside the list and its count (${lang})`, () => {
    // A signed-out claude beside a real account of another assistant.
    const rows = [...asView(billingRows([signedOut], { profiles: {} }, ['claude'] as never, L as never, lang === 'pt')),
      ...asView(billingRows([acc('real', { harness: 'codex' })], { profiles: {} }, ['codex'] as never, L as never, lang === 'pt'))]
    const h = renderToStaticMarkup(<BillingAccountList {...{ ...view([signedOut, acc('real')]), lang }} rows={rows} onSignIn={() => {}} onHideSignedOut={() => {}} />)
    expect(h).toContain('data-signed-out-notice="claude"')
    expect(text(h)).toContain(lang === 'pt' ? 'Entrar' : 'Sign in')
    expect(h).toContain(lang === 'pt' ? 'aria-label="Ocultar o aviso do Claude Code"' : 'aria-label="Hide the Claude Code notice"')
    expect(text(h)).toContain(lang === 'pt' ? '0 de 1 com plano informado' : '0 of 1 with a plan')
    expect((h.match(/role="listitem"/g) ?? []).length).toBe(1)
  })
  test('a hidden notice is gone, and with no account left no empty list is drawn', () => {
    const rows = asView(billingRows([signedOut], { profiles: {} }, ['claude'] as never, L as never, false))
    const h = renderToStaticMarkup(<BillingAccountList {...view([signedOut])} rows={rows} hiddenSignedOut={new Set(['claude'])} onHideSignedOut={() => {}} />)
    expect(h).not.toContain('data-signed-out')
    expect(h).not.toContain('role="list"')
  })
})

describe('CONTA.SEM.PLANO — a detected, unsaved plan', () => {
  test('the row says the plan was detected and asks to confirm, never a bare "No plan"', () => {
    for (const lang of ['pt', 'en'] as const) {
      const v = view([acc('c1')], ['claude'], () => ({ plan: null, detected: 'Claude Max 5x' }))
      const h = renderToStaticMarkup(<BillingAccountList {...v} lang={lang} />)
      expect(text(h)).toContain(lang === 'pt' ? 'Detectado: Claude Max 5x · confirme' : 'Detected: Claude Max 5x · confirm')
      expect(text(h)).not.toContain(lang === 'pt' ? 'Sem plano' : 'No plan')
    }
  })
  test('with nothing detected the row still says "No plan"', () => {
    const h = renderToStaticMarkup(<BillingAccountList {...view([acc('c1')], ['claude'], () => ({ plan: null }))} />)
    expect(text(h)).toContain('No plan')
  })
})

describe('USO.CARREGANDO: before the first plan-limits answer no row claims "No reading yet"', () => {
  // An assistant row with no identified account (the row the loading print showed saying "No reading yet").
  const noAccount = (lang: 'en' | 'pt') => {
    const rows = billingRows([], { profiles: {} }, ['claude'] as never, L as never, lang === 'pt').map(r => ({ ...r, plan: null, problem: false, limits: null }))
    return { ...view([]), lang, rows, limitsReady: false }
  }
  for (const lang of ['en', 'pt'] as const) test(`while loading every row waits (${lang})`, () => {
    const h = renderToStaticMarkup(<BillingAccountList {...noAccount(lang)} />)
    expect(h).toContain('data-usage-waiting')
    expect(text(h)).not.toContain(lang === 'pt' ? 'Sem leitura ainda' : 'No reading yet')
  })
  test('a refusal ends the wait: "not reported", never a spinner and never "no reading yet"', () => {
    __setPlanLimitsFailureForTest('unavailable')
    try {
      const h = renderToStaticMarkup(<BillingAccountList {...noAccount('pt')} />)
      expect(h).not.toContain('data-usage-waiting')
      expect(text(h)).toContain('Não informado')
      expect(text(h)).not.toContain('Sem leitura ainda')
    } finally { __setPlanLimitsFailureForTest(null) }
  })
  test('after the answer the row says what it knows', () => {
    const h = renderToStaticMarkup(<BillingAccountList {...{ ...noAccount('en'), limitsReady: true }} />)
    expect(h).not.toContain('data-usage-waiting')
    expect(text(h)).toContain('No reading yet')
  })
})
