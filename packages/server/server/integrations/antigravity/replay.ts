/**
 * integrations/antigravity/replay.ts — PURE. One agy transcript (`transcript_full.jsonl`), read as
 * canonical events. The IO half is `./index.ts`; the `gen_metadata` rows are `./replay-genmeta.ts`.
 *
 * Shape: `emptyAntigravityReplay` / `foldAntigravityReplay` / `finishAntigravityReplay`, every
 * accumulator moving only forward, so folding a transcript whole and in N uneven chunks emits the
 * same events (the property `replay.test.ts` pins).
 *
 * ## Every rule here is `antigravity-parse.ts`'s, IMPORTED — never restated
 *
 * `parseAntigravityTranscriptDetailed` is the legacy reader and the parity target; this fold walks
 * the same lines under the same gates, in the same order, with the same helpers:
 * - `CONVERSATION_HISTORY` steps are REPLAYS and are skipped (`REPLAY_TYPES`);
 * - a step is read once per `step_index` (a replayed / re-appended step never counts twice);
 * - a USER_INPUT counts when `extractUserRequest` leaves text — and only a non-slash one
 *   (`isSlashCommandPrompt`) makes the conversation GENUINE (a slash command is still counted as a
 *   user message, exactly as legacy counts it, so `turn.started` is emitted for it too — D22's
 *   "one per entry the legacy parser counts as a person's turn");
 * - the three error checks are MUTUALLY EXCLUSIVE (ERROR_MESSAGE, else a non-zero `exit_code`, else
 *   `status ERROR|FAILED`), so one failed step can never be two errors;
 * - a shell command appears TWICE (the `run_command` REQUEST on a planner step, then the RUN_COMMAND
 *   EXECUTION step carrying the command): only the EXECUTION becomes a `tool.requested`, the request
 *   is skipped (`canonicalTool(...) === 'Bash'`), as legacy counts it;
 * - an edit's lines are newline counts of the payload (`countLines`) and its file is the call's
 *   `TargetFile`, for `EDIT_TOOLS` or any call carrying a payload; a CODE_ACTION step names the file
 *   it wrote (`TargetFile`, or the `file://` URIs in its prose, `FILE_URI_RE` + `fileUriToPath`).
 *
 * ## What each event is read from
 *
 * - `session.started` / `run.started` / `agent.started(main)` — the FIRST timestamped step of the
 *   run's own conversation. A child conversation opens only its own `agent.started(subagent)`.
 * - `turn.started` — each USER_INPUT legacy counts (main conversation only: a child's USER_INPUT is
 *   its parent's DISPATCH, which legacy never counts as a person). `occurredAt` is the step's own
 *   `created_at` verbatim — legacy's `user_message_timestamps` entry.
 * - `turn.ended` (`last-line`) — at the last timestamped step before the next counted prompt, or at
 *   the end of the transcript. agy writes no turn duration, so no turn closes as `measured`.
 *   `previousAssistantAt` is never set: legacy agy reports no response times (`[]`).
 * - `tool.requested` — every `tool_calls` entry (the shell REQUEST excepted), and every RUN_COMMAND
 *   execution (as `RUN_COMMAND`, canonical `Bash`, its command only through `commandSummary`).
 * - `tool.completed` — an edit call's payload deltas (the only place agy states them — the same
 *   request-time reading legacy and the Claude replay make), a CODE_ACTION's file names, and a
 *   RUN_COMMAND that exited 0.
 * - `tool.failed` — a non-zero `exit_code` (`errorClass: 'exit_code'`) or a failed `status`
 *   (`errorClass: 'status_error'`), on that step's own execution.
 * - `model.failed` — an ERROR_MESSAGE step (`errorClass: error_<code>` | `error_message`, legacy's
 *   own category). agy ties the step to no call, so the model it names is the conversation's
 *   dominant one (`ctx.modelHint`) and the event is `estimated`.
 * - `agent.ended` — at `finish({ final: true })`, stamped with the LAST timestamped step. The run's
 *   `session.ended` / `run.ended` are the IO half's, because the run's end spans its children.
 */
import { redactSecrets, resolveProvider, type ProviderId, type ToolKind } from '@agentistics/core'
import { canonicalTool } from '../../harness-activity'
import { commandSummary } from '../../sessions/shell-writes'
import {
  EDIT_TOOLS,
  FILE_URI_RE,
  REPLAY_TYPES,
  collectSubagentChildIds,
  countLines,
  extractUserRequest,
  fileUriToPath,
  isSlashCommandPrompt,
} from '../../adapters/antigravity-parse'
import {
  lineRef, makeEvent, toolExecutionIdOf,
  type AntigravityReplayContext, type EmitEvent,
} from './replay-core'

/** `main`: the run's own conversation. `child`: an `invoke_subagent` child folded under the run. */
export type AntigravityTranscriptRole = 'main' | 'child'

export interface AntigravityReplayState {
  ctx: AntigravityReplayContext
  role: AntigravityTranscriptRole
  /** The last raw line folded, 1-based, blanks included. */
  lineNo: number
  seenSteps: Set<number>
  /** The lifecycle start has been emitted (first timestamped step). */
  opened: boolean
  /** Earliest / latest timestamp (ms) of any read step — legacy's start_time / end_time. */
  minMs: number | null
  maxMs: number | null
  maxRef: string | null
  /** The last TIMED step — where an open turn closes. */
  lastTimedAt: string | null
  lastTimedRef: string | null
  turnOpen: boolean
  /** A counted non-slash USER_INPUT was seen — legacy's `hasGenuineUserTurn`. */
  genuine: boolean
  /** USER_INPUTs legacy counts (`user_message_count`). */
  userMessages: number
  /** Conversations this transcript dispatched (`collectSubagentChildIds`, line by line). */
  childIds: Set<string>
  /** Line number the last `final` finish was emitted at — the idempotence guard. */
  finishedAtLine: number | null
}

export function emptyAntigravityReplay(
  ctx: AntigravityReplayContext, role: AntigravityTranscriptRole = 'main',
): AntigravityReplayState {
  return {
    ctx, role, lineNo: 0, seenSteps: new Set(), opened: false,
    minMs: null, maxMs: null, maxRef: null, lastTimedAt: null, lastTimedRef: null,
    turnOpen: false, genuine: false, userMessages: 0, childIds: new Set(), finishedAtLine: null,
  }
}

const SHELL = 'Bash'
const FILE_NAMES = new Set(['Read', 'Write', 'Edit'])
const SEARCH_NAMES = new Set(['Grep', 'Glob', 'search_web', 'web_search', 'find_by_name'])

/** The kind of a tool, from its canonical name (and agy's own prefixes). */
function kindOf(raw: string, canonical: string): ToolKind {
  if (canonical === SHELL) return 'shell'
  if (raw.startsWith('mcp_') || raw === 'call_mcp_tool') return 'mcp'
  if (FILE_NAMES.has(canonical)) return 'file'
  if (SEARCH_NAMES.has(canonical)) return 'search'
  if (raw === 'invoke_subagent') return 'agent'
  if (raw.startsWith('browser_') || raw === 'read_url_content' || raw === 'read_url' || raw === 'fetch_url') return 'browser'
  return 'other'
}

function providerOf(model: string): ProviderId {
  return model ? resolveProvider(model).id : 'other'
}

/** Open the lifecycle on the first timestamped step. */
function open(s: AntigravityReplayState, ms: number, ref: string, emit: EmitEvent): void {
  s.opened = true
  const occurredAt = new Date(ms).toISOString()
  const base = { sourceRef: ref, occurredAt, confidence: 'exact' as const }
  const ctx = s.ctx
  if (s.role === 'main') {
    emit(makeEvent(ctx, 'session.started', {
      origin: 'adapter',
      ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
    }, { ...base, agentId: null }))
    emit(makeEvent(ctx, 'run.started', {
      harness: 'antigravity',
      conversationId: ctx.conversationId,
      conversationLink: 'observed',
      ...(ctx.projectPath ? { cwd: ctx.projectPath } : {}),
    }, { ...base, agentId: null }))
    emit(makeEvent(ctx, 'agent.started', { kind: 'main' }, base))
  } else {
    emit(makeEvent(ctx, 'agent.started', {
      kind: 'subagent',
      ...(ctx.parentAgentId ? { parentAgentId: ctx.parentAgentId } : {}),
      agentType: 'invoke_subagent',
    }, base))
  }
}

/** Advance over ONE parsed step. `lineNo` is the caller's count of the raw line. */
function foldStep(s: AntigravityReplayState, step: Record<string, unknown>, lineNo: number, emit: EmitEvent): void {
  const ctx = s.ctx
  const ref = lineRef(ctx, lineNo)
  const type = typeof step.type === 'string' ? step.type : ''
  if (REPLAY_TYPES.has(type)) return

  const idx = typeof step.step_index === 'number' ? step.step_index : null
  if (idx !== null) {
    if (s.seenSteps.has(idx)) return
    s.seenSteps.add(idx)
  }
  const stepKey = idx !== null ? `step:${idx}` : `line:${lineNo}`

  const createdAt = typeof step.created_at === 'string' ? step.created_at : ''
  const ms = createdAt ? Date.parse(createdAt) : NaN
  const timed = !Number.isNaN(ms)

  if (type === 'USER_INPUT') {
    const text = extractUserRequest(typeof step.content === 'string' ? step.content : '')
    if (timed && !s.opened) open(s, ms, ref, emit)
    if (text) {
      if (!isSlashCommandPrompt(text)) s.genuine = true
      s.userMessages++
      if (s.role === 'main') {
        // Legacy closes the open turn at the last TIMED step BEFORE this prompt.
        if (timed && s.turnOpen && s.lastTimedAt && s.lastTimedRef) {
          emit(makeEvent(ctx, 'turn.ended', { close: 'last-line' }, {
            sourceRef: s.lastTimedRef, occurredAt: s.lastTimedAt, confidence: 'exact',
          }))
        }
        emit(makeEvent(ctx, 'turn.started', { by: 'user' }, {
          sourceRef: ref,
          occurredAt: createdAt || ctx.recordedAt,
          confidence: createdAt ? 'exact' : 'estimated',
        }))
        if (timed) s.turnOpen = true
      }
    }
    noteTime(s, ms, createdAt, ref)
    return
  }

  if (timed && !s.opened) open(s, ms, ref, emit)

  // The shell EXECUTION — requested before any failure recorded on the same step.
  if (type === 'RUN_COMMAND') {
    const toolExecutionId = toolExecutionIdOf(ctx.conversationId, stepKey)
    const cmd = typeof step.content === 'string' ? step.content : ''
    emit(makeEvent(ctx, 'tool.requested', {
      toolExecutionId,
      name: 'RUN_COMMAND',
      canonicalName: canonicalTool('antigravity', 'RUN_COMMAND'),
      kind: 'shell',
      ...(cmd ? { summary: redactSecrets(commandSummary(cmd)) } : {}),
    }, { sourceRef: ref, occurredAt: at(ms, ctx), confidence: 'exact' }))
    if (step.exit_code === 0) {
      emit(makeEvent(ctx, 'tool.completed', { toolExecutionId }, {
        sourceRef: ref, occurredAt: at(ms, ctx), confidence: 'exact',
      }))
    }
  }

  // Errors — mutually exclusive, in legacy's order.
  if (type === 'ERROR_MESSAGE') {
    const code = typeof step.error_code === 'number' ? String(step.error_code) : ''
    const model = ctx.modelHint ?? ''
    emit(makeEvent(ctx, 'model.failed', {
      provider: providerOf(model),
      model: model || 'unknown',
      status: 'failed',
      errorClass: code ? `error_${code}` : 'error_message',
    }, { sourceRef: ref, occurredAt: timed ? new Date(ms).toISOString() : ctx.recordedAt, confidence: 'estimated' }))
  } else if (typeof step.exit_code === 'number' && step.exit_code !== 0) {
    emit(makeEvent(ctx, 'tool.failed', {
      toolExecutionId: toolExecutionIdOf(ctx.conversationId, stepKey),
      status: 'failed', errorClass: 'exit_code', exitCode: step.exit_code,
    }, { sourceRef: ref, occurredAt: at(ms, ctx), confidence: 'exact' }))
  } else if (step.status === 'ERROR' || step.status === 'FAILED') {
    emit(makeEvent(ctx, 'tool.failed', {
      toolExecutionId: toolExecutionIdOf(ctx.conversationId, stepKey),
      status: 'failed', errorClass: 'status_error',
    }, { sourceRef: ref, occurredAt: at(ms, ctx), confidence: 'exact' }))
  }

  if (type === 'CODE_ACTION') {
    const files = new Set<string>()
    const target = typeof step.TargetFile === 'string' ? step.TargetFile : ''
    if (target) files.add(target)
    const content = typeof step.content === 'string' ? step.content : ''
    FILE_URI_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = FILE_URI_RE.exec(content)) !== null) {
      const path = fileUriToPath(`file://${m[1]}`)
      if (path) files.add(path)
    }
    if (files.size > 0) {
      emit(makeEvent(ctx, 'tool.completed', {
        toolExecutionId: toolExecutionIdOf(ctx.conversationId, stepKey),
        filesTouched: [...files],
      }, { sourceRef: ref, occurredAt: at(ms, ctx), confidence: 'exact' }))
    }
  }

  const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] as Record<string, unknown> | null
    const name = call && typeof call.name === 'string' ? call.name : ''
    if (!name) continue
    const canonicalName = canonicalTool('antigravity', name)
    const toolExecutionId = toolExecutionIdOf(ctx.conversationId, `${stepKey}:call:${i}`)
    // The REQUEST for a shell command: its execution is the RUN_COMMAND step above.
    if (canonicalName !== SHELL) {
      emit(makeEvent(ctx, 'tool.requested', {
        toolExecutionId, name, canonicalName, kind: kindOf(name, canonicalName),
      }, { sourceRef: ref, occurredAt: at(ms, ctx), confidence: 'exact', ordinal: i }))
    }
    const args = call!.args && typeof call!.args === 'object' ? call!.args as Record<string, unknown> : null
    if (!args) continue
    const target = typeof args.TargetFile === 'string' ? args.TargetFile.trim() : ''
    const chunks: unknown[] = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [args]
    const hasPayload = chunks.some(ch => ch && typeof ch === 'object'
      && (typeof (ch as Record<string, unknown>).CodeContent === 'string'
        || typeof (ch as Record<string, unknown>).ReplacementContent === 'string'
        || typeof (ch as Record<string, unknown>).TargetContent === 'string'))
    if (!target || (!EDIT_TOOLS.has(name) && !hasPayload)) continue
    let linesAdded = 0, linesRemoved = 0
    for (const ch of chunks) {
      if (!ch || typeof ch !== 'object') continue
      const c = ch as Record<string, unknown>
      if (typeof c.CodeContent === 'string') linesAdded += countLines(c.CodeContent)
      if (typeof c.ReplacementContent === 'string') linesAdded += countLines(c.ReplacementContent)
      if (typeof c.TargetContent === 'string') linesRemoved += countLines(c.TargetContent)
    }
    emit(makeEvent(ctx, 'tool.completed', {
      toolExecutionId, filesTouched: [target], linesAdded, linesRemoved,
    }, { sourceRef: ref, occurredAt: at(ms, ctx), confidence: 'exact', ordinal: i }))
  }

  noteTime(s, ms, createdAt, ref)
}

function at(ms: number, ctx: AntigravityReplayContext): string {
  return Number.isNaN(ms) ? ctx.recordedAt : new Date(ms).toISOString()
}

function noteTime(s: AntigravityReplayState, ms: number, createdAt: string, ref: string): void {
  if (Number.isNaN(ms)) return
  if (s.minMs === null || ms < s.minMs) s.minMs = ms
  if (s.maxMs === null || ms > s.maxMs) { s.maxMs = ms; s.maxRef = ref }
  s.lastTimedAt = createdAt
  s.lastTimedRef = ref
}

/** Advance over raw lines. Numbering counts EVERY raw line, blanks included. */
export function foldAntigravityReplay(state: AntigravityReplayState, lines: Iterable<string>, emit: EmitEvent): void {
  for (const raw of lines) {
    const lineNo = state.lineNo + 1
    state.lineNo = lineNo
    const line = raw.trim()
    if (!line) continue
    // `collectSubagentChildIds` is line-based and runs before every other gate, as legacy's does.
    if (line.includes('INVOKE_SUBAGENT') || line.includes('invoke_subagent')) {
      for (const id of collectSubagentChildIds(line)) if (id !== state.ctx.conversationId) state.childIds.add(id)
    }
    let step: unknown
    try { step = JSON.parse(line) } catch { continue }
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue
    foldStep(state, step as Record<string, unknown>, lineNo, emit)
  }
}

export interface FinishOptions {
  /** Nothing more will be appended — only then does the last turn close and the agent end. */
  final: boolean
}

/**
 * Emit what only the end of the walk can say. Idempotent within a state: a second `final` finish
 * with no new line folded emits nothing.
 */
export function finishAntigravityReplay(state: AntigravityReplayState, opts: FinishOptions, emit: EmitEvent): void {
  if (!opts.final || !state.opened) return
  if (state.finishedAtLine === state.lineNo) return
  state.finishedAtLine = state.lineNo
  const ctx = state.ctx
  if (state.role === 'main' && state.turnOpen && state.lastTimedAt && state.lastTimedRef) {
    emit(makeEvent(ctx, 'turn.ended', { close: 'last-line' }, {
      sourceRef: state.lastTimedRef, occurredAt: state.lastTimedAt, confidence: 'exact',
    }))
  }
  if (state.maxMs !== null && state.maxRef) {
    emit(makeEvent(ctx, 'agent.ended', { status: 'completed' }, {
      sourceRef: state.maxRef, occurredAt: new Date(state.maxMs).toISOString(), confidence: 'exact',
    }))
  }
}
