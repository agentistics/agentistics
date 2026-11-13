import React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Covered, Gap, Interval, Observed } from '@agentistics/core/benchmark'
import { BenchmarkContent } from './BenchmarkPage'
import { cardHeadline, fmtValue, harnessState } from '../lib/benchmarkFormat'

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
  renderToStaticMarkup(<MemoryRouter><BenchmarkContent lang={lang} observed={o} {...extra} /></MemoryRouter>)

describe('benchmark page — real figures, honest gaps', () => {
  const pt = render('pt'), en = render('en')

  test('the experiment region is always visible and says what is missing, in both languages', () => {
    for (const html of [pt, en]) expect(html).toContain('benchmark-experiment-empty')
    expect(pt).toContain('Sem dados suficientes — nenhum experimento rodado')
    expect(pt).toContain('8 tarefas')
    expect(en).toContain('Not enough data — no experiment has run')
  })

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
    expect(pt).toContain('700 de 1.000 medidas')
    expect(en).toContain('700 of 1,000 measured')
  })

  test('a figure nobody could measure is a dash with the reason, never a 0', () => {
    for (const k of ['qaFirstRoundRejection', 'qaRoundsMedian', 'escapedDefectRate']) {
      const card = pt.split(`data-testid="metric-${k}"`)[1]!.split('</article>')[0]!
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
    const card = pt.split('data-testid="metric-coordinationShare"')[1]!.split('</article>')[0]!
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
    expect(pt).toContain('claude: 10/10 com custo')
    expect(pt).toContain('codex: parcial 3/6 com custo')
    expect(pt).toContain('1 sem tokens guardados · 2 com modelo sem preço')
    expect(pt).toContain('kimi: sem medição (0/5)')
    expect(en).toContain('kimi: not measured (0/5)')
    expect(pt).not.toContain('kimi: 0/5 com custo')
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
    expect(failed).toContain('benchmark-experiment-empty')
  })

  test('a recorded experiment is counted, not drawn as a result', () => {
    expect(render('en', observed, { experiments: [{ id: 'x' }] })).toContain('1 experiment(s) recorded')
    expect(en).not.toContain('experiment(s) recorded')
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
