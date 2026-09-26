/**
 * integrations/claude/replay.ts — PURE. A Claude Code transcript, read as canonical events.
 *
 * The shape is `jsonl.ts`'s own: `emptyClaudeReplay` / `foldClaudeReplay` / `finishClaudeReplay`,
 * every accumulator moving only forward, so folding a transcript in one call and in N uneven chunks
 * emits the same events — the property `transcript-cursor.ts` needs to resume a live file from a
 * byte offset instead of re-reading it (CLAUDE.md, "A LIVE transcript is read by what it has
 * WRITTEN SINCE LAST TIME"). The IO half is `./index.ts`.
 *
 * Four sub-folds, one per concern, each in its own module:
 * - `replay-agents.ts` — the session, the run and the agents: when each started and ended, and the
 *   subagents the `subagents/` directory says existed (`subagent-join.ts`).
 * - `replay-model.ts` — one `model.invoked` + `model.completed` per billed response, keyed on
 *   `message.id`, emitted ONCE with its FINAL usage (see that module: the journal keeps the FIRST
 *   row per id, so an early partial would be the one kept).
 * - `replay-tools.ts` — one `tool.requested` per `tool_use` block, one `tool.completed` /
 *   `tool.failed` per result.
 * - `replay-context.ts` — one `context.compacted` per `compact_boundary` record.
 *
 * The fold never collects events: it hands each one to `emit` as it is made, so the caller decides
 * how many to hold (P1 §9 — no unbounded accumulation). `lineNo` is 1-based and counts EVERY raw
 * line, blanks included, exactly as `foldClaudeParse` counts them, so the sink `jsonl.ts` offers and
 * this fold's own line reader name the same record by the same number.
 */
import type { ClaudeReplayContext, EmitEvent } from './replay-core'
import { emptyLifecycleFold, finishLifecycleFold, foldLifecycleEntry, type LifecycleFoldState } from './replay-agents'
import { emptyContextFold, foldContextEntry, type ContextFoldState } from './replay-context'
import { emptyModelFold, finishModelFold, foldModelEntry, type ModelFoldState } from './replay-model'
import { emptyToolFold, finishToolFold, foldToolEntry, type ToolFoldState } from './replay-tools'

/**
 * `main`: the conversation's own transcript, which opens and closes the session, the run and the
 * main agent. `subagent`: a `subagents/agent-<id>.jsonl`, whose agent is opened by the parent's
 * launch (see `subagentLaunchEvents`) — it contributes model and tool events and its own end.
 */
export type ClaudeTranscriptRole = 'main' | 'subagent'

export interface ClaudeReplayState {
  ctx: ClaudeReplayContext
  role: ClaudeTranscriptRole
  /** The last line folded, 1-based. */
  lineNo: number
  lifecycle: LifecycleFoldState
  model: ModelFoldState
  tools: ToolFoldState
  context: ContextFoldState
}

export function emptyClaudeReplay(ctx: ClaudeReplayContext, role: ClaudeTranscriptRole = 'main'): ClaudeReplayState {
  return { ctx, role, lineNo: 0, lifecycle: emptyLifecycleFold(), model: emptyModelFold(), tools: emptyToolFold(),
    context: emptyContextFold() }
}

/**
 * Advance over ONE already-parsed entry — the entry-level half, which `jsonl.ts`'s optional sink
 * feeds without parsing the line a second time. `lineNo` is the caller's count of that line.
 */
export function foldClaudeReplayEntry(
  state: ClaudeReplayState, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  state.lineNo = lineNo
  foldLifecycleEntry(state.lifecycle, state.ctx, state.role, entry, lineNo, emit)
  foldModelEntry(state.model, state.ctx, entry, lineNo, emit)
  foldToolEntry(state.tools, state.ctx, entry, lineNo, emit)
  foldContextEntry(state.context, state.ctx, entry, lineNo, emit)
}

/** Advance over raw lines. Numbering, blank-line and bad-JSON handling mirror `foldClaudeParse`. */
export function foldClaudeReplay(state: ClaudeReplayState, lines: Iterable<string>, emit: EmitEvent): void {
  for (const raw of lines) {
    const lineNo = state.lineNo + 1
    state.lineNo = lineNo
    const line = raw.trim()
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    foldClaudeReplayEntry(state, entry as Record<string, unknown>, lineNo, emit)
  }
}

export interface FinishOptions {
  /**
   * The transcript is COMPLETE — nothing more will be appended. Only then are the held last
   * response and the `*.ended` events emitted. On a live transcript pass `false`: the held response
   * stays held and is emitted by whichever later fold proves it closed.
   */
  final: boolean
}

/**
 * Emit what only the end of the walk can say. Idempotent within a state: a second call emits
 * nothing the first already did. Does not reset the state — a `final: false` finish may be followed
 * by more folding.
 */
export function finishClaudeReplay(state: ClaudeReplayState, opts: FinishOptions, emit: EmitEvent): void {
  finishModelFold(state.model, state.ctx, opts.final, emit)
  finishToolFold(state.tools, state.ctx, opts.final, emit)
  finishLifecycleFold(state.lifecycle, state.ctx, state.role, opts.final, emit)
}
