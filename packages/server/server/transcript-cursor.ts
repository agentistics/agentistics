/**
 * transcript-cursor.ts — resuming a GROWING JSONL transcript where the last read stopped. PURE.
 *
 * `parse-cache.ts` already spares a transcript that has not changed. A LIVE one changes on every
 * turn, so its stamp changes, the row misses, and the parser read the whole file again — from the
 * first byte, re-`JSON.parse`-ing every line it had already parsed. Measured on this machine while
 * the fleet was busy: 16 transcripts written to inside 30 minutes totalling 99,4 MB, the three
 * largest at 26,4 / 21,4 / 12,4 MB, and ONE full `parseSessionJsonl` over them costing 400 / 1004 /
 * 312 ms of pure CPU each. `buildApiResponse` re-runs on a 30 s stale-while-revalidate tick for as
 * long as anybody is watching, so that bill is paid again and again — which is the sustained
 * 66–77 % CPU that took this machine down twice.
 *
 * The cure is to read only the bytes written SINCE the last read and fold them into state that was
 * kept, so a poll costs what the session wrote, not what it has ever written. This module is the
 * decision half of that: it says whether a stored cursor may be resumed from, and never touches a
 * file. `transcript-state.ts` does the reading.
 *
 * THE TWO THINGS THAT MAKE IT SAFE
 *
 * 1. **A PARTIAL LINE IS NEVER CONSUMED.** A read of a file another process is appending to lands
 *    wherever that process happened to be; the last line in the buffer is routinely half-written.
 *    `completeLineEnd` stops at the last newline, everything after it stays UNREAD, and the cursor
 *    advances only that far — so the next read starts at the beginning of that line and sees it
 *    whole. This is `windowLines()` in `transcript-window.ts` pointed the other way: that one drops
 *    the partial line at the START of a tail window, this one declines the partial line at the END
 *    of a head window.
 *
 * 2. **AN OFFSET IS ONLY AS GOOD AS THE BYTES IT SITS BEHIND.** A cursor is a claim about a file
 *    that is not being held open, and the claim is wrong the moment the file is rewritten rather
 *    than appended to. Two checks, and both err toward re-reading:
 *      - the SIZE may only grow; any shrink means the file is not the one the cursor described;
 *      - the ANCHOR — the last `ANCHOR_BYTES` bytes immediately BEFORE the cursor — is re-read and
 *        compared on every resume. A rewrite that kept the exact byte length AND reproduced the
 *        256 bytes ending at our offset is the only thing that can slip through, and a rewrite of
 *        a conversation cannot do either.
 *
 *    When either check fails the file is read WHOLE, once, and the cursor is re-established from
 *    that read — never patched, never half-applied. That is the shape this repository requires of
 *    a measurement it cannot make safely: fall back to the answer it can make, never a confident
 *    number assembled out of two files.
 *
 * COMPACTION IS NOT A REWRITE, AND THAT WAS MEASURED, NOT ASSUMED. Claude Code compacts by
 * APPENDING: a `{"type":"system","subtype":"compact_boundary"}` line and then the summary, with the
 * pre-compaction history left exactly where it was. Verified on a real transcript here — two
 * boundaries, at lines 2992 and 6141 of 6229, with all 2991 earlier lines still present. So a
 * compaction advances the cursor like any other turn and every accumulated figure goes on meaning
 * what `parseSessionJsonl` has always made it mean (`compact_count` increments, the earlier turns
 * keep counting). No rule is needed FOR compaction; the rule above is needed in case a harness ever
 * compacts by rewriting, and it catches that without knowing it happened.
 */

/**
 * How much of the already-read region is re-read and compared before resuming.
 *
 * Big enough that no rewrite reproduces it by accident, small enough that it costs nothing: it is
 * read as part of the same `read()` that fetches the new bytes, so resuming is ONE syscall, and the
 * same buffer then supplies the anchor for the next cursor.
 */
export const ANCHOR_BYTES = 256

/** Where a previous read stopped, and the evidence that it may be resumed from. */
export interface TranscriptCursor {
  /** Bytes consumed. ALWAYS immediately after a newline, so no partial line was ever taken. */
  offset: number
  /** The file's size when this cursor was taken. `offset <= size`; they differ by a partial line. */
  size: number
  /** The file's mtime when this cursor was taken — see `planTranscriptRead`. */
  mtimeMs: number
  /** Hex of the `anchorBytes` bytes ending AT `offset`. Empty when `offset` is 0. */
  anchor: string
  /** How many bytes `anchor` covers: `min(ANCHOR_BYTES, offset)`. */
  anchorBytes: number
}

/** What a file's `stat()` says, reduced to the two fields a cursor is judged against. */
export interface TranscriptStat {
  size: number
  mtimeMs: number
}

/** Why a file has to be read whole. Each is reported, never silently absorbed. */
export type RereadReason =
  /** Nothing was kept for this file — the first read of it, or the first after an eviction. */
  | 'no-cursor'
  /** The file is smaller than the cursor described it. It was truncated or replaced. */
  | 'shrank'
  /** Same size, different mtime: the bytes changed underneath without the length moving. */
  | 'rewritten'
  /** The bytes immediately before the cursor are not the ones it was taken behind. */
  | 'anchor-mismatch'

export type TranscriptReadPlan =
  /** The file has not moved since the cursor was taken. Nothing to read, nothing to fold. */
  | { mode: 'unchanged' }
  /** Read `[0, size)` and fold all of it, replacing whatever state was kept. */
  | { mode: 'full'; reason: RereadReason }
  /**
   * Read `[readFrom, size)` in one go. The first `verifyBytes` of that buffer are the anchor to
   * compare against `TranscriptCursor.anchor`; everything after them is new.
   */
  | { mode: 'append'; readFrom: number; verifyBytes: number; lineFrom: number; to: number }

/**
 * Whether the cursor may be resumed from, and what to read — on `stat()` alone.
 *
 * `mtimeMs` is compared only in the EQUAL-SIZE case, and it is the whole reason that case is not
 * read as `unchanged`: a file rewritten to the same length is the one shape a size comparison
 * cannot see. A grown file needs no mtime agreement — growth is itself the evidence, and a
 * filesystem whose mtime granularity lags the write would otherwise strand a live session forever.
 */
export function planTranscriptRead(
  prev: TranscriptCursor | null | undefined,
  stat: TranscriptStat,
): TranscriptReadPlan {
  if (!prev) return { mode: 'full', reason: 'no-cursor' }
  // A file smaller than the cursor described is not the one the cursor was taken over. `offset <=
  // size` always holds on a `TranscriptCursor` (see its own doc comment), so `stat.size <
  // prev.offset` can never be true unless `stat.size < prev.size` already is — checking only the
  // latter is the same test without a clause that looks like it guards an independent case.
  if (stat.size < prev.size) return { mode: 'full', reason: 'shrank' }
  if (stat.size === prev.size) {
    return stat.mtimeMs === prev.mtimeMs
      ? { mode: 'unchanged' }
      : { mode: 'full', reason: 'rewritten' }
  }
  const verifyBytes = Math.min(ANCHOR_BYTES, prev.offset)
  return {
    mode: 'append',
    readFrom: prev.offset - verifyBytes,
    verifyBytes,
    lineFrom: prev.offset,
    to: stat.size,
  }
}

/** The bytes of `chunk`, hex — the form a cursor stores its anchor in. */
export function anchorHex(chunk: Uint8Array): string {
  let out = ''
  for (let i = 0; i < chunk.length; i++) out += (chunk[i]! & 0xff).toString(16).padStart(2, '0')
  return out
}

/**
 * The byte just past the last COMPLETE line in `chunk`, or 0 when it holds none.
 *
 * Scans for the newline BYTE rather than splitting text, and that is load-bearing twice over. A
 * 0x0A byte cannot occur inside a multi-byte UTF-8 sequence, so cutting here can never cut a
 * character in half — which is what lets the caller decode the cut region and leave the rest
 * undecoded. And the answer is a BYTE count, which is what a file offset is; a character count
 * taken off a decoded string would drift from the offset on the first non-ASCII byte and put every
 * later read at the wrong place.
 */
export function completeLineEnd(chunk: Uint8Array): number {
  for (let i = chunk.length - 1; i >= 0; i--) if (chunk[i] === 0x0a) return i + 1
  return 0
}

/**
 * How much of `chunk` may be CONSUMED — the newline rule, plus the one case it gets wrong.
 *
 * `completeLineEnd` alone says "everything up to the last newline", which is right for a file being
 * appended to and wrong for a file that has STOPPED with no terminating newline: its last line is
 * complete, the one-shot parser has always counted it, and declining it would lose a turn — a
 * silent under-count, and in the reassuring direction.
 *
 * The discriminator is the line itself. A JSONL line is one JSON OBJECT, and a proper prefix of a
 * JSON object is never itself a valid JSON object — the first point at which the braces balance IS
 * the end of the object. So a trailing region that parses as an object cannot be half of a longer
 * one: it is the whole line, whatever the writer does next. One that does not parse is either
 * genuinely half-written or is cut inside a multi-byte character (which breaks the string it is in,
 * so it does not parse either), and is left for the read that completes it.
 *
 * Consuming it is safe even if the newline arrives afterwards: the next read starts ON that
 * newline, yields one empty line, and every reader here skips empty lines.
 */
export function consumedEnd(chunk: Uint8Array): number {
  const lineEnd = completeLineEnd(chunk)
  if (lineEnd === chunk.length) return lineEnd
  const rest = new TextDecoder().decode(chunk.subarray(lineEnd)).trim()
  if (!rest) return lineEnd
  try {
    const parsed = JSON.parse(rest) as unknown
    if (parsed !== null && typeof parsed === 'object') return chunk.length
  } catch { /* half-written — leave it for the next read */ }
  return lineEnd
}

/**
 * The cursor to keep after a read, given the buffer that read produced.
 *
 * `buf` must end at `bufEnd` (its last byte is the file's byte `bufEnd - 1`) and must cover at
 * least the last `min(ANCHOR_BYTES, offset)` bytes before the new offset — which both call shapes
 * satisfy by construction: a full read covers the file from 0, and an append read deliberately
 * starts `ANCHOR_BYTES` early so this buffer always reaches back far enough.
 */
export function cursorFrom(
  buf: Uint8Array,
  bufEnd: number,
  offset: number,
  stat: TranscriptStat,
): TranscriptCursor {
  const anchorBytes = Math.min(ANCHOR_BYTES, offset)
  const end = buf.length - (bufEnd - offset)
  const anchor = anchorBytes > 0 ? anchorHex(buf.subarray(end - anchorBytes, end)) : ''
  return { offset, size: stat.size, mtimeMs: stat.mtimeMs, anchor, anchorBytes }
}

/** What the memo in `transcript-state.ts` keeps per file, reduced to what eviction judges. */
export interface CursorUse {
  /** When this file's state was last asked for, epoch ms. */
  usedMs: number
}

/**
 * Which retained walks to drop — PURE.
 *
 * Keeping a walk is what makes the next read cheap, and it costs memory for as long as it is kept:
 * the accumulators of one live transcript (the counted `message.id`s, the tool-id map, the hour
 * array) run to a megabyte or so. So the memo is bounded twice, and BOTH bounds are about being
 * wrong cheaply rather than about being right:
 *
 *   - a walk nobody has asked for in `ttlMs` is dropped, because a session that stopped writing is
 *     served by `parse-cache.ts` from then on and its walk would sit there until the process ends;
 *   - past `max` walks, the least recently used go, because the number of transcripts a machine
 *     touches has no ceiling while the memory on it does.
 *
 * Dropping one is never a loss of data — it costs exactly one full re-read of that file, which is
 * what every read cost before this existed. That is what lets both bounds be tight.
 */
export function evictTranscriptStates(
  entries: Iterable<readonly [string, CursorUse]>,
  now: number,
  opts: { ttlMs: number; max: number },
): string[] {
  const rows = [...entries]
  const drop = new Set<string>()
  for (const [path, use] of rows) if (now - use.usedMs >= opts.ttlMs) drop.add(path)
  const kept = rows.filter(([path]) => !drop.has(path))
  if (kept.length > opts.max) {
    kept.sort((a, b) => a[1].usedMs - b[1].usedMs)
    for (const [path] of kept.slice(0, kept.length - opts.max)) drop.add(path)
  }
  return [...drop]
}
