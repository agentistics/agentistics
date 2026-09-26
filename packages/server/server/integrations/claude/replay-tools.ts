/**
 * integrations/claude/replay-tools.ts — PURE: the tool-execution half of the Claude replay fold.
 *
 * One `tool.requested` per `tool_use` block in an assistant line, one `tool.completed` /
 * `tool.failed` per `tool_result` block in the user line that answers it — matched by the
 * harness's own `tool_use_id` (Anthropic's id for the call, which both sides carry), never by
 * position: an assistant turn can request several tools in parallel and there is no rule that
 * their results come back in the same order.
 *
 * ## No conversation text (replay-core.ts, rule 2 of its header)
 *
 * Nothing here copies a tool's input body or a result's output into an event. A shell command
 * enters only as `redactSecrets(commandSummary(input.command))`; a file path is a NAME (allowed,
 * like the entity contract already allows on `ToolExecution.filesTouched`), never the file's
 * contents; every other tool's `summary` is left unset.
 *
 * ## State is small and short-lived
 *
 * `ToolFoldState.pending` holds, per open `tool_use_id`, only what its eventual completion needs
 * that the RESULT side cannot recover on its own: the file path an edit tool named and the line
 * delta computed from ITS OWN request input (never from the result, which carries no input back).
 * An entry is dropped the moment its result is seen — see `finishToolFold` for what is left
 * pending at the end of a walk.
 */
import type { EditDelta } from '../../edit-lines'
import { editDelta } from '../../edit-lines'
import { canonicalTool } from '../../harness-activity'
import { commandSummary } from '../../sessions/shell-writes'
import type { ToolCompletedData, ToolFailedData, ToolKind, ToolRequestedData } from '@agentistics/core'
import { redactSecrets } from '@agentistics/core'
import { lineRef, makeEvent, str, toolExecutionIdOf, type ClaudeReplayContext, type EmitEvent } from './replay-core'

// ── Tool classification ─────────────────────────────────────────────────────────────────────────

const SHELL_NAMES = new Set(['Bash', 'BashOutput', 'KillShell'])
const FILE_NAMES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SEARCH_NAMES = new Set(['Grep', 'Glob'])
const AGENT_NAMES = new Set(['Agent', 'Task'])
/** The write tools `edit-lines.ts#editDelta` and this module's own file-path reader recognise. */
const EDIT_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** The `<server>` segment of an `mcp__<server>__<tool>` name, lazily up to the NEXT `__`. */
function mcpServerOf(canonicalName: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(canonicalName)
  return m?.[1]
}

/**
 * `Bash`/`BashOutput`/`KillShell` → shell; `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit` → file;
 * `Grep`/`Glob` → search; `mcp__<server>__<tool>` → mcp; `Agent`/`Task` → agent; everything else
 * `other` — never guessed as `browser`, which nothing in a Claude transcript's tool_use names ever
 * states.
 */
function classifyTool(canonicalName: string): { kind: ToolKind; mcpServer?: string } {
  const mcpServer = mcpServerOf(canonicalName)
  if (mcpServer) return { kind: 'mcp', mcpServer }
  if (canonicalName.startsWith('mcp__')) return { kind: 'mcp' }
  if (SHELL_NAMES.has(canonicalName)) return { kind: 'shell' }
  if (FILE_NAMES.has(canonicalName)) return { kind: 'file' }
  if (SEARCH_NAMES.has(canonicalName)) return { kind: 'search' }
  if (AGENT_NAMES.has(canonicalName)) return { kind: 'agent' }
  return { kind: 'other' }
}

/**
 * The file an edit tool named, from ITS OWN request input — a NAME, allowed by the entity
 * contract's own `ToolExecution.filesTouched`. `NotebookEdit` names its target `notebook_path`;
 * `Write`/`Edit`/`MultiEdit` name theirs `file_path` (`jsonl.ts` reads the same field for the same
 * three tools).
 */
function filePathOf(canonicalName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  if (canonicalName === 'NotebookEdit') return str(input.notebook_path)
  return str(input.file_path)
}

/**
 * A duration the transcript STATES, never one computed from timestamps (replay.ts's own rule,
 * applied here to a tool call): `toolUseResult.durationMs` or `.totalDurationMs`, whichever is a
 * finite non-negative number.
 */
function durationOf(toolUseResult: unknown): number | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined
  const r = toolUseResult as Record<string, unknown>
  const raw = typeof r.durationMs === 'number' ? r.durationMs
    : typeof r.totalDurationMs === 'number' ? r.totalDurationMs
    : undefined
  return raw !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : undefined
}

/**
 * The exact string a user-interrupted `Agent` call's `toolUseResult` becomes — documented and
 * measured in `subagent-join.ts`'s header. It is the one structural signal this module has for
 * "the person cancelled this", so it is matched verbatim rather than by a substring search over
 * whatever text a tool happened to output (which would read conversation content — D5).
 */
const INTERRUPTED_TOOL_USE_RESULT = 'Error: [Request interrupted by user for tool use]'

// ── State ────────────────────────────────────────────────────────────────────────────────────────

/** What a still-open `tool_use_id` needs remembered until its result arrives. */
interface PendingToolRequest {
  /** The file an edit tool named at request time — the result carries no input back to re-read it. */
  filesTouched?: string[]
  /** The line delta computed from the REQUEST's own input, per `edit-lines.ts`'s own rule. */
  delta?: EditDelta
}

export interface ToolFoldState {
  /** Keyed by the harness's own `tool_use.id` / `tool_result.tool_use_id`. */
  pending: Map<string, PendingToolRequest>
}

export function emptyToolFold(): ToolFoldState {
  return { pending: new Map() }
}

export function cloneToolFold(s: ToolFoldState): ToolFoldState {
  // Every `PendingToolRequest` is written once and never mutated afterwards, so copying the map's
  // entries (not deep-cloning each value) is enough for two states to evolve independently.
  return { pending: new Map(s.pending) }
}

// ── Requests: one `tool_use` block → one `tool.requested` ──────────────────────────────────────

function foldToolRequests(
  s: ToolFoldState, ctx: ClaudeReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const msg = entry.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return

  const occurredAt = str(entry.timestamp) ?? ctx.recordedAt
  const harnessVersion = str(entry.version)
  const sourceRef = lineRef(ctx, lineNo)

  let ordinal = 0
  for (const part of content as Record<string, unknown>[]) {
    if (!part || part.type !== 'tool_use') continue
    const thisOrdinal = ordinal
    ordinal++

    const toolUseId = str(part.id)
    const name = str(part.name)
    if (!toolUseId || !name) continue // a block missing either carries nothing to key or name it by

    const input = part.input as Record<string, unknown> | undefined
    const canonicalName = canonicalTool('claude', name)
    const { kind, mcpServer } = classifyTool(canonicalName)

    const data: ToolRequestedData = {
      toolExecutionId: toolExecutionIdOf(ctx.conversationId, toolUseId),
      name,
      canonicalName,
      kind,
    }
    if (mcpServer) data.mcpServer = mcpServer
    if (kind === 'shell') {
      const cmd = str(input?.command)
      if (cmd) data.summary = redactSecrets(commandSummary(cmd))
    }

    emit(makeEvent(ctx, 'tool.requested', data, {
      sourceRef, occurredAt, confidence: 'exact', ordinal: thisOrdinal, harnessVersion,
    }))

    // What the eventual result will need and cannot recover on its own.
    if (EDIT_NAMES.has(canonicalName)) {
      const fp = filePathOf(canonicalName, input)
      const pending: PendingToolRequest = { delta: editDelta(canonicalName, input) }
      if (fp) pending.filesTouched = [fp]
      s.pending.set(toolUseId, pending)
    }
  }
}

// ── Results: one `tool_result` block → one `tool.completed` / `tool.failed` ─────────────────────

function foldToolResults(
  s: ToolFoldState, ctx: ClaudeReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const msg = entry.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return

  const occurredAt = str(entry.timestamp) ?? ctx.recordedAt
  const harnessVersion = str(entry.version)
  const sourceRef = lineRef(ctx, lineNo)
  // `toolUseResult` sits on the ENTRY, not the block — the shape every existing reader of it
  // (jsonl.ts, subagent-join.ts) already assumes one tool_result per user line answers to. A line
  // that ever carries several would apply the same reading to each of them, which is still no
  // worse than the assumption the rest of this codebase already makes about the same field.
  const entryToolUseResult = entry.toolUseResult
  const wholeLineInterrupted = entryToolUseResult === INTERRUPTED_TOOL_USE_RESULT
  const durationMs = durationOf(entryToolUseResult)

  let ordinal = 0
  for (const part of content as Record<string, unknown>[]) {
    if (!part || part.type !== 'tool_result') continue
    const thisOrdinal = ordinal
    ordinal++

    const toolUseId = str(part.tool_use_id)
    if (!toolUseId) continue

    const pending = s.pending.get(toolUseId)
    s.pending.delete(toolUseId) // drop it the moment its result is seen, matched or not

    const toolExecutionId = toolExecutionIdOf(ctx.conversationId, toolUseId)
    const isError = part.is_error === true

    if (wholeLineInterrupted) {
      const data: ToolFailedData = { toolExecutionId, status: 'cancelled' }
      emit(makeEvent(ctx, 'tool.failed', data, {
        sourceRef, occurredAt, confidence: 'exact', ordinal: thisOrdinal, harnessVersion,
      }))
      continue
    }

    if (isError) {
      const data: ToolFailedData = { toolExecutionId, status: 'failed' }
      emit(makeEvent(ctx, 'tool.failed', data, {
        sourceRef, occurredAt, confidence: 'exact', ordinal: thisOrdinal, harnessVersion,
      }))
      continue
    }

    const data: ToolCompletedData = { toolExecutionId }
    if (pending?.filesTouched) data.filesTouched = pending.filesTouched
    if (pending?.delta) {
      data.linesAdded = pending.delta.added
      data.linesRemoved = pending.delta.removed
    }
    if (durationMs !== undefined) data.durationMs = durationMs
    emit(makeEvent(ctx, 'tool.completed', data, {
      sourceRef, occurredAt, confidence: 'exact', ordinal: thisOrdinal, harnessVersion,
    }))
  }
}

// ── Public fold ──────────────────────────────────────────────────────────────────────────────────

export function foldToolEntry(
  s: ToolFoldState, ctx: ClaudeReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  if (entry.type === 'assistant') foldToolRequests(s, ctx, entry, lineNo, emit)
  else if (entry.type === 'user') foldToolResults(s, ctx, entry, lineNo, emit)
}

/**
 * A `tool_use` still pending at the end of a walk — a background launch, an async agent, a call
 * whose answer the transcript never wrote — is not a tool we OBSERVED failing or completing; the
 * absence is a fact about what the transcript states, not a status the tool reached. So this emits
 * nothing, on purpose, for `final` or not: idempotent trivially, since it neither reads nor writes
 * `s.pending`.
 */
export function finishToolFold(
  s: ToolFoldState, ctx: ClaudeReplayContext, final: boolean, emit: EmitEvent,
): void {
  void s
  void ctx
  void final
  void emit
}
