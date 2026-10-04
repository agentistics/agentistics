/**
 * projections/memory.ts — PURE, version 1. B6.6 (§24.6): the memory FACTS, as a projection of the
 * journal's `memory.noted` / `memory.forgotten` events — there is no second write path to drift from it.
 *
 * Keyed by `chainId` (a fact across its versions). Order-independent and idempotent by `eventId`:
 * - every version is a row, valid from its event's time until the version that `supersedes` it (rule
 *   7: closed, never overwritten — "what did we believe on day X" stays answerable);
 * - a forgotten chain has NO rows (rule 6: forgetting deletes; its statements are deleted from the
 *   content store by whoever forgot it, so the journal keeps only hashes);
 * - the statement is a content REF, read by the reader, never stored in the row.
 */
import type { AnyAgentisticsEvent, Confidence, MemoryCategory, MemoryNotedData, MemoryScope, Projection } from '@agentistics/core'

export interface MemoryVersion {
  chainId: string
  factId: string
  supersedes?: string
  scope: MemoryScope
  repoKey?: string
  category: MemoryCategory
  statement: { sha256: string; bytes: number }
  origin: MemoryNotedData['origin']
  derivedFrom?: string[]
  /** When this version was noted (the event's `occurredAt`), and where. */
  validFrom: string
  /** When a later version closed it; `null` = current. */
  validTo: string | null
  sessionId: string | null
  eventId: string
}

export interface MemoryState {
  seen: Set<string>
  versions: Map<string, MemoryVersion>
  forgotten: boolean
  conf: Confidence | null
}

export interface MemoryResult { chainId: string | null; forgotten: boolean; versions: MemoryVersion[] }

export const memoryChainOf = (e: AnyAgentisticsEvent): string | null => {
  if (e.type !== 'memory.noted' && e.type !== 'memory.forgotten') return null
  const c = (e.data as { chainId?: unknown }).chainId
  return typeof c === 'string' && c !== '' ? c : null
}

function foldOne(s: MemoryState, e: AnyAgentisticsEvent): void {
  if (s.seen.has(e.eventId) || memoryChainOf(e) === null) return
  s.seen.add(e.eventId)
  if (e.type === 'memory.forgotten') { s.forgotten = true; return }
  const d = e.data as MemoryNotedData
  if (typeof d.factId !== 'string' || !d.statement || typeof d.statement.sha256 !== 'string') return
  const prior = s.versions.get(d.factId)
  // The same factId twice (a replay under another event id): the earliest event wins, deterministically.
  if (prior && (prior.validFrom < e.occurredAt || (prior.validFrom === e.occurredAt && prior.eventId < e.eventId))) return
  s.versions.set(d.factId, {
    chainId: d.chainId, factId: d.factId, ...(d.supersedes ? { supersedes: d.supersedes } : {}),
    scope: d.scope, ...(d.repoKey !== undefined ? { repoKey: d.repoKey } : {}), category: d.category,
    statement: { sha256: d.statement.sha256, bytes: d.statement.bytes }, origin: d.origin,
    ...(d.derivedFrom ? { derivedFrom: [...d.derivedFrom] } : {}),
    validFrom: e.occurredAt, validTo: null, sessionId: e.sessionId ?? null, eventId: e.eventId,
  })
}

export const memoryProjection: Projection<MemoryState, MemoryResult> = {
  name: 'memory',
  version: 1,
  empty: () => ({ seen: new Set(), versions: new Map(), forgotten: false, conf: null }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish(s) {
    if (s.forgotten) return { chainId: [...s.versions.values()][0]?.chainId ?? null, forgotten: true, versions: [] }
    const versions = [...s.versions.values()].map(v => ({ ...v, validTo: null as string | null }))
    // A version is closed by the EARLIEST version that supersedes it.
    for (const v of versions) {
      if (!v.supersedes) continue
      const closed = versions.find(x => x.factId === v.supersedes)
      if (closed && (closed.validTo === null || v.validFrom < closed.validTo)) closed.validTo = v.validFrom
    }
    versions.sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : a.factId < b.factId ? -1 : 1))
    return { chainId: versions[0]?.chainId ?? null, forgotten: false, versions }
  },
}
