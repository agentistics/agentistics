import type { AnyAgentisticsEvent } from './event'

/**
 * projection.ts — the one contract every projection in the runtime rewrite (P1/P3, see
 * docs/superpowers/specs/2026-09-19-agentistics-runtime-master.md §19.4) is written against.
 *
 * A projection is a pure, RESUMABLE fold over an ordered event stream: `empty()` opens a walk,
 * `fold()` advances it over whatever slice of events is available right now, and `finish()` reads
 * an answer off the walk WITHOUT ending it — the same walk can be folded further and finished
 * again later. This is not a new idea in this codebase: it is the exact shape `ActiveTimeState`
 * (`activeTime.ts`), `ClaudeParseState` (`jsonl.ts`) and `AgentMetricsState` (`agent-metrics.ts`)
 * already use, each with its own hand-written `empty`/`fold`/`finish` trio. This module names that
 * shape once so a new projection can be written against a declared contract instead of copying one
 * of those three by eye, and so an existing accumulator can be adopted here later with no rewrite —
 * only a wrapper that satisfies `Projection<S, R>`.
 *
 * THE RULE THAT MAKES RESUMING SOUND (see CLAUDE.md, "A LIVE transcript is read by what it has
 * WRITTEN SINCE LAST TIME" → "EVERY ACCUMULATOR MOVES ONLY FORWARD"): folding events 1..n and then
 * n+1..m must give the same state as folding 1..m in one call. `fold()` is the only place that can
 * break this — it must never rewind, rewrite or discard anything already folded, only add to it.
 * `projection.test.ts` pins exactly this property by folding one input at every possible split
 * point (and a few genuinely uneven multi-slice walks) and checking every one agrees with folding
 * it whole.
 *
 * `version` is `projectionVersion` from §45 of the spec above: it is metadata for the CALLER (the
 * thing that decides whether a stored projection is stale and must be rebuilt from the journal),
 * never something `fold`/`finish` reads. Bumping it means "re-derive this projection from the raw
 * events" — an old event is never rewritten, and a projection is never silently reinterpreted in
 * place. `name` is the projection's stable name (e.g. `'session-meta'`), used to key wherever a
 * projection's output or resume-state is stored.
 */

/** A projection over an event stream of type `E`, producing accumulator state `S` and a
 *  finished, read-only result `R`. `E` defaults to the canonical event envelope so most
 *  projections in this runtime can write `Projection<MyState, MyResult>` and get the right event
 *  type for free; a projection over some other stream (or a test's own toy events) supplies `E`
 *  explicitly. */
export interface Projection<S, R, E = AnyAgentisticsEvent> {
  /** Stable name for this projection — e.g. `'session-meta'`, `'agent-metrics'`. Used to key
   *  wherever the projection's stored output or resume-state lives. Never used inside the fold. */
  readonly name: string

  /** `projectionVersion` (spec §45). Bumping it means "rebuild this projection from the journal" —
   *  it is read by whatever drives rebuilds, never by `fold`/`finish` themselves. */
  readonly version: number

  /** A walk that has seen nothing. Called once per fresh walk; a resumed walk instead reloads
   *  whatever state was persisted for it and folds new events onto that. */
  empty(): S

  /** Advance `state` over `events`, in stream order. MUTATES `state` and returns nothing — the
   *  same shape `foldActiveTime`/`foldClaudeParse`/`foldAgentMetrics` already have. Must be
   *  forward-only (see the module header): folding is idempotent under re-slicing but never under
   *  re-ordering or repeating the same event twice — a caller that might see an event again is
   *  responsible for not folding it twice, exactly as `transcript-cursor.ts` guarantees for the
   *  existing accumulators. */
  fold(state: S, events: Iterable<E>): void

  /** The answer as of right now, WITHOUT ending the walk — `state` is left untouched so it can be
   *  folded further and finished again. Must not hand out a live collection that is part of
   *  `state`: a caller mutating the returned `R` (or folding more events afterwards) must never
   *  change a `R` some earlier `finish()` call already returned. This mirrors `finishClaudeSession`
   *  copying every collection out of `ClaudeParseState` rather than handing the accumulator's own
   *  arrays to the caller. */
  finish(state: S): R
}

/**
 * One-shot wrapper over `empty` + `fold` + `finish` — the same convenience
 * `computeActiveTime`/`parseSessionJsonl` are over their own folds, for a caller that has the
 * whole event stream in hand and no resume state to carry.
 */
export function project<S, R, E>(p: Projection<S, R, E>, events: Iterable<E>): R {
  const state = p.empty()
  p.fold(state, events)
  return p.finish(state)
}
