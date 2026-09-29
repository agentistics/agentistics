/**
 * completion/emit.ts — the completion gate's two events, `completion.blocked` and
 * `completion.released`, into the same `ProviderJournalSink` the loop's other emitters append to.
 *
 * Counts and codes only (the events-frontier rule): never a plan step's text, never the injected
 * message. Keyed with `deriveEventId` on `<scope>:completion:turn:<n>` — one gate decision per model
 * turn at most — so re-emitting the same run's decisions converges on the same ids. A journal that
 * fails never fails the run: the event is counted in `lost`, the loop goes on (loop/emit.ts's rule).
 */

import {
  CANONICAL_EVENT_SCHEMA,
  deriveEventId,
  type AgentisticsEvent,
  type CompletionBlockedData,
  type CompletionReleasedData,
  type EventData,
} from '@agentistics/core'
import type { EmitScope, ProviderAppendResult, ProviderJournalSink } from '../provider/emit.ts'
import { toolScopeKey } from '../loop/emit.ts'

export const COMPLETION_EMITTED_TYPES = ['completion.blocked', 'completion.released'] as const
export type CompletionEmittedType = (typeof COMPLETION_EMITTED_TYPES)[number]

export interface CompletionEmitter {
  blocked(turn: number, data: CompletionBlockedData): Promise<void>
  released(turn: number, data: CompletionReleasedData): Promise<void>
  lost(): Record<CompletionEmittedType, number>
}

export function createCompletionEmitter<R extends ProviderAppendResult = ProviderAppendResult>(opts: {
  journal: ProviderJournalSink<R> | null
  adapterVersion: string
  scope?: EmitScope
  sourceId?: string
  now?: () => Date
}): CompletionEmitter {
  const now = opts.now ?? (() => new Date())
  const scope = opts.scope ?? {}
  const sourceId = opts.sourceId ?? 'agentistics'
  const scopeKey = toolScopeKey(scope)
  const lost: Record<CompletionEmittedType, number> = { 'completion.blocked': 0, 'completion.released': 0 }

  async function append<T extends CompletionEmittedType>(type: T, turn: number, data: EventData[T]): Promise<void> {
    const sourceRef = `${scopeKey}:completion:turn:${turn}`
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
    blocked: (turn, data) => append('completion.blocked', turn, { openItems: data.openItems, attempt: data.attempt, rule: data.rule }),
    released: (turn, data) => append('completion.released', turn, { reason: data.reason, openItems: data.openItems }),
    lost: () => ({ ...lost }),
  }
}
