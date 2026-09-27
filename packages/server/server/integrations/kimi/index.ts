/**
 * integrations/kimi/index.ts — the IO half of the kimi replay.
 *
 * A kimi session is `~/.kimi-code/sessions/<workspaceId>/session_<uuid>/`: `state.json` (title,
 * workDir, createdAt, updatedAt, the agent tree) plus one `agents/<agentId>/wire.jsonl` per agent.
 * `replay.ts`/`replay-model.ts`/`replay-tools.ts` are the PURE fold, one agent's wire at a time (no
 * held state — see their headers); `replay-agents.ts` derives the Session/Run/Agent lifecycle from
 * `state.json` directly. This module decides WHICH bytes reach the fold and WHEN the lifecycle is
 * closed.
 *
 * ## STATED LIMIT: the cursor is WHOLE-FILE, not byte-range
 * Claude's replay (`integrations/claude/index.ts`) resumes a growing transcript from a byte offset,
 * re-verifying an anchor on every append, because Claude transcripts run to tens of megabytes and a
 * live session is polled every few seconds. Kimi's `wire.jsonl` files are small (the largest on this
 * machine's real store is 222 lines) and this integration's fold holds NO cross-line state to carry
 * across a resume (`replay.ts`'s header) — so the cost of the simpler design below is a full re-read
 * of one small file on every change, not a correctness risk. Each agent's cursor here is therefore
 * just `{size, mtimeMs, lineNo}`: unchanged (same size and mtime) skips the file entirely and emits
 * nothing; anything else re-reads and re-folds the WHOLE file from line 1. Every id `replay-core.ts`
 * derives is a hash of the SOURCE RECORD, so re-emitting an event already seen re-derives the
 * identical `eventId` and the journal downstream dedupes it — a re-read is never a correctness
 * fallback, only a cost. Byte-range resuming (mirroring the Claude approach exactly) is a reasonable
 * future optimisation once a real kimi store is measured at a size where it matters; noted, not done.
 *
 * ## Lifecycle facts are re-emitted on every call, on purpose
 * `session.started`/`run.started`/`agent.started` (and, once settled, their `*.ended` pair) come
 * from `state.json`, which is cheap to re-read, and their ids are deterministic — so this module
 * does not bother tracking "have I said this already"; it says it every call, and the journal's own
 * idempotency absorbs the repeats. See `replay-agents.ts`'s header.
 */

import { readFile, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { KIMI_DIR } from '../../config'
import { safeReadDir } from '../../utils'
import { kimiAgentIds, isoFromKimiTime, parseKimiState, type KimiState } from '../../adapters/kimi-parse'
import type { HarnessReplay, ReplayBatch, ReplayCursor, ReplaySource } from '../types'
import { agentContext, type KimiReplayContext } from './replay-core'
import { lifecycleEndEvents, lifecycleStartEvents, type SessionBounds } from './replay-agents'
import { foldKimiWire, wireTimeRange } from './replay'

const KIMI_SESSIONS_DIR = join(KIMI_DIR, 'sessions')
const KIMI_INDEX_FILE = join(KIMI_DIR, 'session_index.jsonl')

/** Kimi is quiet for at least this long before its lifecycle is considered closed — same default
 *  as the Claude replay's `settledMs` (CLAUDE.md's "Claude Code writes a whole response in one
 *  burst"); nothing measured on this machine suggests kimi's own bursts run longer. */
const DEFAULT_SETTLED_MS = 60_000

export interface KimiReplayOptions {
  /** Default: `KIMI_SESSIONS_DIR` (`~/.kimi-code/sessions`, or `KIMI_DIR`'s override). */
  sessionsDir?: string
  /** Default: `KIMI_INDEX_FILE` (`~/.kimi-code/session_index.jsonl`). */
  indexFile?: string
  /** Default: `Date.now`. Overridable so a test can drive `final` deterministically. */
  now?: () => number
  /** Default: `DEFAULT_SETTLED_MS`. */
  settledMs?: number
}

// ── the work-dir fallback index ─────────────────────────────────────────────────────────────────
//
// Mirrors `adapters/kimi.ts`'s own private `readWorkDirIndex` — duplicated rather than imported,
// since `adapters/kimi.ts` is not one of this integration's own files (only `kimi-parse.ts` is, and
// only for `export`-only edits).

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

// ── discovering session directories ─────────────────────────────────────────────────────────────

interface Located { kimiSessionId: string; dir: string }

async function locateSessions(sessionsDir: string): Promise<Located[]> {
  const workspaces = await safeReadDir(sessionsDir)
  const out: Located[] = []
  await Promise.all(workspaces.map(async ws => {
    const wsPath = join(sessionsDir, ws)
    for (const name of await safeReadDir(wsPath)) {
      if (!name.startsWith('session_')) continue
      out.push({ kimiSessionId: name.slice('session_'.length), dir: join(wsPath, name) })
    }
  }))
  return out
}

async function findSessionDir(sessionsDir: string, kimiSessionId: string): Promise<string | null> {
  const workspaces = await safeReadDir(sessionsDir)
  for (const ws of workspaces) {
    const dir = join(sessionsDir, ws, `session_${kimiSessionId}`)
    const st = await fsStat(dir).catch(() => null)
    if (st?.isDirectory()) return dir
  }
  return null
}

// ── the cursor envelope — {size, mtimeMs, lineNo} per kimi agent id ─────────────────────────────

interface EncodedAgentCursor { size: number; mtimeMs: number; lineNo: number }
interface EncodedCursor { v: 1; agents: Record<string, EncodedAgentCursor> }

function encodeCursor(agents: ReadonlyMap<string, EncodedAgentCursor>): ReplayCursor {
  const enc: EncodedCursor = { v: 1, agents: Object.fromEntries(agents) }
  return JSON.stringify(enc)
}

function parseCursor(cursor: ReplayCursor): Map<string, EncodedAgentCursor> {
  const out = new Map<string, EncodedAgentCursor>()
  if (cursor === null) return out
  let raw: unknown
  try { raw = JSON.parse(cursor) } catch { return out }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || !o.agents || typeof o.agents !== 'object') return out
  for (const [id, v] of Object.entries(o.agents as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const a = v as Record<string, unknown>
    if (typeof a.size !== 'number' || typeof a.mtimeMs !== 'number' || typeof a.lineNo !== 'number') continue
    out.set(id, { size: a.size, mtimeMs: a.mtimeMs, lineNo: a.lineNo })
  }
  return out
}

// ── reading one agent's wire.jsonl, whole-file (see this module's header) ──────────────────────

interface AgentFoldResult {
  cursor: EncodedAgentCursor
  /** `undefined` when the file could not be read at all (never written yet, or gone). */
  mtimeMs?: number
}

async function readAndFoldAgent(
  path: string, prev: EncodedAgentCursor | undefined, ctx: KimiReplayContext,
  emit: (e: AgentisticsEvent) => void, timeBounds: { minMs?: number; maxMs?: number },
): Promise<AgentFoldResult | null> {
  const st = await fsStat(path).catch(() => null)
  if (!st || !st.isFile()) return null

  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
    return { cursor: prev, mtimeMs: st.mtimeMs }
  }

  const text = await readFile(path, 'utf-8').catch(() => null)
  if (text === null) return null

  const lineNo = foldKimiWire(ctx, text, emit, 0)
  const range = wireTimeRange(text)
  if (range.minMs !== undefined && (timeBounds.minMs === undefined || range.minMs < timeBounds.minMs)) timeBounds.minMs = range.minMs
  if (range.maxMs !== undefined && (timeBounds.maxMs === undefined || range.maxMs > timeBounds.maxMs)) timeBounds.maxMs = range.maxMs

  return { cursor: { size: st.size, mtimeMs: st.mtimeMs, lineNo }, mtimeMs: st.mtimeMs }
}

// ── the integration ─────────────────────────────────────────────────────────────────────────────

export function createKimiReplay(opts: KimiReplayOptions = {}): HarnessReplay {
  const sessionsDir = opts.sessionsDir ?? KIMI_SESSIONS_DIR
  const indexFile = opts.indexFile ?? KIMI_INDEX_FILE
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? DEFAULT_SETTLED_MS

  /** kimiSessionId -> resolved directory, remembered like Claude's path memo (positive only: a
   *  session directory does not move once created, and a stale negative would strand a session
   *  whose directory appears after this integration first looked for it). */
  const dirs = new Map<string, string>()
  /** kimiSessionId -> the widest `entry.time` span this integration has folded so far — a
   *  FALLBACK for `state.json` carrying neither `createdAt` nor `updatedAt`. Forward-only. */
  const timeBounds = new Map<string, { minMs?: number; maxMs?: number }>()
  /** One read in flight per session — mirrors Claude's own `reading` map and for the same reason:
   *  two concurrent reads of one file could each plan a full re-read from the same stale stat. */
  const reading = new Map<string, Promise<ReplayBatch>>()

  async function discover(): Promise<ReplaySource[]> {
    const located = await locateSessions(sessionsDir)
    const sources: ReplaySource[] = []
    for (const { kimiSessionId, dir } of located) {
      dirs.set(kimiSessionId, dir)
      sources.push({ sessionId: kimiSessionId, sourceRef: `kimi:${kimiSessionId}` })
    }
    return sources
  }

  async function resolveDir(kimiSessionId: string): Promise<string | null> {
    const known = dirs.get(kimiSessionId)
    if (known) {
      const st = await fsStat(known).catch(() => null)
      if (st?.isDirectory()) return known
      dirs.delete(kimiSessionId)
    }
    const found = await findSessionDir(sessionsDir, kimiSessionId)
    if (found) dirs.set(kimiSessionId, found)
    return found
  }

  async function doReplay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    const kimiSessionId = source.sessionId
    const nowMs = now()
    const recordedAt = new Date(nowMs).toISOString()

    const dir = await resolveDir(kimiSessionId)
    if (dir === null) return { events: [], cursor }

    const events: AgentisticsEvent[] = []
    const emit = (e: AgentisticsEvent) => events.push(e)

    const stateText = await readFile(join(dir, 'state.json'), 'utf-8').catch(() => '')
    const state: KimiState | null = parseKimiState(stateText)
    const agentIds = kimiAgentIds(state)

    const incoming = parseCursor(cursor)
    const outgoing = new Map<string, EncodedAgentCursor>()
    const bounds = timeBounds.get(kimiSessionId) ?? {}
    timeBounds.set(kimiSessionId, bounds)

    let latestMtimeMs = 0
    const stateSt = await fsStat(join(dir, 'state.json')).catch(() => null)
    if (stateSt) latestMtimeMs = Math.max(latestMtimeMs, stateSt.mtimeMs)

    for (const agentId of agentIds) {
      const ctx = agentContext(kimiSessionId, agentId, recordedAt)
      const wirePath = join(dir, 'agents', agentId, 'wire.jsonl')
      const prev = incoming.get(agentId)
      const result = await readAndFoldAgent(wirePath, prev, ctx, emit, bounds)
      if (result) {
        outgoing.set(agentId, result.cursor)
        if (result.mtimeMs !== undefined) latestMtimeMs = Math.max(latestMtimeMs, result.mtimeMs)
      } else if (prev) {
        outgoing.set(agentId, prev) // file unreadable this call — keep what we had
      }
    }

    const workDirIndex = await readWorkDirIndex(indexFile)
    const cwd = state?.workDir || workDirIndex.get(dir) || undefined

    const startPrimary = isoFromKimiTime(state?.createdAt)
    const startAt = startPrimary || (bounds.minMs ? new Date(bounds.minMs).toISOString() : undefined)
    const startBounds: SessionBounds = startAt
      ? { at: startAt, exact: !!startPrimary }
      : { at: recordedAt, exact: false }

    lifecycleStartEvents(kimiSessionId, state, agentIds, startBounds, cwd, recordedAt, emit)

    const final = latestMtimeMs > 0 && nowMs - latestMtimeMs >= settledMs
    if (final) {
      const endPrimary = isoFromKimiTime(state?.updatedAt)
      const endAt = endPrimary || (bounds.maxMs ? new Date(bounds.maxMs).toISOString() : undefined)
      const endBounds: SessionBounds = endAt
        ? { at: endAt, exact: !!endPrimary }
        : { at: recordedAt, exact: false }
      lifecycleEndEvents(kimiSessionId, agentIds, endBounds, recordedAt, emit)
    }

    return { events, cursor: encodeCursor(outgoing) }
  }

  async function replay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    const key = source.sessionId
    const busy = reading.get(key)
    if (busy) return busy
    const run = doReplay(source, cursor).finally(() => { reading.delete(key) })
    reading.set(key, run)
    return run
  }

  return { discover, replay }
}

/** The default instance, reading `KIMI_SESSIONS_DIR` on the real clock — what `INTEGRATIONS.kimi`
 *  should fill (see this integration's handback, SHARED CHANGES REQUESTED). */
export const kimiReplay: HarnessReplay = createKimiReplay()
