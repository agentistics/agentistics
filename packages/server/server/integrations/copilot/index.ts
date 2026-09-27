/**
 * integrations/copilot/index.ts — the IO half of the Copilot replay: which sessions exist, and
 * reading a LIVE one by what it has written SINCE LAST TIME (CLAUDE.md, "A LIVE transcript is read
 * by what it has WRITTEN SINCE LAST TIME"). `replay.ts` is the PURE half; nothing here decides what
 * a record MEANS, only which bytes reach the fold and when the fold's `finish` is told the session
 * is settled.
 *
 * Structurally this is `integrations/claude/index.ts` with the subagent half removed: Copilot has
 * no subagents (`HARNESS_CAPABILITIES.copilot.agents === false`), so there is exactly one file per
 * session and exactly one walk to keep. The resumable byte-cursor machinery
 * (`transcript-cursor.ts`) is the SAME module Claude's replay uses — it is harness-agnostic — so a
 * live Copilot session pays for what it wrote since the last poll, not for the whole file again.
 */
import { readdir, stat as fsStat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { COPILOT_DIR } from '../../config'
import {
  anchorHex, consumedEnd, cursorFrom, evictTranscriptStates, planTranscriptRead,
  type TranscriptCursor, type TranscriptStat,
} from '../../transcript-cursor'
import { MAX_STATES, STATE_TTL_MS } from '../../transcript-state'
import { iterLines } from '../../jsonl'
import type { HarnessReplay, ReplayBatch, ReplayCursor, ReplaySource } from '../types'
import { mainContext, type CopilotReplayContext } from './replay-core'
import {
  cloneCopilotReplay, emptyCopilotReplay, finishCopilotReplay, foldCopilotReplay,
  type CopilotReplayState,
} from './replay'

/** Same heuristic as the Claude replay, applied to Copilot's own events.jsonl: a file this long
 *  quiet is settled, not merely paused between turns. */
const DEFAULT_SETTLED_MS = 60_000

export const COPILOT_SESSION_STATE_DIR = join(COPILOT_DIR, 'session-state')

export interface CopilotReplayOptions {
  /** Default: `COPILOT_SESSION_STATE_DIR` (`~/.copilot/session-state`, or `COPILOT_DIR`'s override). */
  sessionStateDir?: string
  /** Default: `Date.now`. Overridable so a test can drive `final` deterministically. */
  now?: () => number
  /** Default: `DEFAULT_SETTLED_MS`. */
  settledMs?: number
}

// ── The cursor envelope — identical shape to the Claude replay's (see its own header). ─────────

interface EncodedCursor {
  v: 1
  offset: number
  anchor: string
  size: number
  mtimeMs: number
  lineNo: number
}

function encodeCursor(c: TranscriptCursor, lineNo: number): ReplayCursor {
  const enc: EncodedCursor = { v: 1, offset: c.offset, anchor: c.anchor, size: c.size, mtimeMs: c.mtimeMs, lineNo }
  return JSON.stringify(enc)
}

function parseCursor(cursor: ReplayCursor): EncodedCursor | null {
  if (cursor === null) return null
  let raw: unknown
  try { raw = JSON.parse(cursor) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1) return null
  if (
    typeof o.offset !== 'number' || typeof o.anchor !== 'string' || typeof o.size !== 'number'
    || typeof o.mtimeMs !== 'number' || typeof o.lineNo !== 'number'
  ) return null
  return { v: 1, offset: o.offset, anchor: o.anchor, size: o.size, mtimeMs: o.mtimeMs, lineNo: o.lineNo }
}

function cursorMatches(walkCursor: TranscriptCursor, lineNo: number, incoming: EncodedCursor | null): boolean {
  if (!incoming) return false
  return walkCursor.offset === incoming.offset && walkCursor.size === incoming.size
    && walkCursor.mtimeMs === incoming.mtimeMs && walkCursor.anchor === incoming.anchor
    && lineNo === incoming.lineNo
}

// ── Reading one events.jsonl by what changed ────────────────────────────────────────────────────

async function readFully(fh: FileHandle, buf: Buffer, position: number): Promise<number> {
  let got = 0
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, position + got)
    if (bytesRead <= 0) break
    got += bytesRead
  }
  return got
}

interface TranscriptFoldResult {
  state: CopilotReplayState
  cursor: TranscriptCursor
  changed: boolean
}

async function readAndFold(
  path: string,
  prev: { cursor: TranscriptCursor; state: CopilotReplayState } | null,
  ctx: CopilotReplayContext,
  emit: (e: AgentisticsEvent) => void,
): Promise<TranscriptFoldResult | null> {
  let fh: FileHandle
  try { fh = await open(path, 'r') } catch { return null }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const stat: TranscriptStat = { size: st.size, mtimeMs: st.mtimeMs }
    let plan = planTranscriptRead(prev?.cursor, stat)

    if (plan.mode === 'unchanged' && prev) {
      prev.state.ctx = ctx
      return { state: prev.state, cursor: prev.cursor, changed: false }
    }

    if (plan.mode === 'append' && prev) {
      const length = plan.to - plan.readFrom
      const buf = Buffer.allocUnsafe(length)
      const chunk = buf.subarray(0, await readFully(fh, buf, plan.readFrom))
      const anchorOk = plan.verifyBytes === 0
        || anchorHex(chunk.subarray(0, plan.verifyBytes)) === prev.cursor.anchor
      if (anchorOk) {
        const fresh = chunk.subarray(plan.verifyBytes)
        const consumed = consumedEnd(fresh)
        const state = consumed > 0 ? cloneCopilotReplay(prev.state) : prev.state
        state.ctx = ctx
        if (consumed > 0) {
          foldCopilotReplay(state, iterLines(fresh.subarray(0, consumed).toString('utf-8')), emit)
        }
        const offset = plan.lineFrom + consumed
        const cursor = cursorFrom(chunk, plan.readFrom + chunk.length, offset, stat)
        return { state, cursor, changed: consumed > 0 }
      }
      plan = { mode: 'full', reason: 'anchor-mismatch' }
    }

    const buf = Buffer.allocUnsafe(stat.size)
    const chunk = buf.subarray(0, await readFully(fh, buf, 0))
    const consumed = consumedEnd(chunk)
    const state = emptyCopilotReplay(ctx)
    if (consumed > 0) foldCopilotReplay(state, iterLines(chunk.subarray(0, consumed).toString('utf-8')), emit)
    const cursor = cursorFrom(chunk, chunk.length, consumed, stat)
    return { state, cursor, changed: consumed > 0 }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

// ── Discovery ────────────────────────────────────────────────────────────────────────────────────

async function discoverSources(sessionStateDir: string): Promise<ReplaySource[]> {
  let dirs: string[]
  try { dirs = await readdir(sessionStateDir) } catch { return [] }
  const sources: ReplaySource[] = []
  for (const dir of dirs) {
    const eventsPath = join(sessionStateDir, dir, 'events.jsonl')
    const st = await fsStat(eventsPath).catch(() => null)
    if (!st || !st.isFile()) continue
    sources.push({ sessionId: dir, sourceRef: `copilot:${dir}` })
  }
  return sources
}

// ── The integration ─────────────────────────────────────────────────────────────────────────────

export function createCopilotReplay(opts: CopilotReplayOptions = {}): HarnessReplay {
  const sessionStateDir = opts.sessionStateDir ?? COPILOT_SESSION_STATE_DIR
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? DEFAULT_SETTLED_MS

  const walks = new Map<string, { cursor: TranscriptCursor; state: CopilotReplayState; usedMs: number }>()
  /** One read in flight per session — see the Claude replay's identical guard and its reasoning. */
  const reading = new Map<string, Promise<ReplayBatch>>()

  function sweep(nowMs: number): void {
    if (walks.size === 0) return
    for (const path of evictTranscriptStates(walks, nowMs, { ttlMs: STATE_TTL_MS, max: MAX_STATES })) {
      walks.delete(path)
    }
  }

  async function discover(): Promise<ReplaySource[]> {
    return discoverSources(sessionStateDir)
  }

  async function doReplay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    const copilotSessionId = source.sessionId
    const nowMs = now()
    const recordedAt = new Date(nowMs).toISOString()
    const path = join(sessionStateDir, copilotSessionId, 'events.jsonl')

    const events: AgentisticsEvent[] = []
    const emit = (e: AgentisticsEvent) => events.push(e)

    const ctx = mainContext(copilotSessionId, recordedAt)
    const incoming = parseCursor(cursor)
    const existing = walks.get(copilotSessionId)
    const trusted = existing && cursorMatches(existing.cursor, existing.state.lineNo, incoming)
      ? { cursor: existing.cursor, state: existing.state }
      : null

    const result = await readAndFold(path, trusted, ctx, emit)
    if (!result) return { events: [], cursor }

    walks.set(copilotSessionId, { cursor: result.cursor, state: result.state, usedMs: nowMs })
    sweep(nowMs)

    const st = await fsStat(path).catch(() => null)
    // Whole-millisecond comparison — see the Claude replay's identical note on `mtimeMs` fractions.
    const final = st !== null && nowMs - Math.floor(st.mtimeMs) >= settledMs
    finishCopilotReplay(result.state, { final }, emit)

    const outCursor = encodeCursor(result.cursor, result.state.lineNo)
    return { events, cursor: outCursor }
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

/** The default instance, reading `COPILOT_SESSION_STATE_DIR` on the real clock — what
 *  `INTEGRATIONS.copilot` would fill (SHARED CHANGE REQUESTED — see the A3.3 handback). */
export const copilotReplay: HarnessReplay = createCopilotReplay()
