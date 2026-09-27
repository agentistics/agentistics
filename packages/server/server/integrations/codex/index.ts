/**
 * integrations/codex/index.ts — the IO half of the Codex replay: which rollouts exist, and reading a
 * LIVE one by what it has written SINCE LAST TIME. `replay.ts` is the PURE half; nothing here decides
 * what a record MEANS, only which bytes reach the fold and when `finish` is told the rollout settled.
 *
 * It is the Claude integration's IO half without the subagent pass (Codex writes no subagent files):
 * - `discover()` walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — the same walk
 *   `adapters/codex.ts` does (its `collectRolloutFiles` is private to that module, so it is repeated
 *   here: a directory with no extension is descended, a `rollout-*.jsonl` file is a source).
 * - `replay(source, cursor)` resumes through `transcript-cursor.ts`'s rules — a partial trailing line
 *   is never consumed, a rewrite (mtime or anchor) forces one whole re-read — and trusts a cursor only
 *   when it matches THIS process's own retained walk exactly. Anything else re-reads from byte 0 and
 *   re-emits every event, which is safe because every id is derived from its record: the journal
 *   dedupes the repeat.
 * - `final` is "the rollout has been quiet for `settledMs`" (default 60 s, the Claude integration's):
 *   only then are the held turn usage, the open turn's close and the `*.ended` events emitted.
 *
 * A rollout's id is the UUID in its filename (`rollout-<stamp>-<uuid>.jsonl` — the id Codex itself
 * writes into `session_meta.id`), or the basename when the name has no UUID; it is what the entity
 * ids are derived from, so it must be known before a byte of the file is read.
 */
import { readdir, stat as fsStat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { CODEX_SESSIONS_DIR } from '../../config'
import {
  anchorHex, consumedEnd, cursorFrom, evictTranscriptStates, planTranscriptRead,
  type TranscriptCursor, type TranscriptStat,
} from '../../transcript-cursor'
import { MAX_STATES, STATE_TTL_MS } from '../../transcript-state'
import { iterLines } from '../../jsonl'
import type { HarnessReplay, ReplayBatch, ReplayCursor, ReplaySource } from '../types'
import { CODEX_SOURCE_ID, codexContext, type CodexReplayContext } from './replay-core'
import { cloneCodexReplay, emptyCodexReplay, finishCodexReplay, foldCodexReplay, type CodexReplayState } from './replay'

const DEFAULT_SETTLED_MS = 60_000

export interface CodexReplayOptions {
  /** Default: `CODEX_SESSIONS_DIR` (`~/.codex/sessions`, or `CODEX_DIR`'s override). */
  sessionsDir?: string
  now?: () => number
  settledMs?: number
}

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The legacy fallback id (`adapters/codex.ts`): the basename without `.jsonl`. */
export function fallbackIdOf(path: string): string {
  return basename(path).replace(/\.jsonl$/, '')
}

/** The id a rollout is replayed under: its filename's UUID, else the fallback id. */
export function rolloutIdOf(path: string): string {
  const base = fallbackIdOf(path)
  return UUID_TAIL.exec(base)?.[1] ?? base
}

/** Every `rollout-*.jsonl` under `dir`, recursively — the adapter's own walk. Total: `[]` on error. */
export async function collectRollouts(dir: string): Promise<string[]> {
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const out: string[] = []
  for (const name of names.sort()) {
    const full = join(dir, name)
    if (name.endsWith('.jsonl') && name.startsWith('rollout-')) out.push(full)
    else if (!name.includes('.')) out.push(...await collectRollouts(full))
  }
  return out
}

// ── The cursor envelope — the Claude integration's shape ────────────────────────────────────────

interface EncodedCursor { v: 1; offset: number; anchor: string; size: number; mtimeMs: number; lineNo: number }

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
  if (o.v !== 1 || typeof o.offset !== 'number' || typeof o.anchor !== 'string' || typeof o.size !== 'number'
    || typeof o.mtimeMs !== 'number' || typeof o.lineNo !== 'number') return null
  return { v: 1, offset: o.offset, anchor: o.anchor, size: o.size, mtimeMs: o.mtimeMs, lineNo: o.lineNo }
}

function cursorMatches(walk: TranscriptCursor, lineNo: number, incoming: EncodedCursor | null): boolean {
  if (!incoming) return false
  return walk.offset === incoming.offset && walk.size === incoming.size && walk.mtimeMs === incoming.mtimeMs
    && walk.anchor === incoming.anchor && lineNo === incoming.lineNo
}

async function readFully(fh: FileHandle, buf: Buffer, position: number): Promise<number> {
  let got = 0
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, position + got)
    if (bytesRead <= 0) break
    got += bytesRead
  }
  return got
}

/**
 * Read `path` by what changed since `prev`, folding new bytes into a CLONE of the retained state —
 * `transcript-state.ts`'s rules, as the Claude integration applies them. `null` only when the file
 * cannot be opened or stat-ed.
 */
async function readAndFold(
  path: string,
  prev: { cursor: TranscriptCursor; state: CodexReplayState } | null,
  ctx: CodexReplayContext,
  emit: (e: AgentisticsEvent) => void,
): Promise<{ state: CodexReplayState; cursor: TranscriptCursor; mtimeMs: number } | null> {
  let fh: FileHandle
  try { fh = await open(path, 'r') } catch { return null }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const stat: TranscriptStat = { size: st.size, mtimeMs: st.mtimeMs }
    let plan = planTranscriptRead(prev?.cursor, stat)

    if (plan.mode === 'unchanged' && prev) {
      prev.state.ctx = ctx
      return { state: prev.state, cursor: prev.cursor, mtimeMs: st.mtimeMs }
    }
    if (plan.mode === 'append' && prev) {
      const buf = Buffer.allocUnsafe(plan.to - plan.readFrom)
      const chunk = buf.subarray(0, await readFully(fh, buf, plan.readFrom))
      const anchorOk = plan.verifyBytes === 0 || anchorHex(chunk.subarray(0, plan.verifyBytes)) === prev.cursor.anchor
      if (anchorOk) {
        const fresh = chunk.subarray(plan.verifyBytes)
        const consumed = consumedEnd(fresh)
        const state = consumed > 0 ? cloneCodexReplay(prev.state) : prev.state
        state.ctx = ctx
        if (consumed > 0) foldCodexReplay(state, iterLines(fresh.subarray(0, consumed).toString('utf-8')), emit)
        const cursor = cursorFrom(chunk, plan.readFrom + chunk.length, plan.lineFrom + consumed, stat)
        return { state, cursor, mtimeMs: st.mtimeMs }
      }
      plan = { mode: 'full', reason: 'anchor-mismatch' }
    }
    const buf = Buffer.allocUnsafe(stat.size)
    const chunk = buf.subarray(0, await readFully(fh, buf, 0))
    const consumed = consumedEnd(chunk)
    const state = emptyCodexReplay(ctx)
    if (consumed > 0) foldCodexReplay(state, iterLines(chunk.subarray(0, consumed).toString('utf-8')), emit)
    return { state, cursor: cursorFrom(chunk, chunk.length, consumed, stat), mtimeMs: st.mtimeMs }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

// ── The integration ─────────────────────────────────────────────────────────────────────────────

interface RolloutWalk { state: CodexReplayState; cursor: TranscriptCursor; usedMs: number }

export function createCodexReplay(opts: CodexReplayOptions = {}): HarnessReplay {
  const sessionsDir = opts.sessionsDir ?? CODEX_SESSIONS_DIR
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? DEFAULT_SETTLED_MS

  const walks = new Map<string, RolloutWalk>()
  /** rolloutId → path, filled by `discover()` and by the fallback scan. */
  const paths = new Map<string, string>()
  const reading = new Map<string, Promise<ReplayBatch>>()

  async function discover(): Promise<ReplaySource[]> {
    const files = await collectRollouts(sessionsDir)
    const sources: ReplaySource[] = []
    for (const f of files) {
      const id = rolloutIdOf(f)
      if (!paths.has(id)) paths.set(id, f)
      sources.push({ sessionId: id, sourceRef: `${CODEX_SOURCE_ID}:${id}` })
    }
    return sources
  }

  async function pathOf(id: string): Promise<string | null> {
    const known = paths.get(id)
    if (known && await fsStat(known).then(st => st.isFile(), () => false)) return known
    paths.delete(id)
    await discover()
    return paths.get(id) ?? null
  }

  async function doReplay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    const id = source.sessionId
    const nowMs = now()
    const path = await pathOf(id)
    if (path === null) return { events: [], cursor }

    const ctx = codexContext(rolloutIdOf(path), fallbackIdOf(path), new Date(nowMs).toISOString())
    const events: AgentisticsEvent[] = []
    const emit = (e: AgentisticsEvent) => events.push(e)

    const existing = walks.get(id)
    const trusted = existing && cursorMatches(existing.cursor, existing.state.lineNo, parseCursor(cursor))
      ? { cursor: existing.cursor, state: existing.state }
      : null
    const result = await readAndFold(path, trusted, ctx, emit)
    if (!result) return { events: [], cursor }

    walks.set(id, { state: result.state, cursor: result.cursor, usedMs: nowMs })
    for (const k of evictTranscriptStates(walks, nowMs, { ttlMs: STATE_TTL_MS, max: MAX_STATES })) walks.delete(k)

    // Whole milliseconds: `Date.now()` is truncated, `mtimeMs` carries a fraction (Claude's note).
    const final = nowMs - Math.floor(result.mtimeMs) >= settledMs
    finishCodexReplay(result.state, { final }, emit)
    return { events, cursor: encodeCursor(result.cursor, result.state.lineNo) }
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

/** The default instance, reading `CODEX_SESSIONS_DIR` on the real clock — for `INTEGRATIONS.codex`. */
export const codexReplay: HarnessReplay = createCodexReplay()
