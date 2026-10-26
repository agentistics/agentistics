import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { isAdapterHarness, planBudget, planPace, surfaceHarnesses, type PlanLimits } from '@agentistics/core'
import { __setPlanLimitsForTest } from '../../lib/planLimits'
import type { UsageBudgetRow } from '../../lib/usagePlan'
import { HARNESS_LABELS } from '../../lib/harness'
import UsageNowPage from './UsageNowPage'
import UsageHistoryPage from './UsageHistoryPage'
import UsagePlanPage, { UsagePlanContent } from './UsagePlanPage'
import UsageLimitsPage from './UsageLimitsPage'
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
  test('under pace stays under without lighting the over-pace headline', () => {
    seed([row({ paceStatus: 'under' })])
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageNowPage />, 390, lang)
      expect(html).toContain(lang === 'pt' ? '>Abaixo do ritmo<' : '>Under pace<')
      expect(html).toContain(lang === 'pt' ? 'Todos os 1 planos no ritmo.' : 'All 1 plans on pace.')
    }
  })
  test('the expected-week figure uses the locale decimal separator', () => {
    seed([row({ weekPct: 30 })])
    const pt = render(<UsageNowPage />, 390, 'pt'), en = render(<UsageNowPage />, 390, 'en')
    expect(pt).toMatch(/Semana: esperado/)
    expect(pt).toMatch(/>\d+,\d%</)
    expect(en).toMatch(/>\d+\.\d%</)
  })
  test('overage retains the reported percentage with no negative remainder', () => {
    for (const weekPct of [105, 112, 125]) {
      seed([row({ weekPct, status: 'hold' })])
      for (const lang of ['pt', 'en'] as const) for (const page of [<UsageNowPage />, <UsageLimitsPage />]) {
        const html = render(page, 390, lang)
        expect(html).toContain(`${weekPct}%`)
        expect(html).toContain(lang === 'pt' ? 'restam 0%' : '0% left')
        expect(html).toContain(lang === 'pt' ? 'Acima do limite' : 'Over limit')
        expect(html).not.toContain(`-${weekPct - 100}%`)
      }
    }
  })
  test('single-reading and renewed stale fallback rates never become a measured recommendation', () => {
    for (const renewed of [false, true]) {
      const observed: PlanLimits = { harness: 'codex', account: 'a', plan: 'Plus', source: 'codex-rollout',
        updatedAt: renewed ? NOW - 10 * 86_400_000 : NOW,
        windows: [{ kind: 'week', usedPct: renewed ? 99 : 4, resetsAt: renewed ? NOW - 3 * 86_400_000 : NOW + WEEK * 0.98 }] }
      const budget = { ...planBudget(observed, NOW), ...planPace(observed, NOW), account: 'a' }
      expect(budget.freeSlotsMeasured).toBe(false)
      expect(budget.burnPctPerHour).toBeGreaterThan(0) // policy fallback is present, but not measured
      if (!renewed) expect(budget.status).toBe('tight')
      __setPlanLimitsForTest([observed], NOW, [], [budget])
      for (const lang of ['pt', 'en'] as const) for (const page of [<UsageNowPage />, <UsagePlanPage />]) {
        const html = render(page, 390, lang)
        expect(html).toContain(lang === 'pt' ? 'Sem medida ainda' : 'Not measured yet')
        expect(html).not.toContain('0 / 1')
        expect(html).not.toContain(lang === 'pt' ? '1 sessão em paralelo' : '1 parallel session')
      }
    }
  })
  test('pending Copilot accounts use their display label in both Now and Limits, never their raw id', () => {
    for (const accountLabel of ['Principal', undefined]) {
      __setPlanLimitsForTest([], NOW, [{ harness: 'copilot', account: 'acc_e52704c55121', plan: 'Pro', accountLabel }])
      for (const lang of ['pt', 'en'] as const) for (const page of [<UsageNowPage />, <UsageLimitsPage />]) {
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
      const html = render(<UsageNowPage />, width, lang)
      expect(html).toContain(usageHeadline(rows, NOW, lang)!)
      expect(html).toContain(lang === 'pt' ? '2 de 2 planos acima do ritmo.' : '2 of 2 plans over pace.')
      expect(html.match(new RegExp(lang === 'pt' ? '>Acima do ritmo<' : '>Over pace<', 'g'))?.length).toBe(2)
      expect(html).not.toContain(lang === 'pt' ? 'planos no ritmo.' : 'plans on pace.')
    }
  })
  test('tight weekly budgets omit the misleading recent pace / ideal pair', () => {
    seed([row({ status: 'tight', burnPctPerHour: 0.19, sustainablePctPerHour: 0.19, liveSessions: [], suggestedParallel: 1 })])
    for (const lang of ['pt', 'en'] as const) for (const width of [390, 1440]) {
      const now = render(<UsageNowPage />, width, lang)
      const plan = render(<UsagePlanPage />, width, lang)
      expect(now).toContain(lang === 'pt' ? 'Acima do ritmo' : 'Over pace')
      expect(now).not.toContain('0.19 / 0.19')
      expect(now).toContain('0 / 1')
      expect(plan).toContain(lang === 'pt' ? '1 sessão em paralelo' : '1 parallel session')
      expect(plan).not.toContain(lang === 'pt' ? 'Sem medida ainda' : 'Not measured yet')
      expect(now).toContain('grid-template-rows:subgrid')
      expect(now).toContain('data-usage-metrics')
    }
  })
  test('current readings and missing history are described separately', () => {
    seed([row()])
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageNowPage />, 390, lang)
      expect(html).toContain('30%')
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
      for (const page of [<UsageNowPage />, <UsageLimitsPage />]) {
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
  test('overview names the plan once per account and never promises no pause for an over-pace plan', () => {
    seed([row({ plan: 'Claude Max 5x', status: 'tight', pauseUntil: undefined })])
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageNowPage />, 390, lang)
      expect(html.match(/Claude Max 5x/g)).toHaveLength(1)
      expect(html).toContain(lang === 'pt' ? 'Sem horário' : 'No time set')
      expect(html).not.toContain(lang === 'pt' ? '>Sem pausa<' : '>No pause<')
    }
  })
  test('planning explains sustainable capacity and renders pause and unmeasured states', () => {
    for (const lang of ['pt', 'en'] as const) {
      seed([row({ status: 'hold', pauseUntil: NOW + 3_600_000 }), row({ harness: 'codex', freeSlotsMeasured: false })])
      const html = render(<UsagePlanPage />, 390, lang)
      expect(html).toContain(lang === 'pt' ? 'Em pausa até' : 'Paused until')
      expect(html).toContain(lang === 'pt' ? 'Sem medida ainda' : 'Not measured yet')
      expect(html).toContain(lang === 'pt' ? 'Período planejado' : 'Planning window')
      expect(html).toContain(lang === 'pt' ? '4 horas' : '4 hours')
      expect(html).toContain(lang === 'pt' ? 'aumentar as horas não aumenta a capacidade' : 'increasing hours does not increase plan capacity')
    }
  })
  test('planning distinguishes identical account nicknames by harness and plan', () => {
    seed([row({ accountLabel: 'Principal' }), row({ harness: 'codex', accountLabel: 'Principal', plan: 'ChatGPT Plus' })])
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsagePlanPage />, 390, lang)
      expect(html).toContain(`${HARNESS_LABELS.claude} · Principal`)
      expect(html).toContain(`${HARNESS_LABELS.codex} · Principal`)
      expect(html).toContain('ChatGPT Plus')
      expect(html).toContain('min="0"')
      expect(html).toContain('step="any"')
      expect(html).toContain('aria-invalid="false"')
      expect(html).toContain('text-align:left')
    }
  })

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
  test('history states its empty state and empty readings', () => {
    __setPlanLimitsForTest([], NOW)
    for (const lang of ['pt', 'en'] as const) {
      const html = render(<UsageHistoryPage />, 390, lang)
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

for (const lang of ['pt', 'en'] as const) test(`planning units, spacing and invalid edits retain account context in ${lang}`, () => {
  seed([row()])
  const html = render(<UsagePlanPage />, 390, lang)
  expect(html).toContain(lang === 'pt' ? '>horas</span>' : '>hours</span>')
  expect(html).toContain('margin:16px 0 20px')
  expect(html).toContain(lang === 'pt' ? 'Em execução agora' : 'Running now')
  expect(html).toContain(lang === 'pt' ? 'Renovação semanal' : 'Weekly renewal')
  for (const initialHours of ['-2', '0', '', 'text']) {
    const invalid = render(<UsagePlanContent initialHours={initialHours} />, 390, lang)
    expect(invalid).toContain('aria-invalid="true"')
    expect(invalid).toContain('aria-describedby=')
    expect(invalid).toContain('role="alert"')
    expect(invalid).toContain('color:var(--accent-red)')
    expect(invalid).toContain('max5x')
    expect(invalid).toContain('N/A')
    expect(invalid).not.toContain(lang === 'pt' ? '2 sessões em paralelo' : '2 parallel sessions')
  }
})

for (const lang of ['pt', 'en'] as const) test(`the pause tile reads plainly, in the same short form as "no pause" (${lang})`, () => {
  seed([row({ status: 'tight', pauseUntil: undefined })])
  const html = render(<UsageNowPage />, 390, lang)
  const phrase = lang === 'pt' ? 'Sem horário' : 'No time set'
  expect(html).toContain(phrase)
  expect(html).not.toContain('N/A —')
  // As short as "Sem pausa" beside it, so both tiles are drawn at the same figure size (QA r2).
  const neighbour = lang === 'pt' ? 'Sem pausa' : 'No pause'
  expect(Math.abs(phrase.length - neighbour.length)).toBeLessThanOrEqual(3)
})

for (const lang of ['pt', 'en'] as const) test(`overview and limits keep the forecast anchored to the reading in ${lang}`, () => {
  const budget = row({ weekPct: 0, fiveHourPct: 50 })
  const limits = { ...limit(budget), windows: [{ kind: '5h' as const, usedPct: 50, resetsAt: NOW + 2.5 * 3_600_000 + 1000 }] }
  const phrase = lang === 'pt' ? 'acaba ~' : 'runs out ~'
  for (const now of [NOW, NOW + 2000]) {
    __setPlanLimitsForTest([limits], now, [], [budget])
    for (const page of [<UsageNowPage />, <UsageLimitsPage />]) {
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
