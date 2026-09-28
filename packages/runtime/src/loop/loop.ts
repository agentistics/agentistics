/**
 * loop/loop.ts — the native harness's TOOL LOOP (B3.1): model → tool calls → gate → tool_result →
 * model, until the model ends its turn or a bound stops the run.
 *
 * ## What this module owns, and what it deliberately does not
 *
 * - It never executes a tool. Every call goes through `runTool` (`tools/gate.ts`) — parse, subjects,
 *   policy, grant, execute, content store, one terminal event — and `tools-gate.lint.test.ts` holds
 *   that no other module calls `execute`. The loop only decides WHICH calls reach the gate and in
 *   what order.
 * - It never writes a model event by hand. Each model attempt is journaled by the provider emitter
 *   (`provider/emit.ts`): `journalProviderStream` for a streamed attempt, the same
 *   invoked-before / terminal-after pair for a non-streamed one. The retry is the runtime's own
 *   (`provider/retry.ts` `runWithRetry`): the loop hands it a client whose `invokeOnce` journals and
 *   (when streaming) consumes one live attempt, so a retried turn is still one attempt = one pair of
 *   events and the retry rule is not re-implemented here.
 *
 * ## Serial, in the model's order (spec §1: 1,67 % of tool-using turns call more than one tool)
 *
 * Calls run one after another in the order the model emitted them. Parallel execution is the
 * special case and is not built.
 *
 * ## Bounds — every stop names WHICH bound, as a code and in words
 *
 * `maxTurns` counts model invocations (a retried attempt is the same turn). `maxToolCalls` counts
 * calls that reached the gate; a call the loop answers itself (unknown tool, arguments that could not
 * be assembled, a call left unrun by a bound) does not spend it. `wallTimeMs` is measured on the
 * monotonic clock from the loop's start and ALSO armed as a timer that aborts the in-flight model call
 * or tool; the caller's `signal` aborts the same way. When a bound stops the run:
 *
 * - no model call is made after it;
 * - the tool calls of the turn that were not run get a `tool_result` with `isError` and a sentence
 *   ("Not run: the tool-call budget for this run is spent.") — the returned history never holds an
 *   assistant `tool_use` without its `tool_result`, so it can be resumed as it is;
 * - a turn that is the LAST one `maxTurns` allows runs none of its calls: their results could never
 *   be read back by the model, and an effect the model never learns of is one it cannot account for.
 *
 * ## What the model reads, and what the journal gets
 *
 * A `tool_result`'s content is the gate's `outcome.modelText` — a refusal included, in words. The
 * journal gets only facts plus the content-store `{sha256, bytes}` of that text (`loop/emit.ts`).
 */

import { classifyProviderError, sha256Hex, type RetryPolicy } from '@agentistics/core'
import type {
  CredentialRef,
  InvocationResult,
  ProviderCacheControl,
  ProviderClient,
  ProviderMessage,
  ProviderMessagePart,
  ProviderRequest,
  ProviderStreamEvent,
  ToolCallFailure,
} from '../provider/client.ts'
import {
  createProviderEmitter,
  journalProviderStream,
  type AttemptStart,
  type EmitCounters,
  type EmitScope,
  type ProviderAppendResult,
  type ProviderEmitter,
  type ProviderJournalSink,
} from '../provider/emit.ts'
import { runWithRetry, type RetryStoppedBecause } from '../provider/retry.ts'
import { openProviderStream, streamingRefusal } from '../provider/stream.ts'
import type {
  ContentSink,
  PersonAsker,
  Tool,
  ToolErrorClass,
  ToolPolicy,
} from '../tools/contract.ts'
import { runTool, type GateResult } from '../tools/gate.ts'
import { createToolEventEmitter, toolScopeKey, type ToolEmitCounters, type ToolEmitter } from './emit.ts'
import { buildWireTable } from './wire.ts'

// ── Public shapes ───────────────────────────────────────────────────────────────────────────────

export interface ToolLoopLimits {
  /** Model invocations. A retried attempt is the same turn. */
  maxTurns: number
  /** Calls that reached the gate. */
  maxToolCalls: number
  /** Monotonic wall time from the loop's start. */
  wallTimeMs: number
}

export type ToolLoopStatus =
  /** The model answered without asking for a tool. */
  | 'end-turn'
  | 'max-turns'
  | 'max-tool-calls'
  | 'wall-time'
  /** The caller's signal. */
  | 'aborted'
  /** A model attempt failed and the retry gave up. */
  | 'model-failed'
  /** The tool list cannot be declared to a provider (a duplicate or colliding name). Nothing ran. */
  | 'invalid-catalogue'

export type ToolCallStatus =
  | GateResult['status']
  /** Stopped by a bound before it reached the gate. */
  | 'not-run'
  /** The model named a tool this run does not have. */
  | 'unknown-tool'
  /** The streamed arguments could not be assembled into a call. */
  | 'malformed'

export interface ToolCallSummary {
  toolExecutionId: string
  /** The provider's own id for the call (`tool_use.id`). */
  toolUseId: string
  /** The catalogue name, or the name the model sent when no tool has it. */
  name: string
  status: ToolCallStatus
  errorClass?: ToolErrorClass
}

export interface ToolLoopResult {
  status: ToolLoopStatus
  /** The stop, in words (EN). */
  sentence: string
  /** The full history, the caller's messages first. Every `tool_use` in it has its `tool_result`. */
  messages: ProviderMessage[]
  turns: number
  /** Calls that reached the gate. */
  toolCalls: number
  calls: ToolCallSummary[]
  lastResult?: InvocationResult
  /** Why the retry loop stopped on the last model turn. */
  lastRetry?: RetryStoppedBecause
  lost: { provider: EmitCounters['lost']; tool: ToolEmitCounters['lost'] }
}

export interface ToolLoopOptions<R extends ProviderAppendResult = ProviderAppendResult> {
  client: ProviderClient
  model: string
  maxTokens: number
  credential: CredentialRef
  system?: string
  systemCache?: ProviderCacheControl
  /** The conversation so far (the last one normally a user message). Not mutated. */
  messages: readonly ProviderMessage[]
  tools: readonly Tool<unknown>[]
  limits: ToolLoopLimits
  policy: ToolPolicy
  content: ContentSink
  asker?: PersonAsker
  /** The host's journal; `null` = none (every event counted lost, the run goes on). */
  journal: ProviderJournalSink<R> | null
  /** The runtime's version for `tool.*` / `policy.*` provenance (the model events carry the client's). */
  runtimeVersion: string
  workspaceRoot: string
  cwd: string
  scope?: EmitScope
  signal?: AbortSignal
  /** Default true: stream whenever the client can; `false` forces `invokeOnce`. */
  preferStreaming?: boolean
  retry?: {
    policy?: RetryPolicy
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  }
  /** Live events of each streamed attempt, for a reader watching. A throw is ignored. */
  onStreamEvent?: (e: ProviderStreamEvent) => void
  /**
   * Called every time the loop pushes to `messages` — the assistant turn BEFORE its tools run, and
   * the `tool_result` message after them (session/runtime.ts §B4.1). Awaited; a throw is caught and
   * never breaks the run, same as every other emitter in this module.
   */
  onHistory?: (appended: ProviderMessage[]) => Promise<void> | void
  /**
   * Around each call the gate would make, AND around a call this loop answers itself without ever
   * reaching the gate (a bound, a malformed call, an unknown tool) — those are still a call's whole
   * life and session/runtime.ts persists them the same way. Awaited; a throw is caught.
   */
  onToolCall?: (e: ToolCallHookEvent) => Promise<void> | void
  now?: () => Date
  monotonicNow?: () => number
  mintInvocationId?: () => string
}

/** One tool call's life, as `onToolCall` reports it. */
export type ToolCallHookEvent =
  | { phase: 'started'; toolExecutionId: string; toolUseId: string; name: string }
  | { phase: 'settled'; toolExecutionId: string; toolUseId: string; name: string; text: string; isError: boolean }

// ── Sentences (the model and the person read these; nothing here is journaled) ──────────────────

type Bound = 'max-turns' | 'max-tool-calls' | 'wall-time' | 'aborted'

const NOT_RUN: Record<Bound, string> = {
  'max-turns': 'Not run: the turn budget for this run is spent, so the result of this call could never be read back.',
  'max-tool-calls': 'Not run: the tool-call budget for this run is spent.',
  'wall-time': 'Not run: the time budget for this run is spent.',
  aborted: 'Not run: the run was cancelled.',
}

/** The error class a call left unrun by each bound is journaled under. */
const NOT_RUN_CLASS: Record<Bound, ToolErrorClass> = {
  'max-turns': 'killed',
  'max-tool-calls': 'killed',
  'wall-time': 'timeout',
  aborted: 'killed',
}

function stopSentence(status: ToolLoopStatus, limits: ToolLoopLimits, last?: InvocationResult): string {
  switch (status) {
    case 'end-turn':
      return last?.status === 'completed' && last.stopReason.kind === 'max-tokens'
        ? 'The model ended its turn: its answer reached the output-token limit.'
        : 'The model ended its turn.'
    case 'max-turns': return `Stopped: the run reached its limit of ${limits.maxTurns} model turns.`
    case 'max-tool-calls': return `Stopped: the run reached its limit of ${limits.maxToolCalls} tool calls.`
    case 'wall-time': return `Stopped: the run reached its time limit of ${limits.wallTimeMs} ms.`
    case 'aborted': return 'Stopped: the run was cancelled.'
    case 'model-failed':
      return last?.status === 'failed'
        ? `Stopped: the model call failed (${last.error.userCode}) and was not retried further.`
        : 'Stopped: the model call failed and was not retried further.'
    case 'invalid-catalogue': return 'Stopped: the tool catalogue could not be declared to the model.'
  }
}

function failureSentence(f: ToolCallFailure, name: string): string {
  switch (f.reason) {
    case 'malformed': return `The arguments of this call to ${name} could not be read as JSON, so it was not run.`
    case 'truncated': return `The arguments of this call to ${name} were cut off before they were complete (the answer reached its length limit), so it was not run.`
    case 'not-object': return `The arguments of this call to ${name} were not a JSON object, so it was not run.`
    case 'unknown-tool': return `There is no tool named ${name} in this run, so nothing ran.`
  }
}

/**
 * The name journaled for a call naming no tool of this run. The name the model sent is text the
 * MODEL controls (any length, any bytes), and an event is a fact about the run, never conversation
 * content — so it reaches the model's own tool_result sentence and never the journal.
 */
export const UNKNOWN_TOOL_JOURNAL_NAME = 'unknown-tool'

function unknownToolSentence(name: string, available: readonly string[]): string {
  return `There is no tool named ${JSON.stringify(name)} in this run, so nothing ran. The tools available are: ${available.join(', ')}.`
}

// ── Planning one turn's calls ───────────────────────────────────────────────────────────────────

type PlannedCall =
  | { kind: 'call'; id: string; wireName: string; input: unknown }
  | { kind: 'failed'; failure: ToolCallFailure }

interface TurnPlan {
  assistant: ProviderMessagePart[]
  calls: PlannedCall[]
}

/**
 * The assistant message to put in the history and the calls it carries, in the model's order.
 *
 * `content` is the record. A streamed call whose arguments could not be assembled is carried there as
 * `{type:'other', rawType:'tool_use'}` (provider/anthropic/raw-stream.ts), never as a `tool_use`; it is
 * written back into the history as a `tool_use` with an EMPTY input — its real arguments are not valid
 * JSON and cannot be resent — so the `tool_result` explaining the failure has a call to answer. Other
 * block kinds (thinking, server tool results) have no `ProviderMessagePart` shape and are not resent.
 * A `tool-call` event whose id the content lacks is appended rather than dropped.
 */
function planTurn(result: Extract<InvocationResult, { status: 'completed' }>, streamedCalls: StreamedCall[], streamedFailures: ToolCallFailure[]): TurnPlan {
  const failures = new Map<string, ToolCallFailure>()
  for (const f of [...streamedFailures, ...(result.toolCallFailures ?? [])]) if (!failures.has(f.id)) failures.set(f.id, f)
  const pendingFailures = [...failures.values()].sort((a, b) => a.index - b.index)

  const assistant: ProviderMessagePart[] = []
  const calls: PlannedCall[] = []
  const seen = new Set<string>()
  const addFailure = (f: ToolCallFailure) => {
    assistant.push({ type: 'tool_use', id: f.id, name: f.name, input: {} })
    calls.push({ kind: 'failed', failure: f })
    seen.add(f.id)
  }
  for (const block of result.content) {
    if (block.type === 'text') assistant.push({ type: 'text', text: block.text })
    else if (block.type === 'tool_use') {
      if (seen.has(block.id)) continue
      assistant.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
      calls.push({ kind: 'call', id: block.id, wireName: block.name, input: block.input })
      seen.add(block.id)
    } else if (block.rawType === 'tool_use') {
      const f = pendingFailures.shift()
      if (f) addFailure(f)
    }
  }
  for (const f of pendingFailures) if (!seen.has(f.id)) addFailure(f)
  for (const c of [...streamedCalls].sort((a, b) => a.index - b.index)) {
    if (seen.has(c.id)) continue
    assistant.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
    calls.push({ kind: 'call', id: c.id, wireName: c.name, input: c.input })
    seen.add(c.id)
  }
  return { assistant, calls }
}

// ── One model turn: a client whose `invokeOnce` journals (and, streaming, consumes) one attempt ──

interface StreamedCall { index: number; id: string; name: string; input: unknown }

interface AttemptCollect {
  calls: StreamedCall[]
  failures: ToolCallFailure[]
}

function journaledClient(
  client: ProviderClient,
  emitter: ProviderEmitter,
  scope: EmitScope,
  streaming: boolean,
  now: () => Date,
  onStreamEvent: ((e: ProviderStreamEvent) => void) | undefined,
  collect: { current: AttemptCollect },
): ProviderClient {
  return {
    provider: client.provider,
    adapterVersion: client.adapterVersion,
    capabilities: client.capabilities,
    async invokeOnce(req: ProviderRequest, attempt: number): Promise<InvocationResult> {
      const start: AttemptStart = {
        invocationId: req.correlation.invocationId,
        attempt,
        provider: client.provider,
        requestedModel: req.model,
        startedAt: now().toISOString(),
      }
      collect.current = { calls: [], failures: [] }
      const fallback = (): InvocationResult => ({
        invocationId: start.invocationId,
        attempt,
        provider: client.provider,
        requestedModel: req.model,
        startedAt: start.startedAt,
        latencyMs: 0,
        status: 'failed',
        error: classifyProviderError(req.signal?.aborted ? { transport: 'aborted' } : { sdkRejected: true }),
      })

      if (!streaming) {
        await emitter.invoked(start, scope)
        let r: InvocationResult
        try { r = await client.invokeOnce(req, attempt) } catch { r = fallback() }
        await emitter.terminal(r, scope)
        return r
      }

      const opened = openProviderStream(client, req, attempt)
      if (!opened.ok) {
        // Unreachable: streaming is chosen only when `streamingRefusal` said yes.
        const r = fallback()
        await emitter.invoked(start, scope)
        await emitter.terminal(r, scope)
        return r
      }
      let end: InvocationResult | undefined
      try {
        for await (const ev of journalProviderStream(opened.stream, emitter, start, scope)) {
          if (onStreamEvent) { try { onStreamEvent(ev) } catch { /* a watcher never fails the run */ } }
          if (ev.type === 'tool-call') collect.current.calls.push({ index: ev.index, id: ev.id, name: ev.name, input: ev.input })
          else if (ev.type === 'tool-call-failed') collect.current.failures.push(ev.failure)
          else if (ev.type === 'end') end = ev.result
        }
      } catch { /* the stream never throws by contract; a broken one ends without `end` below */ }
      if (!end) {
        // A stream that ended without its `end` event broke its contract; it is a failed attempt,
        // journaled here because `journalProviderStream` never saw a terminal.
        end = fallback()
        await emitter.terminal(end, scope)
      }
      return end
    },
  }
}

// ── The loop ────────────────────────────────────────────────────────────────────────────────────

function toolExecutionIdFor(scopeKey: string, turn: number, position: number, toolUseId: string): string {
  return `tx_${sha256Hex(`${scopeKey}\u0000${turn}\u0000${position}\u0000${toolUseId}`).slice(0, 32)}`
}

export async function runToolLoop<R extends ProviderAppendResult>(opts: ToolLoopOptions<R>): Promise<ToolLoopResult> {
  const now = opts.now ?? (() => new Date())
  const mono = opts.monotonicNow ?? (() => performance.now())
  const mintInvocationId = opts.mintInvocationId ?? (() => `inv_${crypto.randomUUID().replaceAll('-', '')}`)
  const scope: EmitScope = opts.scope ?? {}
  const scopeKey = toolScopeKey(scope)
  const limits = opts.limits
  const messages: ProviderMessage[] = [...opts.messages]
  const calls: ToolCallSummary[] = []

  const providerEmitter = createProviderEmitter({ journal: opts.journal, adapterVersion: opts.client.adapterVersion, now })
  const toolEvents: ToolEmitter = createToolEventEmitter({
    journal: opts.journal, adapterVersion: opts.runtimeVersion, scope, now,
  })
  const lost = () => ({ provider: providerEmitter.counters().lost, tool: toolEvents.counters().lost })

  let turns = 0
  let toolCalls = 0
  let lastResult: InvocationResult | undefined
  let lastRetry: RetryStoppedBecause | undefined
  const done = (status: ToolLoopStatus, sentence = stopSentence(status, limits, lastResult)): ToolLoopResult => ({
    status, sentence, messages, turns, toolCalls, calls, lastResult, lastRetry, lost: lost(),
  })

  const wire = buildWireTable(opts.tools)
  if (!wire.ok) return done('invalid-catalogue', wire.sentence)
  const table = wire.table
  const available = [...table.byWire.keys()]

  // One internal signal: the caller's abort and the wall-time timer both land here, and the cause
  // decides the status. The first cause wins.
  const ctl = new AbortController()
  let cause: 'aborted' | 'wall-time' | null = null
  const stopFor = (c: 'aborted' | 'wall-time') => { if (cause === null) cause = c; ctl.abort() }
  const onCallerAbort = () => stopFor('aborted')
  if (opts.signal?.aborted) stopFor('aborted')
  else opts.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const t0 = mono()
  const timer = setTimeout(() => stopFor('wall-time'), Math.max(0, limits.wallTimeMs))
  /** The bound that stops the run right now, if any. Checked before every model call and tool call. */
  const hardStop = (): 'aborted' | 'wall-time' | null => {
    if (cause !== null) return cause
    if (mono() - t0 >= limits.wallTimeMs) { stopFor('wall-time'); return 'wall-time' }
    return null
  }

  const streaming = (opts.preferStreaming ?? true) && streamingRefusal(opts.client) === null
  const collect: { current: AttemptCollect } = { current: { calls: [], failures: [] } }
  const turnClient = journaledClient(opts.client, providerEmitter, scope, streaming, now, opts.onStreamEvent, collect)

  /** A host that never registered a hook pays nothing; one that throws never breaks the run. */
  const emitHistory = async (msg: ProviderMessage): Promise<void> => {
    if (!opts.onHistory) return
    try { await opts.onHistory([msg]) } catch { /* a host's persistence hook never fails a run */ }
  }
  const emitToolCall = async (
    phase: 'started' | 'settled', toolExecutionId: string, toolUseId: string, name: string,
    settled?: { text: string; isError: boolean },
  ): Promise<void> => {
    if (!opts.onToolCall) return
    try {
      await opts.onToolCall(
        phase === 'started'
          ? { phase, toolExecutionId, toolUseId, name }
          : { phase, toolExecutionId, toolUseId, name, text: settled!.text, isError: settled!.isError },
      )
    } catch { /* a host's persistence hook never fails a run */ }
  }

  /** A call the loop answers without the gate: journaled as requested + failed, content stored. */
  const answerWithoutGate = async (
    toolExecutionId: string, toolName: string, kind: Tool<unknown>['kind'], errorClass: ToolErrorClass,
    status: 'failed' | 'cancelled', text: string,
  ) => {
    const call = { toolExecutionId, toolName }
    await toolEvents.requested({ call, kind, occurredAt: now().toISOString() })
    const result = await opts.content.put(text).catch(() => null)
    await toolEvents.failed({ call, status, errorClass, durationMs: 0, result, occurredAt: now().toISOString() })
  }

  try {
    for (;;) {
      const hs = hardStop()
      if (hs) return done(hs)
      if (turns >= limits.maxTurns) return done('max-turns')
      turns += 1

      const req: ProviderRequest = {
        model: opts.model,
        messages: [...messages],
        tools: table.decls,
        maxTokens: opts.maxTokens,
        signal: ctl.signal,
        correlation: { invocationId: mintInvocationId(), ...scope },
        credential: opts.credential,
      }
      if (opts.system !== undefined) req.system = opts.system
      if (opts.systemCache !== undefined) req.systemCache = opts.systemCache

      const outcome = await runWithRetry(turnClient, req, {
        policy: opts.retry?.policy,
        sleep: opts.retry?.sleep,
        monotonicNow: mono,
      })
      lastResult = outcome.final
      lastRetry = outcome.stoppedBecause
      const final = outcome.final
      if (final.status === 'failed') {
        const hsAfter = hardStop()
        if (hsAfter) return done(hsAfter)
        return done('model-failed')
      }

      const plan = planTurn(final, collect.current.calls, collect.current.failures)
      if (plan.calls.length === 0) {
        if (plan.assistant.length > 0) {
          const msg: ProviderMessage = { role: 'assistant', content: plan.assistant }
          messages.push(msg)
          await emitHistory(msg)
        }
        return done('end-turn')
      }
      {
        const msg: ProviderMessage = { role: 'assistant', content: plan.assistant }
        messages.push(msg)
        await emitHistory(msg)
      }

      // A turn that is the last one allowed runs none of its calls (module doc).
      let bound: Bound | null = turns >= limits.maxTurns ? 'max-turns' : null
      const results: ProviderMessagePart[] = []
      for (let position = 0; position < plan.calls.length; position++) {
        const planned = plan.calls[position]!
        const toolUseId = planned.kind === 'call' ? planned.id : planned.failure.id
        const wireName = planned.kind === 'call' ? planned.wireName : planned.failure.name
        const tool = table.byWire.get(wireName)
        const name = tool?.name ?? wireName
        const toolExecutionId = toolExecutionIdFor(scopeKey, turns, position, toolUseId)
        const reply = (content: string, isError: boolean) => results.push({ type: 'tool_result', toolUseId, content, isError })
        await emitToolCall('started', toolExecutionId, toolUseId, name)

        if (bound === null) bound = hardStop()
        if (bound === null && planned.kind === 'call' && tool && toolCalls >= limits.maxToolCalls) bound = 'max-tool-calls'

        if (bound !== null) {
          const text = NOT_RUN[bound]
          await answerWithoutGate(toolExecutionId, name, tool?.kind ?? 'other', NOT_RUN_CLASS[bound], 'cancelled', text)
          reply(text, true)
          await emitToolCall('settled', toolExecutionId, toolUseId, name, { text, isError: true })
          calls.push({ toolExecutionId, toolUseId, name, status: 'not-run', errorClass: NOT_RUN_CLASS[bound] })
          continue
        }

        if (planned.kind === 'failed') {
          const text = failureSentence(planned.failure, name)
          const cls: ToolErrorClass = planned.failure.reason === 'unknown-tool' ? 'not-found' : 'invalid-input'
          await answerWithoutGate(toolExecutionId, tool ? name : UNKNOWN_TOOL_JOURNAL_NAME, tool?.kind ?? 'other', cls, 'failed', text)
          reply(text, true)
          await emitToolCall('settled', toolExecutionId, toolUseId, name, { text, isError: true })
          calls.push({ toolExecutionId, toolUseId, name, status: 'malformed', errorClass: cls })
          continue
        }

        if (!tool) {
          const text = unknownToolSentence(wireName, available)
          await answerWithoutGate(toolExecutionId, UNKNOWN_TOOL_JOURNAL_NAME, 'other', 'not-found', 'failed', text)
          reply(text, true)
          await emitToolCall('settled', toolExecutionId, toolUseId, name, { text, isError: true })
          calls.push({ toolExecutionId, toolUseId, name, status: 'unknown-tool', errorClass: 'not-found' })
          continue
        }

        toolCalls += 1
        const r = await runTool(tool, planned.input, {
          workspaceRoot: opts.workspaceRoot,
          cwd: opts.cwd,
          signal: ctl.signal,
          sessionId: scope.sessionId,
          runId: scope.runId,
          agentId: scope.agentId,
          now,
          toolExecutionId,
        }, { policy: opts.policy, events: toolEvents, content: opts.content, asker: opts.asker })
        reply(r.outcome.modelText, !r.outcome.ok)
        await emitToolCall('settled', toolExecutionId, toolUseId, name, { text: r.outcome.modelText, isError: !r.outcome.ok })
        const summary: ToolCallSummary = { toolExecutionId, toolUseId, name, status: r.status }
        if (r.outcome.error) summary.errorClass = r.outcome.error.class
        calls.push(summary)
      }
      {
        const msg: ProviderMessage = { role: 'user', content: results }
        messages.push(msg)
        await emitHistory(msg)
      }

      if (bound !== null) return done(bound)
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onCallerAbort)
  }
}
