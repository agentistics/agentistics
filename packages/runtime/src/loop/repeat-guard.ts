/**
 * loop/repeat-guard.ts — PURE: has the model asked for the SAME tool call, with the SAME input,
 * several times in a row while nothing changed? (H18, the doom-loop guard.)
 *
 * The loop folds every call it processes through here and, when `verdict` says `ask`, hands the
 * gate a policy that ESCALATES an `allow` into a question to the person (`./repeat-policy.ts`). This
 * module decides only WHEN; it never executes, never skips the gate and never lifts a deny.
 *
 * ## Identity
 *
 * A call's identity is the catalogue tool name plus a CANONICAL JSON of its input — object keys
 * sorted at every depth, array order kept — so `{a:1,b:2}` and `{b:2,a:1}` are the same call. It is
 * stored as a sha256 of that text, so memory stays bounded however large an input is (a `file.write`
 * carries a whole file): the state is the last call's digest, its count and its last result's digest,
 * nothing more.
 *
 * ## What resets the count, and why
 *
 * - **A different call** (another tool, or the same tool with other input) — the run is no longer
 *   "the same thing again". A call the loop answers itself without the gate (unknown tool, arguments
 *   that could not be read) resets too (`foldBreak`): something other than the repeat happened.
 * - **A result that differs from the previous identical call's result** (`foldResult`). Repeating a
 *   call whose answer keeps moving is POLLING — `git status` while a build runs, reading a log that
 *   grows — and is legitimate; the loop worth stopping is the one where the model is told the same
 *   thing and asks again. So the third identical call asks only when the first two came back
 *   byte-identical. The result is the text the model reads plus whether it was an error.
 * - **A person allowing the repeat** (`foldApproved`) — the approved call is the first of a new run,
 *   so the person is asked again after `REPEAT_LIMIT - 1` more identical calls, never on every one.
 *
 * What does NOT reset it: the guard's own refusal. Its sentence is a different result from the one
 * before, and folding it would let the very next identical call through silently — so the loop does
 * not fold the result of a call the guard refused, and a model that insists is asked (or refused)
 * again on every further repeat.
 */

import { sha256Hex } from '@agentistics/core'

/** The Nth identical call in a row (with identical results in between) goes to the person. */
export const REPEAT_LIMIT = 3

export interface RepeatState {
  /** Digest of the last call's identity; `null` = no call yet, or the run was broken. */
  readonly last: string | null
  /** How many times in a row `last` has been asked for, this one included. */
  readonly count: number
  /** Digest of the last result of `last`; `null` = none folded yet. */
  readonly lastResult: string | null
}

export const emptyRepeatState: RepeatState = { last: null, count: 0, lastResult: null }

/** JSON with object keys sorted at every depth. `undefined` members are dropped, as JSON does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export function callIdentity(toolName: string, input: unknown): string {
  return sha256Hex(`${toolName}\u0000${canonicalJson(input)}`)
}

export function resultDigest(ok: boolean, modelText: string): string {
  return sha256Hex(`${ok ? 'ok' : 'error'}\u0000${modelText}`)
}

/** A call that is about to reach the gate. */
export function foldCall(state: RepeatState, identity: string): RepeatState {
  if (state.last === identity) return { last: identity, count: state.count + 1, lastResult: state.lastResult }
  return { last: identity, count: 1, lastResult: null }
}

/** The result of the call just folded. A result unlike the previous one restarts the count. */
export function foldResult(state: RepeatState, digest: string): RepeatState {
  if (state.last === null) return state
  if (state.lastResult !== null && state.lastResult !== digest) return { last: state.last, count: 1, lastResult: digest }
  return { last: state.last, count: state.count, lastResult: digest }
}

/** A person allowed the repeat: that call starts a new run. */
export function foldApproved(state: RepeatState): RepeatState {
  return state.last === null ? state : { last: state.last, count: 1, lastResult: state.lastResult }
}

/** Something other than a gate call happened between two calls. */
export function foldBreak(): RepeatState {
  return emptyRepeatState
}

export type RepeatVerdict = 'pass' | 'ask'

export function verdict(state: RepeatState, limit: number = REPEAT_LIMIT): RepeatVerdict {
  return state.last !== null && state.count >= limit ? 'ask' : 'pass'
}
