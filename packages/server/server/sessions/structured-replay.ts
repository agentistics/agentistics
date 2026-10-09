/**
 * structured-replay.ts — F2.0b, PURE: the rules for RE-ATTACHING to a structured session whose child
 * outlived the server (see `structured-relay.ts` for the process that keeps it alive).
 *
 * A driver's state — the protocol session id, the turns, the open permission, the requests in flight —
 * lived in the dead server's memory. It is rebuilt the only way that works for every driver alike:
 * start a FRESH driver for the same request and feed it, in the original order, exactly what the old
 * one saw — every stdout line the relay recorded (`out.jsonl`), and every call the host made on the
 * session (`calls.jsonl`, stamped with how many lines had been read when it was made). A deterministic
 * driver then ends where the old one was.
 *
 * Nothing it writes during the replay reaches the child: the child already received those bytes. And
 * that is CHECKED, never assumed — the relay recorded every write it delivered (`in.jsonl`), so each
 * write of the re-created driver must be the next recorded bytes. A write past the end of the record
 * is new (it was never delivered — the server died first) and goes to the child; a write that differs
 * is a DIVERGENCE, and the host abandons the re-attach for the conversation-id resume it already has.
 */

/** One stdout line the relay recorded. */
export interface OutRecord { t: number; l: string }
/** One write the relay delivered to the child. */
export interface InRecord { t: number; w: string }

/** A call the host makes on a session. */
export type SessionCall =
  | { op: 'prompt'; text: string }
  | { op: 'answer'; choice?: number; text?: string; requestId?: string }
  | { op: 'cancel' }

/** A call the host made on the session, and when (`at`: lines read; `t`: ms). */
export type ReplayCall = SessionCall & { at: number; t: number }

/** PURE. A JSONL file's records; a line that does not parse (a torn last write) is dropped. */
export function parseJsonl<T>(text: string, valid: (v: unknown) => v is T): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { const v = JSON.parse(line) as unknown; if (valid(v)) out.push(v) } catch { /* torn */ }
  }
  return out
}

export const isOutRecord = (v: unknown): v is OutRecord =>
  !!v && typeof v === 'object' && typeof (v as OutRecord).t === 'number' && typeof (v as OutRecord).l === 'string'
export const isInRecord = (v: unknown): v is InRecord =>
  !!v && typeof v === 'object' && typeof (v as InRecord).t === 'number' && typeof (v as InRecord).w === 'string'
export const isReplayCall = (v: unknown): v is ReplayCall => {
  if (!v || typeof v !== 'object') return false
  const c = v as ReplayCall
  if (typeof c.at !== 'number' || typeof c.t !== 'number') return false
  if (c.op === 'prompt') return typeof c.text === 'string'
  return c.op === 'answer' || c.op === 'cancel'
}

/**
 * PURE. The writes a re-created driver makes, checked against what the relay delivered. `replayed`:
 * the child already has these bytes (drop them); `live`: past the record — send; `diverged`: not
 * what was written before, the replay is not faithful.
 */
export function writeCheck(delivered: readonly InRecord[]) {
  const expected = delivered.map(r => r.w).join('')
  let cursor = 0
  let diverged = false
  return {
    take(w: string): 'replayed' | 'live' | 'diverged' {
      if (diverged) return 'diverged'
      if (cursor >= expected.length) return 'live'
      // A write may straddle the end of the record (the server died mid-write): the recorded prefix
      // is replayed, and only then is the rest new — which cannot be split from one write, so the
      // straddle is a divergence too. In practice every write is one whole line, recorded whole.
      if (expected.startsWith(w, cursor)) { cursor += w.length; return 'replayed' }
      diverged = true
      return 'diverged'
    },
    /** Every recorded byte has been re-written. */
    complete: () => !diverged && cursor >= expected.length,
    remaining: () => expected.length - cursor,
  }
}

/** PURE. The calls made after exactly `k` lines had been read, in the order they were made. */
export function callsAt(calls: readonly ReplayCall[], k: number): ReplayCall[] {
  return calls.filter(c => c.at === k)
}
