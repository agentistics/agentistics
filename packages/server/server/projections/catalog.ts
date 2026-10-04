/**
 * projections/catalog.ts — PURE. The materialised projections of P3 §2 (six) and LIVE.2 (`SESSION_SURFACE`), each with what the store
 * needs to hold it (its KEY and its OUTPUT rows), plus the rebuild-or-resume decision.
 *
 * A `Projection` (core `projection.ts`) is only `empty`/`fold`/`finish` + a version; materialising one
 * needs two more facts, which live here and nowhere else:
 * - `keyOf(event)`: which fold state an event belongs to (`sessionId`, `runId` or `taskId`) — `null`
 *   means this projection does not read the event, and it is counted as unkeyed, never guessed;
 * - `rows(result)`: what `finish` produces, as the rows a reader queries (`day` is the UTC day the row
 *   is filed under — the billing/tag day rule — or `''` for a row no day filter applies to).
 *
 * `planProjection` is the §19.4 lever: a stored projection is REBUILT from rowid 0 when its
 * `version` differs from the code's, when the adapter versions it was built under differ from the ones
 * running now, or when it never existed; an interrupted rebuild CONTINUES from its cursor (its tables
 * were already dropped when it began); otherwise it RESUMES from its cursor.
 */
import type { AnyAgentisticsEvent, Projection } from '@agentistics/core'
import { agentMetricsProjection } from './agent-metrics'
import { costByDimensionProjection } from './cost-by-dimension'
import { runMetricsProjection } from './run-metrics'
import { sessionMetaProjection } from './session-meta'
import { sessionSurfaceProjection } from './session-surface'
import { taskRollupProjection } from './task-rollup'
import { toolMetricsProjection } from './tool-metrics'
import { utcDay } from './kit'

export interface OutputRow {
  day: string
  data: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StoredProjection<S = any, R = any> {
  /** Table-safe id (`[a-z_]+`), derived from `projection.name`. */
  readonly id: string
  readonly projection: Projection<S, R>
  keyOf(e: AnyAgentisticsEvent): string | null
  rows(result: R): OutputRow[]
}

const tableId = (name: string): string => {
  const id = name.replace(/-/g, '_')
  if (!/^[a-z_]+$/.test(id)) throw new Error(`projection name ${name} is not table-safe`)
  return id
}

function stored<S, R>(p: Projection<S, R>, keyOf: (e: AnyAgentisticsEvent) => string | null, rows: (r: R) => OutputRow[]): StoredProjection<S, R> {
  return { id: tableId(p.name), projection: p, keyOf, rows }
}

const bySession = (e: AnyAgentisticsEvent) => e.sessionId ?? null
const byRun = (e: AnyAgentisticsEvent) => e.runId ?? null
const byTask = (e: AnyAgentisticsEvent) => e.taskId ?? null

/**
 * `notProjectable` / `partialFields` are STATIC (`NOT_PROJECTABLE` / `PARTIAL_FIELDS` in
 * `session-meta.ts`, facts about the event vocabulary rather than about a session) and were most of
 * every row's bytes, so the stored row leaves them out; a reader imports the two constants.
 */
export const SESSION_META = stored(sessionMetaProjection, bySession, r => {
  const { notProjectable: _n, partialFields: _p, ...row } = r
  return [{ day: utcDay(r.meta.start_time), data: row }]
})
export const RUN_METRICS = stored(runMetricsProjection, byRun, r => (r.fact ? [{ day: r.fact.day, data: r.fact }] : []))
export const AGENT_METRICS = stored(agentMetricsProjection, byRun, r => [{ day: '', data: r }])
export const TOOL_METRICS = stored(toolMetricsProjection, byRun, r => [{ day: '', data: r }])
export const COST_BY_DIMENSION = stored(costByDimensionProjection, bySession, r => r.facts.map(f => ({ day: f.day, data: f })))
export const TASK_ROLLUP = stored(taskRollupProjection, byTask, r => [{ day: '', data: r }])
/**
 * LIVE.2. One row per session, filed in `day` under its conversation key (`sessionSurfaceKey`) — the
 * public side knows the conversation but cannot derive the canonical session id (each integration
 * hashes its own). A session that never named its conversation files nothing.
 */
export const SESSION_SURFACE = stored(sessionSurfaceProjection, bySession, r => (r && r.key ? [{ day: r.key, data: r }] : []))

/** Every materialised projection, in a fixed order. */
export const STORED_PROJECTIONS: readonly StoredProjection[] = [
  SESSION_META, RUN_METRICS, AGENT_METRICS, TOOL_METRICS, COST_BY_DIMENSION, TASK_ROLLUP, SESSION_SURFACE,
]

// ── Rebuild or resume ───────────────────────────────────────────────────────────────────────────

/** What the store remembers about one projection. */
export interface StoredMeta {
  id: string
  version: number
  /** The journal rowid folded up to. */
  cursor: number
  /** The adapter versions (`source.id` → version) running when this build began. */
  adapterVersions: Record<string, string>
  /** A rebuild began and has not reached the journal's head yet. */
  rebuilding: boolean
  /** Why the last rebuild began — kept while `rebuilding`, reported afterwards. */
  reason: string | null
}

export type RebuildReason =
  | 'new'
  | 'version-changed'
  | 'adapter-version-changed'
  | 'journal-replaced'

export type ProjectionPlan =
  | { mode: 'resume'; from: number }
  /** `fresh`: drop everything and start at rowid 0. Not fresh: an interrupted rebuild continues from `from`. */
  | { mode: 'rebuild'; fresh: boolean; from: number; reason: string }

function sameVersions(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/** Human-readable, one sentence: why a rebuild happens. */
export function rebuildSentence(reason: RebuildReason, detail?: string): string {
  switch (reason) {
    case 'new': return 'first build: nothing was materialised for this projection yet'
    case 'version-changed': return `projectionVersion changed${detail ? ` (${detail})` : ''}; re-projecting from the journal`
    case 'adapter-version-changed': return `an adapter version changed${detail ? ` (${detail})` : ''}; re-projecting from the journal`
    case 'journal-replaced': return `the journal is not the one this store was folded from${detail ? ` (${detail})` : ''}; re-projecting from it`
  }
}

/**
 * PURE. `adapters` is the set running now; `null` skips that comparison (a caller that cannot say).
 * `journalReplaced` is the store's own finding that its cursors describe a different journal.
 */
export function planProjection(
  stored: StoredMeta | undefined,
  code: { version: number },
  adapters: Record<string, string> | null,
  journalReplaced: string | null = null,
): ProjectionPlan {
  if (!stored) return { mode: 'rebuild', fresh: true, from: 0, reason: rebuildSentence('new') }
  if (journalReplaced !== null) return { mode: 'rebuild', fresh: true, from: 0, reason: rebuildSentence('journal-replaced', journalReplaced) }
  if (stored.version !== code.version) {
    return { mode: 'rebuild', fresh: true, from: 0, reason: rebuildSentence('version-changed', `${stored.version} → ${code.version}`) }
  }
  if (adapters !== null && !sameVersions(stored.adapterVersions, adapters)) {
    const changed = [...new Set([...Object.keys(stored.adapterVersions), ...Object.keys(adapters)])].sort()
      .filter(k => stored.adapterVersions[k] !== adapters[k])
      .map(k => `${k} ${stored.adapterVersions[k] ?? '—'} → ${adapters[k] ?? '—'}`)
    return { mode: 'rebuild', fresh: true, from: 0, reason: rebuildSentence('adapter-version-changed', changed.join(', ')) }
  }
  if (stored.rebuilding) return { mode: 'rebuild', fresh: false, from: stored.cursor, reason: stored.reason ?? 'an interrupted rebuild continues' }
  return { mode: 'resume', from: stored.cursor }
}
