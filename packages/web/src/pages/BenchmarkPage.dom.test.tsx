import React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import type { Covered, Gap, Interval, Observed } from '@agentistics/core/benchmark'
import { BenchmarkContent, BenchmarkHowItWorksPage } from './BenchmarkPage'
import { benchmarkQuery, cardHeadline, dayLabel, formulaText, fmtValue, harnessState, METRIC_ORDER } from '../lib/benchmarkFormat'

const H = 3_600_000
const SOURCES = ['tasks.json (subtasks)', 'deliveries.json (phase history)', 'managed-sessions.json (sessions)', 'sessions store (tokens)']
const iv = (lo: number, hi: number, method: Interval['method'] = 'bootstrap'): Interval => ({ lo, hi, level: 0.95, method })
function cov(value: number | null, n: number, total: number, interval: Interval | null = null, gaps: Gap[] = []): Covered<number> {
  return { value, interval, gaps, n, covered: n, total, missing: [], formula: 'fixture formula', origin: { records: SOURCES, formula: 'fixture formula', n, coverage: `${n} of ${total} records measured` } }
}
const observed: Observed = {
  label: 'observed-biased', period: { from: null, to: null }, deliveries: 1000,
  scope: { published: 900, open: 100, withPhaseHistory: 120, abandonedWithSessions: 7 },
  metrics: {
    costPerDelivery: cov(12.345, 700, 1000, iv(10.1, 14.9), [{ code: 'no_price', count: 40 }]),
    wallMedian: cov(28.2 * H, 900, 900, iv(25 * H, 31 * H)),
    activeMedian: cov(100 * H, 110, 900, iv(80 * H, 120 * H), [{ code: 'no_phase_history', count: 790 }]),
    coordinationShare: cov(null, 500, 800, iv(0.3, 0.5, 'range')),
    qaFirstRoundRejection: cov(null, 0, 1000, null, [{ code: 'no_qa_stage', count: 120 }, { code: 'no_phase_history', count: 880 }]),
    qaRoundsMedian: cov(null, 0, 1000, null, [{ code: 'no_qa_stage', count: 120 }]),
    escapedDefectRate: cov(null, 0, 900, null, [{ code: 'escape_links_not_recorded', count: 900 }]),
    wastedCostShare: cov(0.07, 500, 800, iv(0.05, 0.09, 'bootstrap')),
    throughputPerWeek: cov(97.25, 900, 1000, iv(91, 103, 'poisson-score')),
  },
  coordinationShareRange: { lo: 0.3, hi: 0.5 }, roleUnknownSessions: 12,
  coverage: {
    claude: { sessions: 10, withCost: 10, withTokens: 10, withRole: 8, withLink: 10, status: 'measured', reason: null },
    codex: { sessions: 6, withCost: 3, withTokens: 5, withRole: 6, withLink: 6, status: 'not measured', reason: 'x' },
    kimi: { sessions: 5, withCost: 0, withTokens: 0, withRole: 5, withLink: 5, status: 'not measured', reason: 'x' },
  },
  notStructured: { qaVerdict: 1000, escapedLink: 1000 },
}
const render = (lang: 'pt' | 'en', o: Observed | null = observed, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<MemoryRouter><BenchmarkContent lang={lang} observed={o} initialNumbers {...extra} /></MemoryRouter>)

describe('benchmark page — real figures, honest gaps', () => {
  const pt = render('pt'), en = render('en')

  test('durations and rates carry units and the locale: hours, days and per week, never raw milliseconds', () => {
    expect(pt).toContain('28,2 h')
    expect(en).toContain('28.2 h')
    expect(pt).toContain('4,2 d')                   // 100 h
    expect(pt).toContain('97,3 / semana')
    expect(en).toContain('97.3 / week')
    expect(pt).toContain('US$ 12,35')
    expect(en).toContain('$12.35')
    expect(pt).not.toContain('101396123')
  })

  test('every measured number shows its interval and its sample', () => {
    expect(pt).toContain('IC 95%: 25 h – 31 h')
    expect(en).toContain('95% CI: 25 h – 31 h')
    expect(pt).toContain('IC 95%: 91 / semana – 103 / semana')
    const sub = (html: string, k: string) => html.split(`data-testid="metric-${k}-sub"`)[1]!.split('</div>')[0]!
    expect(sub(pt, 'wallMedian')).toContain('IC 95%: 25 h – 31 h')
    expect(sub(en, 'costPerDelivery')).toContain('95% CI: $10.1 – $14.9')
    expect(sub(pt, 'throughputPerWeek')).toContain('IC 95%')
    expect(pt).toContain('700 de 1.000 medidas')
    expect(en).toContain('700 of 1,000 measured')
  })

  test('a figure nobody could measure is a dash with the reason, never a 0', () => {
    for (const k of ['qaFirstRoundRejection', 'qaRoundsMedian', 'escapedDefectRate']) {
      const card = pt.split(`data-testid="metric-${k}"`)[1]!.split('</li>')[0]!
      expect(card).toContain('data-measured="no"')
      expect(card).toContain('—')
      expect(card).toContain('sem medição')
      expect(card).not.toMatch(/>0%?<|>0 rodada/)
    }
    expect(pt).toContain('sem medição · 880 sem histórico de fases registrado')
    expect(pt).toContain('sem medição · 900 vínculo de defeito escapado não registrado')
    expect(en).toContain('not measured · 900 escape link not recorded')
  })

  test('coordination is shown as a range, never a point', () => {
    const card = pt.split('data-testid="metric-coordinationShare"')[1]!.split('</li>')[0]!
    expect(card).toContain('30% – 50%')
    expect(card).toContain('faixa, nunca um ponto')
  })

  test('the origin drawer is in plain language, names the real sources and the gaps, and no type names leak', () => {
    expect(pt).toContain('origem do número')
    expect(pt).toContain('histórico de fases das entregas (deliveries.json)')
    expect(pt).toContain('790 sem histórico de fases registrado')
    expect(en).toContain('where this number comes from')
    expect(en).toContain('delivery phase history (deliveries.json)')
    for (const html of [pt, en]) { expect(html).not.toContain('MetricItem'); expect(html).not.toContain('ObservedSession') }
    expect(pt).not.toContain('records measured')
    expect(pt).not.toContain('origin<')
  })

  test('coverage per harness: measured, partial and not measured are three different things, with the cause', () => {
    expect(pt).toContain('claude 10/10')
    expect(pt).toContain('codex 3/6 parcial')
    expect(pt).toContain('1 sem tokens guardados · 2 com modelo sem preço')
    expect(pt).toContain('kimi 0/5 sem medição')
    expect(en).toContain('kimi 0/5 not measured')
  })

  test('the scope line says what the delivery count is made of', () => {
    expect(pt).toContain('1.000 entregas consideradas: 900 publicadas e 100 em andamento; 120 têm histórico de fases')
    expect(pt).toContain('7 abandonadas só entram no custo desperdiçado')
    expect(en).toContain('1,000 deliveries considered')
  })

  test('loading and failing reads show no number at all', () => {
    const loading = render('pt', null)
    expect(loading).toContain('benchmark-loading')
    expect(loading).not.toContain('metric-costPerDelivery')
    const failed = render('en', null, { status: 'error' })
    expect(failed).toContain('benchmark-error')
    expect(failed).not.toContain('metric-costPerDelivery')
    expect(failed).not.toContain('benchmark-hero')
  })
})

// ---- the approved D3 structure ------------------------------------------------------------------------
const sc = (display: number, status: 'better' | 'worse' | 'tie', max: number, ratio: number) => ({
  max, points: display, lo: display - 3, hi: display + 3, displayPoints: display, ratio, status,
  metrics: [{ id: 'hidden_tests', type: 'quality', kind: 'rate-higher', candidate: 0.91, reference: 0.78, nCandidate: 30, nReference: 30, ratio, missing: null }], missing: [],
})
const verdictResult = (verdict: string, final: number | null, ratioPoint: number | null) => ({
  verdict, candidate: 'Líder + worker + QA', reference: 'Uma sessão', methodVersion: 'v1', size: 'M', delta: 0.1, seed: 1, resamples: 10000,
  ratio: { point: ratioPoint, lo: null, hi: null },
  sample: { tasks: 10, runsCandidate: 30, runsReference: 30, acceptedCandidate: 20, acceptedReference: 18, unmeasured: 0 },
  minimum: { tasks: 8, repsPerTask: 2, acceptedPerArm: 5 }, reason: 'Em custo por entrega aceita, o novo jeito saiu melhor.',
  secondary: { acceptRate: {}, wallPerAccepted: {}, defectsPerRun: {}, humanInterventions: {} }, coverage: {},
  score: final === null ? null : {
    methodVersion: 'v1', gateBlocked: false, rework: { A: 2.1, B: 1.4 },
    final: { value: final, lo: final - 4, hi: final + 4, display: final, nullReason: null },
    sensitivity: { result: 'depends_on_weights', rows: [{ name: 'pesos iguais', weights: {}, final: 48, lo: 44, hi: 52, verdict: 'tie' }] },
    types: { quality: sc(31, 'better', 40, 2.4), cost: sc(11, 'worse', 30, 0.4), time: sc(7, 'worse', 20, 0.4), reliability: { ...sc(0, 'tie', 10, 1), displayPoints: null, status: 'missing', metrics: [] } },
  },
})
const taskRow = (id: string, title: string, size: 'S' | 'M' | 'L', score: number | null, subtasks: unknown[] = []) => ({
  id, title, size, sessions: [1, 3], costUSD: [0.9, 2.1], wallMs: [22 * 60_000, 58 * 60_000], qaRounds: [0, 1], defects: [0, 0], accepted: [true, true], score, note: `nota de ${title}`, subtasks,
})
const exp = {
  id: 'exp-a', name: 'Uma sessão × líder + worker + QA', result: verdictResult('pays', 61, 0.62),
  tasks: [
    taskRow('t1', 'Corrigir parser', 'S', 30, [{ id: 's1', title: 'Parser: limites', costUSD: [0.4, 1], wallMs: [600000, 1200000], qaRounds: [0, 1], accepted: [true, true] }, { id: 's2', title: 'Parser: testes', costUSD: [0.5, 1.1], wallMs: [700000, 1300000], qaRounds: [0, 0], accepted: [true, true] }]),
    taskRow('t2', 'Filtro de período', 'M', 70), taskRow('t3', 'Passagem de líder', 'L', null),
  ],
  buckets: [{ label: '1 sessão', tasks: 86, costMedianUSD: 1.4, wallMedianMs: 38 * 60_000, escapedDefects: 0.5, firstTryRate: 0.71, notReopenedRate: 0.93 }],
}
const experimentsOf = (...r: unknown[]) => ({ experiments: r })

describe('the Benchmark screen follows the approved D3 layout', () => {
  test('every block is present, in the prototype order', () => {
    const html = render('pt', observed, experimentsOf(exp))
    const at = (s: string) => html.indexOf(s)
    const order = ['benchmark-how', 'benchmark-list', 'benchmark-hero', 'benchmark-parts', 'benchmark-tasks', 'benchmark-buckets', 'benchmark-coverage']
    for (const k of order) expect(at(k)).toBeGreaterThan(-1)
    expect([...order].sort((a, b) => at(a) - at(b))).toEqual(order)
    expect(html).toContain('Como funciona?')
    expect(html).toContain('Por tarefa')
    expect(html).toContain('Por número de sessões')
  })

  test('the list holds the observed history and each experiment; selecting one changes the whole page', () => {
    const history = render('pt', observed, experimentsOf(exp))
    expect(history.match(/data-testid="benchmark-item"/g)!.length).toBe(2)
    expect(history).toContain('data-bench="observed"')
    expect(history).toContain('data-tone="none"')
    expect(history).not.toContain('benchmark-task-row')
    const picked = render('pt', observed, { ...experimentsOf(exp), initialSelected: 'exp-a' })
    expect(picked).toContain('data-bench="exp-a"')
    expect(picked).toContain('data-tone="good"')
    expect(picked).toContain('>Compensou<')
    expect(picked).toContain('Compensou 38%')
    expect(picked).toContain('61')
    expect(picked).toContain('Depende do que você valoriza')
    expect(picked).toContain('Corrigir parser')
    expect(picked).toContain('1 sessão')
  })

  test('hero in the "none" state names what is missing and never draws a score or bar', () => {
    for (const [lang, word, miss] of [['pt', 'Não dá para provar ainda', 'Falta rodar um experimento controlado'], ['en', 'Cannot be proven yet', 'A controlled experiment still has to run']] as const) {
      const html = render(lang, observed)
      const hero = html.split('data-testid="benchmark-hero"')[1]!.split('</details>')[0]!
      expect(hero).toContain(word)
      expect(hero).toContain(miss)
      expect(hero).toContain('8 ')
      expect(hero).not.toContain('de 100')
      expect(hero).not.toContain('role="img"')
    }
    const insufficient = render('pt', observed, { ...experimentsOf({ ...exp, result: verdictResult('insufficient', null, null) }), initialSelected: 'exp-a' })
    expect(insufficient).toContain('data-tone="none"')
    expect(insufficient).toContain('10/8 tarefas')
  })

  test('"Partes": one tile per type, the real per-metric numbers inside their type, a type without data says so', () => {
    const html = render('pt', observed)
    for (const t of ['quality', 'cost', 'time', 'reliability', 'rework']) expect(html).toContain(`data-testid="part-${t}"`)
    expect(html).toContain('Retrabalho')
    const tile = (t: string) => html.split(`data-testid="part-${t}"`)[1]!.split('data-testid="part-')[0]!
    expect(tile('cost')).toContain('data-testid="metric-costPerDelivery"')
    expect(tile('cost')).toContain('US$ 12,35')
    expect(tile('time')).toContain('data-testid="metric-wallMedian"')
    expect(tile('quality')).toContain('data-testid="metric-escapedDefectRate"')
    expect(tile('quality')).not.toContain('metric-wallMedian')
    expect(tile('reliability')).toContain('sem dados suficientes')
    expect(tile('reliability')).toContain('data-state="none"')
    const closed = render('pt', observed, { initialNumbers: false })
    expect(closed).not.toContain('data-testid="metric-costPerDelivery"')
    expect(closed).toContain('Ver os números')
  })

  test('"Partes" of an experiment: points of the type, a status word, "sem dados" for an unmeasured type', () => {
    const html = render('pt', observed, { ...experimentsOf(exp), initialSelected: 'exp-a' })
    const tile = (t: string) => html.split(`data-testid="part-${t}"`)[1]!.split('data-testid="part-')[0]!
    expect(tile('quality')).toContain('78%')
    expect(tile('quality')).toContain('31 de 40 pontos')
    expect(tile('quality')).toContain('Compensou · 2,4× melhor')
    expect(tile('cost')).toContain('Não compensou')
    expect(tile('reliability')).toContain('sem dados suficientes')
    expect(tile('rework')).toContain('evidência, sem pontos')
  })

  test('"Por tarefa": one row per task, both sides in each column, the score and its word; open row shows note and subtasks', () => {
    const html = render('pt', observed, { ...experimentsOf(exp), initialSelected: 'exp-a', initialOpenTask: 't1' })
    expect(html.match(/data-testid="benchmark-task-row"/g)!.length).toBe(3)
    expect(html).toContain('1 → 3')
    expect(html).toContain('22 min → 58 min')
    expect(html).toContain('sim → sim')
    expect(html).toContain('Não compensou')
    expect(html).toContain('sem nota')
    expect(html).toContain('nota de Corrigir parser')
    expect(html.match(/data-testid="benchmark-subtask-row"/g)!.length).toBe(2)
    expect(html).toContain('Filtrar subtarefa')
    expect(html).toContain('Filtrar tarefa')
  })

  test('mobile: the task rows are labelled cards and the buckets stack, by the same @media rules as the prototype', () => {
    const html = render('pt', observed, { ...experimentsOf(exp), initialSelected: 'exp-a' })
    expect(html).toContain('@media (max-width:700px)')
    expect(html).toContain('td[data-l]:not(.bm-cp)::before')
    expect(html).toContain('data-l="Custo"')
    expect(html).toContain('data-l="Tarefas"')
    expect(html).toContain('.bm-top{grid-template-columns:minmax(0,1fr)}')
  })

  test('without data the task and bucket blocks say why, never an empty table or zeros', () => {
    const html = render('pt', observed)
    expect(html).toContain('benchmark-tasks-empty')
    expect(html).toContain('benchmark-buckets-empty')
    expect(html).not.toContain('<table')
  })

  test('coverage by harness is one quiet line, not a row of pills, and keeps the cause', () => {
    const html = render('pt', observed)
    const foot = html.split('data-testid="benchmark-coverage"')[1]!
    expect(foot).toContain('claude 10/10')
    expect(foot).toContain('codex 3/6 parcial')
    expect(foot).toContain('kimi 0/5 sem medição')
    expect(foot).toContain('1 sem tokens guardados · 2 com modelo sem preço')
    expect(render('en', observed)).toContain('kimi 0/5 not measured')
  })

  test('the "how it works" page carries the method version and date', () => {
    const page = (lang: string) => renderToStaticMarkup(<MemoryRouter><Routes><Route element={<Outlet context={{ lang }} />}><Route index element={<BenchmarkHowItWorksPage />} /></Route></Routes></MemoryRouter>)
    expect(page('pt')).toContain('Método v1, 08/11/2026')
    expect(page('pt')).toContain('Empate não quer dizer igual')
    expect(page('en')).toContain('Method v1, 2026-11-08')
  })
})

describe('r3: language, period and currency of the page', () => {
  const pt = render('pt'), en = render('en')

  test('F7: the formula in the drawer is in the page language, not the server English', () => {
    const withFormula: Observed = { ...observed, metrics: { ...observed.metrics, costPerDelivery: { ...observed.metrics.costPerDelivery, origin: { ...observed.metrics.costPerDelivery.origin, formula: 'mean over deliveries of Σ session cost (table×tokens); deliveries with an unpriced or absent session are left out' } } } }
    const html = render('pt', withFormula)
    expect(html).toContain('Fórmula (técnica)')
    expect(html).not.toContain('mean over deliveries')
    expect(html).toContain('média entre as entregas')
    expect(render('en', withFormula)).toContain('mean over deliveries')
  })

  test('F7: a space separates the scope line from "what does not count"', () => {
    expect(pt).toMatch(/fases\.(<!-- -->)? <details/)
    expect(en).toMatch(/phase history\.(<!-- -->)? <details/)
  })

  test('F15: cost follows the chosen currency and the rate', () => {
    expect(render('pt', observed, { currency: 'BRL', brlRate: 2 })).toContain('R$ 24,69')
    expect(render('en', observed, { currency: 'BRL', brlRate: 2 })).toContain('R$24.69')
    expect(render('pt', observed, { currency: 'BRL', brlRate: 2 })).not.toContain('US$ 12,35')
    expect(render('pt', observed, { currency: 'USD' })).toContain('US$ 12,35')
  })

  test('F15: the chosen period is stated on the page; an unbounded one says whole history', () => {
    const range = { fromMs: new Date(2026, 10, 6, 12).getTime(), toMs: new Date(2026, 10, 13, 12).getTime() }
    expect(render('pt', observed, { period: range })).toContain('06/11/2026')
    expect(render('en', observed, { period: range })).toContain('2026-11-06')
    expect(pt).toContain('Período: todo o histórico')
  })

  test('F15: the request carries the period; "all" carries none', () => {
    const f = { dateRange: '7d' as const, customStart: '', customEnd: '', projects: [], models: [] }
    expect(benchmarkQuery(f)).toMatch(/^\?from=\d+&to=\d+$/)
    expect(benchmarkQuery({ ...f, dateRange: 'all' as const })).toBe('')
  })

  test('F15: in plan basis the page says its cost is the API-equivalent figure', () => {
    expect(render('pt', observed, { costBasis: 'plan' })).toContain('equivalente à API')
    expect(render('en', observed, { costBasis: 'plan' })).toContain('API-equivalent')
    expect(pt).not.toContain('equivalente à API')
  })

  test('the incomplete-history gap has plain words in both languages', () => {
    const o: Observed = { ...observed, metrics: { ...observed.metrics, activeMedian: cov(null, 0, 900, null, [{ code: 'incomplete_history', count: 800 }]) } }
    expect(render('pt', o)).toContain('800 histórico incompleto')
    expect(render('en', o)).toContain('800 incomplete history')
  })
})

describe('benchmarkFormat', () => {
  test('units', () => {
    expect(fmtValue('wallMedian', 30 * 60_000, 'pt')).toBe('30 min')
    expect(fmtValue('wallMedian', 47 * H, 'en')).toBe('47 h')
    expect(fmtValue('wallMedian', 72 * H, 'en')).toBe('3 d')
    expect(fmtValue('qaRoundsMedian', 1, 'en')).toBe('1 round')
    expect(fmtValue('qaRoundsMedian', 1.5, 'pt')).toBe('1,5 rodadas')
    expect(fmtValue('qaFirstRoundRejection', 0.333, 'pt')).toBe('33%')
  })
  test('a null value is a dash', () => {
    expect(cardHeadline('qaRoundsMedian', observed, 'pt')).toEqual({ value: '—', measured: false })
  })
  test('harness state', () => {
    expect(harnessState(observed.coverage.claude!)).toBe('measured')
    expect(harnessState(observed.coverage.codex!)).toBe('partial')
    expect(harnessState(observed.coverage.kimi!)).toBe('none')
  })
})


describe('r4: period day, whole history, formulas in pt', () => {
  test('F20: the day is the LOCAL one — 23:59:59 local of the 13th is the 13th, not the 14th', () => {
    const prev = process.env.TZ
    process.env.TZ = 'America/Sao_Paulo'
    try {
      const end = new Date(2026, 10, 13, 23, 59, 59, 999).getTime()   // 13/11 local = 14/11 02:59 UTC
      expect(new Date(end).getUTCDate()).toBe(14)
      expect(dayLabel(end, 'pt')).toBe('13/11/2026')
      expect(dayLabel(end, 'en')).toBe('2026-11-13')
      const html = render('pt', observed, { period: { fromMs: new Date(2026, 10, 7).getTime(), toMs: end } })
      expect(html).toContain('07/11/2026 – 13/11/2026')
    } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev }
  })

  test('F21: with the whole history the scope line names the first day', () => {
    const since = new Date(2026, 5, 3, 12).getTime()
    const o = { ...observed, scope: { ...observed.scope, sinceMs: since } }
    expect(render('pt', o, { period: undefined })).toContain('todo o histórico, desde 03/06/2026')
    expect(render('en', o, { period: undefined })).toContain('whole history, since 2026-06-03')
    expect(render('pt', observed, { period: undefined })).toContain('todo o histórico')
  })

  test('F7: every one of the nine formulas is Portuguese in pt', () => {
    const real: Record<string, string> = {
      coordinationShare: 'a range, never a point: leader cost ÷ total cost (lower end) up to (leader + role-unknown) ÷ total (upper end); withheld when wider than 50 points',
      qaFirstRoundRejection: 'deliveries sent back by QA at least once ÷ deliveries whose phase history shows QA decided',
      qaRoundsMedian: 'median of (QA rejections + 1) over deliveries whose phase history shows QA decided',
      escapedDefectRate: 'published deliveries that a later fix, revert or reopen links back to ÷ published deliveries',
      wastedCostShare: 'cost of sessions filed under abandoned work ÷ total cost, priced sessions only',
      costPerDelivery: 'x', wallMedian: 'x', activeMedian: 'x', throughputPerWeek: 'x',
    }
    for (const k of METRIC_ORDER) {
      const t = formulaText(k, real[k]!, 'pt')
      expect(t).not.toBe(real[k]!)
      expect(t).not.toMatch(/\b(deliveries|median|cost of|published|sent back|range, never)\b/)
    }
    expect(formulaText('escapedDefectRate', 'escape links are not recorded', 'pt')).not.toContain('escape links')
    expect(formulaText('wastedCostShare', 'which work was abandoned is not recorded', 'pt')).not.toContain('abandoned')
  })

  test('F7: the open "what does not count" text is a block of its own, not run into the summary', () => {
    expect(render('pt')).toMatch(/<\/summary> ?<div[^>]*>Tarefas sem/)
  })
})

describe('per-piece history from the server fills the blocks with real rows', () => {
  const sub = (id: string, title: string, o: Record<string, unknown> = {}) => ({ id, title, status: 'done', size: 'M', sessions: 2, costUSD: 4.5, costPartial: false, wallMs: 2 * H, activeMs: null, qaRounds: 1, reworked: false, lines: 200, ...o })
  const history = {
    pieces: 3,
    tasks: [
      { id: 'T1', title: 'Parser de limites', status: 'done', size: 'L', pieces: 2, sessions: 5, costUSD: 9, costPartial: true, wallMs: 5 * H, activeMs: null, qaRounds: 4, reworkedPieces: 1, lines: 700, subtasks: [sub('a', 'Parser: testes'), sub('b', 'Parser: limites', { costPartial: true, qaRounds: 3, reworked: true })] },
      { id: 'T2', title: 'Aba do celular', status: 'in_review', size: null, pieces: 1, sessions: 1, costUSD: null, costPartial: false, wallMs: null, activeMs: null, qaRounds: null, reworkedPieces: null, lines: null, subtasks: [sub('c', 'Corte', { costUSD: null, size: null, wallMs: null, qaRounds: null, reworked: null })] },
    ],
    buckets: [
      { label: '1', pieces: 1, costMedianUSD: 1.5, nCost: 1, wallMedianMs: H, nWall: 1, reworkRate: null, nRework: 0 },
      { label: '2-3', pieces: 2, costMedianUSD: 4.5, nCost: 2, wallMedianMs: 2 * H, nWall: 2, reworkRate: 0.5, nRework: 2 },
      { label: '4-6', pieces: 0, costMedianUSD: null, nCost: 0, wallMedianMs: null, nWall: 0, reworkRate: null, nRework: 0 },
      { label: '7+', pieces: 0, costMedianUSD: null, nCost: 0, wallMedianMs: null, nWall: 0, reworkRate: null, nRework: 0 },
    ],
    coverage: { pieces: 3, withCost: 2, withWall: 2, withQa: 2, withSize: 2, withActive: 0, pctWithCost: 66.7, harnessesWithoutCost: ['codex'], harnessesPartialCost: [] },
  }
  const withHistory = { ...observed, history } as unknown as Observed

  test('Por tarefa lists every task with its measured figures, "—" for the unmeasured, and the cost caveat', () => {
    const html = render('pt', withHistory, { initialOpenTask: 'T1' })
    expect(html.match(/data-testid="benchmark-task-row"/g)!.length).toBe(2)
    expect(html).toContain('Parser de limites')
    expect(html).toContain('US$ 9*')
    expect(html).toContain('1/2')
    const second = html.split('data-task="T2"')[1]!.split('</tr>')[0]!
    expect(second).toContain('—')
    expect(second).not.toContain('US$ 0')
    expect(html.match(/data-testid="benchmark-subtask-row"/g)!.length).toBe(2)
    expect(html).toContain('Filtrar subtarefa')
    expect(html).toContain('custo em 2 de 3 peças')
    expect(html).not.toContain('benchmark-tasks-empty')
  })

  test('Por número de sessões shows the four buckets with median cost, time and rework rate, each with its n', () => {
    const html = render('pt', withHistory)
    const b = html.split('data-testid="benchmark-buckets"')[1]!
    for (const t of ['1 sessão', '2–3 sessões', '4–6 sessões', '7 ou mais']) expect(b).toContain(t)
    expect(b).toContain('US$ 4,5')
    expect(b).toContain('50%')
    expect(b).toContain('(n=2)')
  })

  test('the hero states what history shows, with no "paid off X%"', () => {
    const html = render('pt', withHistory)
    const hero = html.split('data-testid="benchmark-hero"')[1]!.split('</details>')[0]!
    expect(hero).toContain('Não dá para provar ainda')
    expect(hero).toContain('benchmark-facts')
    expect(hero).toContain('3 peças entregues')
    expect(hero).toContain('sem custo: codex')
    expect(hero).not.toMatch(/Compensou \d|Custou \d/)
    expect(render('en', withHistory)).toContain('3 delivered pieces')
  })
})

describe('Retrabalho tile from the observed history', () => {
  test('states the share of pieces with 2+ QA rounds and the median, flagged as read from labels', () => {
    const h = { pieces: 2, tasks: [{ id: 'T', title: 'T', status: 'done', size: 'M', pieces: 2, sessions: 4, costUSD: 1, costPartial: false, wallMs: H, activeMs: null, qaRounds: 4, reworkedPieces: 1, lines: 10,
      subtasks: [{ id: 'a', title: 'a', status: 'done', size: 'M', sessions: 2, costUSD: 1, costPartial: false, wallMs: H, activeMs: null, qaRounds: 1, reworked: false, lines: 5 }, { id: 'b', title: 'b', status: 'done', size: 'M', sessions: 2, costUSD: 1, costPartial: false, wallMs: H, activeMs: null, qaRounds: 3, reworked: true, lines: 5 }] }],
      buckets: [], coverage: { pieces: 2, withCost: 2, withWall: 2, withQa: 2, withSize: 2, withActive: 0, pctWithCost: 100, harnessesWithoutCost: [], harnessesPartialCost: [] } }
    const html = render('pt', { ...observed, history: h } as unknown as Observed)
    const tile = html.split('data-testid="part-rework"')[1]!.split('data-testid="benchmark-tasks"')[0]!
    expect(tile).toContain('Peças com 2+ rodadas de QA')
    expect(tile).toContain('50%')
    expect(tile).toContain('indicativo')
  })
})

describe('phase 3: the list holds observed comparisons, the hero is one sentence', () => {
  const mk = (id: string, o: Record<string, unknown>) => ({ id, title: id, status: 'done', size: 'M', sessions: 1, costUSD: 2, costPartial: false, wallMs: H, activeMs: null, qaRounds: 1, reworked: false, lines: 200, ...o })
  const subs = [...Array.from({ length: 4 }, (_, i) => mk(`o${i}`, {})), ...Array.from({ length: 4 }, (_, i) => mk(`m${i}`, { qaRounds: 3, reworked: true, costUSD: 5, wallMs: 4 * H, sessions: 5 }))]
  const history = { pieces: 8, tasks: [{ id: 'T', title: 'Tarefa real', status: 'done', size: 'M', pieces: 8, sessions: 24, costUSD: 28, costPartial: false, wallMs: H, activeMs: null, qaRounds: 16, reworkedPieces: 4, lines: 1600, subtasks: subs }],
    buckets: [{ label: '1', pieces: 4, costMedianUSD: 2, nCost: 4, wallMedianMs: H, nWall: 4, reworkRate: 0, nRework: 4 }, { label: '2-3', pieces: 0, costMedianUSD: null, nCost: 0, wallMedianMs: null, nWall: 0, reworkRate: null, nRework: 0 }, { label: '4-6', pieces: 4, costMedianUSD: 5, nCost: 4, wallMedianMs: 4 * H, nWall: 4, reworkRate: 1, nRework: 4 }, { label: '7+', pieces: 0, costMedianUSD: null, nCost: 0, wallMedianMs: null, nWall: 0, reworkRate: null, nRework: 0 }],
    coverage: { pieces: 8, withCost: 8, withWall: 8, withQa: 8, withSize: 8, withActive: 0, pctWithCost: 100, harnessesWithoutCost: [], harnessesPartialCost: [] } }
  const html = render('pt', { ...observed, history } as unknown as Observed)

  test('items are the comparisons, stamped "observado", with no score and no verdict word', () => {
    expect(html.match(/data-testid="benchmark-item"/g)!.length).toBe(2)
    expect(html.match(/data-testid="benchmark-seal"/g)!.length).toBe(2)
    expect(html).toContain('1 rodada de QA × 2+ rodadas')
    expect(html).toContain('1 sessão × 4+ sessões')
    const list = html.split('data-testid="benchmark-list"')[1]!.split('</nav>')[0]!
    expect(list).not.toMatch(/Compensou|Empate|>—<|role="img"/)
  })

  test('hero: short title, ONE sentence, a caption, no bar, and the reasons folded in a closed disclosure', () => {
    const hero = html.split('data-testid="benchmark-hero"')[1]!.split('data-testid="benchmark-parts"')[0]!
    expect(hero).toContain('Indício, não prova')
    expect(hero).toContain('custaram 2,5× mais e levaram 4× mais tempo')
    expect(hero).toContain('benchmark-caption')
    expect(hero).not.toContain('role="img"')
    expect(hero).not.toContain('de 100')
    expect(hero).toContain('Por que não é prova?')
    expect(hero).not.toMatch(/<details[^>]* open/)
    // the facts list lives INSIDE the disclosure, not beside the sentence
    expect(hero.indexOf('benchmark-facts')).toBeGreaterThan(hero.indexOf('Por que não é prova?'))
    expect(hero.match(/<p /g)!.length).toBeGreaterThanOrEqual(3)
  })

  test('Partes show the observed multiplier per type; "sem dados" only for quality and reliability, in one line each', () => {
    const tile = (t: string) => html.split(`data-testid="part-${t}"`)[1]!.split('data-testid="part-')[0]!
    expect(tile('cost')).toContain('2,5×')
    expect(tile('cost')).toContain('observado')
    expect(tile('time')).toContain('4×')
    expect(tile('rework')).toContain('5×')
    expect(tile('rework')).toContain('Sessões por peça')
    expect(tile('rework').split('data-testid="benchmark-tasks"')[0]).not.toContain('Retrabalho')
    expect(tile('quality')).toContain('>sem dados<')
    expect(tile('quality')).toContain('title="defeito escapado e peça reaberta não são registrados"')
    expect(tile('quality')).not.toContain('não são registrados</')
    expect(tile('reliability')).toContain('title="nenhuma tarefa foi repetida"')
  })

  test('Por tarefa and the buckets still show the real rows', () => {
    expect(html).toContain('Tarefa real')
    expect(html).toContain('1 sessão')
    expect(html).toContain('4–6 sessões')
  })

  test('selecting the second comparison changes the hero and the third tile', () => {
    const second = render('pt', { ...observed, history } as unknown as Observed, { initialSelected: 'sessions' })
    expect(second).toContain('retrabalho 100% × 0%')
    expect(second.split('data-testid="part-rework"')[1]!.split('data-testid="part-')[0]!).toContain('100% × 0%')
  })
})

describe('Por tarefa status uses the board\'s own labels', () => {
  const row = (status: string) => ({ id: status, title: `T ${status}`, status, size: 'M', pieces: 1, sessions: 1, costUSD: 1, costPartial: false, wallMs: H, activeMs: null, qaRounds: null, reworkedPieces: null, lines: 10, subtasks: [] })
  const h = { pieces: 3, tasks: [row('in_progress'), row('done'), row('in_review')], buckets: [], coverage: { pieces: 3, withCost: 3, withWall: 3, withQa: 0, withSize: 3, withActive: 0, pctWithCost: 100, harnessesWithoutCost: [], harnessesPartialCost: [] } }
  test('pt and en show the translated status, never the raw id', () => {
    const pt = render('pt', { ...observed, history: h } as unknown as Observed), en = render('en', { ...observed, history: h } as unknown as Observed)
    for (const id of ['in_progress', 'in_review']) for (const html of [pt, en]) expect(html.split('data-testid="benchmark-tasks"')[1]!.split('data-testid="benchmark-buckets"')[0]!).not.toMatch(new RegExp(`>${id}<`))
    expect(pt).toContain('>Em andamento<')
    expect(pt).toContain('>Concluído<')
    expect(pt).toContain('>Em revisão<')
    expect(en).toContain('>In progress<')
    expect(en).toContain('>Delivered<')
  })
})
