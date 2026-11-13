/**
 * Seeded paired cluster bootstrap of the cost-per-accepted-delivery (CPA) ratio.
 * Pure and deterministic: the same samples + seed give the same interval, always.
 * Everything is computed on the LOG scale so that swapping the two arms negates the result exactly.
 */
import type { CpaSample } from './contract'

// `percentile` (linear interpolation) lives in deliveryMetrics.ts and is used by observed.ts; the
// bootstrap interval below is index-based because infinities cannot be interpolated.

/** mulberry32: small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface ClusterArm { cost: number; accepted: number }
interface Cluster { cand: ClusterArm; ref: ClusterArm }

/** Σcost / accepted. +Infinity when nothing was accepted (the cost was spent for no delivery). */
export const cpaOf = (a: ClusterArm): number => (a.accepted > 0 ? a.cost / a.accepted : Infinity)

/** ln(CPA_candidate / CPA_reference); NaN when both arms accepted nothing (no ratio exists). */
export function logRatio(cand: ClusterArm, ref: ClusterArm): number {
  const c = cpaOf(cand), r = cpaOf(ref)
  if (c === Infinity && r === Infinity) return NaN
  if (c === Infinity) return Infinity
  if (r === Infinity) return -Infinity
  if (c === 0 || r === 0) return NaN
  return Math.log(c) - Math.log(r)
}

export function clustersOf(samples: readonly CpaSample[], candidate: string, reference: string): Cluster[] {
  const byTask = new Map<string, Cluster>()
  for (const s of samples) {
    if (s.armId !== candidate && s.armId !== reference) continue
    let c = byTask.get(s.taskId)
    if (!c) { c = { cand: { cost: 0, accepted: 0 }, ref: { cost: 0, accepted: 0 } }; byTask.set(s.taskId, c) }
    const arm = s.armId === candidate ? c.cand : c.ref
    arm.cost += s.costUSD ?? 0
    if (s.accepted) arm.accepted += 1
  }
  // Sorted by task id so the result never depends on input order.
  return [...byTask.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(e => e[1])
}

export interface BootstrapResult {
  /** Natural log of the CPA ratio over the whole sample, and the 95% interval; NaN when undefined. */
  logPoint: number
  logLo: number
  logHi: number
  /** Resamples that produced a defined ratio. */
  used: number
}

export function bootstrapRatio(
  samples: readonly CpaSample[],
  candidate: string,
  reference: string,
  seed: number,
  resamples = 10_000,
): BootstrapResult {
  const clusters = clustersOf(samples, candidate, reference)
  const T = clusters.length
  const sum = (pick: (c: Cluster) => ClusterArm, idx: readonly number[]): ClusterArm => {
    const o = { cost: 0, accepted: 0 }
    for (const i of idx) { const a = pick(clusters[i]!); o.cost += a.cost; o.accepted += a.accepted }
    return o
  }
  const all = clusters.map((_, i) => i)
  const logPoint = T ? logRatio(sum(c => c.cand, all), sum(c => c.ref, all)) : NaN
  const rng = mulberry32(seed)
  const logs: number[] = []
  const idx = new Array<number>(T)
  for (let r = 0; r < resamples; r++) {
    for (let k = 0; k < T; k++) idx[k] = Math.floor(rng() * T)
    const v = logRatio(sum(c => c.cand, idx), sum(c => c.ref, idx))
    if (!Number.isNaN(v)) logs.push(v)
  }
  if (!logs.length) return { logPoint, logLo: NaN, logHi: NaN, used: 0 }
  logs.sort((a, b) => a - b)
  const k = logs.length - 1
  // Index-based (no interpolation: infinities cannot be interpolated). Symmetric under negation.
  return { logPoint, logLo: logs[Math.floor(0.025 * k)]!, logHi: logs[Math.ceil(0.975 * k)]!, used: logs.length }
}
