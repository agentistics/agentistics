import { describe, expect, test } from 'bun:test'
import { pointTone, WEIGHTS, firmness, nr, scoreOf, scoreTone, taskScore, vezes } from './benchmarkScore'

describe('the prototype\'s score maths (opcao-d3: nr, fin, pontos, tomTipo)', () => {
  test('nr maps a ratio to 0–100 through 100/(1+1/r): 1 is 50, and swapping the sides mirrors it exactly', () => {
    expect(nr(1)).toBe(50)
    expect(nr(2.45)).toBeCloseTo(71.0, 0)
    expect(nr(0.44)).toBeCloseTo(30.6, 0)
    for (const r of [0.2, 0.7, 1.3, 4]) expect(nr(r) + nr(1 / r)).toBeCloseTo(100, 10)
  })

  test('the weights are the decided ones: 40 / 30 / 20 / 10', () => {
    expect(WEIGHTS).toEqual({ quality: 40, cost: 30, time: 20, reliability: 10 })
  })

  test('the prototype\'s first benchmark: all four types measured → 49 de 100 and points that add up to it', () => {
    const s = scoreOf({ quality: 2.45, cost: 0.44, time: 0.37, reliability: 1.48 })
    expect(s.score).toBeCloseTo(48.9, 0)
    const pts = Object.values(s.types).map(t => t!.points)
    expect(pts.reduce((a, b) => a + b, 0)).toBe(Math.round(s.score!))
    expect(s.types.quality!.max).toBe(40)
    expect(s.types.cost!.max).toBe(30)
  })

  test('only what was measured counts: weights are renormalised over the measured types and the maxima add to 100', () => {
    const s = scoreOf({ quality: null, cost: 0.5, time: 2, reliability: undefined })
    expect(Object.keys(s.types).sort()).toEqual(['cost', 'time'])
    expect(s.types.cost!.max).toBe(60)
    expect(s.types.time!.max).toBe(40)
    expect(s.score).toBeCloseTo((30 * nr(0.5) + 20 * nr(2)) / 50, 10)
    expect(s.types.cost!.points + s.types.time!.points).toBe(Math.round(s.score!))
  })

  test('nothing measured is null, never 0; a non-positive or non-finite ratio is "not measured"', () => {
    expect(scoreOf({}).score).toBeNull()
    expect(scoreOf({ cost: 0, time: Number.NaN, quality: -1, reliability: Infinity })).toEqual({ score: null, types: {} })
  })

  test('rounded points always sum to the rounded score (largest remainder)', () => {
    for (const r of [[1.1, 0.9, 1.7, 0.3], [3, 3, 3, 3], [0.61, 1.9, 1.01, 0.55]]) {
      const s = scoreOf({ quality: r[0], cost: r[1], time: r[2], reliability: r[3] })
      expect(Object.values(s.types).reduce((a, t) => a + t!.points, 0)).toBe(Math.round(s.score!))
    }
  })

  test('tone: ≥ 55.55 pays, ≤ 44.45 does not, between is a tie', () => {
    expect(scoreTone(55.55)).toBe('good')
    expect(scoreTone(55.54)).toBe('tie')
    expect(scoreTone(44.45)).toBe('bad')
    expect(scoreTone(44.46)).toBe('tie')
  })

  test('pointTone (observed comparison, margin 0): above 52 pays, below 48 does not, 48 and 52 themselves tie', () => {
    for (const [n, tone] of [[47.9, 'bad'], [48, 'tie'], [50, 'tie'], [52, 'tie'], [52.1, 'good'], [54, 'good'], [0, 'bad'], [100, 'good']] as const) expect(pointTone(n)).toBe(tone)
    expect(scoreTone(54)).toBe('tie')   // the type band is untouched
  })

  test('vezes: "igual" under 1.03×, otherwise the multiplier and its direction', () => {
    expect(vezes(1.02, 'pt')).toBe('igual')
    expect(vezes(2.45, 'pt')).toBe('2,5× melhor')
    expect(vezes(0.5, 'pt')).toBe('2,0× pior')
    expect(vezes(0.5, 'en')).toBe('2.0× worse')
    expect(vezes(1, 'en')).toBe('equal')
  })

  test('a task\'s own score reads its cost and time ratios; one side missing is the other alone, none is null', () => {
    expect(taskScore({ cost: 1, time: 1 })).toBe(50)
    expect(taskScore({ cost: 2, time: null })).toBeCloseTo(nr(2), 10)
    expect(taskScore({ cost: null, time: null })).toBeNull()
  })

  test('firmness: names the alternative weights that would change the word, "firm" when none does', () => {
    expect(firmness({ cost: 1, time: 1 }).changes).toEqual([])
    const f = firmness({ quality: 3, cost: 0.2, time: 0.25, reliability: 1 })
    expect(f.changes.length).toBeGreaterThan(0)
    expect(f.changes.every(c => ['equal', 'quality', 'costTime'].includes(c.weights))).toBe(true)
  })
})
