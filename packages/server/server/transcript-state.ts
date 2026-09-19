/**
 * transcript-state.ts — reading a LIVE Claude transcript by what it has WRITTEN SINCE LAST TIME.
 *
 * The IO half of `transcript-cursor.ts`, which holds every rule this makes a decision with and
 * explains why the rules are what they are. In one sentence: `parse-cache.ts` spares a transcript
 * that has not changed, a live one changes on every turn, and so the parser re-read and re-parsed
 * the whole file on every rebuild for as long as its session ran. This keeps the walk instead.
 *
 * WHAT A CALLER GETS is a `ClaudeParseState` that has been folded over every complete line of the
 * file, however it got there — resumed from a cursor, or rebuilt from scratch because the cursor
 * could not be trusted. The two are indistinguishable in the answer and are distinguished in
 * `mode`, which exists so the saving can be MEASURED rather than assumed.
 *
 * WHAT IT DOES NOT DO is decide anything about sessions. It reads one file and folds it; whether
 * that state becomes a `SessionMeta` or an `EnrichResult` is `parse-cache-jsonl.ts`'s business, and
 * both finish from the same walk — which is also why the memo is keyed on the FILE alone and not on
 * the caller: the facts a transcript carries do not depend on who asked.
 */

import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { cloneClaudeParseState, emptyClaudeParse, foldClaudeParse, iterLines, type ClaudeParseState } from './jsonl'
import {
  anchorHex, consumedEnd, cursorFrom, evictTranscriptStates, planTranscriptRead,
  type RereadReason, type TranscriptCursor,
} from './transcript-cursor'
import type { FileStamp } from './parse-cache-key'

/** How long a walk nobody has asked for is kept. See `evictTranscriptStates`. */
export const STATE_TTL_MS = 15 * 60_000
/** How many walks are kept at once. See `evictTranscriptStates`. */
export const MAX_STATES = 32

interface Entry {
  cursor: TranscriptCursor
  state: ClaudeParseState
  usedMs: number
}

const walks = new Map<string, Entry>()

/**
 * The read IN FLIGHT for a path, shared by everyone who asks for it meanwhile.
 *
 * A fold is not atomic — every step of the read awaits — so two callers arriving on one file could
 * plan from the SAME cursor, read the same new bytes and fold them TWICE, silently doubling that
 * session's tokens and its cost. `data.ts` runs up to 30 of these at once and a background
 * stale-while-revalidate rebuild can overlap a streamed one, so the arrival is real.
 *
 * WHETHER THE INTERLEAVE ITSELF HAPPENS was NOT observed: removing this guard, ten concurrent reads
 * of one growing file still folded once under bun 1.3.14, because its fs promises happen to settle
 * in an order that lets each read finish before the next plans. That is a scheduling detail of one
 * runtime version, not a property of this code, and the failure it would cause is a silent doubling
 * of somebody's cost. So the promise is shared and the question does not arise — the rule
 * `fleet-baseline.ts` already applies to its own scan, for the same reason.
 */
const reading = new Map<string, Promise<TranscriptRead | null>>()

/** How a read was served. Returned so the saving can be measured, and logged by nothing. */
export interface TranscriptReadInfo {
  mode: 'unchanged' | 'append' | 'full'
  /** Why the file had to be read whole. Absent on the other two modes. */
  reason?: RereadReason
  /** Bytes pulled off the disk by THIS call — the number the whole change is about. */
  bytesRead: number
  /** The file's size, for the ratio. */
  fileBytes: number
}

export interface TranscriptRead {
  state: ClaudeParseState
  stamp: FileStamp
  info: TranscriptReadInfo
}

/**
 * Fill `buf` from `position`, looping until it is full or the file ends.
 *
 * `read()` is allowed to return fewer bytes than asked for, and these reads ask for megabytes. A
 * short read would leave the cursor behind the file's end with `size` and `mtime` both unchanged —
 * which the plan reads as `unchanged`, so the remainder would sit unread until the session happened
 * to write again. Looping removes the case rather than teaching the plan about it.
 */
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
 * The folded state of `path`, up to date, reading only what is new.
 *
 * `null` when the file cannot be opened or stat-ed — the same "nothing to say" every other reader
 * here answers with, never an empty state that would read as a transcript with nothing in it.
 *
 * A HALF-WRITTEN LINE IS NOT READ, in either mode. A file being appended to by another process
 * ends wherever that process got to, so its last line is routinely half-written; consuming it would
 * put the cursor inside a line and corrupt every read after it. `consumedEnd` decides, and it
 * distinguishes a half-written last line from a COMPLETE one that simply has no newline after it —
 * the second is counted, because the one-shot parser counts it and losing it would be a turn
 * quietly missing from a finished session.
 */
export function claudeTranscriptState(path: string, now: number = Date.now()): Promise<TranscriptRead | null> {
  // Deliberately NOT `async`: an async function wraps its return value in a fresh promise, so the
  // second caller would get a different object that merely resolves to the same thing. Handing back
  // the very promise in flight is what makes the share observable — and testable.
  const busy = reading.get(path)
  if (busy) return busy
  const run = readTranscript(path, now).finally(() => { reading.delete(path) })
  reading.set(path, run)
  return run
}

async function readTranscript(path: string, now: number): Promise<TranscriptRead | null> {
  let fh
  try { fh = await open(path, 'r') } catch { return null }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const stat = { size: st.size, mtimeMs: st.mtimeMs }
    const stamp: FileStamp = { path, mtimeMs: st.mtimeMs, size: st.size }
    const prev = walks.get(path)

    let plan = planTranscriptRead(prev?.cursor, stat)

    if (plan.mode === 'unchanged' && prev) {
      prev.usedMs = now
      sweep(now)
      return { state: prev.state, stamp, info: { mode: 'unchanged', bytesRead: 0, fileBytes: stat.size } }
    }

    if (plan.mode === 'append' && prev) {
      const length = plan.to - plan.readFrom
      const buf = Buffer.allocUnsafe(length)
      const chunk = buf.subarray(0, await readFully(fh, buf, plan.readFrom))
      // THE ANCHOR. The bytes immediately before the cursor are re-read as part of this same read
      // and must be the ones it was taken behind; anything else means the file was rewritten rather
      // than appended to, and the cursor describes a file that is no longer there.
      const anchorOk = plan.verifyBytes === 0
        || anchorHex(chunk.subarray(0, plan.verifyBytes)) === prev.cursor.anchor
      if (anchorOk) {
        const fresh = chunk.subarray(plan.verifyBytes)
        const consumed = consumedEnd(fresh)
        // Fold into a CLONE, never `prev.state` directly. `foldClaudeParse` mutates in place and is
        // not guaranteed against throwing on a malformed line; folding the shared object and only
        // THEN discovering the fold failed would leave `prev.state` partially updated while
        // `prev.cursor` (assigned only below, after the fold returns) stayed put — so the next poll
        // would replan the identical append from the unmoved cursor and fold the same bytes AGAIN
        // into the already-mutated state, silently double-counting everything it touched. Committing
        // the clone and the new cursor together, only after the fold has returned without throwing,
        // is what makes this step atomic: a throw here leaves `prev` exactly as it was.
        const next = consumed > 0 ? cloneClaudeParseState(prev.state) : prev.state
        if (consumed > 0) {
          foldClaudeParse(next, iterLines(fresh.subarray(0, consumed).toString('utf-8')))
        }
        const offset = plan.lineFrom + consumed
        prev.state = next
        prev.cursor = cursorFrom(chunk, plan.readFrom + chunk.length, offset, stat)
        prev.usedMs = now
        sweep(now)
        return {
          state: prev.state, stamp,
          info: { mode: 'append', bytesRead: chunk.length, fileBytes: stat.size },
        }
      }
      // Not the same file any more. Fall through to the one thing that is always right.
      plan = { mode: 'full', reason: 'anchor-mismatch' }
    }

    const reason: RereadReason = plan.mode === 'full' ? plan.reason : 'no-cursor'
    const buf = Buffer.allocUnsafe(stat.size)
    const chunk = buf.subarray(0, await readFully(fh, buf, 0))
    const consumed = consumedEnd(chunk)
    const state = emptyClaudeParse()
    if (consumed > 0) foldClaudeParse(state, iterLines(chunk.subarray(0, consumed).toString('utf-8')))
    walks.set(path, { cursor: cursorFrom(chunk, chunk.length, consumed, stat), state, usedMs: now })
    sweep(now)
    return { state, stamp, info: { mode: 'full', reason, bytesRead: chunk.length, fileBytes: stat.size } }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

/** Drop the walks that are no longer worth their memory — the policy is in `transcript-cursor.ts`. */
function sweep(now: number): void {
  if (walks.size === 0) return
  for (const path of evictTranscriptStates(walks, now, { ttlMs: STATE_TTL_MS, max: MAX_STATES })) {
    walks.delete(path)
  }
}

/** How many walks are being kept. For diagnostics and for tests; nothing in the product reads it. */
export function retainedTranscriptStates(): number {
  return walks.size
}

/** Forget every walk. Tests use it; so would anything that needed a cold start. */
export function resetTranscriptStates(): void {
  walks.clear()
}
