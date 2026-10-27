import type React from 'react'
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { type PlanLimits } from '@agentistics/core'
import { __setPlanLimitsForTest } from '../../lib/planLimits'
import type { UsageBudgetRow } from '../../lib/usagePlan'
import { UsageNowContent } from './UsageNowPage'
import { NayLimitsTab } from '../../components/nay/NayLimitsTab'
import { updatedPhrase, shortWhen } from '../../lib/planLimits'
import { PlanLimitBars, PlanUsageCard } from '../../components/PlanLimitMeter'
import { usageHeadline } from '../../lib/usagePlan'
import { timeTicks } from '../../components/ActivityChart'
import { UsageCharts, usageChartData } from './UsageCharts'

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
function render(page: React.ReactElement, width = 1440, lang: 'pt' | 'en' = 'pt') {
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
  test('under pace stays under without lighting the over-pace headline', () => {
    seed([row({ paceStatus: 'under' })])
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageNowContent lang={lang} accounts={false} />, 390, lang)
      expect(html).toContain(lang === 'pt' ? 'Todos os 1 planos no ritmo.' : 'All 1 plans on pace.')
    }
  })
  test('overage retains the reported percentage with no negative remainder', () => {
    for (const weekPct of [105, 112, 125]) {
      seed([row({ weekPct, status: 'hold' })])
      for (const lang of ['pt', 'en'] as const) for (const page of [<NayLimitsTab embedded lang={lang} isMobile />]) {
        const html = render(page, 390, lang)
        expect(html).toContain(`${weekPct}%`)
        expect(html).toContain(lang === 'pt' ? 'restam 0%' : '0% left')
        expect(html).toContain(lang === 'pt' ? 'Acima do limite' : 'Over limit')
        expect(html).not.toContain(`-${weekPct - 100}%`)
      }
    }
  })
  test('pending Copilot accounts use their display label in both Now and Limits, never their raw id', () => {
    for (const accountLabel of ['Principal', undefined]) {
      __setPlanLimitsForTest([], NOW, [{ harness: 'copilot', account: 'acc_e52704c55121', plan: 'Pro', accountLabel }])
      for (const lang of ['pt', 'en'] as const) for (const page of [<NayLimitsTab embedded lang={lang} isMobile />]) {
        const html = render(page, 390, lang)
        expect(html).not.toContain('Copilot CLI · acc_e52704c55121')
        if (accountLabel) expect(html).toContain('Copilot CLI · Principal')
      }
    }
  })
  test('headline and account pills agree when the budget is tight but recent pace is on', () => {
    const rows = [row({ status: 'tight', paceStatus: 'on' }), row({ harness: 'codex', status: 'tight', paceStatus: 'on', weekPct: 27, weekResetsAt: NOW + WEEK * 0.93 })]
    seed(rows)
    for (const lang of ['pt', 'en'] as const) for (const width of [390, 1440]) {
      const html = render(<UsageNowContent lang={lang} accounts={false} />, width, lang)
      expect(html).toContain(usageHeadline(rows, NOW, lang)!)
      expect(html).toContain(lang === 'pt' ? '2 de 2 planos acima do ritmo.' : '2 of 2 plans over pace.')
      expect(html).not.toContain(lang === 'pt' ? 'planos no ritmo.' : 'plans on pace.')
    }
  })
  test('current readings and missing history are described separately', () => {
    seed([row()])
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageNowContent lang={lang} accounts={false} />, 390, lang)
      expect(html).toContain(lang === 'pt' ? 'Ainda não há histórico de uso registrado' : 'No usage history recorded yet')
      expect(html).not.toContain(lang === 'pt' ? 'Ainda não há leituras de uso neste período.' : 'No usage readings in this period yet.')
    }
  })
  test('Nay shows one update age per account, never a competing global age', () => {
    const accounts = [row(), row({ harness: 'codex', account: 'work', plan: 'ChatGPT Plus' })]
    const limits = accounts.map((account, index) => ({ ...limit(account), updatedAt: NOW - (12 - index * 3) * 60_000 }))
    __setPlanLimitsForTest(limits, NOW, [], accounts)
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<NayLimitsTab lang={lang} isMobile={false} />, 1440, lang)
      for (const account of limits) expect(html).toContain(updatedPhrase(account, NOW, lang))
      expect(html.match(new RegExp(lang === 'pt' ? 'atualizado há' : 'updated ', 'g'))).toHaveLength(2)
      expect(html).not.toContain('Updated ')
      const compact = render(<PlanLimitBars limits={limits[0]!} now={NOW} lang={lang} />, 390, lang)
      expect(compact).toContain(shortWhen(limits[0]!.windows[0]!.resetsAt, NOW, lang, limits[0]!.windows[0]!.kind))
    }
  })
  test('a low percent with an early exhaustion forecast never claims room to spare', () => {
    const r = row({ harness: 'codex', weekPct: 27, weekResetsAt: NOW + WEEK * 0.93 })
    seed([r])
    for (const lang of ['pt', 'en'] as const) {
      for (const page of [<NayLimitsTab embedded lang={lang} isMobile />]) {
        const html = render(page, 390, lang)
        expect(html).toContain(lang === 'pt' ? 'acaba ~' : 'runs out ~')
        expect(html).toContain(lang === 'pt' ? 'atenção' : 'attention')
        expect(html).toContain(`aria-label="${lang === 'pt' ? 'atenção' : 'attention'}"`)
        expect(html).toContain('points="10,1 19,18 1,18"')
        expect(html).not.toContain(lang === 'pt' ? 'com folga' : 'room to spare')
      }
      const calm = render(<PlanUsageCard limits={limit(row({ weekPct: 10 }))} now={NOW} lang={lang} />, 390, lang)
      expect(calm).toContain(lang === 'pt' ? 'com folga' : 'room to spare')
    }
  })

  test('history states its empty state and empty readings', () => {
    __setPlanLimitsForTest([], NOW)
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageNowContent lang={lang} accounts={false} />, 390, lang)
      const scope = lang === 'pt' ? /Ainda não há histórico de uso registrado/g : /No usage history recorded yet/g
      expect(html.match(scope)).toHaveLength(1)
    }
  })
})

describe('usage percent series', () => {
  for (const kind of ['week', '5h'] as const) for (const fraction of [0, 0.25, 0.5, 1]) {
    test(`${kind} expected fraction ${fraction} is a straight percentage line`, () => {
      const length = kind === 'week' ? WEEK : 5 * 3_600_000
      const at = NOW - length + fraction * length
      const reading = { harness: 'codex' as const, account: 'a', points: [{ at, weekPct: 125, fiveHourPct: 125 }] }
      expect(usageChartData(reading, kind, NOW).find(p => p.at === at)).toEqual({ at, expected: fraction * 100, actual: 125 })
    })
  }
  test('expected runs from 0 to 100 while measured percentages stay unchanged', () => {
    const reading = { harness: 'claude' as const, account: 'personal', points: [{ at: NOW - WEEK / 2, weekPct: 25, fiveHourPct: null }] }
    expect(usageChartData(reading, 'week', NOW)).toEqual([
      { at: NOW - WEEK, actual: null, expected: 0 },
      { at: NOW - WEEK / 2, actual: 25, expected: 50 },
      { at: NOW, actual: null, expected: 100 },
    ])
    expect(usageChartData(reading, '5h', NOW)).toEqual([])
  })
  test('a renewed window breaks the Real line instead of falling', () => {
    const r1 = NOW - WEEK / 2, r2 = NOW + WEEK / 2
    const reading = { harness: 'claude' as const, account: 'p', points: [
      { at: NOW - WEEK + 1000, weekPct: 80, fiveHourPct: null, weekReset: r1 },
      { at: NOW - WEEK + 2000, weekPct: 95, fiveHourPct: null, weekReset: r1 },
      { at: NOW - 1000, weekPct: 3, fiveHourPct: null, weekReset: r2 },
      { at: NOW, weekPct: 4, fiveHourPct: null, weekReset: r2 },
    ] }
    const data = usageChartData(reading, 'week', r2)
    const gap = data.findIndex(p => p.actual === null && p.expected === null)
    expect(data.slice(0, gap).filter(p => p.actual !== null).at(-1)!.actual).toBe(95)
    expect(data.slice(gap).find(p => p.actual !== null)!.actual).toBe(3)
    // within one window there is no gap
    expect(data.filter(p => p.actual === null && p.expected === null)).toHaveLength(1)
  })
  test('ticks are few, ordered and inside the range', () => {
    const t = timeTicks(NOW - WEEK, NOW, 4)
    expect(t.length).toBeGreaterThan(1)
    expect(t.length).toBeLessThanOrEqual(5)
    expect(t.every((x, i) => x >= NOW - WEEK && x <= NOW && (i === 0 || x > t[i - 1]!))).toBe(true)
    expect(timeTicks(NOW, NOW, 4)).toEqual([NOW])
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



for (const lang of ['pt', 'en'] as const) test(`overview and limits keep the forecast anchored to the reading in ${lang}`, () => {
  const budget = row({ weekPct: 0, fiveHourPct: 50 })
  const limits = { ...limit(budget), windows: [{ kind: '5h' as const, usedPct: 50, resetsAt: NOW + 2.5 * 3_600_000 + 1000 }] }
  const phrase = lang === 'pt' ? 'acaba ~' : 'runs out ~'
  for (const now of [NOW, NOW + 2000]) {
    __setPlanLimitsForTest([limits], now, [], [budget])
    for (const page of [<NayLimitsTab embedded lang={lang} isMobile />]) {
      const html = render(page, 390, lang)
      expect(html.includes(phrase)).toBe(true)
      expect(html).toContain('data-plan-forecast-slot')
      expect(html).toContain('min-height:1.5em')
    }
    const nay = render(<NayLimitsTab lang={lang} isMobile />, 390, lang)
    expect(nay.includes(phrase)).toBe(true)
    expect(nay).toContain('min-height:44px;min-width:44px')
  }
})

for (const lang of ['pt', 'en'] as const) for (const width of [390, 1440]) test(`chart account names are unambiguous in ${lang} at ${width}px`, () => {
  const budgets = [row({ account: 'personal', accountLabel: 'Principal' }),
    row({ harness: 'codex', account: 'work', accountLabel: 'Principal' }),
    row({ account: 'second', accountLabel: 'Principal' })]
  const readings = budgets.map(r => ({ account: r.account!, harness: r.harness,
    points: [{ at: NOW, weekPct: 30, fiveHourPct: 10 }] }))
  for (const bothWindows of [false, true]) {
    const html = render(<UsageCharts budgets={budgets} limits={budgets.map(limit)} readings={readings} lang={lang} bothWindows={bothWindows} />, width, lang)
    for (const name of ['Claude Code · Principal · personal', 'Claude Code · Principal · second', 'Codex CLI · Principal']) expect(html).toContain(name)
    expect(html).not.toContain('aria-label="Principal ·')
  }
})

for (const lang of ['pt', 'en'] as const) test(`Nay manage plans is a framed 44px action aligned with the cards in ${lang}`, () => {
  seed([row()])
  const html = render(<NayLimitsTab lang={lang} isMobile />, 390, lang)
  expect(html).toContain(lang === 'pt' ? 'Gerenciar planos' : 'Manage plans')
  expect(html).toContain('border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated);color:var(--text-primary)')
  expect(html).toContain('padding:2px 0 0')
  expect(html).toContain('min-height:44px;min-width:44px')
})
