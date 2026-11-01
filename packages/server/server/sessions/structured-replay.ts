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

import { validIdempotencyKey } from '@agentistics/engine-api'

/** One stdout line the relay recorded. */
export interface OutRecord { t: number; l: string }
/** One write the relay delivered to the child. */
export interface InRecord { t: number; w: string }

/** A call the host makes on a session. */
export type SessionCall = (
  | { op: 'prompt'; text: string }
  | { op: 'answer'; choice?: number; text?: string; requestId?: string }
  | { op: 'cancel' }
  /** MODE.EVERYWHERE — a mode set through the protocol (it writes to the child, so a replay makes it again). */
  | { op: 'setMode'; id: string }
  /** 1.20 — a model set through the protocol (it writes to the child, so a replay makes it again). */
  | { op: 'setModel'; id: string }
  /**
   * 1.21 (ADAPTER.LIMITES E7) — the keyed actions. Recorded BY THE DRIVER after its ledger claimed the key and right
   * before the protocol write (claim → record → write, spec §4.2), so every one carries its `key` and a record exists
   * only for a claimed key. A re-attach makes the same call on the re-created driver, which makes the same write
   * without the ledger (`ReplayTransport.replaying`).
   */
  | { op: 'submit'; requestId: string; text: string; key: string; step?: 'read' }
  | { op: 'amend'; requestId: string; text: string; key: string; step?: 'read' }
  | { op: 'cancelRequest'; requestId: string; key: string; step?: 'read' }
) & {
  /**
   * 1.21 (ADAPTER.LIMITES) — the caller's idempotency key for this action, when it gave one. It is what lets a
   * reconcile after a crash answer "this call was made, and a re-attach replays it" from the record alone.
   * Optional: a record written before keys (or by a caller that gave none) has none.
   */
  key?: string
}

/**
 * A call the host made on the session, and when (`g`: the driver's child — its generation — the call
 * was made on, absent = 0; `at`: lines read from that child; `t`: ms).
 */
export type ReplayCall = SessionCall & { g?: number; at: number; t: number }

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
  if (c.g !== undefined && !(Number.isInteger(c.g) && c.g >= 0)) return false
  if (c.key !== undefined && !validIdempotencyKey(c.key)) return false
  if (c.op === 'prompt') return typeof c.text === 'string'
  if (c.op === 'setMode' || c.op === 'setModel') return typeof c.id === 'string'
  if (c.op === 'submit' || c.op === 'amend' || c.op === 'cancelRequest') {
    // A keyed action always has its key, and `step` names only the reconcile read-back.
    if (typeof c.key !== 'string' || typeof c.requestId !== 'string' || (c.step !== undefined && c.step !== 'read')) return false
    return c.op === 'cancelRequest' || typeof c.text === 'string'
  }
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

/**
 * PURE (1.21). The recorded call made under `key`, or undefined: the FIRST one — a key names one action, so a
 * second record under it would be a retry that should have been recognised, and the earlier one is the truth.
 */
export function callByKey(calls: readonly ReplayCall[], key: string): ReplayCall | undefined {
  // A reconcile read-back (`step: 'read'`) is not the action's write: it proves nothing was made.
  return calls.find(c => c.key === key && !('step' in c && c.step === 'read'))
}
