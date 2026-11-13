/**
 * Fabricated run sets for the verdict tests (spec §4): known truth, seeded, no IO.
 * Arms are named by id only ('A', 'B'); nothing here knows what an arm "is".
 */
import { mulberry32 } from './stats'
import type { VerdictSample } from './verdict'

export interface ArmRecipe {
  id: string
  /** Mean cost of one run. */
  cost: number
  /** Share of runs accepted, spread evenly (deterministic, no luck). */
  acceptRate: number
  /** Relative cost noise per run (uniform ±). */
  noise?: number
  /** Extra task-to-task multiplier spread (shared by both arms: tasks differ, arms do not). */
  wallMs?: number
}

export interface Recipe {
  tasks: number
  reps: number
  arms: [ArmRecipe, ArmRecipe]
  seed?: number
  /** Task difficulty spread: each task multiplies BOTH arms' cost by exp(±spread). */
  taskSpread?: number
  /** Number of runs (taken from the first arm's tail) whose cost is unmeasured. */
  unpriced?: number
}

export function makeSamples(r: Recipe): VerdictSample[] {
  const rng = mulberry32(r.seed ?? 7)
  const out: VerdictSample[] = []
  const factors = Array.from({ length: r.tasks }, () => Math.exp((rng() * 2 - 1) * (r.taskSpread ?? 0)))
  for (const arm of r.arms) {
    let n = 0
    for (let t = 0; t < r.tasks; t++) {
      for (let rep = 0; rep < r.reps; rep++) {
        n++
        const accepted = Math.floor(n * arm.acceptRate) > Math.floor((n - 1) * arm.acceptRate)
        const jitter = 1 + (rng() * 2 - 1) * (arm.noise ?? 0)
        out.push({
          taskId: `t${t}`, armId: arm.id, rep,
          costUSD: arm.cost * factors[t]! * jitter,
          accepted,
          wallMs: arm.wallMs ?? 60_000,
          defects: accepted ? 0 : 1,
          humanInterventions: 0,
          harnesses: { h: { sessions: 1, withCost: 1 } },
        })
      }
    }
  }
  for (let i = 0; i < (r.unpriced ?? 0); i++) {
    const idx = out.length / 2 - 1 - i
    out[idx] = { ...out[idx]!, costUSD: null, harnesses: { h: { sessions: 1, withCost: 0 } } }
  }
  return out
}

/** Relabel arms (ids) and shuffle order, keeping every number. */
export function relabel(samples: readonly VerdictSample[], map: Record<string, string>, seed = 1): VerdictSample[] {
  const rng = mulberry32(seed)
  const copy = samples.map(s => ({ ...s, armId: map[s.armId] ?? s.armId }))
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!] }
  return copy
}
