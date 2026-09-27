/**
 * integrations/copilot/replay.ts — PURE. A Copilot CLI `events.jsonl`, read as canonical events.
 *
 * The shape mirrors `integrations/claude/replay.ts`: `emptyCopilotReplay` / `foldCopilotReplay` /
 * `finishCopilotReplay`, every accumulator moving only forward, so folding a transcript in one call
 * and in N uneven chunks emits the same events. There is exactly ONE file per session (Copilot has
 * no subagents — `HARNESS_CAPABILITIES.copilot.agents === false`, confirmed against every real
 * session read while building this: no agent-launch shape exists in `events.jsonl` at all), so this
 * module carries no sub-fold split the way Claude's does for its `subagents/` directory.
 *
 * ## THE TRAP (P2 §2): tokens and lines exist ONLY at `session.shutdown`, cumulative, once
 *
 * Every other harness's usage is per-call. Copilot's is not: `events.jsonl` carries no per-response
 * usage record at all (measured across every real session read for this integration — the
 * `model.model_call_success` events some sessions carry hold latency/telemetry fields, never a
 * token count), and the ONLY place tokens appear is `session.shutdown.data.modelMetrics`, a
 * per-model CUMULATIVE total written exactly once, when the CLI exits cleanly.
 *
 * So this fold does not hold a response open the way `replay-model.ts` does — there is nothing to
 * hold, and nothing to close early. It reads the shutdown record's `modelMetrics` map and emits ONE
 * `model.completed` per model key, with that model's own reported usage, the moment the
 * `session.shutdown` line is folded. A session that never writes `session.shutdown` — a crash, a
 * kill -9, a machine that lost power — gets no `model.completed` at all: `finishCopilotReplay`
 * closes the run with `status: 'failed'` and emits nothing about tokens, which is the D21 rule
 * ("a counter the harness did not state is ABSENT") taken to its edge case — an invocation that was
 * never STATED is not reported as a zero-token one either.
 *
 * ## `tool_counts` and the raw-vs-canonical name (SHARED CHANGE REQUESTED — see the A3.3 handback)
 *
 * `ToolRequestedData.name` is documented as "the harness's own name, kept verbatim" — so this fold
 * sets it to Copilot's own `data.toolName` (`view`, `bash`, `report_intent`, …), never the
 * `canonicalName` `canonicalTool('copilot', …)` maps it to. `projections/session-meta.ts`'s
 * `tool_counts`, however, sums by `e.data.name` (see its `case 'tool.requested'`), not by
 * `canonicalName` — which happens to be harmless for Claude (its own tool names ARE the canonical
 * vocabulary, so the two fields are always equal there) and is NOT harmless for Copilot: real
 * sessions on this machine name tools `view` (→ canonical `Read`) and `bash` (→ canonical `Bash`),
 * so the projected `tool_counts` is keyed by the RAW name while legacy's (`copilot-parse.ts`, which
 * calls `canonicalTool` before inserting) is keyed by the CANONICAL one. This is a genuine gap in
 * the shared projection, not something this module can fix without rewriting a file it does not
 * own — flagged in the handback under SHARED CHANGES REQUESTED, and carried in the differential as
 * an `explained` row (re-keying the projected counts through `canonicalTool` before comparing is
 * the independent proof).
 *
 * ## `mcp.tool_call` — UNVERIFIED shape, stated rather than hidden
 *
 * `copilot-parse.ts` reads `data.toolName` off an `mcp.tool_call` record but names no `server`
 * field, and grepping every real session read while building this integration (31 sessions, 0
 * hits) found not one occurrence of the event type at all — so its `data.server` name could not be
 * measured. `foldCopilotReplayEntry` still emits `mcp.requested`/`mcp.completed` for it,
 * defensively reading `data.server ?? data.mcpServer` and marking the event `confidence: 'inferred'`
 * whenever neither is present (an empty server name is stated, not guessed, but naming NO server at
 * all when one might exist is a guess about absence) — this path is untested against a real record
 * and is called out again in the handback's "what could not be verified".
 *
 * ## No conversation text (D5)
 *
 * A shell command enters only through `redactSecrets(commandSummary(...))`, exactly as the Claude
 * replay does it; a tool's `result.content`/`detailedContent` (free text) is never read.
 */
import type {
  McpCompletedData, McpRequestedData, ModelCompletedData, ModelInvokedData,
  ToolCompletedData, ToolFailedData, ToolKind, ToolRequestedData,
} from '@agentistics/core'
import { redactSecrets, resolveProvider } from '@agentistics/core'
import { canonicalTool } from '../../harness-activity'
import { commandSummary } from '../../sessions/shell-writes'
import {
  counter, lineRef, makeEvent, mcpExecutionIdOf, shutdownEditsToolExecutionId, str, toolExecutionIdOf,
  type CopilotReplayContext, type EmitEvent,
} from './replay-core'

// ── Tool classification — the same mapping Claude's replay-tools.ts uses, since `canonicalTool`
// is harness-agnostic (harness-activity.ts's own header: "a mapping, never a filter"). ──────────

function mcpServerOf(canonicalName: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(canonicalName)
  return m?.[1]
}

function classifyTool(canonicalName: string): { kind: ToolKind; mcpServer?: string } {
  const mcpServer = mcpServerOf(canonicalName)
  if (mcpServer) return { kind: 'mcp', mcpServer }
  if (canonicalName.startsWith('mcp__')) return { kind: 'mcp' }
  if (canonicalName === 'Bash') return { kind: 'shell' }
  if (canonicalName === 'Read' || canonicalName === 'Write' || canonicalName === 'Edit') return { kind: 'file' }
  if (canonicalName === 'Grep' || canonicalName === 'Glob') return { kind: 'search' }
  return { kind: 'other' }
}

// ── State ────────────────────────────────────────────────────────────────────────────────────────

export interface CopilotReplayState {
  ctx: CopilotReplayContext
  /** The last line folded, 1-based. */
  lineNo: number
  /** Whether session.started/run.started/agent.started were already emitted. */
  opened: boolean
  /** The last line folded that carried a usable `timestamp` — `null` before the first one. */
  lastOccurredAt: string | null
  /** Idempotence for `finishCopilotReplay` — see `finishLifecycleFold`'s twin in the Claude replay. */
  closedThroughLine: number | null
  /** Whether `session.shutdown` has been folded — decides `run.ended`/`agent.ended`'s status. */
  sawShutdown: boolean
  /** How many `mcp.tool_call` records have been folded — the ordinal `mcpExecutionIdOf` keys on. */
  mcpOrdinal: number
}

export function emptyCopilotReplay(ctx: CopilotReplayContext): CopilotReplayState {
  return { ctx, lineNo: 0, opened: false, lastOccurredAt: null, closedThroughLine: null, sawShutdown: false, mcpOrdinal: 0 }
}

export function cloneCopilotReplay(s: CopilotReplayState): CopilotReplayState {
  return { ...s }
}

// ── One record → events ─────────────────────────────────────────────────────────────────────────

function dataOf(entry: Record<string, unknown>): Record<string, unknown> {
  const d = entry.data
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {}
}

function emitOpen(s: CopilotReplayState, occurredAt: string, sourceRef: string, cwd: string | undefined, emit: EmitEvent): void {
  const base = { sourceRef, occurredAt, confidence: 'exact' as const }
  emit(makeEvent(s.ctx, 'session.started', {
    origin: 'adapter', ...(cwd ? { projectPath: cwd } : {}),
  }, { ...base, agentId: null }))
  emit(makeEvent(s.ctx, 'run.started', {
    harness: 'copilot', conversationId: s.ctx.copilotSessionId, conversationLink: 'observed',
    ...(cwd ? { cwd } : {}),
  }, { ...base, agentId: null }))
  emit(makeEvent(s.ctx, 'agent.started', { kind: 'main' }, base))
  s.opened = true
}

function foldToolStart(s: CopilotReplayState, entry: Record<string, unknown>, lineNo: number, occurredAt: string, emit: EmitEvent): void {
  const data = dataOf(entry)
  const toolCallId = str(data.toolCallId)
  const rawName = str(data.toolName)
  if (!toolCallId || !rawName) return
  const canonicalName = canonicalTool('copilot', rawName)
  const { kind, mcpServer } = classifyTool(canonicalName)
  const sourceRef = lineRef(s.ctx, lineNo)
  const reqData: ToolRequestedData = {
    toolExecutionId: toolExecutionIdOf(s.ctx.copilotSessionId, toolCallId),
    name: rawName,
    canonicalName,
    kind,
  }
  if (mcpServer) reqData.mcpServer = mcpServer
  if (kind === 'shell') {
    const args = data.arguments as Record<string, unknown> | undefined
    const cmd = str(args?.command)
    if (cmd) reqData.summary = redactSecrets(commandSummary(cmd))
  }
  emit(makeEvent(s.ctx, 'tool.requested', reqData, { sourceRef, occurredAt, confidence: 'exact' }))
}

function foldToolComplete(s: CopilotReplayState, entry: Record<string, unknown>, lineNo: number, occurredAt: string, emit: EmitEvent): void {
  const data = dataOf(entry)
  const toolCallId = str(data.toolCallId)
  if (!toolCallId) return
  const toolExecutionId = toolExecutionIdOf(s.ctx.copilotSessionId, toolCallId)
  const sourceRef = lineRef(s.ctx, lineNo)
  const success = data.success !== false
  if (success) {
    const completedData: ToolCompletedData = { toolExecutionId }
    emit(makeEvent(s.ctx, 'tool.completed', completedData, { sourceRef, occurredAt, confidence: 'exact' }))
  } else {
    const failedData: ToolFailedData = { toolExecutionId, status: 'failed' }
    emit(makeEvent(s.ctx, 'tool.failed', failedData, { sourceRef, occurredAt, confidence: 'exact' }))
  }
}

/** UNVERIFIED shape — see this module's header. Best-effort, never throws on a missing field. */
function foldMcpToolCall(s: CopilotReplayState, entry: Record<string, unknown>, lineNo: number, occurredAt: string, emit: EmitEvent): void {
  const data = dataOf(entry)
  const tool = str(data.toolName) ?? str(data.tool) ?? 'unknown'
  const server = str(data.server) ?? str(data.mcpServer)
  const ordinal = s.mcpOrdinal++
  const toolExecutionId = mcpExecutionIdOf(s.ctx.copilotSessionId, ordinal)
  const sourceRef = lineRef(s.ctx, lineNo)
  const confidence = server ? 'exact' as const : 'inferred' as const
  const reqData: McpRequestedData = { toolExecutionId, server: server ?? '', tool }
  const compData: McpCompletedData = { toolExecutionId, server: server ?? '', tool, status: 'completed' }
  emit(makeEvent(s.ctx, 'mcp.requested', reqData, { sourceRef, occurredAt, confidence, ordinal }))
  emit(makeEvent(s.ctx, 'mcp.completed', compData, { sourceRef, occurredAt, confidence, ordinal }))
}

/** One `model.completed` per model key in `session.shutdown.data.modelMetrics` — the trap this
 *  module's header documents. Each counter is read individually (D21): a model whose usage object
 *  is missing a key reports that counter absent, never a folded-in 0. */
function foldShutdownModels(s: CopilotReplayState, entry: Record<string, unknown>, lineNo: number, occurredAt: string, emit: EmitEvent): void {
  const data = dataOf(entry)
  const modelMetrics = data.modelMetrics
  if (!modelMetrics || typeof modelMetrics !== 'object') return
  const sourceRef = lineRef(s.ctx, lineNo)
  let ordinal = 0
  for (const [model, metricsRaw] of Object.entries(modelMetrics as Record<string, unknown>)) {
    const metrics = metricsRaw && typeof metricsRaw === 'object' ? (metricsRaw as Record<string, unknown>) : {}
    const usageRaw = metrics.usage
    const usage = usageRaw && typeof usageRaw === 'object' ? (usageRaw as Record<string, unknown>) : {}
    const thisOrdinal = ordinal++
    const provider = resolveProvider(model).id
    const invoked: ModelInvokedData = { provider, model }
    const completed: ModelCompletedData = { provider, model, usage: {}, status: 'completed' }
    const input = counter(usage.inputTokens)
    const output = counter(usage.outputTokens)
    const cacheRead = counter(usage.cacheReadTokens)
    const cacheWrite = counter(usage.cacheWriteTokens)
    if (input !== undefined) completed.usage.input = input
    if (output !== undefined) completed.usage.output = output
    if (cacheRead !== undefined) completed.usage.cacheRead = cacheRead
    if (cacheWrite !== undefined) completed.usage.cacheWrite = cacheWrite
    const opts = { sourceRef, occurredAt, confidence: 'exact' as const, ordinal: thisOrdinal }
    emit(makeEvent(s.ctx, 'model.invoked', invoked, opts))
    emit(makeEvent(s.ctx, 'model.completed', completed, opts))
  }
}

/** `session.shutdown.data.codeChanges` — a SESSION-WIDE aggregate with no tool call of its own to
 *  attribute it to (Copilot names no tool for "the edits this session made"; it is a shutdown
 *  total). Modelled as one synthetic `tool.completed` with no matching `tool.requested`, which
 *  `session-meta.ts`'s fold accepts without complaint (its `case 'tool.completed'` never checks for
 *  a paired request) and which therefore reproduces legacy's `lines_added`/`lines_removed` exactly
 *  and `files_modified` whenever `filesModified` is an array of paths (see this module's own header
 *  on the one case — a bare count with no names — this cannot reproduce, unmeasured on this machine
 *  because every real session read here reports zero changes). */
function foldCodeChanges(s: CopilotReplayState, entry: Record<string, unknown>, lineNo: number, occurredAt: string, emit: EmitEvent): void {
  const data = dataOf(entry)
  const cc = data.codeChanges
  if (!cc || typeof cc !== 'object') return
  const ccObj = cc as Record<string, unknown>
  const linesAdded = counter(ccObj.linesAdded)
  const linesRemoved = counter(ccObj.linesRemoved)
  const fm = ccObj.filesModified
  const filesTouched = Array.isArray(fm) ? fm.filter((x): x is string => typeof x === 'string') : undefined
  const completedData: ToolCompletedData = {
    toolExecutionId: shutdownEditsToolExecutionId(s.ctx.copilotSessionId),
    ...(linesAdded !== undefined ? { linesAdded } : {}),
    ...(linesRemoved !== undefined ? { linesRemoved } : {}),
    ...(filesTouched ? { filesTouched } : {}),
  }
  emit(makeEvent(s.ctx, 'tool.completed', completedData, {
    sourceRef: lineRef(s.ctx, lineNo), occurredAt, confidence: 'exact',
  }))
}

/** Advance over ONE already-parsed entry. */
export function foldCopilotReplayEntry(
  state: CopilotReplayState, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const occurredAt = str(entry.timestamp)
  if (occurredAt === undefined) return

  state.lineNo = lineNo
  state.lastOccurredAt = occurredAt

  const type = entry.type
  const data = dataOf(entry)
  let cwd: string | undefined
  // `copilot-parse.ts` PREFERS `data.startTime` over the envelope's own `timestamp` when
  // `session.start` carries one ("more accurate") — measured on real sessions, the two differ by a
  // few tens of milliseconds. `session.started`'s occurredAt must match it exactly, or legacy's
  // `start_time` and the projection's disagree on every session that has one.
  let openAt = occurredAt
  if (type === 'session.start') {
    const context = data.context
    if (context && typeof context === 'object') cwd = str((context as Record<string, unknown>).cwd)
    const dataStartTime = str(data.startTime)
    if (dataStartTime) openAt = dataStartTime
  }

  if (!state.opened) emitOpen(state, openAt, lineRef(state.ctx, lineNo), cwd, emit)

  switch (type) {
    case 'tool.execution_start':
      foldToolStart(state, entry, lineNo, occurredAt, emit)
      return
    case 'tool.execution_complete':
      foldToolComplete(state, entry, lineNo, occurredAt, emit)
      return
    case 'mcp.tool_call':
      foldMcpToolCall(state, entry, lineNo, occurredAt, emit)
      return
    case 'session.shutdown':
      state.sawShutdown = true
      foldShutdownModels(state, entry, lineNo, occurredAt, emit)
      foldCodeChanges(state, entry, lineNo, occurredAt, emit)
      return
    default:
      return
  }
}

/** Advance over raw lines. Numbering, blank-line and bad-JSON handling mirror the Claude replay. */
export function foldCopilotReplay(state: CopilotReplayState, lines: Iterable<string>, emit: EmitEvent): void {
  for (const raw of lines) {
    const lineNo = state.lineNo + 1
    state.lineNo = lineNo
    const line = raw.trim()
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    foldCopilotReplayEntry(state, entry as Record<string, unknown>, lineNo, emit)
  }
}

export interface FinishOptions {
  /** The transcript is COMPLETE — nothing more will be appended. Only then are the `*.ended`
   *  events emitted; a live one (`final: false`) stays open. */
  final: boolean
}

/**
 * Emit what only the end of the walk can say. Idempotent within a state: a second `final: true`
 * call with nothing new folded since emits nothing. `run.ended`/`agent.ended` read `'completed'`
 * when `session.shutdown` was seen and `'failed'` otherwise (P2 §2: a crashed session gets a failed
 * run and no model invocation, never a zero-token one).
 */
export function finishCopilotReplay(state: CopilotReplayState, opts: FinishOptions, emit: EmitEvent): void {
  if (!opts.final) return
  if (!state.opened) return
  if (state.lastOccurredAt === null) return
  if (state.closedThroughLine === state.lineNo) return

  const status = state.sawShutdown ? 'completed' as const : 'failed' as const
  const base = { sourceRef: lineRef(state.ctx, state.lineNo), occurredAt: state.lastOccurredAt, confidence: 'exact' as const }

  emit(makeEvent(state.ctx, 'agent.ended', { status }, base))
  emit(makeEvent(state.ctx, 'run.ended', { status }, { ...base, agentId: null }))
  emit(makeEvent(state.ctx, 'session.ended', {}, { ...base, agentId: null }))

  state.closedThroughLine = state.lineNo
}
