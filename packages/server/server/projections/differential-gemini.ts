/**
 * projections/differential-gemini.ts — the Gemini row of the parity matrix (P1 §8, P2 §5, master
 * §40), on the SAME shape `projections/differential.ts` established for Claude, following the
 * pattern `differential-copilot.ts` already applies for a harness with no subagents either.
 *
 * `compareTokens` / `compareTime` / `compareTools` (differential.ts, exported) are generic over
 * `SessionMeta` / `SessionMetaProjection` and reused wholesale, with NO evidence parameter (Gemini
 * has no per-response dedup trap the way Claude's `usage-dedupe.ts` does — each 'gemini' message in
 * the rich-json shape is one billed response, counted once). What is Gemini-specific is layered on
 * TOP, as a `reclassify` pass over the rows those three functions already produced:
 *
 * 1. **The human-turn family** (`user_message_count`/`rounds`/`user_interruptions`/
 *    `user_message_timestamps`/`active_minutes`/`user_response_times`) — this integration emits no
 *    `turn.started`/`turn.ended` (out of scope for this wave; see the handback), and
 *    `session-meta.ts`'s `TURNS_SINCE`/`TURN_END_SINCE` tables carry no `gemini` entry, so these
 *    fields are structurally NOT-PROJECTABLE for this harness today — reclassified as such rather
 *    than left as a `bug`. (SHARED CHANGE, if a later wave adds `turn.*` for gemini: add a `gemini`
 *    row to both tables the same day.)
 * 2. **`tool_errors`/`tool_error_categories`** — legacy (`gemini-parse.ts`) hardcodes `tool_errors:
 *    0` and `tool_error_categories: {}` UNCONDITIONALLY for both file shapes: it never reads
 *    `toolCalls[].status` at all. This replay's rich-json fold DOES read it (`status: 'error'` ->
 *    `tool.failed`), which is real information legacy discards, not a wrong number — an
 *    independent recount of `toolCalls[].status === 'error'` in the raw bytes (excluding
 *    `'cancelled'`, which `session-meta.ts`'s finish also excludes from `tool_errors`) equal to the
 *    projected count, with legacy always 0, proves it a NEW capability rather than a divergence.
 * 3. **`model`** — legacy's `parseRichJson` loop OVERWRITES `model` on every `'gemini'` message it
 *    walks, so it ends up holding the LAST message's model; the projection's `firstModel` (picked
 *    by the EARLIEST order key, `session-meta.ts`) holds the FIRST. They agree whenever a session
 *    used one model throughout (the common case) and can diverge on a genuine mid-session model
 *    switch — proven per session by an independent recount of every `'gemini'` message's `model`
 *    field in the raw bytes.
 * 4. **`duration_minutes`** — `gemini-parse.ts` computes it UNROUNDED
 *    (`(lastUpdated - startTime) / 60000`, both file shapes); `session-meta.ts`'s projection rounds
 *    to the nearest minute. Proven per session: `Math.round(legacy) === projected`.
 * 5. **`daily.<day>.tokens`** — Gemini's legacy `SessionMeta` carries no `daily` field at all
 *    (neither `parseRichJson` nor `buildJsonlSessionMeta` sets one); the projection derives buckets
 *    from each `model.completed`'s own day (rich-json shape only — the jsonl shape emits none).
 *    Per P2 §3 this is the DECLARED gap ("per-UTC-day slicing is new for non-Claude harnesses... an
 *    explained row, not a silent improvement"), reclassified `explained` whenever legacy has no day
 *    series at all and the projection does.
 * 6. **`costUSD` — the price CONSEQUENCE of #3.** Both sides sum the identical raw token totals
 *    (`gemini-parse.ts` and this replay's `main.tokens` both add every 'gemini' message's tokens
 *    with no per-model split), so a cost divergence during a model switch is entirely the pricing
 *    TABLE reading the two model ids differently — proven by repricing legacy's own counters at the
 *    PROJECTED model (`models.first`) and checking the result equals the projected cost exactly.
 *
 * Every explanation above is applied ONLY when its own recount proves it for THAT session; a
 * divergence the recount does not reproduce stays a `bug`, named by field and session id.
 *
 * `project_path` / `session_id` / `harness` are not compared here at all: `compareTokens` /
 * `compareTime` / `compareTools` never touch them (verified by reading their bodies), so there is
 * nothing to reclassify for those fields, even though the replay was written to match them exactly
 * (see `replay.ts`'s `projectPath: ctx.projectPath ?? ''`, never omitted for an empty string).
 *
 * The store is only ever READ; the report names session ids and field names, never content.
 */
import { readFile, stat as fsStat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { project, sessionCostUSD, type AnyAgentisticsEvent, type SessionMeta } from '@agentistics/core'
import { parseGeminiChat } from '../adapters/gemini-parse'
import { safeReadDir, safeReadJson } from '../utils'
import { createGeminiReplay } from '../integrations/gemini'
import {
  compareTokens, compareTime, compareTools, summarize, renderReport,
  type DifferentialReport, type FieldRow, type SessionDiff,
} from './differential'
import { sessionMetaProjection, type SessionMetaProjection } from './session-meta'

// ── Gemini-specific explanations, each with its own per-session proof (see this module's header) ──

export const GEMINI_EXPLANATIONS = {
  turnsNotEmitted:
    "this integration emits no turn.started/turn.ended (out of scope for this wave), and session-meta.ts's "
    + "TURNS_SINCE/TURN_END_SINCE tables carry no gemini entry either way, so the field is not-projectable "
    + 'for this harness today, not a proven-wrong number',
  toolErrorsNewCapability:
    "gemini-parse.ts never reads toolCalls[].status and hardcodes tool_errors: 0 / tool_error_categories: {} "
    + "for both file shapes; the replay's rich-json fold reads status: 'error' as tool.failed, which is real "
    + 'information legacy discards — an independent recount of toolCalls[].status === \'error\' (excluding '
    + "'cancelled') in the raw bytes equals the projected count exactly, and legacy's side is always 0/{}",
  modelSwitch:
    "legacy's parseRichJson loop overwrites `model` on every 'gemini' message, ending on the LAST one; the "
    + 'projection keeps the FIRST (by order key); the recount of every message\'s `model` field in the raw '
    + 'bytes reproduces both',
  costFollowsModel:
    'the price consequence of the model-switch difference above: both sides sum the identical raw token '
    + 'totals, and repricing legacy at the PROJECTED (first) model equals the projected cost exactly',
  durationRounding:
    'gemini-parse.ts computes duration_minutes UNROUNDED ((lastUpdated - startTime) / 60000, both file '
    + "shapes); session-meta.ts's projection rounds to the nearest minute; round(legacy) equals the "
    + 'projected value exactly',
  dailyIsNewCapability:
    'per-UTC-day slicing is new for Gemini (P2 §3, declared): legacy carries no daily field at all, the '
    + "projection derives one bucket per model.completed event's own day (rich-json shape only) — a new "
    + 'capability, not a divergence',
} as const

const TURN_FIELDS = new Set([
  'user_message_count', 'rounds', 'user_interruptions', 'user_message_timestamps',
  'active_minutes', 'user_response_times',
])

// ── Evidence: an independent recount of the raw bytes, sharing no code with either side ──────────

interface GeminiRichMessage {
  type?: unknown
  model?: unknown
  toolCalls?: Array<{ status?: unknown }>
}

/** Attempts a rich-json parse of `content`; `null` for the jsonl shape (or anything unparsable) —
 *  the only shape that can ever carry `toolCalls`/`model` in the first place. */
function tryParseRichJson(content: string): { messages: GeminiRichMessage[] } | null {
  const trimmed = content.trim()
  if (!trimmed || trimmed[0] !== '{') return null
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const messages = (parsed as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return null
  return { messages: messages as GeminiRichMessage[] }
}

/** Every `toolCalls[].status === 'error'` across every message — the proof for reason #2. Never
 *  counts `'cancelled'`, matching `session-meta.ts`'s own exclusion from `tool_errors`. */
export function countGeminiToolErrors(content: string): number {
  const root = tryParseRichJson(content)
  if (!root) return 0
  let n = 0
  for (const msg of root.messages) {
    if (msg?.type !== 'gemini' || !Array.isArray(msg.toolCalls)) continue
    for (const tc of msg.toolCalls) if (tc?.status === 'error') n++
  }
  return n
}

/** The first and last `model` named by any `'gemini'` message, in array order — the proof for #3. */
export function recountGeminiModels(content: string): { first?: string; last?: string } {
  const root = tryParseRichJson(content)
  if (!root) return {}
  let first: string | undefined
  let last: string | undefined
  for (const msg of root.messages) {
    if (msg?.type !== 'gemini' || typeof msg.model !== 'string' || !msg.model) continue
    if (first === undefined) first = msg.model
    last = msg.model
  }
  return { first, last }
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** PURE. Reclassify the Gemini-specific rows on top of the generic comparison — see the header.
 *  `legacy` is needed only for the `costUSD` rule (#6), which reprices legacy's own counters. */
export function reclassifyGeminiRows(rows: FieldRow[], content: string, legacy?: SessionMeta): FieldRow[] {
  const toolErrorCount = countGeminiToolErrors(content)
  const models = recountGeminiModels(content)

  return rows.map(r => {
    // TURN_FIELDS are reclassified UNCONDITIONALLY, even a row that happens to read 'equal' — the
    // field is not-projectable for this harness as a fact about the vocabulary, not a per-session
    // coincidence, and leaving an accidental 'equal' stand would claim a capability that is absent
    // (same rule differential-copilot.ts's reclassifyCopilotRows applies for the identical reason).
    if (TURN_FIELDS.has(r.field)) {
      if (r.verdict === 'not-projectable' && r.reason === GEMINI_EXPLANATIONS.turnsNotEmitted) return r
      return { ...r, verdict: 'not-projectable' as const, reason: GEMINI_EXPLANATIONS.turnsNotEmitted }
    }

    if (r.field === 'costUSD' && r.verdict === 'bug' && legacy && typeof r.projected === 'number'
      && models.first && models.first !== models.last) {
      const repriced = sessionCostUSD({ ...legacy, model: models.first })
      if (repriced === r.projected) {
        return { ...r, verdict: 'explained' as const, reason: GEMINI_EXPLANATIONS.costFollowsModel }
      }
      return r
    }

    if (r.verdict !== 'bug') return r

    if (r.field === 'tool_errors') {
      if (r.legacy === 0 && r.projected === toolErrorCount) {
        return { ...r, verdict: 'explained' as const, reason: GEMINI_EXPLANATIONS.toolErrorsNewCapability }
      }
      return r
    }
    if (r.field === 'tool_error_categories') {
      // Consequence of #2: legacy is always {}, so this row is only a 'bug' when the projected side
      // is non-empty — which happens exactly when tool_errors above is also a (now-explained) bug.
      if (same(r.legacy, {}) && r.projected !== undefined) {
        return { ...r, verdict: 'explained' as const, reason: GEMINI_EXPLANATIONS.toolErrorsNewCapability }
      }
      return r
    }

    if (r.field === 'model' && typeof r.legacy === 'string') {
      if (r.legacy === models.last && r.projected === models.first && models.first !== models.last) {
        return { ...r, verdict: 'explained' as const, reason: GEMINI_EXPLANATIONS.modelSwitch }
      }
      return r
    }

    if (r.field === 'duration_minutes' && typeof r.legacy === 'number' && typeof r.projected === 'number') {
      if (Math.round(r.legacy) === r.projected) {
        return { ...r, verdict: 'explained' as const, reason: GEMINI_EXPLANATIONS.durationRounding }
      }
      return r
    }

    if (r.field.startsWith('daily.') && r.legacy === undefined && r.projected !== undefined) {
      return { ...r, verdict: 'explained' as const, reason: GEMINI_EXPLANATIONS.dailyIsNewCapability }
    }

    return r
  })
}

/** PURE. Every row for one Gemini session. */
export function compareGeminiSession(input: {
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
  return { sessionId, rows: reclassifyGeminiRows(rows, content, legacy) }
}

// ── IO: run it over a store ─────────────────────────────────────────────────────────────────────

export interface GeminiDifferentialOptions {
  /** `~/.gemini` (or its override) — read only. */
  geminiDir: string
  /** Restrict to these session ids (the synthetic `<project>/<file>` form). */
  sessionIds?: readonly string[]
  /** A chat file written to more recently than this is live and skipped (default 60 s). */
  settledMs?: number
  /** Default `Date.now`. */
  now?: () => number
  /** Called once per session compared. */
  onSession?: (d: SessionDiff) => void
  /** Keep every per-session diff on the result (tests); a real-store run keeps only the summary. */
  keepDiffs?: boolean
}

export interface GeminiDifferentialReport extends DifferentialReport {
  /** Chat files whose shape this replay could classify, by P2 §2's own wording ("the shape is
   *  recorded per run"). Every compared session falls into exactly one bucket. */
  shapes: { richJson: number; jsonl: number; empty: number; unknown: number }
}

interface DiscoveredFile { file: string; sessionId: string; projectPath: string }

async function discoverFiles(geminiDir: string): Promise<DiscoveredFile[]> {
  const tmpDir = join(geminiDir, 'tmp')
  const projectsData = await safeReadJson<{ projects?: Record<string, string> }>(join(geminiDir, 'projects.json'))
  const projectMap = new Map<string, string>()
  if (projectsData?.projects) {
    for (const [absPath, shortName] of Object.entries(projectsData.projects)) projectMap.set(shortName, absPath)
  }
  const topDirs = await safeReadDir(tmpDir)
  const out: DiscoveredFile[] = []
  for (const dirName of topDirs) {
    if (dirName === 'bin') continue
    const chatsDir = join(tmpDir, dirName, 'chats')
    const files = await safeReadDir(chatsDir)
    for (const name of files) {
      if (!name.endsWith('.jsonl') && !name.endsWith('.json')) continue
      const fileBase = basename(name).replace(/\.(jsonl|json)$/, '')
      out.push({ file: join(chatsDir, name), sessionId: `${dirName}/${fileBase}`, projectPath: projectMap.get(dirName) ?? '' })
    }
  }
  return out
}

/** Mirrors `detectGeminiShape` (`integrations/gemini/replay.ts`) closely enough to bucket a chat
 *  file for the report — deliberately NOT imported, so this evidence module shares no code with
 *  the side it is checking. */
function shapeOf(content: string): 'richJson' | 'jsonl' | 'empty' | 'unknown' {
  const trimmed = content.trim()
  if (!trimmed) return 'empty'
  if (trimmed[0] !== '{') return 'unknown'
  if (trimmed.indexOf('\n') === -1) return 'richJson'
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).messages)) return 'richJson'
  } catch { /* falls through to jsonl */ }
  return 'jsonl'
}

export async function runGeminiDifferential(opts: GeminiDifferentialOptions): Promise<GeminiDifferentialReport> {
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? 60_000
  const replay = createGeminiReplay({ geminiDir: opts.geminiDir, now })
  const only = opts.sessionIds ? new Set(opts.sessionIds) : undefined
  const diffs: SessionDiff[] = []
  const summaries: SessionDiff[] = []
  const skipped = { live: 0, unreadable: 0 }
  const shapes = { richJson: 0, jsonl: 0, empty: 0, unknown: 0 }

  for (const f of await discoverFiles(opts.geminiDir)) {
    if (only && !only.has(f.sessionId)) continue
    const content = await readFile(f.file, 'utf-8').catch(() => null)
    if (content === null) { skipped.unreadable++; continue }

    // "settled" is judged by the FILE's mtime, the same rule every other differential uses — a
    // gemini rich-json file is rewritten whole on every save, so a fresh mtime means "still being
    // written", exactly as it does for an append-only transcript.
    const st = await fsStat(f.file).catch(() => null)
    if (!st) { skipped.unreadable++; continue }
    if (now() - st.mtimeMs < settledMs) { skipped.live++; continue }

    const shape = shapeOf(content)
    shapes[shape]++

    let diff: SessionDiff
    try {
      const legacy = parseGeminiChat(content, f.sessionId, f.projectPath)
      if (!legacy) continue // a bootstrap-only / unreadable file — legacy publishes no session at all
      const batch = await replay.replay({ sessionId: f.sessionId, sourceRef: `gemini:${f.sessionId}` }, null)
      const projection = project(sessionMetaProjection, batch.events as AnyAgentisticsEvent[])
      diff = compareGeminiSession({ sessionId: f.sessionId, legacy, projection, content })
    } catch {
      skipped.unreadable++
      continue
    }
    opts.onSession?.(diff)
    if (opts.keepDiffs) diffs.push(diff)
    summaries.push({ sessionId: diff.sessionId, rows: diff.rows.map(r => ({ family: r.family, field: r.field, verdict: r.verdict, reason: r.reason })) })
  }
  const report = summarize(summaries, skipped)
  return { ...report, shapes, ...(opts.keepDiffs ? { diffs } : {}) }
}

export { renderReport }
