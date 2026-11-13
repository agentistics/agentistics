/**
 * Benchmark data contract (BENCHMARK-SPEC §3 + the leader's review). Types only: every other module
 * under `core/benchmark/` and every shell (web, HTTP, MCP, CLI) imports from here.
 *
 * Two sources never mix in a verdict: `Observed` (history, biased, NO verdict by type) and the
 * controlled experiment (`Run[]` → `VerdictResult`, the only place a verdict exists).
 * A figure that could not be measured is `null`, never 0.
 */

export type Verdict = 'pays' | 'does_not_pay' | 'tie' | 'insufficient'
export type Severity = 'P0' | 'P1' | 'P2' | 'P3'
export type SessionRole = 'single' | 'leader' | 'worker' | 'qa' | 'evaluator' | 'other' | 'unknown'
/** Task size bucket. `L` = work that really exceeds one session's context window. A verdict is per bucket. */
export type SizeBucket = 'S' | 'M' | 'L'

export interface Priced {
  costUSD: number | null
  missing?: 'price' | 'tokens'
  basis: 'table×tokens'
  /** Price-table version/date. */
  priceTable: string
}

/** A 95% interval of the figure's own sample (never a forecast). */
export interface Interval {
  lo: number
  hi: number
  level: 0.95
  method: 'wilson' | 'poisson-score' | 'bootstrap' | 'range'
}

/** Why part of a figure could not be measured. Language-neutral: every surface words it itself. */
export type GapCode =
  | 'no_phase_history' | 'incomplete_history' | 'no_active_stage' | 'role_range_too_wide' | 'no_qa_stage' | 'not_published' | 'no_price' | 'no_tokens'
  | 'no_sessions' | 'waste_not_tracked' | 'escape_links_not_recorded' | 'role_unknown'
export interface Gap { code: GapCode; count: number }

export interface Covered<T> {
  value: T | null
  /** 95% interval of the sample behind `value`; null when the sample is too small or the figure is a range. */
  interval: Interval | null
  /** What kept records out of `n`, with counts. Empty when everything applicable was measured. */
  gaps: Gap[]
  /** Items the figure is computed over. */
  n: number
  covered: number
  total: number
  /** Session (or item) ids that could not be measured. */
  missing: string[]
  formula: string
  /** Traceability for the displayed figure: source records, formula, sample and coverage. */
  origin: { records: string[]; formula: string; n: number; coverage: string }
}

export interface ArmDef {
  id: string
  label: string
  roles: { role: SessionRole; harness: string; model: string; effort?: string }[]
}

export interface TaskDef {
  id: string
  title: string
  size: SizeBucket
  repo: string
  baseCommit: string
  brief: string
  doneCriteria: string
  timeBudgetMin: number
}

export interface Run {
  id: string
  experimentId: string
  taskId: string
  armId: string
  rep: number
  blindId: string | null
  status: 'queued' | 'running' | 'done' | 'interrupted' | 'skipped' | 'failed'
  sessions: {
    id: string
    role: SessionRole
    harness: string
    model: string
    cost: Priced
    startedAt: string
    endedAt: string | null
  }[]
  wallMs: number | null
  activeMs: number | null
  /** Times a person had to step in during the run. Null when it was not recorded (never 0 by default). */
  humanInterventions: number | null
  hidden: { passed: number; failed: number } | null
  evaluation: { meetsDone: boolean; defects: { severity: Severity; title: string }[] } | null
  /** null until both hidden tests and the evaluation exist. */
  accepted: boolean | null
  /** Sum of all its sessions, incl. retries and dead ones. */
  costUSD: Covered<number>
}

export type ScoreType = 'quality' | 'cost' | 'time' | 'reliability'
export type ScoreTypeStatus = 'better' | 'worse' | 'tie' | 'missing'

/** One raw metric, both sides kept. `ratio` > 1 = the candidate is better. */
export interface ScoreMetricResult {
  id: string
  type: ScoreType
  kind: 'rate-higher' | 'rate-lower' | 'count' | 'lower-better'
  candidate: number | null
  reference: number | null
  /** Sample behind a rate (runs or tasks); null for the others. */
  nCandidate: number | null
  nReference: number | null
  ratio: number | null
  /** Why it could not be measured; null when it was. */
  missing: string | null
}

export interface ScoreTypeResult {
  max: number
  points: number | null
  /** Interval of the points from the same bootstrap resamples as the final. Data only: the status stays the 1.25 rule on the point. */
  lo: number | null
  hi: number | null
  /** Integer points for display; they sum to the rounded final. Null when the type is unmeasured. */
  displayPoints: number | null
  /** Geometric mean of the type's measured metric ratios. */
  ratio: number | null
  status: ScoreTypeStatus
  metrics: ScoreMetricResult[]
  /** Ids of metrics left out because they could not be measured (never counted as 0). */
  missing: string[]
}

export interface ScoreSensitivityRow {
  name: string
  weights: Record<ScoreType, number>
  final: number | null
  lo: number | null
  hi: number | null
  verdict: Verdict | null
}

/** The score of the candidate against the reference (method v1). Final = Σ points; the mirror sums to 100. */
export interface ScoreResult {
  methodVersion: 'v1'
  types: Record<ScoreType, ScoreTypeResult>
  final: { value: number | null; lo: number | null; hi: number | null; display: number | null; nullReason: string | null }
  /** Evidence only, outside the score: QA rounds / discarded work per run, per arm. Null = not recorded. */
  rework: Record<string, number | null>
  /** Supporting line, not a fourth verdict. */
  sensitivity: { result: 'firm' | 'depends_on_weights' | null; rows: ScoreSensitivityRow[] }
  /** The acceptance gate blocked the winner the score would declare (the side that would win accepted fewer runs than the other beyond the margin), in either direction. */
  gateBlocked: boolean
}

export interface VerdictResult {
  verdict: Verdict
  /** The score behind the verdict; null when the verdict is `insufficient` before anything was computed. */
  score: ScoreResult | null
  methodVersion: 'v1'
  candidate: string
  reference: string
  /** The size bucket this verdict covers; never one global verdict across buckets. */
  size: SizeBucket
  delta: number
  seed: number
  resamples: number
  /** CPA_candidate / CPA_reference. */
  ratio: { point: number | null; lo: number | null; hi: number | null }
  sample: {
    tasks: number
    runsCandidate: number
    runsReference: number
    acceptedCandidate: number
    acceptedReference: number
    unmeasured: number
  }
  minimum: { tasks: number; repsPerTask: number; acceptedPerArm: number }
  /** Human sentence; for `insufficient` it says what is missing. Always qualified "em custo por entrega aceita". */
  reason: string
  secondary: {
    acceptRate: Record<string, number | null>
    wallPerAccepted: Record<string, number | null>
    defectsPerRun: Record<string, number | null>
    /** Owner attention is not part of the cost; disclosed here. Null per arm when not recorded. */
    humanInterventions: Record<string, number | null>
  }
  coverage: Record<string, { sessions: number; withCost: number }>
}

/** Observed history. NO `verdict` field, by type. */
export interface Observed {
  label: 'observed-biased'
  period: { from: string | null; to: string | null }
  /** Real deliveries in scope (abandoned work is not a delivery; its sessions only feed wasted cost). */
  deliveries: number
  /** What `deliveries` is made of, so no denominator has to be guessed. */
  scope: { published: number; open: number; withPhaseHistory: number; abandonedWithSessions: number }
  metrics: Record<
    | 'costPerDelivery'
    | 'wallMedian'
    | 'activeMedian'
    | 'coordinationShare'
    | 'qaFirstRoundRejection'
    | 'qaRoundsMedian'
    | 'escapedDefectRate'
    | 'wastedCostShare'
    | 'throughputPerWeek',
    Covered<number>
  >
  /** Honest range, not a point. `interval` is the same range, for surfaces that draw intervals uniformly. */
  coordinationShareRange: { lo: number | null; hi: number | null }
  /** Registered sessions whose role is not recorded (they widen the upper end of the range). */
  roleUnknownSessions: number
  coverage: Record<
    string,
    { sessions: number; withCost: number; withTokens: number; withRole: number; withLink: number; status: 'measured' | 'not measured'; reason: string | null }
  >
  /** Counts of items whose data is still free text. */
  notStructured: { qaVerdict: number; escapedLink: number }
}

/** One run reduced to what the verdict needs: a cost per accepted delivery sample. */
export interface CpaSample {
  taskId: string
  armId: string
  rep: number
  /** Total cost of the run, all sessions; null = unmeasured. */
  costUSD: number | null
  accepted: boolean
}
