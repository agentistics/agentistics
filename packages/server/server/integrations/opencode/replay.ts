/**
 * integrations/opencode/replay.ts — PURE. Folds opencode's own rows (already read and parsed by
 * `index.ts`, the IO half) into canonical events.
 *
 * ## The input shape, and why it is not "lines"
 *
 * Every other integration in this repo folds a stream of TEXT LINES (a JSONL transcript). opencode's
 * store is a relational database: one row per `message`, one row per `part` (a tool call, a text
 * block, a `step-finish` usage report, …). There is no line to iterate — the atomic unit here is a
 * ROW, already parsed into a small closed union (`OpencodeRecord`) by the IO half, in one STABLE
 * reading order (`(time_created, kind priority, id)` — see `index.ts`'s `orderedRecords`). That
 * order is what `sourceRef`'s ordinal counts over, and it is fixed once discovery reads the rows, so
 * re-folding the same records twice reproduces the identical ordinals and ids.
 *
 * ## Measured, not assumed (this file's whole job)
 *
 * - **One opencode `message` row of role `assistant` is ONE billed response.** Verified against the
 *   real store (`~/.local/share/opencode/opencode.db`, 2 sessions / 39 messages / 114 parts):
 *   `session.tokens_input/output/reasoning/cache_read/cache_write` equals the straight SUM of every
 *   assistant message's own `tokens{…}`, which equals the sum of the SAME session's `part` rows of
 *   `type: "step-finish"`. There is exactly one `step-finish` per assistant message in every
 *   transcript measured here, so — unlike Claude (`usage-dedupe.ts`), Kimi (`usage.record` vs
 *   `step.end`) and agy (request vs execution) — there is no double-counting rule to apply: the
 *   message's own `tokens` field IS the response's usage, once.
 * - **`tokens.output` does NOT already include `tokens.reasoning`.** Verified arithmetically on a
 *   real row: `input 9653 + output 9 + reasoning 45 + cache.write 0 + cache.read 0 === total 9707`.
 *   Output and reasoning are two SEPARATE counters that sum to the total, which is exactly Google's
 *   `additive` reasoning shape (`ReasoningBilling`) — never `included-in-output` here.
 * - **A message still being written carries neither `finish` nor `error`.** Such a row is IN FLIGHT
 *   (opencode streams `time.completed` in only once the step ends) and produces no `model.*` event
 *   at all until a later read sees it settled — the same "not yet arrived" treatment every other
 *   integration gives a transcript line still being appended to.
 * - **No per-turn duration is ever stated.** opencode times each STEP (`part.time.start/end`, or the
 *   row's own `time_created`/`time_updated`), never a whole human turn the way Claude's
 *   `system/turn_duration` line does — so `turn.ended.close` is ALWAYS `'last-line'` here, never
 *   `'measured'` (D25's other case). `activeTime.ts`'s reconstruction from the turn's boundary
 *   timestamps is therefore the whole story for `active_minutes`, exactly as for a harness with no
 *   measured-duration marker at all.
 * - **`filesTouched` is read from a tool's own `input.filePath`** (the `write`/`read` tools carry
 *   one); `linesAdded`/`linesRemoved` are deliberately NOT emitted — no tool part measured here
 *   carries a diff-shaped field (a line count, a patch), so counting newlines in `input.content`
 *   the way `antigravity-parse.ts` does for its `CodeContent` would be a rule invented for a payload
 *   never observed to need it. `session.summary_additions/deletions/files` (git-shaped columns on
 *   the `session` table itself) exist in the schema and were 0 on both real sessions measured — a
 *   session-wide aggregate, not a per-tool-call figure, and left unwired for the same reason.
 * - **The context gauge is deliberately NOT emitted.** `docs/harness-contract.md`'s rule (mirrored
 *   from CLAUDE.md) requires a field the harness states IS a context size, or a per-turn prompt size
 *   with a name that says so (codex's `last_token_usage.input_tokens`, Claude's last `message.usage`
 *   input side). opencode's per-message `tokens.input` is architecturally very likely to already BE
 *   that (a chat-completions-shaped API bills the whole resent context as "input" on every call), but
 *   nothing in the schema NAMES it that way, and there is no second, independent number here to
 *   reconcile it against the way agy's `1.9.10.4` or codex's `model_context_window` field would let a
 *   reader check. Emitting one would be exactly the kind of undocumented-binary-format leap
 *   `antigravity-protobuf.ts`'s header warns against (the `1.4.1` mis-mapping, caught only because a
 *   bill was compared against it) — so `contextWindow` stays unset rather than guessed.
 */
import {
  resolveProvider,
  type AgentisticsEvent,
  type ModelUsageCounters,
} from '@agentistics/core'
import { canonicalTool } from '../../harness-activity'
import { commandSummary } from '../../sessions/shell-writes'
import { redactSecrets } from '@agentistics/core'
import {
  makeEvent, num, opencodeContext, recordRef, str, toolExecutionIdOf,
  type EmitEvent, type OpencodeReplayContext,
} from './replay-core'

// ── The record shape the IO half hands the fold ────────────────────────────────────────────────

export interface OpencodeUserMessageRecord {
  kind: 'user_message'
  id: string
  createdAt: number
}

export interface OpencodeAssistantMessageRecord {
  kind: 'assistant_message'
  id: string
  createdAt: number
  completedAt?: number
  modelId?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }
  /** Present on a settled, successful step (`'stop'`, `'tool-calls'`, …). */
  finish?: string
  /** Present on a settled, failed/aborted step. */
  errorName?: string
}

export interface OpencodeToolPartRecord {
  kind: 'tool_part'
  id: string
  createdAt: number
  updatedAt: number
  tool: string
  /** `'completed' | 'error' | 'running' | 'pending' | …` — opencode's own, verbatim. */
  status?: string
  startedAt?: number
  endedAt?: number
  command?: string
  filePath?: string
}

export type OpencodeRecord =
  | OpencodeUserMessageRecord
  | OpencodeAssistantMessageRecord
  | OpencodeToolPartRecord

// ── Tool naming ─────────────────────────────────────────────────────────────────────────────────

/** opencode's own tool names, measured on the real store: `bash`, `write`, `read`, `skill`. Every
 *  one of these already maps through `canonicalTool` (`bash`→`Bash` pre-existed; `write`→`Write`,
 *  `read`→`Read` and `skill`→`Skill` were added there by this integration, since no harness had
 *  previously reported those bare names). A tool this store has never shown us passes through
 *  `canonicalTool` unchanged, which is the function's own contract. */
function kindOf(canonicalName: string): 'shell' | 'file' | 'search' | 'mcp' | 'browser' | 'agent' | 'other' {
  if (canonicalName === 'Bash') return 'shell'
  if (canonicalName === 'Read' || canonicalName === 'Write' || canonicalName === 'Edit') return 'file'
  if (canonicalName === 'Grep' || canonicalName === 'Glob') return 'search'
  return 'other'
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────

export interface OpencodeReplayState {
  ctx: OpencodeReplayContext
  /** The next ordinal to assign — a running counter, so folding in slices reproduces one sequence. */
  ordinal: number
  opened: boolean
  minMs: number | null
  maxMs: number | null
  maxRef: string | undefined
  /** A human turn is open from its `user_message` until the fold or `finish()` closes it. */
  turnOpen: boolean
  turnStartAt: number | undefined
  /** The last assistant-role settlement seen since the turn opened (closes the turn on `finish`). */
  lastAssistantAt: number | undefined
  lastAssistantRef: string | undefined
  /** The last timestamped record of ANY kind seen since the turn opened — the `'last-line'` fallback
   *  when the turn never got a settled assistant reply at all. */
  lastAnyAt: number | undefined
  lastAnyRef: string | undefined
  /** The last assistant-role settlement of the WHOLE session, for `turn.started.previousAssistantAt`. */
  lastSessionAssistantAt: number | undefined
}

export function emptyOpencodeReplay(ctx: OpencodeReplayContext): OpencodeReplayState {
  return {
    ctx, ordinal: 0, opened: false, minMs: null, maxMs: null, maxRef: undefined,
    turnOpen: false, turnStartAt: undefined,
    lastAssistantAt: undefined, lastAssistantRef: undefined,
    lastAnyAt: undefined, lastAnyRef: undefined,
    lastSessionAssistantAt: undefined,
  }
}

function touch(s: OpencodeReplayState, atMs: number, ref: string): void {
  s.opened = true
  if (s.minMs === null || atMs < s.minMs) s.minMs = atMs
  if (s.maxMs === null || atMs > s.maxMs) { s.maxMs = atMs; s.maxRef = ref }
  s.lastAnyAt = atMs
  s.lastAnyRef = ref
}

/** Closes the open turn (if any), preferring the last SETTLED assistant reply and falling back to
 *  the last timestamped record of any kind — D25's `'last-line'` rule, the only one opencode ever
 *  qualifies for (see the module header). */
function closeTurn(s: OpencodeReplayState, emit: EmitEvent): void {
  if (!s.turnOpen) return
  const atMs = s.lastAssistantAt ?? s.lastAnyAt
  const ref = s.lastAssistantRef ?? s.lastAnyRef
  if (atMs !== undefined && ref !== undefined) {
    emit(makeEvent(s.ctx, 'turn.ended', { close: 'last-line' }, {
      sourceRef: ref, occurredAt: new Date(atMs).toISOString(), confidence: 'exact',
    }))
  }
  s.turnOpen = false
  s.turnStartAt = undefined
  s.lastAssistantAt = undefined
  s.lastAssistantRef = undefined
}

function foldUserMessage(s: OpencodeReplayState, r: OpencodeUserMessageRecord, ref: string, emit: EmitEvent): void {
  touch(s, r.createdAt, ref)
  // A second user prompt closes whatever turn the previous one opened (a person does not wait for
  // opencode's reply before typing again in every transcript, and opencode never REPLACES a prior
  // message — it only appends).
  closeTurn(s, emit)
  s.turnOpen = true
  s.turnStartAt = r.createdAt
  const at = new Date(r.createdAt).toISOString()
  emit(makeEvent(s.ctx, 'turn.started', {
    by: 'user',
    ...(s.lastSessionAssistantAt !== undefined ? { previousAssistantAt: new Date(s.lastSessionAssistantAt).toISOString() } : {}),
  }, { sourceRef: ref, occurredAt: at, confidence: 'exact' }))
}

function foldAssistantMessage(s: OpencodeReplayState, r: OpencodeAssistantMessageRecord, ref: string, emit: EmitEvent): void {
  touch(s, r.createdAt, ref)
  if (!r.finish && !r.errorName) return // in flight — no settled response to report yet

  const settledAt = r.completedAt ?? r.createdAt
  const settledRef = ref
  touch(s, settledAt, settledRef)
  s.lastAssistantAt = settledAt
  s.lastAssistantRef = settledRef
  s.lastSessionAssistantAt = settledAt

  const model = str(r.modelId)
  const provider = model ? resolveProvider(model).id : 'other'
  const startedAt = new Date(r.createdAt).toISOString()
  const completedAtIso = new Date(settledAt).toISOString()

  if (model) {
    emit(makeEvent(s.ctx, 'model.invoked', { provider, model }, {
      sourceRef: ref, occurredAt: startedAt, confidence: 'exact',
    }))
  }

  if (r.errorName) {
    emit(makeEvent(s.ctx, 'model.failed', {
      provider, model: model ?? 'unknown',
      status: r.errorName === 'MessageAbortedError' ? 'cancelled' : 'failed',
      errorClass: r.errorName,
    }, { sourceRef: settledRef, occurredAt: completedAtIso, confidence: 'exact' }))
    return
  }

  const usage: ModelUsageCounters = {}
  const t = r.tokens
  if (t) {
    if (t.input !== undefined) usage.input = t.input
    if (t.output !== undefined) usage.output = t.output
    if (t.cacheRead !== undefined) usage.cacheRead = t.cacheRead
    if (t.cacheWrite !== undefined) usage.cacheWrite = t.cacheWrite
  }
  const reasoning = t?.reasoning !== undefined ? { tokens: t.reasoning, billing: 'additive' as const } : undefined
  emit(makeEvent(s.ctx, 'model.completed', {
    provider,
    model: model ?? 'unknown',
    usage,
    ...(reasoning ? { reasoning } : {}),
    ...(r.cost !== undefined ? { costUSD: r.cost, costSource: 'harness' as const } : {}),
    status: 'completed',
  }, { sourceRef: settledRef, occurredAt: completedAtIso, confidence: 'exact' }))
}

function foldToolPart(s: OpencodeReplayState, r: OpencodeToolPartRecord, ref: string, emit: EmitEvent): void {
  touch(s, r.createdAt, ref)
  const toolExecutionId = toolExecutionIdOf(s.ctx.sessionId, r.id)
  const canonicalName = canonicalTool('opencode', r.tool)
  const requestedAt = new Date(r.startedAt ?? r.createdAt).toISOString()
  emit(makeEvent(s.ctx, 'tool.requested', {
    toolExecutionId, name: r.tool, canonicalName, kind: kindOf(canonicalName),
    ...(r.command ? { summary: redactSecrets(commandSummary(r.command)) } : {}),
  }, { sourceRef: ref, occurredAt: requestedAt, confidence: 'exact' }))

  const endedAtMs = r.endedAt ?? r.updatedAt
  const endedAt = new Date(endedAtMs).toISOString()
  touch(s, endedAtMs, ref)
  const durationMs = r.startedAt !== undefined && r.endedAt !== undefined ? r.endedAt - r.startedAt : undefined

  if (r.status === 'error') {
    emit(makeEvent(s.ctx, 'tool.failed', { toolExecutionId, status: 'failed' }, {
      sourceRef: ref, occurredAt: endedAt, confidence: 'exact',
    }))
    return
  }
  if (r.status === 'completed') {
    emit(makeEvent(s.ctx, 'tool.completed', {
      toolExecutionId,
      ...(r.filePath ? { filesTouched: [r.filePath] } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }, { sourceRef: ref, occurredAt: endedAt, confidence: 'exact' }))
  }
  // Any other status (`'running'`, `'pending'`, …) is not yet settled — nothing to report until a
  // later read sees it complete or error, the same "in flight" rule assistant messages get.
}

/**
 * Fold `records` (already in `index.ts`'s stable reading order) into `state`, emitting every new
 * event. Idempotent-under-resuming: `state.ordinal` only grows, and the caller passes each record
 * exactly once across the whole resumed walk (`index.ts` slices by ordinal, never by re-deriving
 * order here) — this function does not re-check for duplicates itself.
 */
export function foldOpencodeReplay(s: OpencodeReplayState, records: readonly OpencodeRecord[], emit: EmitEvent): void {
  for (const r of records) {
    const ref = recordRef(s.ctx, s.ordinal)
    s.ordinal++
    switch (r.kind) {
      case 'user_message': foldUserMessage(s, r, ref, emit); break
      case 'assistant_message': foldAssistantMessage(s, r, ref, emit); break
      case 'tool_part': foldToolPart(s, r, ref, emit); break
    }
  }
}

/**
 * Emits the lifecycle events that depend on the WHOLE walk: `session.started`/`run.started`/
 * `agent.started` need the session's own first-seen facts (passed by the caller, since they live on
 * opencode's `session` row rather than on any one record), and — only when `final` — the closing
 * `turn.ended` (if a turn was still open), `agent.ended`/`run.ended`/`session.ended`.
 */
export function finishOpencodeReplay(
  s: OpencodeReplayState,
  session: { projectPath: string; version?: string; startedAtMs: number },
  opts: { final: boolean },
  emit: EmitEvent,
): void {
  if (!s.opened) return
  const startedAt = new Date(session.startedAtMs).toISOString()
  emit(makeEvent(s.ctx, 'session.started', {
    origin: 'adapter',
    projectPath: session.projectPath,
  }, { sourceRef: recordRef(s.ctx, -1), occurredAt: startedAt, confidence: 'exact', agentId: null, ordinal: -1 }))
  emit(makeEvent(s.ctx, 'run.started', {
    harness: 'opencode',
    ...(session.version ? { harnessVersion: session.version } : {}),
    conversationId: s.ctx.sessionId,
    conversationLink: 'observed',
    cwd: session.projectPath,
  }, { sourceRef: recordRef(s.ctx, -1), occurredAt: startedAt, confidence: 'exact', agentId: null, ordinal: -1 }))
  emit(makeEvent(s.ctx, 'agent.started', { kind: 'main' }, {
    sourceRef: recordRef(s.ctx, -1), occurredAt: startedAt, confidence: 'exact', ordinal: -1,
  }))

  if (!opts.final) return
  closeTurn(s, emit)
  if (s.maxMs === null || s.maxRef === undefined) return
  const endedAt = new Date(s.maxMs).toISOString()
  emit(makeEvent(s.ctx, 'agent.ended', { status: 'completed' }, {
    sourceRef: s.maxRef, occurredAt: endedAt, confidence: 'exact',
  }))
  emit(makeEvent(s.ctx, 'run.ended', { status: 'completed' }, {
    sourceRef: s.maxRef, occurredAt: endedAt, confidence: 'exact', agentId: null,
  }))
  emit(makeEvent(s.ctx, 'session.ended', {}, {
    sourceRef: s.maxRef, occurredAt: endedAt, confidence: 'exact', agentId: null,
  }))
}
