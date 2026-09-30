/**
 * projections/parity-matrix.ts — the §40 PARITY MATRIX (master spec, master §40; P3 §1.2/§5/§8.1),
 * one row per (metric × harness), built from the per-harness differentials that already exist
 * (`differential.ts` + `differential-<harness>.ts`, A3).
 *
 * PURE. Takes each harness's compared `SessionDiff[]` (kept from a `run<Harness>Differential({...,
 * keepDiffs: true})` call) and folds them, through `differential.ts`'s own `summarize()`, into one
 * row per normalised field — then reclassifies that row against `HARNESS_CAPABILITIES` /
 * `CAPABILITY_STATES` (`@agentistics/core`) so a metric the harness's capability table says it
 * cannot produce reads `explained: not produced by <harness>: <reason>`, never a confident
 * equal-at-0 (the same N/A-vs-0 rule CLAUDE.md states for every other capability-gated surface).
 *
 * ## Verdict → status
 *
 * `differential.ts` has FIVE verdicts (`equal | explained | bug | not-projectable | partial`); the
 * matrix has THREE (`equal | explained | regression`, master §40):
 *
 * - `equal`                       → `equal`
 * - `explained` / `not-projectable` / `partial` → `explained`, carrying the row's own one-sentence
 *   reason (the `EXPLANATIONS` / `NOT_PROJECTABLE` / `PARTIAL_FIELDS` sentence the differential
 *   already proved for that field). A row with NO reason is a bug in THIS generator, not a valid
 *   `explained` row — `statusFromSummary` throws rather than emit one.
 * - `bug`                         → `regression`. Never softened, never reclassified away.
 *
 * A field aggregates over every fixture session of that harness (`summarize`'s own fold): a single
 * `bug` anywhere in the set makes the whole row a `regression` — "a phase may not ship with a
 * regression row" (master §40) is a statement about the METRIC, not about one lucky session.
 *
 * ## Capability coverage
 *
 * `FIELD_CAPABILITY` maps a normalised field name to the `HarnessCapabilities` key it measures
 * (`input_tokens` → `tokens`, `agentMetrics.*` → `agents`, …). Whenever that capability is anything
 * other than `supported`/`partial` for the harness, the row's status is OVERRIDDEN to `explained:
 * not produced by <harness>: <capabilityReason>` — regardless of what the raw differential verdict
 * said, because a `false` capability can still surface as a coincidental `equal` (`0` on both sides)
 * in today's comparator, and that is exactly the confident-0 this repo refuses everywhere else.
 *
 * Three capabilities (`dynamicWorkflows`, `skills`, most of `mcpServers`) have NO corresponding
 * field in today's comparator at all (`compareTools` never emits a row for them), so there is
 * nothing to override — `synthesizeUncoveredCapabilityRows` adds one explicit row per harness for
 * every DECLARED-UNSUPPORTED capability metric that no field row already covered, so the matrix
 * states the gap instead of silently omitting the harness/metric pair. A SUPPORTED capability with
 * no covering field (e.g. `dynamicWorkflows` on claude) is left OUT rather than fabricated — there
 * is no comparison to report on, and inventing an `equal` row for something never measured is the
 * same defect as a confident 0.
 */
import {
  CAPABILITY_METRICS,
  CAPABILITY_STATES,
  capabilityReason,
  HARNESS_ORDER,
  NO_RECORDED_REASON,
  type CapabilityMetric,
  type CapabilityState,
  type HarnessId,
} from '@agentistics/core'
import { summarize, type FieldSummary, type SessionDiff, type Verdict } from './differential'

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────

export type ParityStatus = 'equal' | 'explained' | 'regression'

export interface ParityMatrixRow {
  metric: string
  harness: HarnessId
  legacyValue: unknown
  projectedValue: unknown
  /** `projected - legacy` when both are numbers; `null` otherwise (an object, an array, one side
   *  absent — none of those has a single meaningful numeric delta). */
  delta: number | null
  /** The `HarnessCapabilities` key this metric measures, when one is known. */
  capability: CapabilityMetric | null
  /** `CAPABILITY_STATES[harness][capability].state`, when `capability` is known. */
  capabilityState: CapabilityState['state'] | null
  /** `'exact' | 'estimated' | 'inferred'` when the capability table states one; `'n/a'` for a
   *  declared-absent capability (nothing to be exact about); `'exact'` for an `equal` row with no
   *  mapped capability; `'declared'` for an `explained` row with no mapped capability; `'unproven'`
   *  for a `regression`. */
  exactness: string
  status: ParityStatus
  /** Required whenever `status !== 'equal'`. */
  reason?: string
  /** How many fixture sessions contributed a verdict to this row (0 for a synthesized
   *  capability-only row — the harness's own table, not a session, is the evidence). */
  sessionsCompared: number
  /** Session ids that produced the `bug` verdict this row's `regression` status came from. */
  bugSessions?: readonly string[]
}

export interface ParityMatrix {
  generatedAt: string
  rows: readonly ParityMatrixRow[]
}

// ── Field → capability ──────────────────────────────────────────────────────────────────────────

/** A normalised `differential.ts` field name → the `HarnessCapabilities` key it measures. A field
 *  with no entry here carries no capability tag and is judged purely on its own verdict. */
export const FIELD_CAPABILITY: Readonly<Record<string, CapabilityMetric>> = {
  input_tokens: 'tokens',
  output_tokens: 'tokens',
  cache_read_input_tokens: 'tokens',
  cache_creation_input_tokens: 'tokens',
  cache_creation_1h_input_tokens: 'tokens',
  cache_creation_5m_input_tokens: 'tokens',
  daily: 'tokens',
  'daily.<day>.tokens': 'tokens',
  costUSD: 'cost',
  model: 'model',
  tool_counts: 'tools',
  tool_errors: 'tools',
  tool_error_categories: 'tools',
  uses_task_agent: 'tools',
  uses_web_search: 'tools',
  uses_web_fetch: 'tools',
  uses_mcp: 'tools',
  context_tokens: 'contextWindow',
  context_window: 'contextWindow',
  compact_count: 'compaction',
  compact_ms: 'compaction',
  compact_dropped_tokens: 'compaction',
  lines_added: 'gitLines',
  lines_removed: 'gitLines',
  files_modified: 'gitLines',
  active_minutes: 'activeTime',
  'agentMetrics.totalInvocations': 'agents',
  'agentMetrics.unmeasuredInvocations': 'agents',
  'agentMetrics.totalTokens': 'agents',
  'agentMetrics.totalCostUSD': 'agents',
  'agentMetrics.invocations[]': 'agents',
  'agentMetrics.invocations[].unmeasured': 'agents',
  'agentMetrics.invocations[].agentType': 'agents',
  'agentMetrics.invocations[].totalToolUseCount': 'agents',
  'agentMetrics.invocations[].toolStats': 'agents',
  'agentMetrics.invocations[].totalTokens': 'agents',
}

// ── Per-field status ────────────────────────────────────────────────────────────────────────────

const countTotal = (counts: Record<Verdict, number>): number =>
  counts.equal + counts.explained + counts.bug + counts['not-projectable'] + counts.partial

/**
 * PURE. One field's aggregate verdicts (across every fixture session of the harness) → a parity
 * status. `bug` always wins (a phase may not ship with a `regression` row hidden behind an
 * `explained` majority); an `explained`/`not-projectable`/`partial` verdict with NO recorded reason
 * is a failure of the GENERATOR (it means a field row was pushed with a declared verdict and no
 * sentence — differential.ts's own contract requires one), never silently downgraded to `equal`.
 */
export function statusFromSummary(s: FieldSummary): { status: ParityStatus; reason?: string } {
  if (s.counts.bug > 0) return { status: 'regression' }
  const declared = s.counts.explained + s.counts['not-projectable'] + s.counts.partial
  if (declared > 0) {
    if (s.reasons.length === 0) {
      throw new Error(
        `parity-matrix: ${s.family}/${s.field} has ${declared} declared (explained/not-projectable/partial) `
        + 'verdict(s) but carries no reason — a row with no sentence is a failure of the generator, not an explained row',
      )
    }
    return { status: 'explained', reason: s.reasons.join(' | ') }
  }
  if (s.counts.equal > 0) return { status: 'equal' }
  throw new Error(`parity-matrix: ${s.family}/${s.field} carries no verdicts at all`)
}

/** PURE. The first (by session id, so the pick is stable regardless of fold order) row for this
 *  field, for a representative legacy/projected sample. `undefined` if no diff carries the field. */
export function firstSample(
  diffs: readonly SessionDiff[], field: string,
): { legacy: unknown; projected: unknown } | undefined {
  const sorted = [...diffs].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  for (const d of sorted) {
    const row = d.rows.find(r => normalizeFieldLocal(r.field) === field)
    if (row) return { legacy: row.legacy, projected: row.projected }
  }
  return undefined
}

// Mirrors differential.ts's own (unexported) `normalizeField` — a day segment or a bracketed key
// collapses to one bucket, so a field name here matches the one `summarize()` already produced.
function normalizeFieldLocal(f: string): string {
  return f.replace(/^daily\.\d{4}-\d{2}-\d{2}\./, 'daily.<day>.').replace(/\[[^\]]+\]/g, '[]')
}

function deltaOf(legacy: unknown, projected: unknown): number | null {
  return typeof legacy === 'number' && typeof projected === 'number' ? projected - legacy : null
}

function exactnessOf(status: ParityStatus, capState: CapabilityState | undefined): string {
  if (capState && (capState.state === 'supported' || capState.state === 'partial')) return capState.exactness
  if (capState) return 'n/a' // a declared-absent capability: nothing to be exact about
  if (status === 'equal') return 'exact'
  if (status === 'explained') return 'declared'
  return 'unproven'
}

/** PURE. `capabilityReason`'s sentence, or the codebase's own stated fallback for an undocumented
 *  absence — never an invented sentence. */
function reasonFor(state: CapabilityState): string {
  return capabilityReason(state) ?? NO_RECORDED_REASON
}

// ── One harness ─────────────────────────────────────────────────────────────────────────────────

/** PURE. Every parity row for one harness's compared sessions, capability-overridden, UNSORTED
 *  (the caller — `buildParityMatrix` — imposes the deterministic order across harnesses). */
export function buildHarnessRows(harness: HarnessId, diffs: readonly SessionDiff[]): ParityMatrixRow[] {
  const rows: ParityMatrixRow[] = []
  const covered = new Set<CapabilityMetric>()
  const capsForHarness = CAPABILITY_STATES[harness]

  if (diffs.length > 0) {
    const report = summarize(diffs)
    for (const s of report.fields) {
      const capMetric = FIELD_CAPABILITY[s.field]
      const capState = capMetric ? capsForHarness?.[capMetric] : undefined
      if (capMetric) covered.add(capMetric)

      let outcome = statusFromSummary(s)
      if (capState && capState.state !== 'supported' && capState.state !== 'partial') {
        outcome = { status: 'explained', reason: `not produced by ${harness}: ${reasonFor(capState)}` }
      }

      const sample = firstSample(diffs, s.field)
      rows.push({
        metric: s.field,
        harness,
        legacyValue: sample?.legacy,
        projectedValue: sample?.projected,
        delta: deltaOf(sample?.legacy, sample?.projected),
        capability: capMetric ?? null,
        capabilityState: capState?.state ?? null,
        exactness: exactnessOf(outcome.status, capState),
        status: outcome.status,
        reason: outcome.reason,
        sessionsCompared: countTotal(s.counts),
        bugSessions: outcome.status === 'regression' ? s.bugSessions : undefined,
      })
    }
  }

  // A capability the table declares this harness cannot produce, and that no field row above
  // already carried, gets ONE explicit row so the harness/metric pair is stated, not silently
  // absent. A capability that IS supported/partial but never covered by a field is left out: there
  // is nothing measured to report, and fabricating an `equal` row for it would be the same
  // confident-0 defect this whole module exists to refuse.
  for (const capMetric of CAPABILITY_METRICS) {
    if (covered.has(capMetric)) continue
    const capState = capsForHarness?.[capMetric]
    if (!capState || capState.state === 'supported' || capState.state === 'partial') continue
    rows.push({
      metric: capMetric,
      harness,
      legacyValue: undefined,
      projectedValue: undefined,
      delta: null,
      capability: capMetric,
      capabilityState: capState.state,
      exactness: 'n/a',
      status: 'explained',
      reason: `not produced by ${harness}: ${reasonFor(capState)}`,
      sessionsCompared: 0,
    })
  }

  return rows
}

// ── The whole matrix ────────────────────────────────────────────────────────────────────────────

/** PURE. Deterministic: HARNESS_ORDER, then metric name — the SAME two-key sort every call
 *  produces, regardless of the order harnesses/fields were folded in. */
export function sortParityRows(rows: readonly ParityMatrixRow[]): ParityMatrixRow[] {
  const rank = new Map(HARNESS_ORDER.map((h, i) => [h, i]))
  return [...rows].sort((a, b) =>
    (rank.get(a.harness) ?? 99) - (rank.get(b.harness) ?? 99) || a.metric.localeCompare(b.metric))
}

/**
 * PURE. The full §40 matrix over every harness's compared fixture sessions. `perHarness` need not
 * carry every `HarnessId` — a harness with no entry (or an empty array) simply contributes no rows
 * from its own sessions but STILL gets its declared-unsupported capability rows, since those come
 * from the capability table alone, never from data.
 */
export function buildParityMatrix(
  perHarness: Readonly<Partial<Record<HarnessId, readonly SessionDiff[]>>>,
  generatedAt: string = new Date().toISOString(),
): ParityMatrix {
  const rows: ParityMatrixRow[] = []
  for (const harness of HARNESS_ORDER) {
    rows.push(...buildHarnessRows(harness, perHarness[harness] ?? []))
  }
  return { generatedAt, rows: sortParityRows(rows) }
}

// ── Reporting ───────────────────────────────────────────────────────────────────────────────────

export interface ParitySummary {
  total: number
  equal: number
  explained: number
  regression: number
  byHarness: Record<HarnessId, { equal: number; explained: number; regression: number }>
}

/** PURE. */
export function summarizeParityMatrix(matrix: ParityMatrix): ParitySummary {
  const byHarness = {} as ParitySummary['byHarness']
  for (const h of HARNESS_ORDER) byHarness[h] = { equal: 0, explained: 0, regression: 0 }
  let equal = 0, explained = 0, regression = 0
  for (const r of matrix.rows) {
    byHarness[r.harness][r.status]++
    if (r.status === 'equal') equal++
    else if (r.status === 'explained') explained++
    else regression++
  }
  return { total: matrix.rows.length, equal, explained, regression, byHarness }
}

const fmtValue = (v: unknown): string => {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v === 'object') return '`' + JSON.stringify(v) + '`'
  return String(v)
}

/** PURE. The matrix as Markdown — one table, `metric` / `harness` / values / capability / status. */
export function renderParityMatrixMarkdown(matrix: ParityMatrix): string {
  const summary = summarizeParityMatrix(matrix)
  const lines = [
    `generated: ${matrix.generatedAt}`,
    '',
    `rows: ${summary.total} · equal: ${summary.equal} · explained: ${summary.explained} · regression: ${summary.regression}`,
    '',
    '| harness | metric | legacy | projected | delta | capability | exactness | status | reason |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of matrix.rows) {
    const cap = r.capability ? `${r.capability}${r.capabilityState ? ` (${r.capabilityState})` : ''}` : '—'
    const delta = r.delta === null ? '—' : String(r.delta)
    const reason = r.reason ? r.reason.replace(/\|/g, '\\|') : ''
    lines.push(
      `| ${r.harness} | \`${r.metric}\` | ${fmtValue(r.legacyValue)} | ${fmtValue(r.projectedValue)} | ${delta} `
      + `| ${cap} | ${r.exactness} | ${r.status} | ${reason} |`,
    )
  }
  return lines.join('\n')
}

/** PURE. */
export function renderParityMatrixJson(matrix: ParityMatrix): string {
  return JSON.stringify(matrix, null, 2)
}
