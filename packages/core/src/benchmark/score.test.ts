import { describe, expect, test } from 'bun:test'
import type { ScoreType } from './contract'
import { makeSamples } from './fixtures'
import {
  computeScore, countRatio, displayPoints, failureRatio, finalOf, geoMean, lowerBetterRatio, METHOD_VERSION, SCORE_TYPES, SENSITIVITY_WEIGHTS, share,
  statusOf, WEIGHTS_V1, type RunSample,
} from './score'
import { mulberry32 } from './stats'
import { verdict } from './verdict'

const A = 'A', B = 'B'
const r2 = (x: number) => Math.round(x * 100) / 100
const N = 60

// The worked examples of decisao-pesos.py (raw values from opcao-d2.html), reproduced with the same
// helpers: chance(ref, comp) = failure-rate ratio, contagem = count with 0.5, menor_melhor = ref/comp.
const chance = (refPct: number, compPct: number, higherBetter = true) => {
  const f = (p: number) => ((higherBetter ? 100 - p : p) / 100) * N
  return failureRatio(f(refPct), f(compPct))
}
const EXAMPLES: Record<string, Record<ScoreType, number[]>> = {
  a: { quality: [chance(78, 91), countRatio(0.6, 0.4), countRatio(4, 1)], cost: [lowerBetterRatio(1.25, 2.83)], time: [lowerBetterRatio(41, 112)], reliability: [chance(17, 10, false), lowerBetterRatio(31, 24)] },
  b: { quality: [chance(74, 93), countRatio(0.8, 0.4), countRatio(6, 1)], cost: [lowerBetterRatio(2.1, 2.48)], time: [lowerBetterRatio(62, 77)], reliability: [chance(22, 11, false), lowerBetterRatio(28, 22)] },
  c: { quality: [chance(84, 89), countRatio(0.5, 0.5), countRatio(2, 2)], cost: [lowerBetterRatio(1.1, 2.9)], time: [lowerBetterRatio(48, 43)], reliability: [chance(12, 11, false), lowerBetterRatio(26, 25)] },
}
// What the script prints under "Razão por tipo".
const PRINTED: Record<string, Record<ScoreType, number>> = {
  a: { quality: 2.08, cost: 0.44, time: 0.37, reliability: 1.48 },
  b: { quality: 2.85, cost: 0.85, time: 0.81, reliability: 1.6 },
  c: { quality: 1.13, cost: 0.38, time: 1.12, reliability: 1.07 },
}

describe('worked examples (decisao-pesos.py)', () => {
  for (const k of Object.keys(EXAMPLES)) {
    test(`example ${k}: type ratios match what the script prints`, () => {
      for (const t of SCORE_TYPES) expect(r2(geoMean(EXAMPLES[k]![t]))).toBe(PRINTED[k]![t])
    })
  }
  test('final = Σ max × r/(r+1), and the mirror sums to 100', () => {
    for (const k of Object.keys(EXAMPLES)) {
      const ratio = Object.fromEntries(SCORE_TYPES.map(t => [t, geoMean(EXAMPLES[k]![t])])) as Record<ScoreType, number>
      const inline = 40 * ratio.quality / (ratio.quality + 1) + 30 * ratio.cost / (ratio.cost + 1) + 20 * ratio.time / (ratio.time + 1) + 10 * ratio.reliability / (ratio.reliability + 1)
      const f = finalOf(ratio, WEIGHTS_V1)!
      expect(f).toBeCloseTo(inline, 10)
      const mirrored = Object.fromEntries(SCORE_TYPES.map(t => [t, 1 / ratio[t]])) as Record<ScoreType, number>
      expect(f + finalOf(mirrored, WEIGHTS_V1)!).toBeCloseTo(100, 10)
    }
    // a: one session beats leader+worker+QA on cost and time, loses on quality — the sum lands under 50
    const a = Object.fromEntries(SCORE_TYPES.map(t => [t, geoMean(EXAMPLES.a![t])])) as Record<ScoreType, number>
    expect(finalOf(a, WEIGHTS_V1)!).toBeCloseTo(40 * 2.0825 / 3.0825 + 30 * 0.4417 / 1.4417 + 20 * 0.3661 / 1.3661 + 10 * 1.4808 / 2.4808, 1)
  })
})

describe('ratios', () => {
  test('rates use the failure-rate ratio; 0.5 on both sides only when a count is zero', () => {
    expect(failureRatio(10, 5)).toBe(2)
    expect(failureRatio(0, 0)).toBe(1)
    expect(failureRatio(0, 3)).toBeCloseTo(0.5 / 3.5, 12)
    expect(failureRatio(3, 0)).toBeCloseTo(3.5 / 0.5, 12)
  })
  test('counts always add 0.5', () => { expect(countRatio(0, 0)).toBe(1); expect(countRatio(4, 1)).toBe(3) })
  test('lower-better handles zero and infinity without NaN surprises', () => {
    expect(lowerBetterRatio(Infinity, 2)).toBe(Infinity)
    expect(lowerBetterRatio(2, Infinity)).toBe(0)
    expect(lowerBetterRatio(Infinity, Infinity)).toBeNaN()
    expect(share(Infinity)).toBe(1); expect(share(0)).toBe(0); expect(share(1)).toBe(0.5)
  })
  test('type and metric tie band is 0.8..1.25', () => {
    expect([statusOf(1.25), statusOf(0.8), statusOf(1.26), statusOf(0.79), statusOf(null)]).toEqual(['tie', 'tie', 'better', 'worse', 'missing'])
  })
})

describe('display rounding', () => {
  test('integer points sum to the rounded final, each within 1 of its true value', () => {
    const rng = mulberry32(5)
    for (let i = 0; i < 300; i++) {
      const pts = { quality: rng() * 40, cost: rng() * 30, time: rng() * 20, reliability: rng() * 10 }
      const final = pts.quality + pts.cost + pts.time + pts.reliability
      const d = displayPoints(pts, final)
      expect(SCORE_TYPES.reduce((a, t) => a + d[t], 0)).toBe(Math.round(final))
      for (const t of SCORE_TYPES) expect(Math.abs(d[t] - pts[t])).toBeLessThan(1.0000001)
    }
  })
})

const base = (o: Partial<Parameters<typeof makeSamples>[0]> = {}) => makeSamples({ tasks: 10, reps: 3, taskSpread: 0.15, arms: [{ id: A, cost: 1.6, acceptRate: 0.9, noise: 0.1 }, { id: B, cost: 1, acceptRate: 0.4, noise: 0.1 }], ...o })
const score = (samples: RunSample[]) => computeScore({ samples, candidate: A, reference: B, seed: 1, resamples: 1000, delta: 0.1 })

describe('computeScore', () => {
  test('versioned, with raw values for both sides', () => {
    const s = score(base())
    expect(s.methodVersion).toBe(METHOD_VERSION)
    const m = s.types.cost.metrics[0]!
    expect(m.id).toBe('cost-per-accepted')
    expect(m.candidate).not.toBeNull(); expect(m.reference).not.toBeNull()
    expect(s.types.quality.metrics.find(x => x.id === 'accepted-rate')).toMatchObject({ nCandidate: 30, nReference: 30 })
    expect(SCORE_TYPES.map(t => s.types[t].max)).toEqual([40, 30, 20, 10])
    expect(SCORE_TYPES.reduce((a, t) => a + s.types[t].displayPoints!, 0)).toBe(s.final.display!)
  })

  test('a metric nobody recorded is reported missing — never 0, never dropped silently', () => {
    const s = score(base())
    expect(s.types.quality.missing).toEqual(['severe-defects-per-run'])
    const sev = s.types.quality.metrics.find(x => x.id === 'severe-defects-per-run')!
    expect(sev.ratio).toBeNull(); expect(sev.missing).toContain('severity not recorded')
    expect(s.types.quality.ratio).not.toBeNull()
  })

  test('a whole type that cannot be measured makes the final null, with the reason', () => {
    const samples = base().map(x => (x.armId === A && x.taskId === 't0' ? { ...x, costUSD: null } : x))
    const s = score(samples)
    expect(s.final.value).toBeNull()
    expect(s.types.cost.status).toBe('missing')
    expect(s.final.nullReason).toContain('cost')
    const v = verdict({ samples, candidate: A, reference: B, size: 'M', seed: 1, resamples: 500 })
    expect(v.verdict).toBe('insufficient')
  })

  test('zero defects on both sides is a measured tie, not a missing metric', () => {
    const samples = base().map(x => ({ ...x, defects: 0 }))
    const m = score(samples).types.quality.metrics.find(x => x.id === 'defects-per-run')!
    expect(m.ratio).toBe(1)
  })

  test('swapping the arms mirrors: finals add to 100, every type mirrors', () => {
    const rng = mulberry32(77)
    for (let i = 0; i < 60; i++) {
      const s = makeSamples({
        tasks: 6 + Math.floor(rng() * 6), reps: 2 + Math.floor(rng() * 2), seed: i + 3, taskSpread: rng() * 0.4,
        arms: [{ id: A, cost: 0.5 + rng() * 2, acceptRate: 0.2 + rng() * 0.8, noise: rng() * 0.5 }, { id: B, cost: 0.5 + rng() * 2, acceptRate: 0.2 + rng() * 0.8, noise: rng() * 0.5 }],
      })
      const f = score(s)
      const r = computeScore({ samples: s, candidate: B, reference: A, seed: 1, resamples: 1000, delta: 0.1 })
      if (f.final.value === null) continue
      expect(f.final.value + r.final.value!).toBeCloseTo(100, 8)
      expect(f.final.lo! + r.final.hi!).toBeCloseTo(100, 8)
      for (const t of SCORE_TYPES) if (f.types[t].ratio !== null) expect(f.types[t].ratio! * r.types[t].ratio!).toBeCloseTo(1, 8)
    }
}, 120_000)

  test('rework is evidence only: changing it moves no point', () => {
    const plain = score(base())
    const reworked = score(base().map(x => ({ ...x, reworkRounds: x.armId === A ? 5 : 1 })))
    expect(reworked.final.value).toBe(plain.final.value)
    expect(reworked.rework[A]).toBe(5)
    expect(plain.rework[A]).toBeNull()
  })

  test('sensitivity: the three weight sets are run and the result is firm or depends_on_weights', () => {
    const s = score(base())
    expect(s.sensitivity.rows.map(r => r.name)).toEqual(SENSITIVITY_WEIGHTS.map(w => w.name))
    for (const r of s.sensitivity.rows) expect(SCORE_TYPES.reduce((a, t) => a + r.weights[t], 0)).toBe(100)
    expect(s.sensitivity.result).toBe('firm')
    // Quality-high vs cost+time-high give different finals for the same ratios.
    const ratio = Object.fromEntries(SCORE_TYPES.map(t => [t, s.types[t].ratio!])) as Record<ScoreType, number>
    expect(finalOf(ratio, SENSITIVITY_WEIGHTS[1]!.weights)).not.toBeCloseTo(finalOf(ratio, SENSITIVITY_WEIGHTS[2]!.weights)!, 3)
  })

  test('sensitivity can say depends_on_weights', () => {
    // Quality clearly worse, cost and time clearly better: the weights decide who wins.
    const s = score(makeSamples({ tasks: 12, reps: 3, taskSpread: 0.05, arms: [{ id: A, cost: 0.35, acceptRate: 0.78, noise: 0.05, wallMs: 20_000 }, { id: B, cost: 1, acceptRate: 0.85, noise: 0.05, wallMs: 60_000 }] }))
    expect(s.sensitivity.result).toBe('depends_on_weights')
  })
})

describe('acceptance gate', () => {
  const cheapAndFast = () => makeSamples({ tasks: 12, reps: 3, taskSpread: 0.05, arms: [{ id: A, cost: 0.2, acceptRate: 0.7, noise: 0.05, wallMs: 12_000 }, { id: B, cost: 1, acceptRate: 0.8, noise: 0.05, wallMs: 60_000 }] })

  test('fewer accepted beyond the margin cannot get `pays`: it is a tie, and the reason says why', () => {
    const v = verdict({ samples: cheapAndFast(), candidate: A, reference: B, size: 'M', seed: 3, resamples: 1500 })
    expect(v.score!.final.lo!).toBeGreaterThan(52)
    expect(v.score!.gateBlocked).toBe(true)
    expect(v.verdict).toBe('tie')
    expect(v.reason).toContain('sem "Compensou"')
  })

  test('within the margin the same shape pays', () => {
    const s = makeSamples({ tasks: 12, reps: 3, taskSpread: 0.05, arms: [{ id: A, cost: 0.2, acceptRate: 0.78, noise: 0.05, wallMs: 12_000 }, { id: B, cost: 1, acceptRate: 0.8, noise: 0.05, wallMs: 60_000 }] })
    const v = verdict({ samples: s, candidate: A, reference: B, size: 'M', seed: 3, resamples: 1500 })
    expect(v.score!.gateBlocked).toBe(false)
    expect(v.verdict).toBe('pays')
  })

  test('symmetric: the swapped call is the same tie, with the gate fired on both sides', () => {
    const fwd = verdict({ samples: cheapAndFast(), candidate: A, reference: B, size: 'M', seed: 3, resamples: 1500 })
    const rev = verdict({ samples: cheapAndFast(), candidate: B, reference: A, size: 'M', seed: 3, resamples: 1500 })
    expect(rev.score!.final.hi!).toBeLessThan(48)
    expect(rev.score!.gateBlocked).toBe(true)
    expect(rev.score!.gateBlocked).toBe(fwd.score!.gateBlocked)
    expect(rev.verdict).toBe('tie')
    expect(rev.reason).toContain('sem "Compensou"')
    for (let k = 0; k < fwd.score!.sensitivity.rows.length; k++) {
      expect(rev.score!.sensitivity.rows[k]!.verdict).toBe(fwd.score!.sensitivity.rows[k]!.verdict)
    }
  })
})

describe('interval per type', () => {
  test('lo ≤ points ≤ hi per type, and swapping the arms mirrors them (max − hi, max − lo)', () => {
    const samples = base()
    const f = score(samples)
    const r = computeScore({ samples, candidate: B, reference: A, seed: 1, resamples: 1000, delta: 0.1 })
    for (const t of SCORE_TYPES) {
      const x = f.types[t], y = r.types[t]
      expect(x.lo).not.toBeNull(); expect(x.hi).not.toBeNull()
      expect(x.lo!).toBeLessThanOrEqual(x.hi!)
      expect(x.lo! + y.hi!).toBeCloseTo(x.max, 8)
      expect(x.hi! + y.lo!).toBeCloseTo(x.max, 8)
    }
  })
})
