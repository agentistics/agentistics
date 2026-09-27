/**
 * projections/differential-copilot.ts — the Copilot row of the parity matrix (P1 §8, P2 §5, master
 * §40), on the SAME shape `projections/differential.ts` established for Claude.
 *
 * `compareTokens` / `compareTime` / `compareTools` (differential.ts, exported) are generic over
 * `SessionMeta` / `SessionMetaProjection` — nothing in their bodies is Claude-specific except the
 * OPTIONAL `UsageEvidence` parameter, which Copilot has no equivalent of and simply omits — so this
 * module reuses them wholesale rather than re-deriving the same comparisons. What is Copilot-specific
 * is layered on TOP, as a `reclassify` pass over the rows those three functions already produced:
 *
 * (`tool_counts` used to need a reclassification here — `session-meta.ts`'s `tool.requested` fold
 * summed by `event.data.name`, the harness's own verbatim name, which diverged from legacy's
 * canonical-keyed `tool_counts` for Copilot's `view`/`bash` names. That gap was closed UPSTREAM: the
 * fold now sums by `canonicalName`, so the row is `equal` directly and nothing is reclassified.)
 *
 * 1. **`tool_errors` / `tool_error_categories` — TWO gaps, not one.**
 *    (a) `session.error` is a SESSION-level error with no tool call to attach it to;
 *    `ToolFailedData` requires a `toolExecutionId`, so there is no event for it and the projection
 *    can never report one. Proven per session by an independent recount of `session.error` lines in
 *    the raw bytes: when that count equals legacy's `tool_errors` short-fall, the difference is
 *    `explained`, never a `bug`.
 *    (b) the REVERSE gap: `copilot-parse.ts` never reads `tool.execution_complete`'s `success` field
 *    at all, so a genuinely FAILED tool call (measured: zero occurrences in this integration's real
 *    store, so this path is unverified) is not a legacy tool error, while `replay.ts` emits a real
 *    `tool.failed` for it (LEGACY DEFECT: the harness's own data says a call failed, and legacy drops
 *    it). Proven per session by an independent recount of `tool.execution_complete` lines with
 *    `success === false`: when that count exactly accounts for the projected-over-legacy delta, the
 *    difference is `explained`. (SHARED CHANGE PROPOSED: a `toolFailuresAreErrors` flag on
 *    `HarnessToolRules`, mirroring the existing `modelFailuresAreErrors`, so a per-harness answer to
 *    "does a failed tool call count" lives in the one shared place instead of being reclassified here.)
 * 2. **The human-turn family** (`user_message_count`, `rounds`, `user_interruptions`,
 *    `user_message_timestamps`, `active_minutes`, `user_response_times`) — this integration does not
 *    emit `turn.started`/`turn.ended` (P2 §2's table lists only run, agent, model.completed,
 *    tool.* and mcp.* for Copilot), and `session-meta.ts`'s `TURNS_SINCE`/`TURN_END_SINCE` tables have no
 *    `copilot` entry either way, so `recordsSince` is false for every Copilot event regardless — the
 *    fields are structurally NOT-PROJECTABLE for this harness today. Reclassified as such rather than
 *    left as a `bug` (SHARED CHANGE REQUESTED: add a `copilot` row to both tables the day turn events
 *    are added, or drop this reclassification).
 * 3. **`duration_minutes`** — legacy's copilot-parse.ts computes it UNROUNDED
 *    (`(end - start) / 60000`); `session-meta.ts` rounds to the nearest minute. Proven per session:
 *    `Math.round(legacy) === projected` reclassifies the row `explained`.
 * 4. **`daily.<day>.tokens`** — Copilot's legacy `SessionMeta` carries no `daily` field at all
 *    (`copilot-parse.ts` never sets one); the projection derives ONE bucket (the `session.shutdown`
 *    line's own day) from the cumulative usage report. Per P2 §3 this is the DECLARED gap ("per-UTC-
 *    day slicing is new for non-Claude harnesses... an explained row, not a silent improvement"),
 *    reclassified `explained` whenever legacy has no day series at all and the projection does.
 * 5. **`model` / `costUSD` when `session.shutdown.data.currentModel` is set but `modelMetrics` is
 *    EMPTY** (measured: exactly 3 real sessions, each with `totalApiDurationMs: 0` — the CLI picked
 *    a model but never actually made a billed call). `copilot-parse.ts` still sets `model` from
 *    `currentModel` unconditionally, which prices `costUSD` at 0 for a NAMED model; `replay.ts`
 *    deliberately does NOT invent a `model.completed` for a model nothing was ever billed under (a
 *    completed call that did not happen is exactly the D21 confident-zero this repo refuses one
 *    counter at a time — here it would be a whole invented response), so the projection's `model` is
 *    absent and its `costUSD` is `null` (never a 0 standing in for "nothing seen"). Proven per session
 *    by an independent check of the raw `session.shutdown` line: `currentModel` is a non-empty string
 *    and `modelMetrics` has no keys.
 *
 * **Also SHARED CHANGE REQUESTED (unmeasured on this store, so not reclassified here):**
 * `HARNESS_TOOL_RULES` has no `copilot` entry, so `uses_mcp`/`uses_web_search`/`uses_web_fetch`/
 * `uses_task_agent` fall through to `DEFAULT_TOOL_RULES` (canonical tool-NAME predicates). Legacy's
 * copilot-parse.ts derives NONE of the three booleans from a tool name at all — `uses_web_search`
 * and `uses_web_fetch` are hardcoded `false` unconditionally, and `uses_mcp` comes from a
 * `session.info { infoType: 'mcp' }` marker this integration has no event for (zero occurrences in
 * 31 real sessions — see `replay.ts`'s header). Every real session on this machine reads `false` on
 * both sides by coincidence (no tool canonicalizes to `WebSearch`/`WebFetch`/`mcp__…`), so nothing
 * diverges YET; a copilot entry (`webSearch: () => false, webFetch: () => false, mcp: () => false`)
 * would make the agreement structural rather than accidental.
 */
import { readFile, readdir, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import { project, type AnyAgentisticsEvent, type SessionMeta } from '@agentistics/core'
import { parseCopilotEvents } from '../adapters/copilot-parse'
import { createCopilotReplay } from '../integrations/copilot'
import {
  compareTokens, compareTime, compareTools, summarize, renderReport,
  type DifferentialReport, type FieldRow, type SessionDiff,
} from './differential'
import { sessionMetaProjection, type SessionMetaProjection } from './session-meta'

// ── Copilot-specific explanations, each with its own per-session proof (see this module's header) ──

export const COPILOT_EXPLANATIONS = {
  sessionErrorNotAttributable:
    'session.error is a session-level error with no tool call to attach it to (ToolFailedData requires '
    + 'a toolExecutionId); an independent recount of session.error lines in the raw bytes equals '
    + "legacy's tool_errors exactly, and the projected side is always 0",
  failedToolCallNotCountedByLegacy:
    "LEGACY DEFECT: copilot-parse.ts never reads tool.execution_complete's success field, so a failed "
    + 'tool call is not a legacy tool error; the projection reports it honestly (a real tool.failed '
    + 'event), and an independent recount of success:false tool.execution_complete lines accounts for '
    + 'the exact delta over legacy',
  turnsNotEmitted:
    "this integration emits no turn.started/turn.ended (P2 §2), and session-meta.ts's TURNS_SINCE/"
    + 'TURN_END_SINCE tables carry no copilot entry either way, so the field is not-projectable for '
    + 'this harness today, not a proven-wrong number',
  durationRounding:
    "copilot-parse.ts computes duration_minutes UNROUNDED ((end - start) / 60000); session-meta.ts's "
    + 'projection rounds to the nearest minute; round(legacy) equals the projected value exactly',
  dailyIsNewCapability:
    'per-UTC-day slicing is new for Copilot (P2 §3, declared): legacy carries no daily field at all, '
    + 'the projection derives one bucket (the session.shutdown line\'s own day) from the cumulative '
    + 'usage report — a new capability, not a divergence',
  namedModelWithNoBilledCall:
    "session.shutdown named a currentModel with an EMPTY modelMetrics (nothing was ever billed); "
    + "copilot-parse.ts still prices costUSD at 0 for that named model, while the projection refuses "
    + 'to invent a model.completed for a call that never happened, so model is absent and costUSD is '
    + 'null (never a confident 0) — D21 applied to a whole invocation, not one counter',
} as const

const TURN_FIELDS = new Set([
  'user_message_count', 'rounds', 'user_interruptions', 'user_message_timestamps',
  'active_minutes', 'user_response_times',
])

/** Every raw line of `type` in the content — the shared shape behind both independent recounts
 *  below (reasons #1a and #1b in the header). */
function countLinesOfType(content: string, type: string): number {
  let n = 0
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let e: unknown
    try { e = JSON.parse(line) } catch { continue }
    if (e && typeof e === 'object' && (e as Record<string, unknown>).type === type) n++
  }
  return n
}

/** Every `tool.execution_complete` line whose `data.success` is literally `false` — the independent
 *  recount for reason #1b above (a failed tool call legacy never reads at all). */
function countFailedToolCompleteLines(content: string): number {
  let n = 0
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let e: unknown
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    const rec = e as Record<string, unknown>
    if (rec.type !== 'tool.execution_complete') continue
    const data = rec.data
    if (data && typeof data === 'object' && (data as Record<string, unknown>).success === false) n++
  }
  return n
}

/** Whether some `session.shutdown` line names a `currentModel` while its own `modelMetrics` has NO
 *  keys — the independent structural proof for reason #5 in the header (a model picked but never
 *  actually billed). */
function namedModelWithNoBilledCall(content: string): boolean {
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let e: unknown
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    const rec = e as Record<string, unknown>
    if (rec.type !== 'session.shutdown') continue
    const data = rec.data
    if (!data || typeof data !== 'object') continue
    const d = data as Record<string, unknown>
    const currentModel = d.currentModel
    const modelMetrics = d.modelMetrics
    if (typeof currentModel === 'string' && currentModel.length > 0
      && modelMetrics && typeof modelMetrics === 'object' && Object.keys(modelMetrics).length === 0) {
      return true
    }
  }
  return false
}

/** PURE. Reclassify the Copilot-specific rows on top of the generic comparison — see the header. */
export function reclassifyCopilotRows(rows: FieldRow[], content: string): FieldRow[] {
  const sessionErrorCount = countLinesOfType(content, 'session.error')
  const failedToolCallCount = countFailedToolCompleteLines(content)
  const namedModelNoBill = namedModelWithNoBilledCall(content)
  return rows.map(r => {
    if (namedModelNoBill && r.field === 'model' && r.projected === undefined) {
      return { ...r, verdict: 'explained' as const, reason: COPILOT_EXPLANATIONS.namedModelWithNoBilledCall }
    }
    if (namedModelNoBill && r.field === 'costUSD' && r.legacy === 0 && r.projected === null) {
      return { ...r, verdict: 'explained' as const, reason: COPILOT_EXPLANATIONS.namedModelWithNoBilledCall }
    }
    if (r.verdict !== 'bug') {
      if (TURN_FIELDS.has(r.field) && r.verdict !== 'not-projectable') {
        return { ...r, verdict: 'not-projectable' as const, reason: COPILOT_EXPLANATIONS.turnsNotEmitted }
      }
      return r
    }

    if (TURN_FIELDS.has(r.field)) {
      return { ...r, verdict: 'not-projectable' as const, reason: COPILOT_EXPLANATIONS.turnsNotEmitted }
    }

    if (r.field === 'tool_errors' && typeof r.legacy === 'number' && typeof r.projected === 'number') {
      // The two gaps push in OPPOSITE directions: session.error inflates LEGACY (counted there,
      // never projectable), a failed tool.execution_complete inflates PROJECTED (a real tool.failed
      // event legacy never reads). The net delta must equal exactly the difference of the two
      // independent recounts, or this is a genuine bug, not an explained gap.
      const expectedDelta = sessionErrorCount - failedToolCallCount
      if (r.legacy - r.projected === expectedDelta && (sessionErrorCount > 0 || failedToolCallCount > 0)) {
        const reason = failedToolCallCount > 0 && sessionErrorCount > 0
          ? `${COPILOT_EXPLANATIONS.sessionErrorNotAttributable}; also: ${COPILOT_EXPLANATIONS.failedToolCallNotCountedByLegacy}`
          : failedToolCallCount > 0
            ? COPILOT_EXPLANATIONS.failedToolCallNotCountedByLegacy
            : COPILOT_EXPLANATIONS.sessionErrorNotAttributable
        return { ...r, verdict: 'explained' as const, reason }
      }
      return r
    }
    if (r.field === 'tool_error_categories') {
      // A consequence of #1a/#1b above: legacy never files a session.error under any tool name and
      // never reads a failed tool.execution_complete at all, so this stays an empty object on the
      // legacy side whenever tool_errors is explained by the recounts above; the projected side is
      // likewise empty (session.error has no event) or the FAILED tool's own canonical name (which
      // legacy has no opinion about, since it never counted the failure in the first place).
      return r
    }

    if (r.field === 'duration_minutes' && typeof r.legacy === 'number' && typeof r.projected === 'number') {
      if (Math.round(r.legacy) === r.projected) {
        return { ...r, verdict: 'explained' as const, reason: COPILOT_EXPLANATIONS.durationRounding }
      }
      return r
    }

    if (r.field.startsWith('daily.') && r.legacy === undefined && r.projected !== undefined) {
      return { ...r, verdict: 'explained' as const, reason: COPILOT_EXPLANATIONS.dailyIsNewCapability }
    }

    return r
  })
}

/** PURE. Every row for one Copilot session. */
export function compareCopilotSession(input: {
  sessionId: string
  legacy: SessionMeta
  projection: SessionMetaProjection
  content: string
}): SessionDiff {
  const { sessionId, legacy, projection, content } = input
  const rows = [
    ...compareTokens(legacy, projection),
    ...compareTime(legacy, projection),
    ...compareTools(sessionId, legacy, projection),
  ]
  return { sessionId, rows: reclassifyCopilotRows(rows, content) }
}

// ── IO: run it over a store ─────────────────────────────────────────────────────────────────────

export interface CopilotDifferentialOptions {
  /** A Copilot `session-state` directory. Read only. */
  sessionStateDir: string
  /** Restrict to these session ids. */
  sessionIds?: readonly string[]
  /** A file written to more recently than this is live and skipped (default 60 s). */
  settledMs?: number
  /** Default `Date.now`. */
  now?: () => number
  /** Called once per session compared. */
  onSession?: (d: SessionDiff) => void
  /** Keep every per-session diff on the result (tests); a real-store run keeps only the summary. */
  keepDiffs?: boolean
}

async function locate(sessionStateDir: string, only?: ReadonlySet<string>): Promise<{ sessionId: string; path: string }[]> {
  let dirs: string[]
  try { dirs = await readdir(sessionStateDir) } catch { return [] }
  const out: { sessionId: string; path: string }[] = []
  for (const dir of dirs.sort()) {
    if (only && !only.has(dir)) continue
    const path = join(sessionStateDir, dir, 'events.jsonl')
    out.push({ sessionId: dir, path })
  }
  return out
}

export async function runCopilotDifferential(
  opts: CopilotDifferentialOptions,
): Promise<DifferentialReport & { diffs?: SessionDiff[] }> {
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? 60_000
  const replay = createCopilotReplay({ sessionStateDir: opts.sessionStateDir, settledMs, now })
  const only = opts.sessionIds ? new Set(opts.sessionIds) : undefined
  const diffs: SessionDiff[] = []
  const summaries: SessionDiff[] = []
  const skipped = { live: 0, unreadable: 0 }

  for (const loc of await locate(opts.sessionStateDir, only)) {
    const st = await fsStat(loc.path).catch(() => null)
    if (!st) { skipped.unreadable++; continue }
    if (now() - st.mtimeMs < settledMs) { skipped.live++; continue }
    let diff: SessionDiff
    try {
      const content = await readFile(loc.path, 'utf-8')
      const legacy = parseCopilotEvents(content, loc.sessionId)
      if (!legacy) { skipped.unreadable++; continue }
      const batch = await replay.replay({ sessionId: loc.sessionId, sourceRef: `copilot:${loc.sessionId}` }, null)
      const projection = project(sessionMetaProjection, batch.events as AnyAgentisticsEvent[])
      diff = compareCopilotSession({ sessionId: loc.sessionId, legacy, projection, content })
    } catch {
      skipped.unreadable++
      continue
    }
    opts.onSession?.(diff)
    if (opts.keepDiffs) diffs.push(diff)
    summaries.push({ sessionId: diff.sessionId, rows: diff.rows.map(r => ({ family: r.family, field: r.field, verdict: r.verdict, reason: r.reason })) })
  }
  const report = summarize(summaries, skipped)
  return opts.keepDiffs ? { ...report, diffs } : report
}

export { renderReport }
