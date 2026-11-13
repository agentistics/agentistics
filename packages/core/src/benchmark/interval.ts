/**
 * 95% intervals for the observed figures. Each is a statement about the sample behind the figure, not a
 * claim about the future: a proportion gets Wilson, a rate of events gets the Poisson score interval, a
 * median or a mean gets a seeded bootstrap (same input + seed = same interval, always).
 */
import type { Interval } from './contract'
import { mulberry32 } from './stats'

const Z = 1.959964
const SEED = 20261113
const RESAMPLES = 2000

/** Wilson score interval of k successes in n trials. Null for an empty sample. */
export function wilsonInterval(k: number, n: number): Interval | null {
  if (n <= 0) return null
  const p = k / n, z2 = Z * Z
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), level: 0.95, method: 'wilson' }
}

/** Poisson score interval of `k` events over `exposure` units (weeks, ...): bounds are events per unit. */
export function poissonScoreInterval(k: number, exposure: number): Interval | null {
  if (!(exposure > 0) || k < 0) return null
  const z2 = Z * Z
  const centre = k + z2 / 2
  const half = Z * Math.sqrt(k + z2 / 4)
  return { lo: Math.max(0, (centre - half) / exposure), hi: (centre + half) / exposure, level: 0.95, method: 'poisson-score' }
}

/** Percentile bootstrap of any statistic over `values`. Null when fewer than two values or the statistic is undefined. */
export function bootstrapInterval(
  values: readonly number[],
  stat: (sample: number[]) => number | null,
  seed = SEED,
  resamples = RESAMPLES,
): Interval | null {
  if (values.length < 2) return null
  const rand = mulberry32(seed)
  const out: number[] = []
  for (let r = 0; r < resamples; r++) {
    const sample = new Array<number>(values.length)
    for (let i = 0; i < values.length; i++) sample[i] = values[Math.floor(rand() * values.length)]!
    const s = stat(sample)
    if (s !== null && Number.isFinite(s)) out.push(s)
  }
  if (out.length < resamples / 2) return null
  out.sort((a, b) => a - b)
  const at = (q: number) => out[Math.min(out.length - 1, Math.max(0, Math.floor(q * out.length)))]!
  return { lo: at(0.025), hi: at(0.975), level: 0.95, method: 'bootstrap' }
}
