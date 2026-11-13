import { describe, expect, test } from 'bun:test'
import { buildComparisons, type HistorySubtaskRow, type Observed, type ObservedHistory } from '@agentistics/core/benchmark'
import { entriesOf, heroOf, historyTaskRows, observedFacts } from './benchmarkView'

const H = 3_600_000
const sub = (id: string, o: Partial<HistorySubtaskRow> = {}): HistorySubtaskRow => ({
  id, title: id, status: 'done', size: 'M', sessions: 2, costUSD: 4, costPartial: false, wallMs: 2 * H, activeMs: null, qaRounds: 1, reworked: false, lines: 200, ...o,
})
const history = (subs: HistorySubtaskRow[]): ObservedHistory => ({
  pieces: subs.length,
  tasks: [{ id: 'T', title: 'Task', status: 'done', size: 'M', pieces: subs.length, sessions: subs.length * 2, costUSD: 40, costPartial: false, wallMs: 5 * H, activeMs: null, qaRounds: 4, reworkedPieces: 3, lines: 800, subtasks: subs }],
  buckets: [], comparisons: buildComparisons(subs), coverage: { pieces: subs.length, withCost: subs.length, withWall: subs.length, withoutDuration: 0, withQa: subs.length, withSize: subs.length, withActive: 0, pctWithCost: 100, harnessesWithoutCost: ['codex'], harnessesPartialCost: [] },
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
import { comparisonsOf, moneyText, partsOf } from './benchmarkView'

describe('observed comparisons the history already allows', () => {
  const one = (i: number) => sub(`o${i}`, { qaRounds: 1, reworked: false, costUSD: 2, wallMs: H, sessions: 1 })
  const many = (i: number) => sub(`m${i}`, { qaRounds: 3, reworked: true, costUSD: 5, wallMs: 4 * H, sessions: 5 })
  const subs = [...Array.from({ length: 4 }, (_, i) => one(i)), ...Array.from({ length: 4 }, (_, i) => many(i))]
  const h = history(subs)

  test('two comparisons: 1 vs 2+ QA rounds, and 1 session vs 5+ sessions, size-matched, each with its n', () => {
    const c = comparisonsOf(h, 'pt')
    expect(c.map(x => x.id)).toEqual(['qa', 'sessions'])
    const qa = c[0]!
    expect(qa.name).toBe('1 rodada de QA × 2+ rodadas')
    expect([qa.cost!.ratio, qa.wall!.ratio, qa.cost!.sizes[0]!.medA, qa.cost!.sizes[0]!.medB, qa.nA, qa.nB]).toEqual([2.5, 4, 2, 5, 4, 4])
    expect(qa.third.kind).toBe('sessions')
    const ss = c[1]!
    expect(ss.name).toBe('1 sessão × 5+ sessões')
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
    expect(hero.say).toBe('Com 2+ rodadas de QA: 2,5× mais custo, 4× mais tempo, 5× mais sessões.')
    expect(hero.score).toBeNull()
    expect(hero.delta).toBeNull()
    expect(hero.caption).toBe('contra 1 rodada de QA · 4 × 4 peças · mesmo tamanho')
    expect(hero.disclosure).toBe('Por que não é prova?')
    expect(hero.why.join('\n')).toContain('experimento')
    expect(hero.facts!.length).toBeGreaterThan(0)
    const s = heroOf(entriesOf(obs(h), [], 'pt')[1]!, obs(h), 'pt', { currency: 'USD' })
    expect(s.say).toContain('retrabalho 0% → 100%')
    const en = heroOf(entriesOf(obs(h), [], 'en')[0]!, obs(h), 'en', { currency: 'USD' })
    expect(en.word).toBe('Evidence, not proof')
    expect(en.say).toBe('With 2+ QA rounds: 2.5× more cost, 4× more time, 5× more sessions.')
    expect(en.disclosure).toBe('Why is this not proof?')
  })

  test('parts: the observed multiplier per type with the "observado" label; no data only where there really is none', () => {
    const p = partsOf(entriesOf(obs(h), [], 'pt')[0]!, obs(h), 'pt', { currency: 'USD' })
    const by = Object.fromEntries(p.map(x => [x.type, x]))
    expect([by.cost!.big, by.time!.big, by.rework!.big]).toEqual(['2,5×', '4×', '5×'])
    expect(by.cost!.word).toBe('comparado dentro do mesmo tamanho')
    expect(by.cost!.state).toBe('history')
    expect(by.quality!.state).toBe('none')
    expect(by.reliability!.state).toBe('none')
    expect(by.quality!.word).toBe('sem dados')
    expect(by.quality!.hint).toContain('defeito escapado')
    expect(by.rework!.name).toBe('Sessões por peça')            // the tile says what the multiplier is, not "Retrabalho"
    expect(by.cost!.rows[0]!.value).toContain('→')
    const s = partsOf(entriesOf(obs(h), [], 'pt')[1]!, obs(h), 'pt', { currency: 'USD' })
    expect(s.find(x => x.type === 'rework')!.big).toBe('0% → 100%')
    expect(s.find(x => x.type === 'rework')!.name).toBe('Retrabalho')
  })

  test('H1: the tile shows the size-matched multiplier and the per-size pairs behind it, NEVER a pooled median pair', () => {
    // S: 2 → 4 (2×), L: 100 → 400 (4×). Pooled medians would read 2 → 400 or similar and divide to a different figure.
    const sm = (i: number) => sub(`s${i}`, { size: 'S', qaRounds: 1, costUSD: 2, wallMs: H, sessions: 1 })
    const sM = (i: number) => sub(`S${i}`, { size: 'S', qaRounds: 2, reworked: true, costUSD: 4, wallMs: H, sessions: 1 })
    const lm = (i: number) => sub(`l${i}`, { size: 'L', qaRounds: 1, costUSD: 100, wallMs: H, sessions: 1 })
    const lM = (i: number) => sub(`L${i}`, { size: 'L', qaRounds: 2, reworked: true, costUSD: 400, wallMs: H, sessions: 1 })
    const three = (f: (i: number) => HistorySubtaskRow) => [0, 1, 2].map(f)
    const hh = history([...three(sm), ...three(sM), ...three(lm), ...three(lM)])
    const cost = partsOf(entriesOf(obs(hh), [], 'pt')[0]!, obs(hh), 'pt', { currency: 'USD' }).find(x => x.type === 'cost')!
    expect(cost.big).toBe('2,8×')                                           // weighted geometric mean of 2× and 4× (equal n)
    expect(cost.rows.map(r => [r.label, r.value, r.sub])).toEqual([
      ['Custo mediano · P', 'US$ 2,00 → US$ 4,00', '2× · peças 3 × 3'],
      ['Custo mediano · G', 'US$ 100,00 → US$ 400,00', '4× · peças 3 × 3'],
    ])
    expect(cost.rows.some(r => r.value.includes('→') && !/(P|G)$/.test(r.label))).toBe(false)   // no row without its size
    expect(cost.word).toBe('comparado dentro do mesmo tamanho')
  })

  test('a pair that got CHEAPER shows its real ratio (0,5×), never an inverted "2×" beside a falling pair', () => {
    const a = (i: number) => sub(`a${i}`, { qaRounds: 1, costUSD: 4, wallMs: 4 * H, sessions: 1 })
    const b = (i: number) => sub(`b${i}`, { qaRounds: 2, reworked: true, costUSD: 2, wallMs: 2 * H, sessions: 1 })
    const hh = history([0, 1, 2].flatMap(i => [a(i), b(i)]))
    const cost = partsOf(entriesOf(obs(hh), [], 'pt')[0]!, obs(hh), 'pt', { currency: 'USD' }).find(x => x.type === 'cost')!
    expect(cost.big).toBe('0,5×')
    expect(cost.rows[0]).toMatchObject({ value: 'US$ 4,00 → US$ 2,00', sub: '0,5× · peças 3 × 3' })
    expect(heroOf(entriesOf(obs(hh), [], 'pt')[0]!, obs(hh), 'pt', { currency: 'USD' }).say).toContain('2× menos custo')
  })

  test('H2: pieces with no duration are named in the time tile, not hidden', () => {
    const hh = history(subs); hh.coverage.withoutDuration = 20
    const time = partsOf(entriesOf(obs(hh), [], 'pt')[0]!, obs(hh), 'pt', { currency: 'USD' }).find(x => x.type === 'time')!
    expect(time.rows.at(-1)).toMatchObject({ label: 'Sem duração', value: '20 peças' })
  })

  test('money keeps its two decimals in USD and BRL', () => {
    const q = partsOf(entriesOf(obs(h), [], 'pt')[0]!, obs(h), 'pt', { currency: 'BRL', brlRate: 5.6461 }).find(x => x.type === 'cost')!
    expect(q.rows[0]!.value).toBe('R$ 11,29 → R$ 28,23')
    expect(moneyText(3802.89 / 5.6461, 'pt', { currency: 'BRL', brlRate: 5.6461 })).toBe('R$ 3.802,89')
    expect(moneyText(3802.9 / 5.6461, 'pt', { currency: 'BRL', brlRate: 5.6461 })).toBe('R$ 3.802,90')
    expect(moneyText(19.8, 'en', { currency: 'USD' })).toBe('$19.80')
  })
})
