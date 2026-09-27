/**
 * projections/differential-codex.ts — the parity row for Codex (P2 §5): the LEGACY `SessionMeta`
 * (`parseCodexRollout` over a rollout's bytes — what every surface is fed from today) against the
 * PROJECTED one (the Codex replay's events over the SAME bytes, folded through
 * `sessionMetaProjection`), field by field, in `differential.ts`'s vocabulary and with its row
 * builders (`compareTokens` / `compareTime` / `compareTools`, `summarize`, `renderReport`).
 *
 * No tolerance anywhere. A differing row stays a `bug` unless an explanation from `CODEX_EXPLANATIONS`
 * is PROVEN for that very session by `recountCodex` — an independent walk of the raw lines, written
 * here from the rollout format and sharing no code with either side — reproducing BOTH values.
 *
 * The two shared changes this module once stubbed (codex in `TURNS_SINCE`/`TURN_END_SINCE`, and
 * `tool_counts` keyed by `canonicalName`) have landed in `session-meta.ts` (A3).
 *
 * The store is only ever READ; the report names session ids and field names, never content.
 */
import { readFile, stat as fsStat } from 'node:fs/promises'
import {
  project,
  sessionCostUSD,
  type AgentisticsEvent,
  type AnyAgentisticsEvent,
  type SessionMeta,
} from '@agentistics/core'
import { parseCodexRollout } from '../adapters/codex-parse'
import { iterLines } from '../jsonl'
import { collectRollouts, fallbackIdOf, rolloutIdOf } from '../integrations/codex'
import { codexContext } from '../integrations/codex/replay-core'
import { replayCodexRollout } from '../integrations/codex/replay'
import {
  compareTime, compareTokens, compareTools, summarize,
  type DifferentialReport, type FieldRow, type SessionDiff,
} from './differential'
import { sessionMetaProjection, type SessionMetaProjection } from './session-meta'

/** The projection of one Codex event stream. */
export function projectCodex(events: readonly AgentisticsEvent[]): SessionMetaProjection {
  return project(sessionMetaProjection, events as AnyAgentisticsEvent[])
}

// ── Evidence: an independent recount of the raw lines ───────────────────────────────────────────

export interface CodexEvidence {
  /** `session_meta.payload.timestamp` (last one), else the first line's envelope timestamp. */
  startRaw?: string
  /** The last envelope timestamp. */
  endRaw?: string
  userMessages: number
  webSearchCalls: number
  /** Every cumulative snapshot, in the parser's split. */
  snapshots: { input: number; cacheRead: number; output: number }[]
  /** How many times a snapshot counter went DOWN. */
  resets: number
  /** Sum over series of each series' last snapshot — what a reset-aware delta sum gives. */
  seriesSum: { input: number; cacheRead: number; output: number }
  /** The last `turn_context.model`, and the one in force at the first usage snapshot. */
  lastModel?: string
  modelAtFirstUsage?: string
}

/** PURE. The rollout's facts, recounted from the format — no import from either side. */
export function recountCodex(lines: Iterable<string>): CodexEvidence {
  const ev: CodexEvidence = { userMessages: 0, webSearchCalls: 0, snapshots: [], resets: 0, seriesSum: { input: 0, cacheRead: 0, output: 0 } }
  let first = true
  let metaStart: string | undefined
  let firstLineTs: string | undefined
  let model: string | undefined
  let prev: { input: number; cacheRead: number; output: number } | undefined
  const closeSeries = () => {
    if (!prev) return
    ev.seriesSum.input += prev.input; ev.seriesSum.cacheRead += prev.cacheRead; ev.seriesSum.output += prev.output
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, any>
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (first) { first = false; if (typeof e.timestamp === 'string') firstLineTs = e.timestamp }
    const p = e.payload && typeof e.payload === 'object' ? e.payload : e
    const kind = e.type === 'event_msg' || e.type === 'response_item' ? p.type : e.type
    if (typeof e.timestamp === 'string' && e.timestamp) ev.endRaw = e.timestamp
    if (kind === 'session_meta' && typeof p.timestamp === 'string') metaStart = p.timestamp
    if (kind === 'turn_context' && typeof p.model === 'string') model = p.model
    if (kind === 'user_message') ev.userMessages++
    if (kind === 'web_search_call') ev.webSearchCalls++
    if (kind === 'token_count') {
      const u = p.info?.total_token_usage ?? p.total_token_usage
      if (!u) continue
      const snap = {
        input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
        cacheRead: u.cached_input_tokens ?? 0,
        output: u.output_tokens ?? prev?.output ?? 0,
      }
      if (ev.snapshots.length === 0) ev.modelAtFirstUsage = model
      if (prev && (snap.input < prev.input || snap.cacheRead < prev.cacheRead || snap.output < prev.output)) {
        ev.resets++
        closeSeries()
      }
      ev.snapshots.push(snap)
      prev = snap
    }
  }
  closeSeries()
  ev.lastModel = model
  const start = metaStart ?? firstLineTs
  if (start) ev.startRaw = start
  return ev
}

// ── Explanations — one sentence each, applied only when the recount proves them ────────────────

export const CODEX_EXPLANATIONS = {
  durationRounded:
    'codex-parse.ts keeps the fractional minutes of end - start while the shared projection rounds them '
    + 'to whole minutes (the Claude rule); the recount of start and end from the raw lines reproduces both',
  interruptionsHardcoded:
    'codex-parse.ts writes user_interruptions: 0 unconditionally while the projection derives count - 1 '
    + 'from the same user_message turns; the recount of user_message records reproduces both',
  dailyNew:
    'the parser writes no per-day split for Codex; the projection slices each turn delta onto its UTC day '
    + '(P2 §3, master §40), and the projected days sum exactly to the recount of the counted usage',
  modelNoUsage:
    'the rollout carries no billed usage, so no model.completed names a model; legacy still names the last '
    + 'turn_context model, which the recount reproduces',
  modelSwitch:
    'legacy names the LAST turn_context model, the projection the model of the FIRST billed turn; the recount '
    + 'of turn_context records reproduces both',
  costFollows:
    'the price of the model/counter differences explained above: the legacy session repriced with the '
    + 'projected model and the recount of the projected counters equals the projected cost exactly',
  cumulativeReset:
    'a cumulative counter went DOWN (a restarted series): legacy keeps only the last snapshot, the replay adds '
    + 'every series; the recount of snapshots reproduces both',
  webSearchName:
    'legacy sets uses_web_search from a web_search_call record, which canonicalTool leaves unmapped, while the '
    + "projection looks for the canonical 'WebSearch'; the recount of web_search_call records reproduces both",
} as const

const TOKEN_KEYS = [
  ['input_tokens', 'input'], ['cache_read_input_tokens', 'cacheRead'], ['output_tokens', 'output'],
] as const

function explain(rows: FieldRow[], legacy: SessionMeta, p: SessionMetaProjection, ev: CodexEvidence): void {
  const set = (r: FieldRow, reason: string) => { r.verdict = 'explained'; r.reason = reason }
  const byField = new Map(rows.map(r => [r.field, r]))

  // Tokens: only a reset can move a total, and then both sides must equal their recount.
  let tokensExplained = true
  for (const [field, k] of TOKEN_KEYS) {
    const r = byField.get(field)
    if (r?.verdict !== 'bug') continue
    const last = ev.snapshots.at(-1)?.[k] ?? 0
    if (ev.resets > 0 && r.legacy === last && r.projected === ev.seriesSum[k]) set(r, CODEX_EXPLANATIONS.cumulativeReset)
    else tokensExplained = false
  }

  const model = byField.get('model')
  let modelExplained = false
  if (model?.verdict === 'bug' && model.legacy === ev.lastModel) {
    if (ev.snapshots.length === 0 && model.projected === undefined) { set(model, CODEX_EXPLANATIONS.modelNoUsage); modelExplained = true }
    else if (ev.snapshots.length > 0 && model.projected === ev.modelAtFirstUsage) { set(model, CODEX_EXPLANATIONS.modelSwitch); modelExplained = true }
  }
  // Cost: only the differences already proven above may move it. Reprice legacy with the projected
  // model and the RECOUNT of the projected counters (the reset-aware sum when a series restarted).
  // What the replay counts, per the recount: the last snapshot, or every series' last one after a reset.
  const counted = ev.resets > 0 ? ev.seriesSum : ev.snapshots.at(-1) ?? { input: 0, cacheRead: 0, output: 0 }
  const cost = byField.get('costUSD')
  const modelOk = model?.verdict === 'equal' || modelExplained
  if (cost?.verdict === 'bug' && tokensExplained && modelOk) {
    const repriced = sessionCostUSD({
      ...legacy, model: p.meta.model,
      input_tokens: counted.input, cache_read_input_tokens: counted.cacheRead, output_tokens: counted.output,
    })
    if (repriced === p.costUSD) set(cost, CODEX_EXPLANATIONS.costFollows)
  }

  const dur = byField.get('duration_minutes')
  if (dur?.verdict === 'bug' && ev.startRaw && ev.endRaw) {
    const exact = Math.max(0, (new Date(ev.endRaw).getTime() - new Date(ev.startRaw).getTime()) / 60000)
    if (dur.legacy === exact && dur.projected === Math.round(exact)) set(dur, CODEX_EXPLANATIONS.durationRounded)
  }

  const intr = byField.get('user_interruptions')
  if (intr?.verdict === 'bug' && intr.legacy === 0 && intr.projected === Math.max(0, ev.userMessages - 1)) {
    set(intr, CODEX_EXPLANATIONS.interruptionsHardcoded)
  }

  const web = byField.get('uses_web_search')
  if (web?.verdict === 'bug' && web.legacy === true && web.projected === false && ev.webSearchCalls > 0
    && !('WebSearch' in (p.meta.tool_counts ?? {}))) set(web, CODEX_EXPLANATIONS.webSearchName)

  // Per-day rows: legacy has no `daily` at all; proven once per session by the days summing back.
  const days = Object.values(p.meta.daily_tokens ?? {})
  const sum = days.reduce((a, d) => ({ input: a.input + d.input, cacheRead: a.cacheRead + d.cacheRead, output: a.output + d.output }),
    { input: 0, cacheRead: 0, output: 0 })
  const daysReconcile = legacy.daily === undefined && tokensExplained && days.every(d => d.cacheWrite === 0)
    && sum.input === counted.input && sum.cacheRead === counted.cacheRead && sum.output === counted.output
  for (const r of rows) {
    if (r.verdict === 'bug' && /^daily\.\d{4}-\d{2}-\d{2}\.tokens$/.test(r.field) && r.legacy === undefined && daysReconcile) {
      set(r, CODEX_EXPLANATIONS.dailyNew)
    }
  }
}

/** PURE. Every row for one rollout: the shared row builders, then the Codex explanations. */
export function compareCodexSession(input: {
  sessionId: string; legacy: SessionMeta; projection: SessionMetaProjection; evidence: CodexEvidence
}): SessionDiff {
  const { sessionId, legacy, projection, evidence } = input
  const rows = [
    ...compareTokens(legacy, projection),
    ...compareTime(legacy, projection),
    ...compareTools(sessionId, legacy, projection),
  ]
  explain(rows, legacy, projection, evidence)
  return { sessionId, rows }
}

// ── IO: run it over a store ─────────────────────────────────────────────────────────────────────

export interface CodexDifferentialOptions {
  /** A Codex `sessions` directory. Read only. */
  sessionsDir: string
  /** A rollout written to more recently than this is live and skipped (default 60 s). */
  settledMs?: number
  now?: () => number
  onSession?: (d: SessionDiff) => void
  keepDiffs?: boolean
}

export interface CodexDifferentialReport extends DifferentialReport {
  /** Rollouts the adapter itself publishes nothing for (no usable line, or no start time). */
  unpublished: number
  /** Rollouts whose cumulative counters went down at least once. */
  resets: number
  diffs?: SessionDiff[]
}

export async function runCodexDifferential(opts: CodexDifferentialOptions): Promise<CodexDifferentialReport> {
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? 60_000
  const skipped = { live: 0, unreadable: 0 }
  let unpublished = 0, resets = 0
  const diffs: SessionDiff[] = []
  const summaries: SessionDiff[] = []

  for (const path of await collectRollouts(opts.sessionsDir)) {
    const st = await fsStat(path).catch(() => null)
    if (!st) { skipped.unreadable++; continue }
    if (now() - st.mtimeMs < settledMs) { skipped.live++; continue }
    let diff: SessionDiff
    try {
      const text = await readFile(path, 'utf-8')
      const legacy = parseCodexRollout(text, fallbackIdOf(path))
      if (!legacy || !legacy.start_time) { unpublished++; continue }
      const ctx = codexContext(rolloutIdOf(path), fallbackIdOf(path), new Date(now()).toISOString())
      const projection = projectCodex(replayCodexRollout(ctx, iterLines(text)))
      const evidence = recountCodex(iterLines(text))
      if (evidence.resets > 0) resets++
      diff = compareCodexSession({ sessionId: legacy.session_id, legacy, projection, evidence })
    } catch {
      skipped.unreadable++
      continue
    }
    opts.onSession?.(diff)
    if (opts.keepDiffs) diffs.push(diff)
    summaries.push({ sessionId: diff.sessionId, rows: diff.rows.map(r => ({ family: r.family, field: r.field, verdict: r.verdict, reason: r.reason })) })
  }
  return { ...summarize(summaries, skipped), unpublished, resets, ...(opts.keepDiffs ? { diffs } : {}) }
}
