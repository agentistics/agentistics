/**
 * integrations/claude/replay-turns.ts — PURE. One `turn.started` per PERSON's turn (decision D22,
 * 2026-09-26), plus (D25, 2026-09-26) one `turn.ended` per turn CLOSE and `previousAssistantAt` on
 * every `turn.started` — everything a projection needs to reproduce legacy's `active_minutes`
 * (`packages/core/src/activeTime.ts`, `foldActiveTime`) and `user_response_times`
 * (`jsonl.ts`'s `foldClaudeParse`, ~lines 636-790) EXACTLY, from replayed events alone.
 *
 * `isHumanUserEntry` is IMPORTED, never restated — it is the exact predicate `jsonl.ts` counts
 * `user_message_count` with (excluding a pure `tool_result` feedback, `isMeta`'s
 * `<local-command-caveat>` block and `isCompactSummary`'s continuation notice), so a projection that
 * counts these events agrees with legacy by construction rather than by two readings of one rule
 * happening to match.
 *
 * ## No text, no size (D5)
 *
 * `turn.started` carries WHO (`by: 'user'`), WHEN a prior response last spoke
 * (`previousAssistantAt`) and nothing else — never the message body, its character count, or
 * whether it was plain text or an array of content blocks. `turn.ended` carries only HOW it closed
 * (`close`) and, when measured, HOW LONG (`durationMs`). WHEN either happened is the envelope's
 * `occurredAt` and WHICH LINE is its `sourceRef`.
 *
 * ## MAIN transcripts only — a subagent's `user` lines are not a person's turns
 *
 * Legacy's `user_message_count` and `foldActiveTime`'s walk are both driven by the MAIN transcript
 * alone; `subagent-parse.ts` (the reader behind `AgentInvocation` metrics) never calls
 * `isHumanUserEntry` and folds no notion of "human turns" over a `subagents/agent-<id>.jsonl` file
 * at all. Those files carry the orchestrator's own tool-call traffic under the `user` role (mostly
 * `tool_result` feedback), not a person typing — so counting them here would count something legacy
 * never counts. `foldTurnEntry`/`finishTurnFold` therefore take the same
 * `role: ClaudeTranscriptRole` the sibling lifecycle fold does and are a no-op for
 * `role: 'subagent'`, mirroring `foldLifecycleEntry`'s `role === 'main'` gate.
 *
 * ## A line with no parseable timestamp still counts a TURN, but never a CLOSE
 *
 * `jsonl.ts`'s counting line (`state.userMsgs++`) sits OUTSIDE the `if (ts) { … }` block that gates
 * every timestamp-dependent side effect in that walk — a human line with an unparseable or absent
 * `timestamp` is still a round, still emits `turn.started` (falling back to `ctx.recordedAt`,
 * `confidence: 'estimated'`, exactly as before D25). But `foldActiveTime`'s `TurnEvent[]` only ever
 * receives an event for a line whose `Date.parse` SUCCEEDS (`jsonl.ts`'s `tsMs` guard) — a line that
 * cannot be timed is never pushed to the array at all, so it can neither open nor close a turn in
 * legacy's own reconstruction. `timedTimestamp` below is that exact "timed line" test (a `str()`
 * truthy string is not enough — it must additionally `Date.parse` cleanly), and every open/close
 * decision in this module is gated on it. This is WHY the untimed human line above still emits
 * `turn.started` (matching `user_message_count`) while never touching `TurnFoldState`'s open/close
 * bookkeeping (matching `foldActiveTime`, which never saw it either).
 *
 * ## The three ways a turn closes (`docs/harness-contract.md` § 1 / `activeTime.ts`'s header)
 *
 * 1. **`measured`** — a `system`/`turn_duration` line, itself a timed line, with a `durationMs` that
 *    is a `number`. Legacy's `foldActiveTime` only actually CLOSES the turn with it when the number
 *    is additionally finite and `>= 0` (a negative one is dropped as a duration but the line still
 *    updates `state.last`, per `activeTime.ts`'s guard) — so a valid-but-negative measurement is
 *    "just an ordinary timed line" here too: no `turn.ended`, but the last-timed bookkeeping moves.
 *    A `turn_duration` line with NO open turn emits nothing (a stray measurement invents no turn),
 *    but still advances the last-timed line, exactly as `foldActiveTime`'s unconditional
 *    `state.last = ts` does after the `if (state.turnStart !== null)` guard.
 * 2. **`last-line`, on the next human turn** — legacy closes the OPEN turn at `state.last` (the last
 *    TIMED line seen, of ANY type/role-in-file, BEFORE this prompt) the instant a new timed human
 *    line arrives, then opens the new one. The close is emitted before `turn.started` for the same
 *    reason: `activeTime.ts` closes at the OLD `state.last`, never at the new prompt's own time.
 * 3. **`last-line`, at `finish({final: true})`** — mirrors `finishActiveTime`: the last turn ends at
 *    the last timed event ever seen, without being marked closed in `state` (a resumed live
 *    transcript may still append to it — see below).
 *
 * ## Finish is a SNAPSHOT, not a close — mirrors `finishLifecycleFold`'s `closedThroughLine`
 *
 * `finishActiveTime` explicitly does NOT mutate `state.turnStart` — "closing the turn in place would
 * make the next fold count the time before it twice" once more lines arrive. This module keeps the
 * same promise for the SAME reason: `TurnFoldState.turnOpen` is left `true` after a finish-time
 * `turn.ended`, so a resumed transcript's next prompt (or next final finish) still closes the SAME
 * open turn, correctly, from wherever `lastTimedAt` has moved to. `closedThroughLine` is the
 * idempotence guard (identical in spirit to `LifecycleFoldState.closedThroughLine`): a second
 * `final: true` finish with no new timed line folded since emits nothing, and one after MORE lines
 * were folded emits again, at the new true end. It is reset to `null` the moment the turn actually
 * closes for a real reason (measured, or a new prompt), so a LATER turn's own finish-time close is
 * judged fresh rather than against a stale line number from a turn that is no longer open.
 *
 * ## `previousAssistantAt` — legacy `state.lastAssistantTs`, never reset between turns
 *
 * `jsonl.ts` sets `state.lastAssistantTs = ts` for every `type: 'assistant'` line whose `timestamp`
 * is a TRUTHY STRING — deliberately not gated on `Date.parse` succeeding, unlike the close logic
 * above (an unparseable `lastAssistantTs` simply fails the later `new Date(...).getTime()` NaN
 * comparison and contributes no response time, without ever being treated as "no value"). This
 * module mirrors that with `str()` alone, tracked separately from the timed-line bookkeeping the
 * closes use, and carried on every `turn.started` — including an ESTIMATED one, so the projection
 * decides whether an untimed prompt's response time can be trusted.
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
 * A line legacy's `foldActiveTime` could ever open or close a turn AT: `timestamp` is a string AND
 * `Date.parse` of it succeeds. `str()` alone accepts any non-empty string, including one
 * `Date.parse` cannot read — see this module's header on why that distinction matters here and does
 * not for `turn.started`/`previousAssistantAt`.
 */
function timedTimestamp(entry: Record<string, unknown>): string | undefined {
  const ts = str(entry.timestamp)
  if (ts === undefined) return undefined
  return Number.isNaN(Date.parse(ts)) ? undefined : ts
}

/**
 * The walk this module keeps between folds — see `replay.ts`'s `ClaudeReplayState`. Every field
 * moves only forward or resets on a real state change, per CLAUDE.md's rule for a walk that must
 * give the same answer whether it is folded in one call or in a hundred uneven ones.
 */
export interface TurnFoldState {
  /** Is a turn currently open (opened by a human timed line, not yet closed by a measurement or a
   *  later human timed line)? An UNTIMED human line never changes this either way. */
  turnOpen: boolean
  /** The last line folded (main transcript only) that was a TIMED line (`timedTimestamp`), of ANY
   *  type — legacy's `state.last`. 0 = none yet. Where an open turn closes when nothing measured it. */
  lastTimedLineNo: number
  /** That line's own timestamp, or `null` before the first timed line. */
  lastTimedAt: string | null
  /** The raw `timestamp` string of the last `type: 'assistant'` line seen so far with a truthy
   *  string timestamp (need not be `Date.parse`-able) — legacy `state.lastAssistantTs`. Never reset
   *  between turns; `undefined` until the first one is seen. */
  lastAssistantAt: string | undefined
  /**
   * The `lastTimedLineNo` a finish-time `turn.ended('last-line')` was already emitted for — the
   * idempotence guard, mirroring `LifecycleFoldState.closedThroughLine`. Reset to `null` whenever
   * the open turn closes for a REAL reason (measured, or a new prompt), so a later turn's own
   * finish-time close is judged against its own lines, never a stale one from a closed turn.
   */
  closedThroughLine: number | null
}

export function emptyTurnFold(): TurnFoldState {
  return { turnOpen: false, lastTimedLineNo: 0, lastTimedAt: null, lastAssistantAt: undefined, closedThroughLine: null }
}

export function cloneTurnFold(s: TurnFoldState): TurnFoldState {
  return { ...s }
}

export function foldTurnEntry(
  state: TurnFoldState, ctx: ClaudeReplayContext, role: Role, entry: Record<string, unknown>, lineNo: number,
  emit: EmitEvent,
): void {
  if (role !== 'main') return

  const timed = timedTimestamp(entry)

  // 1. The harness's own per-turn measurement. Matches legacy's `typeof e.durationMs === 'number'`
  // gate exactly (a negative/non-finite value still takes this branch and is treated as an ordinary
  // timed line — see `activeTime.ts`'s `foldActiveTime` guard); a line that fails EITHER the type
  // check or the timed-line test falls through to be treated as an ordinary main-transcript line.
  if (timed !== undefined && entry.type === 'system' && entry.subtype === 'turn_duration'
      && typeof entry.durationMs === 'number') {
    const durationMs = entry.durationMs
    if (state.turnOpen && Number.isFinite(durationMs) && durationMs >= 0) {
      emit(makeEvent(ctx, 'turn.ended', { close: 'measured', durationMs }, {
        sourceRef: lineRef(ctx, lineNo), occurredAt: timed, confidence: 'exact',
      }))
      state.turnOpen = false
      state.closedThroughLine = null
    }
    // A stray or non-closing measurement still moves `last` — legacy's unconditional
    // `state.last = ts` runs whether or not the branch above actually closed anything.
    state.lastTimedLineNo = lineNo
    state.lastTimedAt = timed
    return
  }

  // 2. A person's turn (D22) — same predicate `turn.started` has always used.
  if (isHumanUserEntry(entry)) {
    if (timed !== undefined) {
      // A turn already open closes HERE, at the PREVIOUS last-timed line — never at this prompt's
      // own timestamp, matching `activeTime.ts`'s "closes at the last event seen, not the prompt
      // that starts the next one".
      if (state.turnOpen) {
        emit(makeEvent(ctx, 'turn.ended', { close: 'last-line' }, {
          sourceRef: lineRef(ctx, state.lastTimedLineNo), occurredAt: state.lastTimedAt!, confidence: 'exact',
        }))
      }
      state.turnOpen = true
      state.closedThroughLine = null
      state.lastTimedLineNo = lineNo
      state.lastTimedAt = timed
    }
    // An UNTIMED human line neither opens nor closes anything in the bookkeeping above (it never
    // reaches legacy's `TurnEvent[]` either), but it is still counted as a round — `turn.started`
    // fires unconditionally, exactly as before D25.
    const ts = str(entry.timestamp)
    emit(makeEvent(ctx, 'turn.started', {
      by: 'user',
      ...(state.lastAssistantAt !== undefined ? { previousAssistantAt: state.lastAssistantAt } : {}),
    }, {
      sourceRef: lineRef(ctx, lineNo),
      occurredAt: ts ?? ctx.recordedAt,
      confidence: ts ? 'exact' : 'estimated',
    }))
    return
  }

  // 3. Everything else on the main transcript: an assistant line additionally updates
  // `lastAssistantAt` (on a truthy string timestamp, `Date.parse`-able or not — legacy's
  // `state.lastAssistantTs` is gated the same, looser way), and — like every other non-human,
  // non-turn_duration line — moves the last-timed bookkeeping when it IS a timed line.
  if (entry.type === 'assistant') {
    const rawAssistantTs = str(entry.timestamp)
    if (rawAssistantTs !== undefined) state.lastAssistantAt = rawAssistantTs
  }

  if (timed !== undefined) {
    state.lastTimedLineNo = lineNo
    state.lastTimedAt = timed
  }
}

/**
 * Emit what only the end of the walk can say — see `replay.ts`'s `FinishOptions`. Idempotent: a
 * second `final: true` call with nothing new folded since emits nothing; a `final: true` call after
 * MORE lines were folded closes again, at the new last timed line (a resumed conversation's open
 * turn ends again, further along). Deliberately does NOT set `turnOpen = false` — see this module's
 * header on why a finish is a snapshot, never a close.
 */
export function finishTurnFold(
  state: TurnFoldState, ctx: ClaudeReplayContext, role: Role, final: boolean, emit: EmitEvent,
): void {
  if (role !== 'main') return
  if (!final) return
  if (!state.turnOpen) return
  if (state.lastTimedAt === null) return
  if (state.closedThroughLine === state.lastTimedLineNo) return

  emit(makeEvent(ctx, 'turn.ended', { close: 'last-line' }, {
    sourceRef: lineRef(ctx, state.lastTimedLineNo), occurredAt: state.lastTimedAt, confidence: 'exact',
  }))
  state.closedThroughLine = state.lastTimedLineNo
}
