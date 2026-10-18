import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { isAdapterHarness, surfaceHarnesses, type PlanLimits } from '@agentistics/core'
import { __setPlanLimitsForTest } from '../../lib/planLimits'
import type { UsageBudgetRow } from '../../lib/usagePlan'
import { HARNESS_LABELS } from '../../lib/harness'
import UsageNowPage from './UsageNowPage'
import UsageHistoryPage from './UsageHistoryPage'
import UsagePlanPage from './UsagePlanPage'
import { usageChartData } from './UsageCharts'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const WEEK = 7 * 24 * 3_600_000
const row = (patch: Partial<UsageBudgetRow> = {}): UsageBudgetRow => ({
  harness: 'claude', plan: 'max5x', account: 'personal', accountLabel: 'Personal',
  fiveHourPct: 10, weekPct: 30, weekResetsAt: NOW + WEEK / 2, daysToWeekReset: 3.5,
  dailyBudgetPct: 10, status: 'ok', updatedAt: NOW, stale: false,
  paceStatus: 'on', burnPctPerHour: 0.4, sustainablePctPerHour: 0.8, suggestedParallel: 2,
  note: '', freeSlots: 1, freeSlotsMeasured: true,
  liveSessions: [{ id: 'worker', model: 'example', burnPctPerHour: 0.4 }], ...patch,
})
const limit = (r: UsageBudgetRow): PlanLimits => ({
  harness: r.harness, account: r.account ?? 'default', plan: r.plan,
  source: 'codex-rollout', updatedAt: NOW,
  windows: [{ kind: 'week', usedPct: r.weekPct, resetsAt: r.weekResetsAt }, { kind: '5h', usedPct: r.fiveHourPct, resetsAt: NOW + 3_600_000 }],
})
function render(page = <UsageNowPage />, width = 1440, lang: 'pt' | 'en' = 'pt') {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: width }
  try {
    return renderToStaticMarkup(<MemoryRouter><Routes><Route element={<Outlet context={{ lang }} />}><Route index element={page} /></Route></Routes></MemoryRouter>)
  } finally {
    if (previous === undefined) delete root.window
    else root.window = previous
  }
}
function seed(rows: UsageBudgetRow[]) {
  __setPlanLimitsForTest(rows.map(limit), NOW, rows.map(r => ({ harness: r.harness, account: r.account, plan: r.plan })), rows)
}
afterEach(() => __setPlanLimitsForTest(null, NOW))

describe('usage account cards', () => {
  test('two accounts of a harness produce two cards, with their own meters', () => {
    seed([row(), row({ account: 'work', accountLabel: 'Work', weekPct: 80 })])
    const html = render()
    expect(html.match(/data-usage-account=/g)?.length).toBe(2)
    expect(html).toContain('data-usage-account="claude:personal"')
    expect(html).toContain('data-usage-account="claude:work"')
    const personal = html.slice(html.indexOf('data-usage-account="claude:personal"'), html.indexOf('data-usage-account="claude:work"'))
    expect(personal).toContain('30%')
    expect(personal).not.toContain('80%')
    expect(html.slice(html.indexOf('data-usage-account="claude:work"'))).toContain('80%')
  })
  test('uses surface registry order followed by account label, regardless of input order', () => {
    const harnesses = surfaceHarnesses(false).filter(isAdapterHarness)
    const budgets = harnesses.flatMap(harness => [row({ harness, account: `${harness}-z`, accountLabel: 'Zeta' }), row({ harness, account: `${harness}-a`, accountLabel: 'Alpha' })]).reverse()
    seed(budgets)
    const keys = [...render().matchAll(/data-usage-account="([^"]+)"/g)].map(m => m[1])
    expect(keys).toEqual(harnesses.flatMap(h => [`${h}:${h}-a`, `${h}:${h}-z`]))
  })
  test('a registered account without a reading still has a pending card in registry order', () => {
    const r = row({ harness: 'codex' })
    __setPlanLimitsForTest([limit(r)], NOW, [{ harness: 'claude', account: 'pending', plan: 'max5x' }, { harness: 'codex', account: r.account, plan: r.plan }], [r])
    const html = render()
    expect(html.match(/data-usage-account=/g)?.length).toBe(2)
    expect(html).toContain('aguardando leitura')
    expect(html.indexOf('data-usage-account="claude:pending"')).toBeLessThan(html.indexOf('data-usage-account="codex:personal"'))
  })
  test('missing subscription plans use chips and a registration action', () => {
    seed([row()])
    const html = render()
    expect(html).toContain('Sem plano registrado')
    expect(html).toContain('Registrar plano')
    for (const h of surfaceHarnesses(false).filter(h => h !== 'claude')) expect(html).toContain(HARNESS_LABELS[h])
  })
  test('unmeasured capacity is stated, never displayed as a confident zero', () => {
    seed([row({ freeSlotsMeasured: false, freeSlots: 0, suggestedParallel: 0 })])
    const html = render()
    expect(html).toContain('Sem medida ainda — abra uma sessão para medir o ritmo')
    expect(html).not.toContain('Em paralelo / recomendado')
    expect(html).not.toContain('0 / 0')
  })
  test('empty state and registration remain visible at desktop and mobile widths in both languages', () => {
    __setPlanLimitsForTest([], NOW)
    for (const width of [390, 1440]) for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageNowPage />, width, lang)
      expect(html).toContain(lang === 'pt' ? 'Nenhum plano com leitura de uso ainda.' : 'No plans with usage readings yet.')
      expect(html).toContain(lang === 'pt' ? 'Registrar plano' : 'Register plan')
      if (width === 390) expect(html).toContain('min-height:44px')
    }
  })
  test('planning uses the shared helper and a numeric hours field', () => {
    seed([row()])
    const html = render(<UsagePlanPage />, 390)
    expect(html).toContain('type="number"')
    expect(html).toContain('value="4"')
    expect(html).toContain('2 sessões em paralelo')
  })
  test('history explains its in-memory lifetime and empty readings', () => {
    __setPlanLimitsForTest([], NOW)
    const html = render(<UsageHistoryPage />)
    expect(html).toContain('Histórico desde que o servidor iniciou.')
    expect(html).toContain('Ainda não há leituras de uso neste período.')
  })
})

describe('usage percent series', () => {
  test('expected runs from 0 to 100 while measured percentages stay unchanged', () => {
    const reading = { harness: 'claude' as const, account: 'personal', points: [{ at: NOW - WEEK / 2, weekPct: 25, fiveHourPct: null }] }
    expect(usageChartData(reading, 'week', NOW)).toEqual([
      { at: NOW - WEEK, actual: null, expected: 0 },
      { at: NOW - WEEK / 2, actual: 25, expected: 50 },
      { at: NOW, actual: null, expected: 100 },
    ])
    expect(usageChartData(reading, '5h', NOW)).toEqual([])
  })
  test('missing renewal does not invent an expected line or a zero for unknown readings', () => {
    const reading = { harness: 'codex' as const, account: 'work', points: [{ at: NOW, weekPct: null, fiveHourPct: 12 }] }
    expect(usageChartData(reading, 'week')).toEqual([])
    expect(usageChartData(reading, '5h')).toEqual([{ at: NOW, actual: 12, expected: null }])
  })
  test('history preserves previous readings while Agora limits comparisons to the current window', () => {
    const reading = { harness: 'claude' as const, account: 'personal', points: [{ at: NOW - WEEK - 1, weekPct: 90, fiveHourPct: null }, { at: NOW - WEEK / 2, weekPct: 25, fiveHourPct: null }] }
    expect(usageChartData(reading, 'week', NOW)[0]).toEqual({ at: NOW - WEEK - 1, actual: 90, expected: null })
    expect(usageChartData(reading, 'week', NOW, true).some(p => p.actual === 90)).toBe(false)
  })
})
