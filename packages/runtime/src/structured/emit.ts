/**
 * structured/emit.ts — the structured-result events, `structured.attempt` and `structured.exhausted`,
 * into the same `ProviderJournalSink` the loop's other emitters append to (TOOL.1).
 *
 * Counts only (the events-frontier rule): never the submitted value, never a validation message.
 * `structured.attempt` names the `invocationId` of the billed response the attempt came in, so the
 * attempt and its `model.completed` (which carries the cost) are joined by an id rather than by
 * order. Keyed with `deriveEventId` on `<scope>:structured:attempt:<n>` / `<scope>:structured:exhausted`,
 * so re-emitting one run converges on the same ids. A journal that fails never fails the run: the
 * event is counted in `lost` and the loop goes on (loop/emit.ts's rule).
 */

import {
  CANONICAL_EVENT_SCHEMA,
  deriveEventId,
  type AgentisticsEvent,
  type EventData,
  type StructuredAttemptData,
  type StructuredExhaustedData,
} from '@agentistics/core'
import type { EmitScope, ProviderAppendResult, ProviderJournalSink } from '../provider/emit.ts'
import { toolScopeKey } from '../loop/emit.ts'

export const STRUCTURED_EMITTED_TYPES = ['structured.attempt', 'structured.exhausted'] as const
export type StructuredEmittedType = (typeof STRUCTURED_EMITTED_TYPES)[number]

export interface StructuredEmitter {
  attempt(data: StructuredAttemptData): Promise<void>
  exhausted(data: StructuredExhaustedData): Promise<void>
  lost(): Record<StructuredEmittedType, number>
}

export function createStructuredEmitter<R extends ProviderAppendResult = ProviderAppendResult>(opts: {
  journal: ProviderJournalSink<R> | null
  adapterVersion: string
  scope?: EmitScope
  sourceId?: string
  now?: () => Date
}): StructuredEmitter {
  const now = opts.now ?? (() => new Date())
  const scope = opts.scope ?? {}
  const sourceId = opts.sourceId ?? 'agentistics'
  const scopeKey = toolScopeKey(scope)
  const lost: Record<StructuredEmittedType, number> = { 'structured.attempt': 0, 'structured.exhausted': 0 }

  async function append<T extends StructuredEmittedType>(type: T, key: string, data: EventData[T]): Promise<void> {
    const sourceRef = `${scopeKey}:structured:${key}`
    const at = now().toISOString()
    const e: AgentisticsEvent<T> = {
      eventId: deriveEventId({ sourceKind: 'runtime', sourceId, sourceRef, type }),
      schema: CANONICAL_EVENT_SCHEMA,
      type,
      occurredAt: at,
      recordedAt: at,
      source: { kind: 'runtime', id: sourceId },
      provenance: { mode: 'native', confidence: 'exact', adapterVersion: opts.adapterVersion, sourceRef },
      data,
    }
    if (scope.sessionId !== undefined) e.sessionId = scope.sessionId
    if (scope.runId !== undefined) e.runId = scope.runId
    if (scope.agentId !== undefined) e.agentId = scope.agentId
    if (scope.taskId !== undefined) e.taskId = scope.taskId
    if (!opts.journal) { lost[type] += 1; return }
    try {
      const r = await opts.journal.append([e])
      if (r.written + r.duplicates < 1) lost[type] += 1
    } catch {
      lost[type] += 1
    }
  }

  return {
    // Fields copied one by one: an attempt's data is exactly these facts, whatever the caller held.
    attempt: d => append('structured.attempt', `attempt:${d.attempt}`, {
      attempt: d.attempt, ok: d.ok, errorCount: d.errorCount, submitted: d.submitted, invocationId: d.invocationId,
    }),
    exhausted: d => append('structured.exhausted', 'exhausted', { attempts: d.attempts }),
    lost: () => ({ ...lost }),
  }
}
