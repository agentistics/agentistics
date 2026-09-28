/**
 * projections/differential-kimi.ts — the kimi row of the parity matrix (P1 §1 item 6, P2 §5).
 *
 * For every kimi session this machine holds: the LEGACY `SessionMeta` (`kimi-parse.ts`'s own
 * `accumulateKimiWire`/`buildKimiSession`, over the exact bytes `adapters/kimi.ts` reads) against
 * the PROJECTED one (`createKimiReplay`'s events, folded through the shared, harness-generic
 * `sessionMetaProjection`), field by field — reusing `projections/differential.ts`'s exported
 * `compareSession`/`summarize`/`renderReport` UNCHANGED: they take a plain `SessionMeta` and a
 * `SessionMetaProjection` and know nothing about which harness produced either, so kimi needs no
 * fork of that logic, only its own IO half (this file) and its own post-classification (below).
 *
 * ## Two rows this module reclassifies, and why that is not "explaining away" a bug
 *
 * `compareSession` calls the generic `row()` helper (private to `differential.ts`), which knows
 * nothing about WHY two sides differ — every difference starts as `bug` until something says
 * otherwise. Two families of difference here are not bugs, and each is turned into the more
 * accurate verdict using a fact the PROJECTION itself already states, never a guess this module
 * invents:
 *
 * 1. **The turn-count family** (`user_message_count`, `rounds`, `user_interruptions`,
 *    `user_message_timestamps`, `active_minutes`, `user_response_times`). This kimi adapter version
 *    (1.0.0) emits no `turn.started`/`turn.ended` (`integrations/kimi/replay.ts`'s header explains
 *    why), so `sessionMetaProjection` leaves these fields ABSENT and says so on `caveats` (the field
 *    names `'user_message_count'` and `'active_minutes'`/`'user_response_times'`). Legacy, unlike
 *    Claude before adapter 1.3.0, DOES compute real values for these from `turn.prompt` lines — so
 *    the row is a genuine difference, but its REASON is a declared, versioned absence, not
 *    something wrong with either side's arithmetic. `not-projectable` is the truthful verdict:
 *    "the projection declares this field absent, with its reason" — matching `differential.ts`'s
 *    own vocabulary for `message_hours` etc., just decided PER HARNESS here rather than statically
 *    in `session-meta.ts` (which cannot special-case kimi without a shared change — see the
 *    handback's "SHARED CHANGES REQUESTED": adding `kimi` to `TURNS_SINCE` would let
 *    `user_message_count`/`rounds`/`user_interruptions`/`user_message_timestamps` read EQUAL, since
 *    kimi's `turn.prompt` predicate is exactly D22's; `active_minutes`/`user_response_times` need a
 *    separate check FIRST — see that module's header — before they could ever follow).
 * 2. **`daily.<day>.tokens`**. Legacy's kimi shape has no `daily` breakdown at all (`buildKimiSession`
 *    never sets it); the projection derives one from every harness's event timestamps for free
 *    (`session-meta.ts`'s `main.daily`). Master spec §40 calls this out BY NAME: "the per-UTC-day
 *    slice… exist[s] only for Claude today; a projection that computes them for every harness is
 *    *better*, and every affected figure is an `explained` row rather than a silent improvement."
 *    So a `daily.<day>.tokens` row where legacy is absent and the projection is not is reclassified
 *    to `explained`, proven per-session by construction: the projected day bucket is the sum of
 *    THIS session's own `model.completed` events falling on that UTC day, which is exactly what
 *    `session-meta.ts` computes it as — there is nothing on the legacy side to recount against,
 *    because legacy never attempted the figure.
 *
 * Every OTHER field goes through `compareSession` untouched, including the honest, UNCLASSIFIED
 * (`bug`) `tool_errors`/`tool_error_categories` finding this module's sibling files describe: both
 * sides read 0 on every real session here because `isToolError` (reused verbatim, never
 * reimplemented) checks a shallower field than kimi's real `result.isError` flag — see
 * `integrations/kimi/replay-tools.ts`'s header and this delivery's handback. Because BOTH sides
 * share the same (mis-)reading, the row is `equal` on every session measured, not a bug row in this
 * report — the finding is real but currently invisible to the differential precisely because it is
 * symmetric.
 */
import { readFile, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import { project, sessionCostUSD, totalTokens, type AnyAgentisticsEvent, type SessionMeta } from '@agentistics/core'
import {
  accumulateKimiWire, buildKimiSession, emptyKimiTotals, kimiAgentIds, parseKimiState,
} from '../adapters/kimi-parse'
import { safeReadDir } from '../utils'
import { KIMI_DIR } from '../config'
import { createKimiReplay } from '../integrations/kimi'
import {
  compareSession, summarize, type DifferentialReport, type FieldRow, type SessionDiff,
  stillBeingWritten,
} from './differential'
import { sessionMetaProjection } from './session-meta'

// ── locating sessions (mirrors integrations/kimi/index.ts's own locate — duplicated on purpose:
// that module's is private IO for the replay's `discover()`, this one additionally needs the raw
// legacy bytes, which the replay never reads) ──────────────────────────────────────────────────

interface Located { kimiSessionId: string; dir: string }

async function locateSessions(sessionsDir: string): Promise<Located[]> {
  const workspaces = await safeReadDir(sessionsDir)
  const out: Located[] = []
  for (const ws of workspaces.sort()) {
    const wsPath = join(sessionsDir, ws)
    for (const name of (await safeReadDir(wsPath)).sort()) {
      if (!name.startsWith('session_')) continue
      out.push({ kimiSessionId: name.slice('session_'.length), dir: join(wsPath, name) })
    }
  }
  return out
}

async function readWorkDirIndex(indexFile: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const text = await readFile(indexFile, 'utf-8').catch(() => '')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line) as { sessionDir?: string; workDir?: string }
      if (d.sessionDir && d.workDir) map.set(d.sessionDir, d.workDir)
    } catch { /* skip a malformed index line */ }
  }
  return map
}

/** Legacy's own read of one session — the exact walk `adapters/kimi.ts`'s `loadSessions` performs,
 *  for a single session directory instead of every one on the machine. */
async function legacySessionMeta(
  kimiSessionId: string, dir: string, workDirFallback: string,
): Promise<SessionMeta | null> {
  const state = parseKimiState(await readFile(join(dir, 'state.json'), 'utf-8').catch(() => ''))
  const totals = emptyKimiTotals()
  for (const agentId of kimiAgentIds(state)) {
    const wirePath = join(dir, 'agents', agentId, 'wire.jsonl')
    const text = await readFile(wirePath, 'utf-8').catch(() => null)
    if (text === null) continue
    accumulateKimiWire(text, totals, { main: agentId === 'main' })
  }
  return buildKimiSession(kimiSessionId, state, totals, workDirFallback)
}

// ── the two reclassifications this harness's absence table needs ───────────────────────────────

const TURN_COUNT_FIELDS = new Set(['user_message_count', 'rounds', 'user_interruptions', 'user_message_timestamps'])
const TURN_TIME_FIELDS = new Set(['active_minutes', 'user_response_times'])
const DAILY_TOKENS_RE = /^daily\.\d{4}-\d{2}-\d{2}\.tokens$/

function applyKimiClassification(rows: FieldRow[], caveats: readonly { field: string; reason: string }[]): void {
  const caveatReason = (field: string): string | undefined => caveats.find(c => c.field === field)?.reason

  for (const r of rows) {
    if (r.verdict !== 'bug') continue

    if (TURN_COUNT_FIELDS.has(r.field)) {
      const reason = caveatReason('user_message_count')
      if (reason) { r.verdict = 'not-projectable'; r.reason = reason }
      continue
    }
    if (TURN_TIME_FIELDS.has(r.field)) {
      const reason = caveatReason(r.field) ?? caveatReason('active_minutes') ?? caveatReason('user_response_times')
      if (reason) { r.verdict = 'not-projectable'; r.reason = reason }
      continue
    }
    if (DAILY_TOKENS_RE.test(r.field) && r.legacy === undefined && r.projected !== undefined) {
      r.verdict = 'explained'
      r.reason = 'master spec §40: per-UTC-day token slicing is new for kimi — legacy\'s kimi shape '
        + 'never computed a `daily` breakdown at all, so this bucket is derived from this session\'s '
        + 'own model.completed timestamps, which is the improvement §40 declares rather than a '
        + 'silent one'
    }
  }
}

// ── the subagent family: legacy folds every agent into one session, with no agentMetrics ─────────

export const KIMI_EXPLANATIONS = {
  lastModel:
    'legacy names a kimi session after the model of the LAST usage.record it reads (agents are read '
    + 'main-first), so a subagent\'s model can name the whole session; the projection names it after the '
    + 'main agent\'s first model — proven per session: legacy\'s model is one a subagent reported',
  lastModelCost:
    'legacy prices the whole session at that last-read (subagent) model; the projected counters priced at '
    + 'legacy\'s model reproduce legacy\'s figure exactly, so the difference is the model choice alone '
    + '(costByDimension prices every response at its own model)',
  subagentNew:
    'a kimi subagent is a child Agent under the run (P2), an improvement over legacy, which has no '
    + 'agentMetrics for kimi; its tokens are ALREADY in the session totals (legacy\'s all-agents rule), so '
    + 'a reader must not add them again — proven per session: the totals equal the subagents\' own '
    + 'model.completed sums',
} as const

interface SubagentEvidence {
  /** Agent ids that are not the main agent (the projection's own invocation keys). */
  subIds: Set<string>
  /** Models the subagents reported. */
  subModels: Set<string>
  /** Tokens (all four counters) the subagents' responses carried. */
  subTokens: number
}

function subagentEvidence(events: readonly AnyAgentisticsEvent[], subIds: Set<string>): SubagentEvidence {
  const subModels = new Set<string>()
  let subTokens = 0
  for (const e of events) {
    if (e.type !== 'model.completed' || !e.agentId || !subIds.has(e.agentId)) continue
    const d = e.data as { model?: string; usage?: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>> }
    if (d.model) subModels.add(d.model)
    const u = d.usage ?? {}
    subTokens += totalTokens({ input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 })
  }
  return { subIds, subModels, subTokens }
}

function applyKimiSubagentClassification(
  rows: FieldRow[], legacy: SessionMeta, projected: SessionMeta, events: readonly AnyAgentisticsEvent[],
): void {
  const invocations = projected.agentMetrics?.invocations ?? []
  const subIds = new Set(invocations.map(i => i.agentId).filter((x): x is string => !!x))
  if (subIds.size === 0) return
  const ev = subagentEvidence(events, subIds)
  const legacyModel = legacy.model
  for (const r of rows) {
    if (r.verdict !== 'bug') continue
    if (r.field === 'model' && typeof legacyModel === 'string' && ev.subModels.has(legacyModel) && r.projected === projected.model) {
      r.verdict = 'explained'; r.reason = KIMI_EXPLANATIONS.lastModel; continue
    }
    if (r.field === 'costUSD' && typeof legacyModel === 'string' && ev.subModels.has(legacyModel)
      && sessionCostUSD({ ...projected, model: legacyModel }) === r.legacy) {
      r.verdict = 'explained'; r.reason = KIMI_EXPLANATIONS.lastModelCost; continue
    }
    if (r.field.startsWith('agentMetrics.') && legacy.agentMetrics === undefined) {
      const am = projected.agentMetrics
      const proven = !!am && am.totalInvocations === subIds.size && am.totalTokens === ev.subTokens
      if (proven) { r.verdict = 'explained'; r.reason = KIMI_EXPLANATIONS.subagentNew }
    }
  }
}

// ── running it over a real store ────────────────────────────────────────────────────────────────

export interface KimiDifferentialOptions {
  /** A kimi `sessions` directory (`~/.kimi-code/sessions`). Read only. */
  sessionsDir: string
  /** A kimi `session_index.jsonl` (the workDir fallback). Default: `<KIMI_DIR>/session_index.jsonl`. */
  indexFile?: string
  /** Restrict to these kimi session ids. */
  sessionIds?: readonly string[]
  /** A session touched more recently than this is live and skipped (default 60s). */
  settledMs?: number
  /** Default `Date.now`. */
  now?: () => number
  onSession?: (d: SessionDiff) => void
  /** Keep every per-session diff on the result (tests); a real-store run keeps only the summary. */
  keepDiffs?: boolean
}

export async function runKimiDifferential(
  opts: KimiDifferentialOptions,
): Promise<DifferentialReport & { diffs?: SessionDiff[] }> {
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? 60_000
  const indexFile = opts.indexFile ?? join(KIMI_DIR, 'session_index.jsonl')
  const only = opts.sessionIds ? new Set(opts.sessionIds) : undefined

  // The REPLAY side runs with settledMs: 0 — by the time we reach it below we have already decided,
  // on the REAL settledMs, that this session is not live, so the replay may treat it as settled
  // immediately (final: true on the first call) rather than waiting out a second clock of its own.
  const replay = createKimiReplay({ sessionsDir: opts.sessionsDir, indexFile, now, settledMs: 0 })
  const workDirIndex = await readWorkDirIndex(indexFile)

  const summaries: SessionDiff[] = []
  const diffs: SessionDiff[] = []
  const skipped = { live: 0, unreadable: 0 }

  for (const { kimiSessionId, dir } of await locateSessions(opts.sessionsDir)) {
    if (only && !only.has(kimiSessionId)) continue

    const stateSt = await fsStat(join(dir, 'state.json')).catch(() => null)
    let latestMtimeMs = stateSt?.mtimeMs ?? 0
    for (const agentId of kimiAgentIds(parseKimiState(await readFile(join(dir, 'state.json'), 'utf-8').catch(() => '')))) {
      const st = await fsStat(join(dir, 'agents', agentId, 'wire.jsonl')).catch(() => null)
      if (st) latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs)
    }
    if (latestMtimeMs > 0 && stillBeingWritten(now(), latestMtimeMs, settledMs)) { skipped.live++; continue }

    let diff: SessionDiff
    try {
      const legacy = await legacySessionMeta(kimiSessionId, dir, workDirIndex.get(dir) ?? '')
      if (!legacy) { skipped.unreadable++; continue }

      const batch = await replay.replay({ sessionId: kimiSessionId, sourceRef: `kimi:${kimiSessionId}` }, null)
      const projection = project(sessionMetaProjection, batch.events as AnyAgentisticsEvent[])

      diff = compareSession({ sessionId: kimiSessionId, legacy, projection })
      applyKimiClassification(diff.rows, projection.caveats)
      applyKimiSubagentClassification(diff.rows, legacy, projection.meta as SessionMeta, batch.events as AnyAgentisticsEvent[])
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
