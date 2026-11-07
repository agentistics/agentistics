import { describe, expect, test } from 'bun:test'
import { buildMetricItems, buildMetrics, type MetricInput } from '@agentistics/core'
import { blockReasonLabel, deltaOf, emptyKind, fmtDur, fmtPct, leadSentence, stageParts } from './evolutionModel'

const H = 3_600_000
const T0 = Date.parse('2026-11-01T12:00:00Z')
const NOW = Date.parse('2026-11-07T15:00:00Z')
const shipped = (id: string, o: Partial<MetricInput> = {}): MetricInput => ({
  subtaskId: id, taskId: 'T', taskTitle: 'Task', title: id, priority: 'high', version: '2.201.0', phase: 'publicado', createdAtMs: T0, requestedAtMs: null, publishedAtMs: T0 + 24 * H,
  authorModel: 'm', qaModel: null, harness: 'claude', costUSD: null, tokens: null,
  history: [
    { from: 'fila', to: 'executando', atMs: T0 + 2 * H, detail: '' }, { from: 'executando', to: 'qa', atMs: T0 + 14 * H, detail: '' },
    { from: 'qa', to: 'publicado', atMs: T0 + 24 * H, detail: '' },
  ], ...o,
})
const reply = (inputs: MetricInput[], f = {}) => buildMetrics(buildMetricItems(inputs, NOW), f, NOW)

describe('formatting never turns "not measured" into a number', () => {
  test('durations', () => {
    expect(fmtDur(null, true)).toBe('—')
    expect(fmtDur(undefined, false)).toBe('—')
    expect(fmtDur(NaN, true)).toBe('—')
    expect(fmtDur(20 * 60_000, true)).toBe('20 min')
    expect(fmtDur(90 * 60_000, true)).toBe('1,5 h')
    expect(fmtDur(90 * 60_000, false)).toBe('1.5 h')
    expect(fmtDur(30 * H, true)).toBe('30 h')
    expect(fmtDur(72 * H, true)).toBe('3,0 d')
  })
  test('percentages', () => {
    expect(fmtPct(null, true)).toBe('—')
    expect(fmtPct(0, true)).toBe('0%')
    expect(fmtPct(0.333, false)).toBe('33%')
  })
})

describe('deltaOf', () => {
  test('lower is better flips good and bad; a flat change is flat', () => {
    expect(deltaOf(80, 100, true)).toMatchObject({ tone: 'good' })
    expect(deltaOf(120, 100, true)).toMatchObject({ tone: 'bad' })
    expect(deltaOf(120, 100, false)).toMatchObject({ tone: 'good' })
    expect(deltaOf(101, 100, true)).toMatchObject({ tone: 'flat' })
  })
  test('no change over nothing: either side unmeasured or a zero prior is null', () => {
    expect(deltaOf(null, 100, true)).toBeNull()
    expect(deltaOf(100, null, true)).toBeNull()
    expect(deltaOf(5, 0, true)).toBeNull()
  })
})

describe('the story built from the reply', () => {
  const cost = (usd: number) => `$${usd.toFixed(2)}`
  test('only measured clauses appear', () => {
    const s = leadSentence(reply([shipped('a'), shipped('b')]), true, cost)
    expect(s).toContain('2 de 2 entregas foram publicadas')
    expect(s).toContain('tempo mediano do pedido até a publicação é de 24 h')
    expect(s).not.toContain('ETA') // no prediction was ever recorded: the clause is absent, not "0%"
    expect(s).not.toContain('custou') // nothing priced
  })
  test('QA, ETA and cost appear when measured', () => {
    const base = shipped('a', { costUSD: 10, eta: { madeAtMs: T0, predictedAtMs: T0 + 24 * H, confidence: 'high' }, history: [
      { from: 'fila', to: 'executando', atMs: T0 + 2 * H, detail: '' }, { from: 'executando', to: 'qa', atMs: T0 + 14 * H, detail: '' },
      { from: 'qa', to: 'ajuste', atMs: T0 + 16 * H, detail: '' }, { from: 'ajuste', to: 'qa', atMs: T0 + 18 * H, detail: '' }, { from: 'qa', to: 'publicado', atMs: T0 + 24 * H, detail: '' },
    ] })
    const s = leadSentence(reply([base]), false, cost)
    expect(s).toContain('1 of 1 came back from QA (100%)')
    expect(s).toContain('ETA was right 100%')
    expect(s).toContain('cost $10.00 on average')
  })
  test('nothing published and nothing at all', () => {
    expect(leadSentence(reply([shipped('a', { phase: 'qa', publishedAtMs: null })]), true, cost)).toContain('nenhuma publicada ainda')
    expect(leadSentence(reply([]), false, cost)).toBe('No deliveries with these filters.')
  })
})

describe('empty states and chart parts', () => {
  test('no data at all differs from filters that match nothing', () => {
    expect(emptyKind(reply([]))).toBe('no-data')
    expect(emptyKind(reply([shipped('a')], { versions: ['9.9.9'] }))).toBe('no-match')
    expect(emptyKind(reply([shipped('a')]))).toBe('none')
  })
  test('stage parts keep the walking order and drop empty stages', () => {
    const parts = stageParts(reply([shipped('a')]).summary)
    expect(parts.map(p => p.stage)).toEqual(['queue', 'running', 'qa'])
    expect(parts.map(p => p.ms)).toEqual([2 * H, 12 * H, 10 * H])
  })
  test('a block reason has a sentence, an unrecorded one says so, an unknown id passes through', () => {
    expect(blockReasonLabel('limite', true)).toBe('Limite de uso da conta')
    expect(blockReasonLabel('unknown', false)).toBe('Reason not recorded')
    expect(blockReasonLabel('novo_motivo', true)).toBe('novo_motivo')
  })
})
