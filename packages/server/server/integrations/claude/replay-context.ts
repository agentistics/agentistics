/**
 * integrations/claude/replay-context.ts — PURE. One `context.compacted` per compaction Claude Code
 * recorded: a `system` line with `subtype: 'compact_boundary'` and a `compactMetadata` block — the
 * exact record `jsonl.ts`'s `foldCompactEntry` counts, under the same gate, so a projection of these
 * events reproduces `compact_count` / `compact_ms` / `compact_dropped_tokens`.
 *
 * ## `droppedTokens` is an INCREMENT, because the harness writes a running total
 *
 * `ContextCompactedData.droppedTokens` is what ONE compaction removed. Claude Code records
 * `cumulativeDroppedTokens` instead — monotonic across the conversation (measured on a real
 * five-compact session: 954.238 → 4.785.215) and frequently ABSENT (27 of 46 records when
 * `jsonl.ts` measured it). Copying the running total into a per-compaction field would make any
 * projection that sums the events report 14,4M for a session that dropped 4,8M. So each event
 * carries the increment over the largest total reported so far, never negative:
 *
 *   Σ droppedTokens over the events  ===  the largest cumulativeDroppedTokens  ===  legacy's max
 *
 * which is the legacy rule restated per event. An increment that follows a compaction whose record
 * carried NO total may include what that silent compaction dropped, so its confidence is
 * `estimated`; while every earlier compaction reported, it is `exact`. A record with no total carries
 * no `droppedTokens` at all — an absent measurement is never a `0`.
 *
 * `durationMs` and `trigger` are copied when the record states them. `preTokens` / `postTokens` are
 * not carried: the event shape has no field for them, and the vocabulary is not this module's to
 * widen. Nothing here reads the summary text the harness writes after the boundary.
 */
import type { ContextCompactedData } from '@agentistics/core'
import { type ClaudeReplayContext, type EmitEvent, lineRef, makeEvent, str } from './replay-core'

export interface ContextFoldState {
  /** The largest `cumulativeDroppedTokens` read so far; `undefined` until one is. */
  maxDropped: number | undefined
  /** A compaction has been seen whose record carried no total. */
  sawUnreported: boolean
}

export function emptyContextFold(): ContextFoldState {
  return { maxDropped: undefined, sawUnreported: false }
}

/** Every field is a primitive. */
export function cloneContextFold(s: ContextFoldState): ContextFoldState {
  return { ...s }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

export function foldContextEntry(
  state: ContextFoldState, ctx: ClaudeReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') return
  const meta = entry.compactMetadata
  if (!meta || typeof meta !== 'object') return   // the same gate `foldCompactEntry` applies
  const m = meta as Record<string, unknown>

  const data: ContextCompactedData = {}
  let confidence: 'exact' | 'estimated' = 'exact'
  if (finite(m.durationMs)) data.durationMs = m.durationMs
  if (m.trigger === 'auto' || m.trigger === 'manual') data.trigger = m.trigger

  const cumulative = m.cumulativeDroppedTokens
  if (finite(cumulative)) {
    data.droppedTokens = Math.max(0, cumulative - (state.maxDropped ?? 0))
    if (state.sawUnreported) confidence = 'estimated'
    state.maxDropped = Math.max(state.maxDropped ?? 0, cumulative)
  } else {
    state.sawUnreported = true
  }

  const ts = str(entry.timestamp)
  const version = str(entry.version)
  emit(makeEvent(ctx, 'context.compacted', data, {
    sourceRef: lineRef(ctx, lineNo),
    occurredAt: ts ?? ctx.recordedAt,
    confidence,
    ...(version ? { harnessVersion: version } : {}),
  }))
}
