import { describe, expect, test } from 'bun:test'
import type { Verdict } from './contract'
import { makeSamples, relabel, type Recipe } from './fixtures'
import { mulberry32 } from './stats'
import { MIN_SAMPLE, verdict, type VerdictSample } from './verdict'

const A = 'A', B = 'B'
const run = (samples: VerdictSample[], candidate = A, reference = B, extra: object = {}) =>
  verdict({ samples, candidate, reference, size: 'M', seed: 42, resamples: 2000, ...extra })
const mirrorOf = (v: Verdict): Verdict => (v === 'pays' ? 'does_not_pay' : v === 'does_not_pay' ? 'pays' : v)
const recipe = (r: Partial<Recipe> & Pick<Recipe, 'arms'>): Recipe => ({ tasks: 10, reps: 3, taskSpread: 0.15, ...r })

describe('verdict — where the method can lose (spec §4)', () => {
  test('1 does not pay, clearly', () => {
    const s = makeSamples(recipe({ arms: [{ id: A, cost: 3, acceptRate: 0.85, noise: 0.1, wallMs: 180_000 }, { id: B, cost: 1, acceptRate: 0.8, noise: 0.1 }] }))
    const v = run(s)
    expect(v.verdict).toBe('does_not_pay')
    expect(v.ratio.point).toBeGreaterThan(2)
    expect(v.ratio.lo!).toBeGreaterThan(1.1)
    expect(v.score!.final.hi!).toBeLessThan(48)
    expect(v.reason).toContain('Não compensou')
    expect(run(s, B, A).verdict).toBe('pays')
  })

  test('2 pays', () => {
    const s = makeSamples(recipe({ arms: [{ id: A, cost: 1.6, acceptRate: 0.9, noise: 0.1 }, { id: B, cost: 1, acceptRate: 0.4, noise: 0.1 }] }))
    const v = run(s)
    expect(v.verdict).toBe('pays')
    expect(v.ratio.hi!).toBeLessThan(0.9)
    expect(v.score!.final.lo!).toBeGreaterThan(52)
    expect(v.reason).toContain('Compensou.')
  })

  test('3 tie', () => {
    const s = makeSamples(recipe({ tasks: 12, reps: 4, arms: [{ id: A, cost: 1, acceptRate: 0.75, noise: 0.02 }, { id: B, cost: 1, acceptRate: 0.75, noise: 0.02 }] }))
    expect(run(s).verdict).toBe('tie')
  })

  test('4 insufficient: too few tasks, and it says how many', () => {
    const s = makeSamples(recipe({ tasks: 5, arms: [{ id: A, cost: 2.4, acceptRate: 0.85 }, { id: B, cost: 1, acceptRate: 0.8 }] }))
    const v = run(s)
    expect(v.verdict).toBe('insufficient')
    expect(v.reason).toContain('Faltam 3 tarefas')
    expect(v.ratio).toEqual({ point: null, lo: null, hi: null })
  })

  test('5 interval crosses the score margin: a tie, never a verdict', () => {
    const s = makeSamples(recipe({ tasks: 9, reps: 2, taskSpread: 0, arms: [{ id: A, cost: 1, acceptRate: 0.6, noise: 0.9 }, { id: B, cost: 1.05, acceptRate: 0.7, noise: 0.9 }] }))
    const v = run(s)
    expect(v.verdict).toBe('tie')
    expect(v.reason).toContain('Empate: não dá para cravar')
    expect(v.score!.final.lo!).toBeLessThan(48)
    expect(v.score!.final.hi!).toBeGreaterThan(50)
  })

  test('6 insufficient: cost missing for 2 runs, no verdict from the covered rest', () => {
    const s = makeSamples(recipe({ unpriced: 2, arms: [{ id: A, cost: 2.4, acceptRate: 0.85 }, { id: B, cost: 1, acceptRate: 0.8 }] }))
    const v = run(s)
    expect(v.verdict).toBe('insufficient')
    expect(v.sample.unmeasured).toBe(2)
    expect(v.reason).toContain('Custo ausente em 2 execuções')
    expect(v.coverage.h!.withCost).toBeLessThan(v.coverage.h!.sessions)
  })

  test('7 zero accepted in one arm: pays with a finite bound; mirrored does not pay', () => {
    const s = makeSamples({ tasks: 10, reps: 2, taskSpread: 0.1, arms: [{ id: A, cost: 1.2, acceptRate: 0.6 }, { id: B, cost: 1, acceptRate: 0 }] })
    const v = run(s)
    expect(v.verdict).toBe('pays')
    expect(Number.isFinite(v.ratio.hi!)).toBe(true)
    expect(v.reason).toContain('B aceitou 0 de 20')
    expect(run(s, B, A).verdict).toBe('does_not_pay')
  })

  test('both arms accepting nothing is insufficient, not a verdict', () => {
    const s = makeSamples({ tasks: 10, reps: 2, arms: [{ id: A, cost: 1, acceptRate: 0 }, { id: B, cost: 1, acceptRate: 0 }] })
    expect(run(s).verdict).toBe('insufficient')
  })

  test('9 cap hit: insufficient, reason names the cap and the skipped cells', () => {
    const s = makeSamples(recipe({ arms: [{ id: A, cost: 2.4, acceptRate: 0.85 }, { id: B, cost: 1, acceptRate: 0.8 }] }))
    const v = run(s, A, B, { cap: { skippedCells: 12 } })
    expect(v.verdict).toBe('insufficient')
    expect(v.reason).toContain('limite de custo')
    expect(v.reason).toContain('12')
  })

  test('the reason carries the long-leader disclosure; "por entrega aceita" is the cost line only', () => {
    const s = makeSamples(recipe({ arms: [{ id: A, cost: 2.4, acceptRate: 0.85 }, { id: B, cost: 1, acceptRate: 0.8 }] }))
    for (const v of [run(s), run(s.slice(0, 6))]) expect(v.reason).toContain('Não inclui o contexto acumulado de um líder longo')
    const full = run(s)
    expect(full.reason.split('Custo:')[0]).not.toContain('por entrega aceita')
    expect(full.reason).toContain('Custo:')
    expect(full.reason).toContain('por entrega aceita')
  })

  test('both arms are required and must differ', () => {
    const s = makeSamples(recipe({ arms: [{ id: A, cost: 1, acceptRate: 1 }, { id: B, cost: 1, acceptRate: 1 }] }))
    expect(() => run(s, A, '')).toThrow()
    expect(() => run(s, A, A)).toThrow()
  })

  test('secondary measures sit beside the verdict', () => {
    const s = makeSamples(recipe({ arms: [{ id: A, cost: 2.4, acceptRate: 0.85 }, { id: B, cost: 1, acceptRate: 0.8 }] }))
    const v = run(s)
    expect(v.secondary.acceptRate[A]).toBeCloseTo(0.85, 1)
    expect(v.secondary.humanInterventions[A]).toBe(0)
    expect(v.size).toBe('M')
    expect(v.minimum).toEqual({ ...MIN_SAMPLE })
  })
})

describe('verdict — symmetry and invariance', () => {
  test('mirror symmetry on 200 random inputs', () => {
    const rng = mulberry32(2026)
    let gated = 0
    for (let i = 0; i < 200; i++) {
      const s = makeSamples({
        tasks: 6 + Math.floor(rng() * 8), reps: 2 + Math.floor(rng() * 3), seed: i + 1, taskSpread: rng() * 0.5,
        arms: [
          { id: A, cost: 0.5 + rng() * 2.5, acceptRate: rng(), noise: rng() * 0.6 },
          { id: B, cost: 0.5 + rng() * 2.5, acceptRate: rng(), noise: rng() * 0.6 },
        ],
      })
      const fwd = run(s, A, B), rev = run(s, B, A)
      if (fwd.score?.final.value != null && rev.score?.final.value != null) expect(fwd.score.final.value + rev.score.final.value).toBeCloseTo(100, 8)
      // The acceptance gate blocks only the candidate's `pays`, so it is the one case that is not a mirror.
      if (fwd.score?.gateBlocked || rev.score?.gateBlocked) { gated++; continue }
      expect(rev.verdict).toBe(mirrorOf(fwd.verdict))
      if (fwd.ratio.point !== null && Number.isFinite(fwd.ratio.point) && fwd.ratio.point > 0) expect(rev.ratio.point!).toBeCloseTo(1 / fwd.ratio.point, 8)
    }
}, 120_000)

  test('relabelling and reordering arms changes nothing', () => {
    const base = makeSamples(recipe({ arms: [{ id: A, cost: 1.6, acceptRate: 0.9, noise: 0.1 }, { id: B, cost: 1, acceptRate: 0.4, noise: 0.1 }] }))
    const v0 = run(base)
    const shuffled = relabel(base, { A: 'zz-blue', B: 'aa-red' }, 9)
    const v1 = run(shuffled, 'zz-blue', 'aa-red')
    expect(v1.verdict).toBe(v0.verdict)
    expect(v1.ratio).toEqual(v0.ratio)
    expect(v1.sample).toEqual(v0.sample)
  })

  test('same seed → identical result; the seed is stored', () => {
    const s = makeSamples(recipe({ arms: [{ id: A, cost: 1.3, acceptRate: 0.8, noise: 0.3 }, { id: B, cost: 1, acceptRate: 0.8, noise: 0.3 }] }))
    expect(run(s)).toEqual(run(s))
    expect(run(s).seed).toBe(42)
  })
})

// The review's calibration test: two EQUAL arms (true ratio 1) at the minimum sample, 1000 seeded
// experiments. If `pays` + `does_not_pay` exceed 10%, MIN_SAMPLE must be raised — not tuned away.
describe('calibration: false-verdict rate at the minimum sample', () => {
  test('equal arms are called pays/does_not_pay in ≤ 10% of experiments', () => {
    const rng = mulberry32(99)
    const n = 1000
    let wrong = 0, insufficient = 0, tie = 0
    for (let e = 0; e < n; e++) {
      const s = makeSamples({
        tasks: MIN_SAMPLE.tasks, reps: MIN_SAMPLE.repsPerTask, seed: Math.floor(rng() * 1e9), taskSpread: 0.5,
        arms: [{ id: A, cost: 1, acceptRate: 0.7, noise: 0.5 }, { id: B, cost: 1, acceptRate: 0.7, noise: 0.5 }],
      })
      // random acceptance pattern per arm, same true rate
      for (const x of s) x.accepted = rng() < 0.7
      const v = verdict({ samples: s, candidate: A, reference: B, size: 'M', seed: e + 1, resamples: 1000 })
      if (v.verdict === 'pays' || v.verdict === 'does_not_pay') wrong++
      else if (v.verdict === 'tie') tie++
      else insufficient++
    }
    console.log(`[calibration] equal arms, ${MIN_SAMPLE.tasks} tasks × ${MIN_SAMPLE.repsPerTask} reps, ${n} experiments: false verdict ${(wrong / n * 100).toFixed(1)}%, tie ${(tie / n * 100).toFixed(1)}%, insufficient ${(insufficient / n * 100).toFixed(1)}%`)
    expect(wrong / n).toBeLessThanOrEqual(0.1)
  }, 180_000)
})
