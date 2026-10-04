/**
 * memory.ts — B6.6 (§24.6): the two memory events, built the same way by every writer (the engine's
 * `memory.note` and `/remember`, the server's forget), so a fact's event id is deterministic wherever
 * it is written. The fact's text is never in the event — `statement` is a content-store reference.
 */
import { CANONICAL_EVENT_SCHEMA, type AgentisticsEvent, type MemoryNotedData } from './canonical/event'
import { deriveEventId } from './canonical/event-id'

export const MEMORY_SOURCE_ID = 'agentistics'

export interface MemoryEventContext {
  occurredAt: string
  adapterVersion: string
  sessionId?: string
}

function base<T extends 'memory.noted' | 'memory.forgotten'>(type: T, sourceRef: string, ctx: MemoryEventContext) {
  return {
    eventId: deriveEventId({ sourceKind: 'runtime', sourceId: MEMORY_SOURCE_ID, sourceRef, type }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt: ctx.occurredAt,
    recordedAt: ctx.occurredAt,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    source: { kind: 'runtime' as const, id: MEMORY_SOURCE_ID },
    provenance: { mode: 'native' as const, confidence: 'exact' as const, adapterVersion: ctx.adapterVersion, sourceRef },
  }
}

export function memoryNotedEvent(data: MemoryNotedData, ctx: MemoryEventContext): AgentisticsEvent<'memory.noted'> {
  return { ...base('memory.noted', `memory:noted:${data.factId}`, ctx), data }
}

export function memoryForgottenEvent(chainId: string, ctx: MemoryEventContext): AgentisticsEvent<'memory.forgotten'> {
  return { ...base('memory.forgotten', `memory:forgotten:${chainId}`, ctx), data: { chainId } }
}

/**
 * The key a repository's memory is filed under: its normalised remote, or — a repository with no
 * remote, or a plain folder — `path:<root>`. Two clones of one remote share their memory; two
 * unrelated folders never do.
 */
export function memoryRepoKey(normalizedRemote: string | null | undefined, workspaceRoot: string): string {
  return normalizedRemote && normalizedRemote.trim() !== '' ? normalizedRemote : `path:${workspaceRoot.replace(/\/+$/, '') || '/'}`
}
