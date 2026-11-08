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

export interface Covered<T> {
  value: T | null
  /** Items the figure is computed over. */
  n: number
  covered: number
  total: number
  /** Session (or item) ids that could not be measured. */
  missing: string[]
  formula: string
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

export interface VerdictResult {
  verdict: Verdict
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
  deliveries: number
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
  /** Honest range, not a point. */
  coordinationShareRange: { lo: number | null; hi: number | null }
  coverage: Record<
    string,
    { sessions: number; withCost: number; withTokens: number; withRole: number; withLink: number }
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
