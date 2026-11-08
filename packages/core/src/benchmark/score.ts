/**
 * The score (method v1, DECISAO-PESOS.md). Pure: raw per-arm values in, points out.
 *
 * Four types worth Quality 40, Cost 30, Time 20, Reliability 10 (Σ 100). A type's points are
 * max × r/(r+1), where r is the geometric mean of that type's metric ratios and r > 1 means the
 * candidate is better. The final score is the SUM of points, so swapping the arms gives the exact
 * mirror (the two finals add up to 100). Rework is evidence, not part of the score.
 *
 * Rates compare FAILURE rates (never an odds ratio); when a failure count is zero, 0.5 is added to
 * both sides. A metric that cannot be measured is reported missing — never 0, never silently dropped;
 * a type with no measurable metric makes the final null.
 */
import type {
  CpaSample, ScoreMetricResult, ScoreResult, ScoreSensitivityRow, ScoreType, ScoreTypeResult, ScoreTypeStatus, Verdict,
} from './contract'
import { mulberry32 } from './stats'

export const METHOD_VERSION = 'v1' as const
export const SCORE_TYPES: readonly ScoreType[] = ['quality', 'cost', 'time', 'reliability']
export type Weights = Record<ScoreType, number>
export const WEIGHTS_V1: Weights = { quality: 40, cost: 30, time: 20, reliability: 10 }
export const SENSITIVITY_WEIGHTS: readonly { name: string; weights: Weights }[] = [
  { name: 'equal', weights: { quality: 25, cost: 25, time: 25, reliability: 25 } },
  { name: 'quality-high 55/20/15/10', weights: { quality: 55, cost: 20, time: 15, reliability: 10 } },
  { name: 'cost+time-high 25/40/25/10', weights: { quality: 25, cost: 40, time: 25, reliability: 10 } },
]
/** Final-score verdict thresholds: pays if the whole interval is above, does not pay if below. */
export const PAYS_ABOVE = 52
export const NOT_PAY_BELOW = 48
/** A type/metric ratio inside this band is a tie (no interval of its own). */
export const TIE_BAND = { lo: 0.8, hi: 1.25 } as const
/** Smoothing for the spread metric (coefficient of variation), so a perfectly steady arm does not divide by 0. */
const SPREAD_EPS = 0.01

/** A run as the score reads it. Optional fields absent/null = not recorded (the metric is then missing). */
export interface RunSample extends CpaSample {
  wallMs?: number | null
  /** Defects found by the evaluator + hidden tests. */
  defects?: number | null
  /** Defects at or above the blocking severity. */
  severeDefects?: number | null
  humanInterventions?: number | null
  /** QA rounds / discarded work: evidence only. */
  reworkRounds?: number | null
}

/** One task with the runs of both arms. Duplicated clusters (bootstrap) are allowed. */
export interface Cluster { cand: RunSample[]; ref: RunSample[] }

export function clusterRuns(samples: readonly RunSample[], candidate: string, reference: string): Cluster[] {
  const by = new Map<string, Cluster>()
  for (const s of samples) {
    if (s.armId !== candidate && s.armId !== reference) continue
    const c = by.get(s.taskId) ?? { cand: [], ref: [] }
    ;(s.armId === candidate ? c.cand : c.ref).push(s)
    by.set(s.taskId, c)
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(e => e[1])
}

// ---------------------------------------------------------------------------------------------- ratios

/** Failure-rate ratio (ref/candidate) from FAILURE counts; +0.5 on both sides when either is zero. */
export function failureRatio(refFailures: number, candFailures: number): number {
  const z = refFailures === 0 || candFailures === 0
  return (refFailures + (z ? 0.5 : 0)) / (candFailures + (z ? 0.5 : 0))
}
/** A count that may be zero, lower is better: +0.5 on both sides, always. */
export const countRatio = (ref: number, cand: number): number => (ref + 0.5) / (cand + 0.5)
/** A plain quantity, lower is better. ∞ (nothing accepted) is allowed; both ∞ has no ratio. */
export function lowerBetterRatio(ref: number, cand: number): number {
  if (ref === Infinity && cand === Infinity) return NaN
  if (ref === cand) return 1
  if (cand === 0) return Infinity
  if (ref === 0) return 0
  return ref / cand
}

const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0)
const mean = (v: readonly number[]) => (v.length ? sum(v) / v.length : NaN)

interface Side { runs: RunSample[]; tasks: RunSample[][] }
const sideOf = (clusters: readonly Cluster[], pick: (c: Cluster) => RunSample[]): Side => {
  const tasks = clusters.map(pick).filter(t => t.length > 0)
  return { runs: tasks.flat(), tasks }
}

/** Every value of `f` over the runs, or null if any run did not record it. */
function all(runs: readonly RunSample[], f: (r: RunSample) => number | null | undefined): number[] | null {
  const out: number[] = []
  for (const r of runs) { const v = f(r); if (typeof v !== 'number' || Number.isNaN(v)) return null; out.push(v) }
  return out
}

const acceptedOf = (s: Side) => s.runs.filter(r => r.accepted).length

interface MetricDef {
  id: string
  type: ScoreType
  kind: ScoreMetricResult['kind']
  /** value + n for one side, or a reason it is missing. */
  read: (s: Side) => { value: number; n: number | null } | string
}

const METRICS: readonly MetricDef[] = [
  { id: 'accepted-rate', type: 'quality', kind: 'rate-higher', read: s => s.runs.length ? { value: acceptedOf(s) / s.runs.length, n: s.runs.length } : 'no runs' },
  { id: 'defects-per-run', type: 'quality', kind: 'count', read: s => { const v = all(s.runs, r => r.defects); return v ? { value: mean(v), n: null } : 'defects not evaluated' } },
  { id: 'severe-defects-per-run', type: 'quality', kind: 'count', read: s => { const v = all(s.runs, r => r.severeDefects); return v ? { value: mean(v), n: null } : 'severity not recorded' } },
  {
    id: 'cost-per-accepted', type: 'cost', kind: 'lower-better',
    read: s => {
      const v = all(s.runs, r => r.costUSD)
      if (!v) return 'cost missing'
      const a = acceptedOf(s)
      return { value: a > 0 ? sum(v) / a : Infinity, n: null }
    },
  },
  {
    id: 'time-per-accepted', type: 'time', kind: 'lower-better',
    read: s => {
      const v = all(s.runs, r => r.wallMs)
      if (!v) return 'time not recorded'
      const a = acceptedOf(s)
      return { value: a > 0 ? sum(v) / a : Infinity, n: null }
    },
  },
  {
    // Share of tasks where the repetitions disagree (some accepted, some not): the arm is not repeatable.
    id: 'inconsistent-tasks', type: 'reliability', kind: 'rate-lower',
    read: s => {
      const reps = s.tasks.filter(t => t.length >= 2)
      if (!reps.length) return 'no repeated tasks'
      return { value: reps.filter(t => t.some(r => r.accepted) && t.some(r => !r.accepted)).length / reps.length, n: reps.length }
    },
  },
  {
    // Mean within-task coefficient of variation of the run cost.
    id: 'cost-spread', type: 'reliability', kind: 'lower-better',
    read: s => {
      const cvs: number[] = []
      for (const t of s.tasks) {
        if (t.length < 2) continue
        const v = all(t, r => r.costUSD)
        if (!v) return 'cost missing'
        const m = mean(v)
        if (m <= 0) return 'cost is zero'
        cvs.push(Math.sqrt(sum(v.map(x => (x - m) ** 2)) / v.length) / m)
      }
      return cvs.length ? { value: mean(cvs), n: null } : 'no repeated tasks'
    },
  },
]

function metricResult(def: MetricDef, cand: Side, ref: Side): ScoreMetricResult {
  const c = def.read(cand), r = def.read(ref)
  const base = { id: def.id, type: def.type, kind: def.kind }
  if (typeof c === 'string' || typeof r === 'string') {
    return {
      ...base, candidate: typeof c === 'string' ? null : c.value, reference: typeof r === 'string' ? null : r.value,
      nCandidate: typeof c === 'string' ? null : c.n, nReference: typeof r === 'string' ? null : r.n,
      ratio: null, missing: typeof c === 'string' ? `candidate: ${c}` : `reference: ${r as string}`,
    }
  }
  let ratio: number
  if (def.kind === 'rate-higher') ratio = failureRatio((1 - r.value) * (r.n ?? 0), (1 - c.value) * (c.n ?? 0))
  else if (def.kind === 'rate-lower') ratio = failureRatio(r.value * (r.n ?? 0), c.value * (c.n ?? 0))
  else if (def.kind === 'count') ratio = countRatio(r.value, c.value)
  else if (def.id === 'cost-spread') ratio = (r.value + SPREAD_EPS) / (c.value + SPREAD_EPS)
  else ratio = lowerBetterRatio(r.value, c.value)
  return {
    ...base, candidate: c.value, reference: r.value, nCandidate: c.n, nReference: r.n,
    ratio: Number.isNaN(ratio) ? null : ratio, missing: Number.isNaN(ratio) ? 'no ratio (nothing accepted on either side)' : null,
  }
}

/** Geometric mean of ratios (0 and ∞ allowed); NaN when they pull in opposite directions without a mean. */
export function geoMean(ratios: readonly number[]): number {
  if (!ratios.length) return NaN
  return Math.exp(sum(ratios.map(Math.log)) / ratios.length)
}
/** r/(r+1) — the share of a type's maximum the candidate earns. */
export const share = (r: number): number => (r === Infinity ? 1 : r === 0 ? 0 : r / (r + 1))

export const statusOf = (r: number | null): ScoreTypeStatus => (r === null ? 'missing' : r > TIE_BAND.hi ? 'better' : r < TIE_BAND.lo ? 'worse' : 'tie')

// ---------------------------------------------------------------------------------------------- score

export interface TypeRatios { metrics: ScoreMetricResult[]; ratio: Record<ScoreType, number | null> }

export function typeRatios(clusters: readonly Cluster[], exclude: readonly string[] = []): TypeRatios {
  const cand = sideOf(clusters, c => c.cand), ref = sideOf(clusters, c => c.ref)
  const metrics = METRICS.filter(d => !exclude.includes(d.id)).map(d => metricResult(d, cand, ref))
  const ratio = {} as Record<ScoreType, number | null>
  for (const t of SCORE_TYPES) {
    const g = geoMean(metrics.filter(m => m.type === t && m.ratio !== null).map(m => m.ratio!))
    ratio[t] = Number.isNaN(g) ? null : g
  }
  return { metrics, ratio }
}

/** Σ max × share(r); null when any type is unmeasured. */
export function finalOf(ratio: Record<ScoreType, number | null>, weights: Weights): number | null {
  let total = 0
  for (const t of SCORE_TYPES) { if (ratio[t] === null) return null; total += weights[t] * share(ratio[t]!) }
  return total
}

/** Integer points that sum to round(final): largest-remainder rounding. Internal values are not rounded. */
export function displayPoints(points: Record<ScoreType, number>, final: number): Record<ScoreType, number> {
  const target = Math.round(final)
  const floors = SCORE_TYPES.map(t => ({ t, f: Math.floor(points[t]), rem: points[t] - Math.floor(points[t]) }))
  let missing = target - floors.reduce((a, x) => a + x.f, 0)
  const order = [...floors].sort((a, b) => b.rem - a.rem || SCORE_TYPES.indexOf(a.t) - SCORE_TYPES.indexOf(b.t))
  const out = {} as Record<ScoreType, number>
  for (const x of floors) out[x.t] = x.f
  for (let i = 0; missing > 0 && i < order.length; i = (i + 1) % order.length, missing--) out[order[i]!.t]++
  return out
}

export function verdictOfScore(lo: number, hi: number): Verdict {
  if (lo > PAYS_ABOVE) return 'pays'
  if (hi < NOT_PAY_BELOW) return 'does_not_pay'
  return 'tie'
}

export interface ScoreInput {
  samples: readonly RunSample[]
  candidate: string
  reference: string
  seed: number
  resamples: number
  /** Margin for the acceptance gate (default 0.1). */
  delta: number
  /** Metric ids to leave out. Analysis only (which metric makes the noise); never set by a verdict. */
  excludeMetrics?: readonly string[]
}

/** Bootstrap the final score (and every sensitivity set) over tasks; one shared resample sequence. */
export function computeScore(input: ScoreInput): ScoreResult {
  const clusters = clusterRuns(input.samples, input.candidate, input.reference)
  const { metrics, ratio } = typeRatios(clusters, input.excludeMetrics)
  const finalPoint = finalOf(ratio, WEIGHTS_V1)

  const types = {} as Record<ScoreType, ScoreTypeResult>
  for (const t of SCORE_TYPES) {
    const ms = metrics.filter(m => m.type === t)
    types[t] = {
      max: WEIGHTS_V1[t], ratio: ratio[t], status: statusOf(ratio[t]),
      points: ratio[t] === null ? null : WEIGHTS_V1[t] * share(ratio[t]!), lo: null, hi: null, displayPoints: null,
      metrics: ms, missing: ms.filter(m => m.ratio === null).map(m => m.id),
    }
  }
  const unmeasured = SCORE_TYPES.filter(t => ratio[t] === null)
  let display: number | null = null
  if (finalPoint !== null) {
    display = Math.round(finalPoint)
    const dp = displayPoints({ quality: types.quality.points!, cost: types.cost.points!, time: types.time.points!, reliability: types.reliability.points! }, finalPoint)
    for (const t of SCORE_TYPES) types[t].displayPoints = dp[t]
  }

  // evidence: rework per arm
  const rework: Record<string, number | null> = {}
  for (const arm of [input.candidate, input.reference]) {
    const v = all(input.samples.filter(s => s.armId === arm), r => r.reworkRounds)
    rework[arm] = v && v.length ? mean(v) : null
  }

  const empty: ScoreResult = {
    methodVersion: METHOD_VERSION, types, rework, gateBlocked: false,
    final: { value: null, lo: null, hi: null, display: null, nullReason: null },
    sensitivity: { result: null, rows: [] },
  }
  if (finalPoint === null) {
    return { ...empty, final: { ...empty.final, nullReason: `Não foi possível medir: ${unmeasured.join(', ')}.` } }
  }

  // bootstrap: same index sequence as stats.ts (T draws per resample from the same seed)
  const sets = [{ name: 'method v1', weights: WEIGHTS_V1 }, ...SENSITIVITY_WEIGHTS]
  const draws: number[][] = sets.map(() => [])
  const typeDraws = {} as Record<ScoreType, number[]>
  for (const t of SCORE_TYPES) typeDraws[t] = []
  const rng = mulberry32(input.seed)
  const T = clusters.length
  const pick = new Array<Cluster>(T)
  for (let r = 0; r < input.resamples; r++) {
    for (let k = 0; k < T; k++) pick[k] = clusters[Math.floor(rng() * T)]!
    const rr = typeRatios(pick, input.excludeMetrics).ratio
    sets.forEach((s, i) => { const f = finalOf(rr, s.weights); if (f !== null) draws[i]!.push(f) })
    for (const t of SCORE_TYPES) if (rr[t] !== null) typeDraws[t].push(WEIGHTS_V1[t] * share(rr[t]!))
  }
  const interval = (v: number[]) => {
    if (!v.length) return null
    v.sort((a, b) => a - b)
    const k = v.length - 1
    return { lo: v[Math.floor(0.025 * k)]!, hi: v[Math.ceil(0.975 * k)]! }
  }

  for (const t of SCORE_TYPES) {
    const iv = interval(typeDraws[t])
    if (iv) { types[t].lo = iv.lo; types[t].hi = iv.hi }
  }

  // acceptance gate, symmetric: the side the score would declare the winner may not have fewer accepted
  // runs than the other beyond the margin. Candidate winning with fewer -> tie; reference winning with fewer -> tie.
  const cs = sideOf(clusters, c => c.cand), rs = sideOf(clusters, c => c.ref)
  const rateC = cs.runs.length ? acceptedOf(cs) / cs.runs.length : 0
  const rateR = rs.runs.length ? acceptedOf(rs) / rs.runs.length : 0
  const candFewer = rateC < rateR / (1 + input.delta)
  const refFewer = rateR < rateC / (1 + input.delta)
  const blocks = (v: Verdict) => (v === 'pays' && candFewer) || (v === 'does_not_pay' && refFewer)
  const decide = (lo: number, hi: number): Verdict => { const v = verdictOfScore(lo, hi); return blocks(v) ? 'tie' : v }

  const rows: ScoreSensitivityRow[] = []
  for (let i = 0; i < sets.length; i++) {
    const iv = interval(draws[i]!)
    const f = finalOf(ratio, sets[i]!.weights)
    rows.push({ name: sets[i]!.name, weights: sets[i]!.weights, final: f, lo: iv?.lo ?? null, hi: iv?.hi ?? null, verdict: iv ? decide(iv.lo, iv.hi) : null })
  }
  const main = rows[0]!
  const sens = rows.slice(1)
  const allKnown = rows.every(r => r.verdict !== null)
  const gateBlocked = main.lo !== null && main.hi !== null && blocks(verdictOfScore(main.lo, main.hi))
  return {
    ...empty, gateBlocked,
    final: { value: finalPoint, lo: main.lo, hi: main.hi, display, nullReason: main.lo === null ? 'Não foi possível calcular a margem.' : null },
    sensitivity: {
      result: allKnown ? (sens.every(r => r.verdict === main.verdict) ? 'firm' : 'depends_on_weights') : null,
      rows: sens,
    },
  }
}
