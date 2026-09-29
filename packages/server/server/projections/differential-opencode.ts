/**
 * projections/differential-opencode.ts — the parity row for opencode (P2 §5, CLAUDE.md step 17).
 *
 * opencode has NO legacy adapter (step 4, skipped by scope), so there is no `parseXRollout` to read
 * as "the legacy side" the way every other `differential-<id>.ts` in this repo does. Both sides of
 * this comparison are therefore built here, from scratch, over the SAME raw SQLite rows:
 *
 * - the PROJECTED side: the real replay's events (`integrations/opencode/index.ts`'s
 *   `orderedRecords` + `replay.ts`'s fold — the actual production code path), folded through
 *   `sessionMetaProjection` exactly as every other differential does;
 * - the "legacy" side: `recountOpencode`, a hand-written recount that opens `message`/`part` rows
 *   ITSELF, parses their `data` JSON ITSELF, and sums tokens / counts turns / counts tools / finds
 *   start-end / picks a model with its OWN loop — sharing no function with `replay.ts`'s fold. Its
 *   only imports from this integration are the entity-id helpers (`opencodeContext`) needed to run
 *   the SAME projection pipeline every other differential runs, which is the harness of the test,
 *   not the thing under test.
 *
 * A `bug` here is real: there is no adapter defect to blame it on, only a disagreement between two
 * independent readings of the same rows — which is exactly what this file exists to catch before
 * either one ships.
 */
import { Database } from 'bun:sqlite'
import {
  project,
  type AnyAgentisticsEvent, type SessionMeta,
} from '@agentistics/core'
import { OPENCODE_DB_PATH } from '../config'
import { canonicalTool } from '../harness-activity'
import { orderedRecords } from '../integrations/opencode'
import { opencodeContext } from '../integrations/opencode/replay-core'
import { emptyOpencodeReplay, finishOpencodeReplay, foldOpencodeReplay } from '../integrations/opencode/replay'
import {
  compareSession, summarize, type DifferentialReport, type FieldRow, type SessionDiff,
} from './differential'
import { sessionMetaProjection, type SessionMetaProjection } from './session-meta'

// ── Reading the store (IO) ──────────────────────────────────────────────────────────────────────

interface RawSession { id: string; directory: string | null; version: string | null; time_created: number }
interface RawMessage { id: string; time_created: number; data: string }
interface RawPart { id: string; message_id: string; time_created: number; time_updated: number; data: string }

function openReadOnly(path: string): any | null {
  try {
    return new Database(path, { readonly: true })
  } catch {
    return null
  }
}

function readSessions(db: any): RawSession[] {
  try { return db.query('SELECT id, directory, version, time_created FROM session ORDER BY id').all() as RawSession[] } catch { return [] }
}
function readMessages(db: any, sessionId: string): RawMessage[] {
  try {
    return db.query('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as RawMessage[]
  } catch { return [] }
}
function readParts(db: any, sessionId: string): RawPart[] {
  try {
    return db.query('SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as RawPart[]
  } catch { return [] }
}

// ── The independent recount — no import from replay.ts, no shared loop ────────────────────────

interface Tokens4 { input: number; output: number; cacheRead: number; cacheWrite: number }
const zero4 = (): Tokens4 => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export interface OpencodeRecount {
  startMs?: number
  endMs?: number
  model?: string
  tokens: Tokens4
  userMessageCount: number
  userMessageTimestamps: string[]
  userResponseTimes: number[]
  activeMinutesMs: number
  activeMinutesOpen: boolean
  toolCounts: Record<string, number>
  toolErrors: number
  toolErrorCategories: Record<string, number>
}

interface Turn { at: number }

/**
 * PURE. Its own JSON parse, its own tokens sum, its own turn walk, its own tool count — none of it
 * calls into `replay.ts`. Written directly from the schema measured on the real store (session/
 * message/part, verified against `opencode.db` on this machine: 2 sessions / 39 messages / 114
 * parts), never from what `replay.ts` happens to compute.
 */
export function recountOpencode(
  sessionTimeCreated: number, messages: readonly RawMessage[], parts: readonly RawPart[],
): OpencodeRecount {
  // The session ROW's own `time_created` is the true start — it is stamped when opencode creates
  // the session record, a few ms BEFORE the first message is written (measured on the real store:
  // 17ms on one session). `session.started.occurredAt` in the replay uses this same column
  // (`finishOpencodeReplay`'s `session.startedAtMs`), so a recount that started counting from the
  // first MESSAGE instead was a bug in the recount, not a disagreement worth reporting — caught by
  // running this differential against the real store, exactly as it exists to catch.
  let startMs: number | undefined = sessionTimeCreated, endMs: number | undefined = sessionTimeCreated
  const touch = (ms: number): void => {
    if (startMs === undefined || ms < startMs) startMs = ms
    if (endMs === undefined || ms > endMs) endMs = ms
  }

  const tokens = zero4()
  let model: string | undefined
  let modelAt: number | undefined

  interface Item { at: number; role: 'user' | 'assistant'; settledAt?: number; ok?: boolean }
  const items: Item[] = []

  for (const m of messages) {
    let d: {
      role?: string
      time?: { created?: number; completed?: number }
      modelID?: string
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      finish?: string
      error?: { name?: string }
    }
    try { d = JSON.parse(m.data) } catch { continue }
    touch(m.time_created)
    if (d.role === 'user') {
      items.push({ at: m.time_created, role: 'user' })
      continue
    }
    if (d.role !== 'assistant') continue
    const settled = Boolean(d.finish || d.error?.name)
    if (!settled) { items.push({ at: m.time_created, role: 'assistant' }); continue }
    const settledAt = d.time?.completed ?? m.time_created
    touch(settledAt)
    items.push({ at: m.time_created, role: 'assistant', settledAt, ok: !d.error?.name })
    if (!d.error?.name) {
      tokens.input += d.tokens?.input ?? 0
      tokens.output += d.tokens?.output ?? 0
      tokens.cacheRead += d.tokens?.cache?.read ?? 0
      tokens.cacheWrite += d.tokens?.cache?.write ?? 0
      if (d.modelID && (modelAt === undefined || m.time_created < modelAt)) { model = d.modelID; modelAt = m.time_created }
    }
  }

  const toolCounts: Record<string, number> = {}
  const toolErrorCategories: Record<string, number> = {}
  let toolErrors = 0
  for (const p of parts) {
    let d: { type?: string; tool?: string; state?: { status?: string } }
    try { d = JSON.parse(p.data) } catch { continue }
    touch(p.time_created)
    touch(p.time_updated)
    if (d.type !== 'tool' || !d.tool) continue
    const canonical = canonicalTool('opencode', d.tool)
    if (d.state?.status === 'completed' || d.state?.status === 'error') {
      toolCounts[canonical] = (toolCounts[canonical] ?? 0) + 1
    }
    if (d.state?.status === 'error') {
      toolErrors++
      toolErrorCategories[canonical] = (toolErrorCategories[canonical] ?? 0) + 1
    }
  }

  // The turn walk — independent of `closeTurn`/`foldUserMessage` in replay.ts. A turn opens at a
  // user message and closes at the last SETTLED assistant reply seen before the next user message
  // (falling back to the last touched timestamp of any kind, then to nothing if none exists) —
  // `close: 'last-line'` is the ONLY case opencode ever produces (see replay.ts's header), so this
  // recount need not reproduce the 'measured' branch of `turnTime`/`computeActiveTime` at all.
  items.sort((a, b) => a.at - b.at)
  const userMessageTimestamps: string[] = []
  const userResponseTimes: number[] = []
  let activeMinutesMs = 0
  let activeMinutesOpen = false
  let lastSessionAssistantAt: number | undefined
  let turnStart: number | undefined
  let turnLastAssistant: number | undefined
  let turnLastAny: number | undefined

  const closeOpenTurn = (): void => {
    if (turnStart === undefined) return
    const closeAt = turnLastAssistant ?? turnLastAny
    if (closeAt !== undefined) activeMinutesMs += Math.max(0, closeAt - turnStart)
    else activeMinutesOpen = true
    turnStart = undefined; turnLastAssistant = undefined; turnLastAny = undefined
  }

  for (const it of items) {
    if (it.role === 'user') {
      closeOpenTurn()
      if (lastSessionAssistantAt !== undefined) {
        const deltaSec = (it.at - lastSessionAssistantAt) / 1000
        if (deltaSec >= 0 && deltaSec < 3600) userResponseTimes.push(Math.round(deltaSec))
      }
      userMessageTimestamps.push(new Date(it.at).toISOString())
      turnStart = it.at
      turnLastAny = it.at
      continue
    }
    // assistant
    if (turnLastAny === undefined || it.at > turnLastAny) turnLastAny = it.at
    if (it.settledAt !== undefined) {
      if (turnLastAny === undefined || it.settledAt > turnLastAny) turnLastAny = it.settledAt
      turnLastAssistant = turnLastAssistant === undefined ? it.settledAt : Math.max(turnLastAssistant, it.settledAt)
      lastSessionAssistantAt = lastSessionAssistantAt === undefined ? it.settledAt : Math.max(lastSessionAssistantAt, it.settledAt)
    }
  }
  closeOpenTurn()

  return {
    startMs, endMs, model, tokens,
    userMessageCount: userMessageTimestamps.length,
    userMessageTimestamps, userResponseTimes, activeMinutesMs, activeMinutesOpen,
    toolCounts, toolErrors, toolErrorCategories,
  }
}

/** The recount, shaped into a `SessionMeta` — the "legacy" side `compareSession` compares against.
 *  Fields the events cannot produce at all (`NOT_PROJECTABLE`) get harmless defaults: `np()` records
 *  the value without asserting it, so what is written here for them never affects a verdict. */
export function recountToSessionMeta(sessionId: string, projectPath: string, r: OpencodeRecount): SessionMeta {
  const meta: SessionMeta = {
    session_id: sessionId,
    project_path: projectPath,
    start_time: r.startMs !== undefined ? new Date(r.startMs).toISOString() : '',
    ...(r.endMs !== undefined ? { end_time: new Date(r.endMs).toISOString() } : {}),
    ...(r.startMs !== undefined && r.endMs !== undefined
      ? { duration_minutes: Math.max(0, Math.round((r.endMs - r.startMs) / 60000)) } : {}),
    ...(!r.activeMinutesOpen ? { active_minutes: Math.round(r.activeMinutesMs / 60000) } : {}),
    user_message_count: r.userMessageCount,
    user_interruptions: Math.max(0, r.userMessageCount - 1),
    user_message_timestamps: r.userMessageTimestamps,
    user_response_times: r.userResponseTimes,
    assistant_message_count: 0,
    tool_counts: r.toolCounts,
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: r.tokens.input,
    output_tokens: r.tokens.output,
    cache_read_input_tokens: r.tokens.cacheRead,
    cache_creation_input_tokens: r.tokens.cacheWrite,
    ...(r.model ? { model: r.model } : {}),
    first_prompt: '',
    tool_errors: r.toolErrors,
    tool_error_categories: r.toolErrorCategories,
    uses_task_agent: false,
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: [],
    harness: 'opencode',
  }
  return meta
}

// ── Running it ──────────────────────────────────────────────────────────────────────────────────

export function projectOpencode(events: readonly AnyAgentisticsEvent[]): SessionMetaProjection {
  return project(sessionMetaProjection, events)
}

/** Runs the real replay to completion (`final: true`) over the given rows and projects it. */
export function replayAndProjectOpencode(
  sessionId: string, session: RawSession, messages: readonly RawMessage[], parts: readonly RawPart[], recordedAt: string,
): SessionMetaProjection {
  const ctx = opencodeContext(sessionId, recordedAt)
  const state = emptyOpencodeReplay(ctx)
  const events: AnyAgentisticsEvent[] = []
  foldOpencodeReplay(state, orderedRecords(messages, parts), e => events.push(e as AnyAgentisticsEvent))
  finishOpencodeReplay(state, {
    projectPath: session.directory ?? '', version: session.version ?? undefined, startedAtMs: session.time_created,
  }, { final: true }, e => events.push(e as AnyAgentisticsEvent))
  return projectOpencode(events)
}

const DAILY_TOKENS_FIELD = /^daily\.\d{4}-\d{2}-\d{2}\.tokens$/

/** The reason attached to every `daily.<day>.tokens` bug reclassified below. */
export const OPENCODE_DAILY_EXPLANATION =
  'opencode has no legacy equivalent to compare a day-keyed token split against (this integration '
  + 'has no adapter at all); reclassified only because the projected days sum EXACTLY to the '
  + "projected session totals, proven per session below — never assumed from the field's absence."

/**
 * CLAUDE.md step 17: "A `daily` field with no legacy equivalent is `explained`, never assumed, only
 * once the projected days are proven to sum exactly to the projected totals." There is no legacy
 * `daily` at all here (no adapter writes one), so EVERY `daily.<day>.tokens` row is a `bug` by
 * construction (`row()` compares `undefined` against a real bucket) unless reclassified — and it is
 * reclassified only after re-summing the projection's OWN day buckets and checking them against its
 * OWN totals, right here, per session.
 */
export function reclassifyOpencodeRows(rows: FieldRow[], projection: SessionMetaProjection): FieldRow[] {
  const daily = projection.meta.daily_tokens ?? {}
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const t of Object.values(daily)) {
    sums.input += t.input; sums.output += t.output; sums.cacheRead += t.cacheRead; sums.cacheWrite += t.cacheWrite
  }
  const totalsMatch = sums.input === (projection.meta.input_tokens ?? 0)
    && sums.output === (projection.meta.output_tokens ?? 0)
    && sums.cacheRead === (projection.meta.cache_read_input_tokens ?? 0)
    && sums.cacheWrite === (projection.meta.cache_creation_input_tokens ?? 0)

  return rows.map(r => {
    if (r.verdict === 'bug' && r.family === 'time' && DAILY_TOKENS_FIELD.test(r.field) && totalsMatch) {
      return { ...r, verdict: 'explained', reason: OPENCODE_DAILY_EXPLANATION }
    }
    return r
  })
}

export interface OpencodeDifferentialOptions {
  /** Default `OPENCODE_DB_PATH`. Read only. */
  dbPath?: string
  sessionIds?: readonly string[]
  now?: () => number
  onSession?: (d: SessionDiff) => void
  keepDiffs?: boolean
}

export interface OpencodeDifferentialReport extends DifferentialReport {
  diffs?: SessionDiff[]
}

export async function runOpencodeDifferential(opts: OpencodeDifferentialOptions = {}): Promise<OpencodeDifferentialReport> {
  const dbPath = opts.dbPath ?? OPENCODE_DB_PATH
  const now = opts.now ?? Date.now
  const db = openReadOnly(dbPath)
  const skipped = { live: 0, unreadable: 0 }
  const diffs: SessionDiff[] = []
  const summaries: SessionDiff[] = []
  if (!db) return { ...summarize(summaries, skipped) }

  try {
    const only = opts.sessionIds ? new Set(opts.sessionIds) : null
    const sessions = readSessions(db).filter(s => !only || only.has(s.id))
    for (const session of sessions) {
      const messages = readMessages(db, session.id)
      const parts = readParts(db, session.id)
      const recount = recountOpencode(session.time_created, messages, parts)
      if (recount.startMs === undefined) { skipped.unreadable++; continue }
      const legacy = recountToSessionMeta(session.id, session.directory ?? '', recount)
      const recordedAt = new Date(now()).toISOString()
      const projection = replayAndProjectOpencode(session.id, session, messages, parts, recordedAt)
      let diff = compareSession({ sessionId: session.id, legacy, projection })
      diff = { ...diff, rows: reclassifyOpencodeRows(diff.rows, projection) }
      opts.onSession?.(diff)
      if (opts.keepDiffs) diffs.push(diff)
      summaries.push({ sessionId: diff.sessionId, rows: diff.rows.map(r => ({ family: r.family, field: r.field, verdict: r.verdict, reason: r.reason })) })
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
  return { ...summarize(summaries, skipped), ...(opts.keepDiffs ? { diffs } : {}) }
}
