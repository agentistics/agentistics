import { describe, expect, test } from 'bun:test'
import type { HistorySubtaskRow, Observed, ObservedHistory } from '@agentistics/core/benchmark'
import { entriesOf, heroOf, historyTaskRows, observedFacts } from './benchmarkView'

const H = 3_600_000
const sub = (id: string, o: Partial<HistorySubtaskRow> = {}): HistorySubtaskRow => ({
  id, title: id, status: 'done', size: 'M', sessions: 2, costUSD: 4, costPartial: false, wallMs: 2 * H, activeMs: null, qaRounds: 1, reworked: false, lines: 200, ...o,
})
const history = (subs: HistorySubtaskRow[]): ObservedHistory => ({
  pieces: subs.length,
  tasks: [{ id: 'T', title: 'Task', status: 'done', size: 'M', pieces: subs.length, sessions: subs.length * 2, costUSD: 40, costPartial: false, wallMs: 5 * H, activeMs: null, qaRounds: 4, reworkedPieces: 3, lines: 800, subtasks: subs }],
  buckets: [], coverage: { pieces: subs.length, withCost: subs.length, withWall: subs.length, withQa: subs.length, withSize: subs.length, withActive: 0, pctWithCost: 100, harnessesWithoutCost: ['codex'], harnessesPartialCost: [] },
})
const obs = (h: ObservedHistory | undefined): Observed => ({ deliveries: 5, metrics: { qaFirstRoundRejection: { value: 0.365, n: 192 } }, coverage: {}, history: h }) as unknown as Observed

describe('the observed hero — what ANALISE.md lets us say, never a "paid off X%"', () => {
  const subs = [
    ...Array.from({ length: 4 }, (_, i) => sub(`one${i}`, { qaRounds: 1, costUSD: 2, wallMs: H })),
    ...Array.from({ length: 4 }, (_, i) => sub(`many${i}`, { qaRounds: 3, reworked: true, costUSD: 5, wallMs: 4 * H })),
  ]
  const entry = entriesOf(obs(history(subs)), [], 'pt')[0]!

  test('pt: says it cannot be proven yet, lists what is seen and what is missing for a verdict', () => {
    const hero = heroOf(entry, obs(history(subs)), 'pt', { currency: 'USD' })
    expect(hero.tone).toBe('none')
    expect(hero.word).toBe('Não dá para provar ainda')
    expect(hero.delta).toBeNull()
    expect(hero.score).toBeNull()
    expect(hero.say).toContain('Peças difíceis vão para o método pesado')
    expect(hero.facts!.join('\n')).toContain('8 peças entregues')
    expect(hero.facts!.join('\n')).toContain('M US$ 3,5')                 // median of 4×2 and 4×5
    expect(hero.facts!.join('\n')).toContain('2,5×')                       // 5 / 2 cost, with 2+ QA rounds against 1
    expect(hero.facts!.join('\n')).toContain('36,5%')
    expect(hero.facts!.join('\n')).toContain('codex')
    expect(hero.why.join('\n')).toContain('experimento')
    expect(JSON.stringify(hero)).not.toMatch(/Compensou \d|Custou \d/)
  })

  test('en: same facts in English', () => {
    const hero = heroOf(entriesOf(obs(history(subs)), [], 'en')[0]!, obs(history(subs)), 'en', { currency: 'USD' })
    expect(hero.word).toBe('Cannot be proven yet')
    expect(hero.facts!.join('\n')).toContain('8 delivered pieces')
    expect(hero.facts!.join('\n')).toContain('$3.5')
    expect(hero.say).toContain('Hard pieces go to the heavy method')
  })

  test('a comparison needs enough pieces on both sides, otherwise it is not made', () => {
    const f = observedFacts(history([sub('a', { qaRounds: 1 }), sub('b', { qaRounds: 3 })]), obs(undefined), 'pt', { currency: 'USD' })
    expect(f.join('\n')).not.toContain('rodadas de QA custam')
  })

  test('without history (an older server) it says the per-piece figures are absent', () => {
    const hero = heroOf(entry, obs(undefined), 'pt', { currency: 'USD' })
    expect(hero.facts).toEqual([])
    expect(hero.why.join('\n')).toContain('histórico por peça')
  })
})

describe('history rows for the table', () => {
  const h = history([sub('a', { title: 'Parser' }), sub('b', { title: 'Filtro', size: 'S', costUSD: null })])
  test('filter by size and by name, sorted with unmeasured last', () => {
    expect(historyTaskRows(h.tasks, { size: 'all', needle: 'tas', key: 'cost', dir: -1 }).length).toBe(1)
    expect(historyTaskRows(h.tasks, { size: 'S', needle: '', key: 'cost', dir: 1 }).length).toBe(0)
  })
})
