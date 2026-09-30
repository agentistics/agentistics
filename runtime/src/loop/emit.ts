/**
 * loop/emit.ts — the canonical `ToolEventSink` (tools/contract.ts): one tool call's life becomes
 * `tool.*` and `policy.*` events in the host's journal, through the same `ProviderJournalSink` the
 * provider emitter (`provider/emit.ts`) appends to. The gate (`tools/gate.ts`) decides WHEN each
 * method is called; this module only decides what each call becomes.
 *
 * ## The sequence (acceptance §6.1: one `requested`, exactly one terminal)
 *
 *   tool.requested → policy.requested → policy.approved + tool.approved → tool.completed | tool.failed
 *                                     → policy.denied  + tool.denied        (the denial IS the terminal)
 *
 * ## The keys — replay converges
 *
 * Every event is keyed with `deriveEventId` on `(sourceKind 'runtime', sourceId, sourceRef, type)`
 * where `sourceRef` is `<scope>:tx:<toolExecutionId>` and `<scope>` names the run (or the session
 * when there is no run). Nothing is minted here: emitting the same call's events twice hashes to the
 * same ids, and the journal counts the second append as a duplicate rather than a second call. The
 * loop derives `toolExecutionId` itself from the provider's own tool_use id (`loop.ts`), so the key is
 * stable across a re-emission, not only within one.
 *
 * ## What never reaches an event
 *
 * `modelText`, a tool's input, a file's contents and every sentence (a refusal's `sentence`, an
 * error's `detail`). The sink's inputs carry a `ContentRef` for the result text instead — the gate
 * already put the text in the content store — and a denial carries only its stable `code`.
 *
 * ## A journal that fails never fails a call (P1 §4.2)
 *
 * Every method resolves, never rejects. An event the journal did not take is counted in `lost` by
 * type — the loss is visible, the call goes on (the provider emitter's rule, applied here).
 */

import {
  CANONICAL_EVENT_SCHEMA,
  deriveEventId,
  type AgentisticsEvent,
  type EventData,
  type PolicyDecidedData,
  type ToolCompletedData,
  type ToolFailedData,
  type ToolRequestedData,
} from '@agentistics/core'
import type { EmitScope, ProviderAppendResult, ProviderJournalSink } from '../provider/emit.ts'
import type { ToolCallInfo, ToolEventSink } from '../tools/contract.ts'

export const TOOL_EMITTED_TYPES = [
  'tool.requested',
  'policy.requested',
  'policy.approved',
  'tool.approved',
  'policy.denied',
  'tool.denied',
  'tool.completed',
  'tool.failed',
] as const
export type ToolEmittedType = (typeof TOOL_EMITTED_TYPES)[number]

export interface ToolEmitCounters {
  /** Events the journal did not take, by type. */
  lost: Record<ToolEmittedType, number>
}

export interface ToolEmitterOptions<R extends ProviderAppendResult = ProviderAppendResult> {
  /** `null` = no journal: every event is counted lost and the call goes on. */
  journal: ProviderJournalSink<R> | null
  /** The runtime's own mapping version — the re-projection lever (`provenance.adapterVersion`). */
  adapterVersion: string
  /** `source.id`; defaults to `agentistics` (the native harness). */
  sourceId?: string
  sourceVersion?: string
  /** The ids every event of this loop carries. */
  scope?: EmitScope
  /** The policy consulted, named on `policy.requested` (the verdict names the deciding rule). */
  policyName?: string
  now?: () => Date
}

export interface ToolEmitter extends ToolEventSink {
  counters(): ToolEmitCounters
}

/** The scope segment of every `sourceRef`: the run, else the session, else an explicit marker. */
export function toolScopeKey(scope: EmitScope): string {
  if (scope.runId !== undefined) return `run:${scope.runId}`
  if (scope.sessionId !== undefined) return `session:${scope.sessionId}`
  return 'unscoped'
}

export function createToolEventEmitter<R extends ProviderAppendResult = ProviderAppendResult>(
  opts: ToolEmitterOptions<R>,
): ToolEmitter {
  const now = opts.now ?? (() => new Date())
  const scope = opts.scope ?? {}
  const sourceId = opts.sourceId ?? 'agentistics'
  const policyName = opts.policyName ?? 'agentistics:tool-policy'
  const scopeKey = toolScopeKey(scope)
  const lost = Object.fromEntries(TOOL_EMITTED_TYPES.map(t => [t, 0])) as Record<ToolEmittedType, number>

  function build<T extends ToolEmittedType>(
    type: T, toolExecutionId: string, occurredAt: string, data: EventData[T],
  ): AgentisticsEvent<T> {
    const sourceRef = `${scopeKey}:tx:${toolExecutionId}`
    const e: AgentisticsEvent<T> = {
      eventId: deriveEventId({ sourceKind: 'runtime', sourceId, sourceRef, type }),
      schema: CANONICAL_EVENT_SCHEMA,
      type,
      occurredAt,
      recordedAt: now().toISOString(),
      source: opts.sourceVersion === undefined
        ? { kind: 'runtime', id: sourceId }
        : { kind: 'runtime', id: sourceId, version: opts.sourceVersion },
      provenance: { mode: 'native', confidence: 'exact', adapterVersion: opts.adapterVersion, sourceRef },
      data,
    }
    if (scope.sessionId !== undefined) e.sessionId = scope.sessionId
    if (scope.runId !== undefined) e.runId = scope.runId
    if (scope.agentId !== undefined) e.agentId = scope.agentId
    if (scope.taskId !== undefined) e.taskId = scope.taskId
    return e
  }

  async function append(event: AgentisticsEvent<ToolEmittedType>): Promise<void> {
    if (!opts.journal) { lost[event.type] += 1; return }
    try {
      const r = await opts.journal.append([event])
      if (r.written + r.duplicates < 1) lost[event.type] += 1
    } catch {
      lost[event.type] += 1
    }
  }

  const id = (call: ToolCallInfo) => call.toolExecutionId

  return {
    async requested({ call, kind, occurredAt }) {
      const data: ToolRequestedData = {
        toolExecutionId: id(call),
        name: call.toolName,
        // The native harness's catalogue IS its canonical vocabulary — there is no second name.
        canonicalName: call.toolName,
        kind,
      }
      await append(build('tool.requested', id(call), occurredAt, data))
    },

    async policyRequested({ call, occurredAt }) {
      await append(build('policy.requested', id(call), occurredAt, { policy: policyName, toolExecutionId: id(call) }))
    },

    async policyDecided({ call, verdict, occurredAt }) {
      const decidedBy: PolicyDecidedData['decidedBy'] = verdict.by === 'user' ? 'user' : 'policy'
      if (verdict.decision === 'allow') {
        await append(build('policy.approved', id(call), occurredAt, { policy: verdict.policy, toolExecutionId: id(call), decidedBy }))
        await append(build('tool.approved', id(call), occurredAt, { toolExecutionId: id(call), by: verdict.by }))
        return
      }
      // `verdict.sentence` is for the model and is deliberately not read here.
      await append(build('policy.denied', id(call), occurredAt, {
        policy: verdict.policy, toolExecutionId: id(call), decidedBy, code: verdict.code,
      }))
      await append(build('tool.denied', id(call), occurredAt, { toolExecutionId: id(call), by: verdict.by }))
    },

    async completed({ call, facts, durationMs, result, occurredAt }) {
      const data: ToolCompletedData = { toolExecutionId: id(call), durationMs }
      if (facts.filesTouched !== undefined) data.filesTouched = [...facts.filesTouched]
      if (facts.linesAdded !== undefined) data.linesAdded = facts.linesAdded
      if (facts.linesRemoved !== undefined) data.linesRemoved = facts.linesRemoved
      if (facts.exitCode !== undefined) data.exitCode = facts.exitCode
      if (result) data.result = { sha256: result.sha256, bytes: result.bytes }
      await append(build('tool.completed', id(call), occurredAt, data))
    },

    async failed({ call, status, errorClass, exitCode, durationMs, result, occurredAt }) {
      const data: ToolFailedData = { toolExecutionId: id(call), status, errorClass, durationMs }
      if (exitCode !== undefined) data.exitCode = exitCode
      if (result) data.result = { sha256: result.sha256, bytes: result.bytes }
      await append(build('tool.failed', id(call), occurredAt, data))
    },

    counters: () => ({ lost: { ...lost } }),
  }
}
