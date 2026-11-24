import { describe, expect, test } from 'bun:test'
import { buildComparisons, taskSides, type HistorySubtaskRow, type Observed, type ObservedHistory } from '@agentistics/core/benchmark'
import { entriesOf, heroOf, historyTaskRows, measuredBadge, comparisonScore } from './benchmarkView'
import { pointTone } from './benchmarkScore'

const H = 3_600_000
const sub = (id: string, o: Partial<HistorySubtaskRow> = {}): HistorySubtaskRow => ({
  id, title: id, status: 'done', size: 'M', sessions: 2, costUSD: 4, costPartial: false, wallMs: 2 * H, activeMs: null, qaRounds: 1, reworked: false, lines: 200, model: null, harness: null, accepted: null, ...o,
})
const history = (subs: HistorySubtaskRow[]): ObservedHistory => ({
  pieces: subs.length,
  tasks: [{ id: 'T', title: 'Task', status: 'done', size: 'M', pieces: subs.length, sessions: subs.length * 2, costUSD: 40, costPartial: false, wallMs: 5 * H, activeMs: null, qaRounds: 4, reworkedPieces: 3, lines: 800, subtasks: subs, overall: { pieces: subs.length, sessions: 2, costUSD: 4, costPartial: false, wallMs: 2 * H, qaRounds: 1 }, sides: { qa: taskSides(subs, 'qa'), sessions: taskSides(subs, 'sessions'), models: taskSides(subs, 'models'), harnesses: taskSides(subs, 'harnesses') } }],
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
    expect(hero.facts!.join('\n')).not.toMatch(/×|US\$/)
    expect(hero.facts!.join('\n')).toContain('codex')
    expect(hero.why.join('\n')).toContain('experimento')
    expect(JSON.stringify(hero)).not.toMatch(/Compensou \d|Custou \d/)
  })

  test('en: same facts in English', () => {
    const hero = heroOf(entriesOf(obs(undefined), [], 'en')[0]!, obs(history(subs)), 'en', { currency: 'USD' })
    expect(hero.word).toBe('Cannot be proven yet')
    expect(hero.facts!.join('\n')).toContain('8 delivered pieces')
    expect(hero.say).toContain('Hard pieces go to the heavy method')
  })

  test('without history (an older server) it says the per-piece figures are absent', () => {
    const hero = heroOf(entry, obs(undefined), 'pt', { currency: 'USD' })
    expect(hero.facts).toEqual([])
    expect(hero.why.join('\n')).toContain('histórico por peça')
  })
})

describe('an observed comparison is read with the prototype\'s point rule (margin 0), not the type band', () => {
  // cost 100 → 80 (ratio 1,25 → 55,6) and equal time (50): score 53,3 — above 52 pays, yet inside the 44,45–55,55 tie band.
  const subs = [...Array.from({ length: 4 }, (_, i) => sub(`o${i}`, { qaRounds: 1, costUSD: 100, wallMs: H, sessions: 1 })), ...Array.from({ length: 4 }, (_, i) => sub(`m${i}`, { qaRounds: 3, costUSD: 80, wallMs: H, sessions: 5 }))]
  const o = { history: history(subs) } as unknown as Observed
  const e = entriesOf(o, [], 'pt')[0]!
  test('the point rule says "pays" at 53,3 — but with only cost and time measured the card carries no verdict', () => {
    const sc = comparisonScore(comparisonsOf(o.history!, 'pt')[0]!).score!
    expect(sc).toBeCloseTo(53.3, 0)
    expect(pointTone(sc)).toBe('good')
    expect(e).toMatchObject({ score: null, tone: 'none', word: 'sem dados suficientes' })
    expect(heroOf(e, o, 'pt', { currency: 'USD' })).toMatchObject({ tone: 'none', word: 'Sem dados suficientes' })
    // the approved hero structure stays: the PARTIAL score is carried, honestly, without a verdict tone
    expect(heroOf(e, o, 'pt', { currency: 'USD' }).score).toBeCloseTo(sc, 6)
  })
})

describe('history rows for the table', () => {
  const h = history([sub('a', { title: 'Parser' }), sub('b', { title: 'Filtro', size: 'S', costUSD: null })])
  test('filter by size and by name, sorted with unmeasured last', () => {
    expect(historyTaskRows(h.tasks, { size: 'all', needle: 'tas', key: 'cost', dir: -1 }).length).toBe(1)
    expect(historyTaskRows(h.tasks, { size: 'S', needle: '', key: 'cost', dir: 1 }).length).toBe(0)
  })
})

describe('history rows sorted by "Compensou?" (the task\'s own score)', () => {
  const side = (a: number, b: number) => ({ key: 'qa', nA: 1, nB: 1, sessions: [null, null], costUSD: [a, b], wallMs: [null, null], qaRounds: [null, null], costPartial: [false, false], defects: [null, null], accepted: [null, null] })
  const task = (id: string, sides: unknown) => ({ id, title: id, status: 'done', size: 'M', pieces: 1, sessions: 1, costUSD: 1, costPartial: false, wallMs: null, activeMs: null, qaRounds: 0, reworkedPieces: 0, lines: 1, subtasks: [], sides: sides ? { qa: sides } : undefined })
  const rows = [task('good', side(10, 2)), task('none', undefined), task('bad', side(2, 10)), task('tie', side(5, 5))] as never
  const ids = (dir: 1 | -1) => historyTaskRows(rows, { size: 'all', needle: '', key: 'score', dir }).map(r => r.task.id)
  test('ascending reads worst to best and a task with no score goes last either way', () => {
    expect(ids(1)).toEqual(['bad', 'tie', 'good', 'none'])
    expect(ids(-1)).toEqual(['good', 'tie', 'bad', 'none'])
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

  test('the list holds the comparisons, each with the prototype\'s 0–100 score, tone and verdict word (cost and time measured)', () => {
    const es = entriesOf(obs(h), [], 'pt')
    expect(es.map(e => e.id)).toEqual(['qa', 'sessions', 'models', 'harnesses'])
    // 2.5× the cost and 4× the time on side B → ratios 0.4 and 0.25 → (30·nr(.4) + 20·nr(.25)) / 50
    expect(comparisonScore(comparisonsOf(h, 'pt')[0]!).score).toBeCloseTo((30 * (100 / 3.5) + 20 * 20) / 50, 5)
    // only 2 of the 4 dimensions are measured: no score, no verdict word
    expect(es[0]).toMatchObject({ kind: 'comparison', tone: 'none', score: null, word: 'sem dados suficientes' })
    expect(es.slice(2).every(e => e.kind === 'unmeasured' && e.score === null && e.word === 'sem medição' && !!e.reason)).toBe(true)
    expect(es.slice(2).every(e => e.kind === 'unmeasured' && e.score === null && e.word === 'sem medição' && !!e.reason)).toBe(true)
    expect(entriesOf(obs(h), [], 'en')[0]!.word).toBe('not enough data')
    expect(entriesOf(obs(undefined), [], 'pt')[0]!.id).toBe('observed')       // an older server: the single history entry
  })

  test('hero: the verdict word and N de 100, ONE sentence in the prototype mould, no caption, the rest behind a disclosure', () => {
    const e = entriesOf(obs(h), [], 'pt')[0]!
    const hero = heroOf(e, obs(h), 'pt', { currency: 'USD' })
    expect(hero).toMatchObject({ word: 'Sem dados suficientes', tone: 'none' })
    expect(hero.score).not.toBeNull()
    expect(hero.say).toBe('Com 2+ rodadas de QA: 2,5× mais custo, 4× mais tempo, 5× mais sessões.')
    expect(hero.delta).toBeNull()
    expect(hero).not.toHaveProperty('caption')
    expect(hero.word).not.toContain('Indício')
    expect(hero.disclosure).toBe('Por que esse resultado?')
    // the approved prototype's disclosure: why the verdict, the firmness sentence, then "Baseado em" — exactly three, in this order
    expect(hero.why).toHaveLength(2)
    expect(hero.why[0]).toContain('2 de 4 dimensões medidas')
    expect(hero.why[1]).toContain('Baseado em indício observado, não em experimento: contra 1 rodada de QA · 4 × 4 peças')
    expect(hero.why.join('\n')).not.toMatch(/experimento controlado|Qualidade final|Cobertura por harness|rótulo das sessões/)
    expect(hero.facts).toBeUndefined()
    // L1: the disclosure carries no ratio of its own beyond the piece counts
    expect(hero.why.join('\n')).not.toMatch(/rodadas de QA custam|US\$/)
    const s = heroOf(entriesOf(obs(h), [], 'pt')[1]!, obs(h), 'pt', { currency: 'USD' })
    expect(s.say).toContain('retrabalho 0% → 100%')
    const en = heroOf(entriesOf(obs(h), [], 'en')[0]!, obs(h), 'en', { currency: 'USD' })
    expect(en.word).toBe('Not enough data')
    expect(en).not.toHaveProperty('caption')
    expect(en.say).toBe('With 2+ QA rounds: 2.5× more cost, 4× more time, 5× more sessions.')
    expect(en.disclosure).toBe('Why this result?')
    expect(en.why).toHaveLength(2)
    expect(en.why[0]).toContain('2 of 4 dimensions measured')
    expect(en.why[1]).toMatch(/^Based on observed evidence, not an experiment: against /)
  })

  test('L1: the sessions comparison carries no QA lines in its disclosure', () => {
    const s = heroOf(entriesOf(obs(h), [], 'pt')[1]!, obs(h), 'pt', { currency: 'USD' })
    expect(JSON.stringify([s.why, s.facts])).not.toMatch(/rodadas de QA custam|primeira rodada/)
  })

  test('parts: the observed multiplier per type with the "observado" label; no data only where there really is none', () => {
    const p = partsOf(entriesOf(obs(h), [], 'pt')[0]!, obs(h), 'pt', { currency: 'USD' })
    const by = Object.fromEntries(p.map(x => [x.type, x]))
    expect([by.cost!.big, by.time!.big, by.rework!.big]).toEqual(['2,5×', '4×', '5×'])
    expect(by.cost!.word).toBe('Não compensou · 2,5× pior')
    expect(by.cost!.state).toBe('scored')
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
    expect(cost.word).toBe('Não compensou · 2,8× pior')
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

describe('BENCHMARK.LACUNAS: "firm" needs 3 of the 4 dimensions measured', () => {
  const subs = [
    ...Array.from({ length: 4 }, (_, i) => sub(`one${i}`, { sessions: 1, costUSD: 2, wallMs: null })),
    ...Array.from({ length: 4 }, (_, i) => sub(`many${i}`, { sessions: 6, costUSD: 5, wallMs: null })),
  ]
  const o = obs(history(subs))
  const sessionsEntry = () => entriesOf(o, [], 'pt').find(e => e.id === 'sessions')!
  test('with only cost measured the verdict is "sem dados suficientes" and the badge says "só custo medido", never "Resultado firme"', () => {
    const e = sessionsEntry()
    expect(e.score).toBeNull(); expect(e.word).toBe('sem dados suficientes')
    const hero = heroOf(e, o, 'pt', { currency: 'USD' })
    expect(hero.word).toBe('Sem dados suficientes'); expect(hero.score).not.toBeNull(); expect(hero.tone).toBe('none')
    expect(hero.firm).toEqual({ ok: false, text: 'Só custo medido' })
    expect(JSON.stringify(hero)).not.toContain('Resultado firme')
    expect(hero.why.join('\n')).toContain('1 de 4 dimensões medidas')
  })
  test('cost and time are 2 of 4: still not enough, and the badge names both', () => {
    const both = obs(history([...Array.from({ length: 4 }, (_, i) => sub(`a${i}`, { sessions: 1, costUSD: 2, wallMs: H })), ...Array.from({ length: 4 }, (_, i) => sub(`b${i}`, { sessions: 6, costUSD: 5, wallMs: 3 * H }))]))
    const c = comparisonsOf(both.history!, 'pt').find(x => x.id === 'sessions')!
    expect(measuredBadge(c, 'pt')).toBe('Só custo e tempo medidos')
    expect(heroOf(entriesOf(both, [], 'pt').find(e => e.id === 'sessions')!, both, 'pt', { currency: 'USD' }).word).toBe('Sem dados suficientes')
  })
})

describe('BENCHMARK.LACUNAS: Sonnet × Opus and Entre harnesses are computed when the pieces allow it', () => {
  const mk = (n: number, o: Partial<HistorySubtaskRow>) => Array.from({ length: n }, (_, i) => sub(`${o.model ?? o.harness}${i}`, o))
  test('with 3 + 3 pieces the model comparison is a card of its own, not a "sem medição" slot', () => {
    const e = entriesOf(obs(history([...mk(3, { model: 'sonnet', costUSD: 2 }), ...mk(3, { model: 'opus', costUSD: 6 })])), [], 'pt')
    expect(e.find(x => x.id === 'models')!.kind).toBe('comparison')
  })
  test('with too few pieces the slot stays, and says how many each side has and the minimum', () => {
    const qaPair = [...mk(3, { qaRounds: 1, costUSD: 2 }), ...mk(3, { qaRounds: 3, costUSD: 5 })].map((x, i) => ({ ...x, id: `q${i}` }))
    const e = entriesOf(obs(history([...qaPair, ...mk(2, { model: 'sonnet' }), ...mk(5, { model: 'opus' })])), [], 'pt')
    const m = e.find(x => x.id === 'models')!
    expect(m.kind).toBe('unmeasured'); expect(m.reason).toContain('Sonnet 2 × Opus 5'); expect(m.reason).toContain('mínimo 3')
  })
})
