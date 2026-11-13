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
  const entry = entriesOf(obs(undefined), [], 'pt')[0]!

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
    const hero = heroOf(entriesOf(obs(undefined), [], 'en')[0]!, obs(history(subs)), 'en', { currency: 'USD' })
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

// ---- observed comparisons (phase 3) ---------------------------------------------------------------------
import { comparisonsOf, partsOf } from './benchmarkView'

describe('observed comparisons the history already allows', () => {
  const one = (i: number) => sub(`o${i}`, { qaRounds: 1, reworked: false, costUSD: 2, wallMs: H, sessions: 1 })
  const many = (i: number) => sub(`m${i}`, { qaRounds: 3, reworked: true, costUSD: 5, wallMs: 4 * H, sessions: 5 })
  const subs = [...Array.from({ length: 4 }, (_, i) => one(i)), ...Array.from({ length: 4 }, (_, i) => many(i))]
  const h = history(subs)

  test('two comparisons: 1 vs 2+ QA rounds, and 1 session vs 4+ sessions, size-matched, each with its n', () => {
    const c = comparisonsOf(h, 'pt')
    expect(c.map(x => x.id)).toEqual(['qa', 'sessions'])
    const qa = c[0]!
    expect(qa.name).toBe('1 rodada de QA × 2+ rodadas')
    expect([qa.cost!.ratio, qa.wall!.ratio, qa.cost!.medA, qa.cost!.medB, qa.nA, qa.nB]).toEqual([2.5, 4, 2, 5, 4, 4])
    expect(qa.third.kind).toBe('sessions')
    const ss = c[1]!
    expect(ss.name).toBe('1 sessão × 4+ sessões')
    expect(ss.third).toMatchObject({ kind: 'rework', rateA: 0, rateB: 1 })
  })

  test('a side with fewer than 3 pieces of a size is not compared; no comparison, no entry', () => {
    expect(comparisonsOf(history([one(0), one(1), many(0), many(1)]), 'pt')).toEqual([])
  })

  test('the list holds the comparisons, each stamped "observado" and without any score', () => {
    const es = entriesOf(obs(h), [], 'pt')
    expect(es.map(e => e.id)).toEqual(['qa', 'sessions'])
    expect(es.every(e => e.kind === 'comparison' && e.score === null && e.word === 'observado')).toBe(true)
    expect(entriesOf(obs(h), [], 'en')[0]!.word).toBe('observed')
    expect(entriesOf(obs(undefined), [], 'pt')[0]!.id).toBe('observed')       // an older server: the single history entry
  })

  test('hero: "Indício, não prova", ONE sentence in the prototype mould, a caption, the rest behind a disclosure', () => {
    const e = entriesOf(obs(h), [], 'pt')[0]!
    const hero = heroOf(e, obs(h), 'pt', { currency: 'USD' })
    expect(hero.word).toBe('Indício, não prova')
    expect(hero.say).toBe('Em comparação com as peças de 1 rodada de QA, as de 2+ rodadas custaram 2,5× mais e levaram 4× mais tempo; usaram 5× mais sessões.')
    expect(hero.score).toBeNull()
    expect(hero.delta).toBeNull()
    expect(hero.caption).toContain('observado')
    expect(hero.disclosure).toBe('Por que não é prova?')
    expect(hero.why.join('\n')).toContain('experimento')
    expect(hero.facts!.length).toBeGreaterThan(0)
    const s = heroOf(entriesOf(obs(h), [], 'pt')[1]!, obs(h), 'pt', { currency: 'USD' })
    expect(s.say).toContain('retrabalho 100% × 0%')
    const en = heroOf(entriesOf(obs(h), [], 'en')[0]!, obs(h), 'en', { currency: 'USD' })
    expect(en.word).toBe('Evidence, not proof')
    expect(en.say).toBe('Compared with pieces with 1 QA round, those with 2+ rounds cost 2.5× more and took 4× more time; used 5× more sessions.')
    expect(en.disclosure).toBe('Why is this not proof?')
  })

  test('parts: the observed multiplier per type with the "observado" label; no data only where there really is none', () => {
    const p = partsOf(entriesOf(obs(h), [], 'pt')[0]!, obs(h), 'pt', { currency: 'USD' })
    const by = Object.fromEntries(p.map(x => [x.type, x]))
    expect([by.cost!.big, by.time!.big, by.rework!.big]).toEqual(['2,5×', '4×', '5×'])
    expect(by.cost!.word).toBe('observado')
    expect(by.cost!.state).toBe('history')
    expect(by.quality!.state).toBe('none')
    expect(by.reliability!.state).toBe('none')
    expect(by.quality!.word).toBe('sem dados')
    expect(by.quality!.hint).toContain('defeito escapado')
    expect(by.rework!.name).toBe('Sessões por peça')            // the tile says what the multiplier is, not "Retrabalho"
    expect(by.cost!.rows[0]!.value).toContain('→')
    const s = partsOf(entriesOf(obs(h), [], 'pt')[1]!, obs(h), 'pt', { currency: 'USD' })
    expect(s.find(x => x.type === 'rework')!.big).toBe('100% × 0%')
    expect(s.find(x => x.type === 'rework')!.name).toBe('Retrabalho')
  })
})
