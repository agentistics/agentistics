/**
 * integrations/claude/replay-turns.ts — PURE. One `turn.started` per PERSON's turn (decision D22,
 * 2026-09-26): a `type: 'user'` line for which `isHumanUserEntry` (`jsonl.ts`) is true.
 *
 * `isHumanUserEntry` is IMPORTED, never restated — it is the exact predicate `jsonl.ts` counts
 * `user_message_count` with (excluding a pure `tool_result` feedback, `isMeta`'s
 * `<local-command-caveat>` block and `isCompactSummary`'s continuation notice), so a projection that
 * counts these events agrees with legacy by construction rather than by two readings of one rule
 * happening to match.
 *
 * ## No text, no size (D5)
 *
 * The event carries WHO (`by: 'user'`) and nothing else. WHEN is the envelope's `occurredAt` and
 * WHICH LINE is its `sourceRef` — never the message body, its character count, or whether it was
 * plain text or an array of content blocks. `TurnStartedData` has exactly one field for this reason.
 *
 * ## MAIN transcripts only — a subagent's `user` lines are not a person's turns
 *
 * Legacy's `user_message_count` is computed by `foldClaudeParse` walking the MAIN transcript alone;
 * `subagent-parse.ts` (the reader behind `AgentInvocation` metrics) never calls `isHumanUserEntry`
 * and folds no notion of "human turns" over a `subagents/agent-<id>.jsonl` file at all. Those files
 * carry the orchestrator's own tool-call traffic under the `user` role (mostly `tool_result`
 * feedback), not a person typing — so counting them here would count something legacy never counts,
 * and the whole point of this event is that counting it reproduces `user_message_count` exactly.
 * `foldTurnEntry` therefore takes the same `role: ClaudeTranscriptRole` the sibling lifecycle fold
 * does and is a no-op for `role: 'subagent'`, mirroring `foldLifecycleEntry`'s `role === 'main'`
 * gate for `session.started`/`run.started`/`agent.started`.
 *
 * ## A line with no parseable timestamp still counts — matching legacy exactly
 *
 * `jsonl.ts`'s counting line (`state.userMsgs++`) sits OUTSIDE the `if (ts) { … }` block that gates
 * every timestamp-dependent side effect in that walk — a human line with an unparseable or absent
 * `timestamp` is still a round, still opens a turn, still counted. Two sibling folds already answer
 * "what happens when a line has no usable timestamp" differently: `replay-agents.ts`'s
 * `foldLifecycleEntry` returns without emitting (a lifecycle boundary needs a real time to define
 * `session.started`/`agent.ended` at all), while `replay-model.ts` and `replay-tools.ts` fall back to
 * `ctx.recordedAt` — the walk's own clock, not a fabricated occurrence time — so a `model.completed`
 * or `tool.requested` is still emitted for a line the harness forgot to stamp.
 *
 * This module follows the SECOND precedent, deliberately: the event's whole reason to exist is that
 * `Σ turn.started === legacy's user_message_count`, and skipping timestamp-less lines would make
 * that equation false the moment a fixture (or a real transcript) has one. `ctx.recordedAt` is
 * already the codebase's established stand-in for "we do not know when, so we say when we are
 * replaying" — it is not an invented business fact, and every event in this integration already
 * accepts it as an honest fallback. The one place this module DOES diverge from `replay-model.ts` /
 * `replay-tools.ts`: `provenance.confidence` reads `'estimated'` rather than a blanket `'exact'` when
 * the fallback fires, per D17's own rule ("it becomes `estimated` the moment the rule introduces an
 * estimate") — `by: 'user'` is certain either way, but `occurredAt` is a guess in that case, and the
 * envelope's confidence is the weakest of its inputs.
 */
import { isHumanUserEntry } from '../../jsonl'
import { lineRef, makeEvent, str, type ClaudeReplayContext, type EmitEvent } from './replay-core'

/**
 * `'main' | 'subagent'` — kept as a literal here for the same reason `replay-agents.ts` keeps its
 * own copy: importing it from `./replay.ts` (which imports THIS module) would be a cycle, and
 * TypeScript's structural typing makes the duplication free.
 */
type Role = 'main' | 'subagent'

/**
 * No state is kept between lines: whether a line is a human turn is decided entirely by the line
 * itself (`isHumanUserEntry`) and the caller's `role`, never by anything folded earlier. The empty
 * object still exists, rather than this module offering no state type at all, so it slots into
 * `ClaudeReplayState`/`cloneClaudeReplayState` exactly like every sibling fold.
 */
export type TurnFoldState = Record<string, never>

export function emptyTurnFold(): TurnFoldState {
  return {}
}

export function cloneTurnFold(s: TurnFoldState): TurnFoldState {
  return { ...s }
}

export function foldTurnEntry(
  _state: TurnFoldState, ctx: ClaudeReplayContext, role: Role, entry: Record<string, unknown>, lineNo: number,
  emit: EmitEvent,
): void {
  if (role !== 'main') return
  if (!isHumanUserEntry(entry)) return

  const ts = str(entry.timestamp)
  emit(makeEvent(ctx, 'turn.started', { by: 'user' }, {
    sourceRef: lineRef(ctx, lineNo),
    occurredAt: ts ?? ctx.recordedAt,
    confidence: ts ? 'exact' : 'estimated',
  }))
}
