/**
 * memory-service.ts — B6.6 (§24.6) on the host: the facts, read by folding the journal's memory events
 * (`projections/memory.ts`) through its rare-event side table — always current, never a second store
 * that could drift from the journal — and forgetting.
 *
 * - **Scope on the READ path (rule 3):** `recall` answers a session ONLY its own repository's facts and
 *   the person's; a fact of another repository is never in the answer, whatever asked.
 * - **Forgetting deletes (rule 6):** every version of the chain leaves memory (a `memory.forgotten`
 *   event the fold honours) AND each version's statement is deleted from the content store, so the
 *   journal keeps only hashes.
 * - **The statement blob** is `{kind: 'memory-statement', factId, text}` — unique per fact, so deleting
 *   it can never delete another content-store object that happened to hold the same words.
 * - Memory stays on this machine (D14): nothing here is synced or pushed.
 */
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { memoryForgottenEvent, type AnyAgentisticsEvent, type MemoryCategory, type MemoryScope } from '@agentistics/core'
import type { Journal } from './journal/types'
import { memoryProjection, type MemoryVersion } from './projections/memory'

export interface MemoryFactView {
  chainId: string
  factId: string
  scope: MemoryScope
  repoKey?: string
  category: MemoryCategory
  /** `null` when the statement is no longer in the content store. */
  statement: string | null
  origin: MemoryVersion['origin']
  validFrom: string
  validTo: string | null
  sessionId: string | null
  supersedes?: string
}

export interface MemoryServiceDeps {
  journal: () => Promise<Journal | null>
  contentDir: string
  adapterVersion: string
  now?: () => Date
}

const MEMORY_TYPES = ['memory.noted', 'memory.forgotten'] as const

export function statementBlob(factId: string, text: string): string {
  return JSON.stringify({ kind: 'memory-statement', factId, text })
}

function contentPath(dir: string, sha: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null
  return join(dir, sha.slice(0, 2), sha.slice(2, 4), sha)
}

export function createMemoryService(deps: MemoryServiceDeps) {
  const now = deps.now ?? (() => new Date())

  /** Every chain's versions (forgotten chains have none), folded from the journal now. */
  async function chains(): Promise<MemoryVersion[]> {
    const j = await deps.journal()
    if (!j?.readTypes) return []
    const byChain = new Map<string, AnyAgentisticsEvent[]>()
    let cursor = 0
    for (;;) {
      const page = await j.readTypes(MEMORY_TYPES, cursor, 1000)
      for (const e of page.events as AnyAgentisticsEvent[]) {
        const c = (e.data as { chainId?: unknown }).chainId
        if (typeof c !== 'string') continue
        const list = byChain.get(c) ?? []
        list.push(e)
        byChain.set(c, list)
      }
      if (page.events.length === 0 || page.cursor === cursor) break
      cursor = page.cursor
    }
    const out: MemoryVersion[] = []
    for (const events of byChain.values()) {
      const s = memoryProjection.empty()
      memoryProjection.fold(s, events)
      out.push(...memoryProjection.finish(s).versions)
    }
    return out
  }

  async function statementOf(v: MemoryVersion): Promise<string | null> {
    const p = contentPath(deps.contentDir, v.statement.sha256)
    if (!p) return null
    try {
      const raw = JSON.parse(await Bun.file(p).text()) as { kind?: unknown; text?: unknown }
      return raw.kind === 'memory-statement' && typeof raw.text === 'string' ? raw.text : null
    } catch { return null }
  }

  const view = async (v: MemoryVersion): Promise<MemoryFactView> => ({
    chainId: v.chainId, factId: v.factId, scope: v.scope, ...(v.repoKey !== undefined ? { repoKey: v.repoKey } : {}),
    category: v.category, statement: await statementOf(v), origin: v.origin,
    validFrom: v.validFrom, validTo: v.validTo, sessionId: v.sessionId, ...(v.supersedes ? { supersedes: v.supersedes } : {}),
  })

  return {
    /** Current facts for ONE session: its repository's and the person's. Scope enforced here (rule 3). */
    async recall(q: { repoKey: string | null }): Promise<MemoryFactView[]> {
      const current = (await chains()).filter(v => v.validTo === null && (v.scope === 'person' || (v.scope === 'repo' && q.repoKey !== null && v.repoKey === q.repoKey)))
      return Promise.all(current.map(view))
    },
    /** Every fact, current and closed — the person's inspection (rule 1). */
    async list(): Promise<MemoryFactView[]> {
      return Promise.all((await chains()).map(view))
    },
    /** Forget a fact: every version leaves memory and its statements are deleted. */
    async forget(chainId: string): Promise<{ ok: true; versions: number } | { ok: false; reason: 'not-found' | 'journal-unavailable' }> {
      const versions = (await chains()).filter(v => v.chainId === chainId)
      if (versions.length === 0) return { ok: false, reason: 'not-found' }
      const j = await deps.journal()
      if (!j) return { ok: false, reason: 'journal-unavailable' }
      const res = await j.append([memoryForgottenEvent(chainId, { occurredAt: now().toISOString(), adapterVersion: deps.adapterVersion })])
      if (res.written + res.duplicates === 0) return { ok: false, reason: 'journal-unavailable' }
      for (const v of versions) {
        const p = contentPath(deps.contentDir, v.statement.sha256)
        if (p) await unlink(p).catch(() => {})
      }
      return { ok: true, versions: versions.length }
    },
  }
}

export type MemoryService = ReturnType<typeof createMemoryService>
