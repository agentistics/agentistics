/**
 * reopen-link.ts — the IO half of `reopen-target.ts`'s exact-link rule: which recorded conversation
 * ids the harness's OWN transcript reader can find on disk.
 *
 * Asked only for rows that need it — not running, holding an exact id the store does not carry,
 * on a harness that resumes by id — so on an ordinary machine it is a handful of lookups. The
 * answer is memoized the same way `transcript-path-memo.ts` memoizes: a FOUND transcript is
 * remembered (a conversation that was written does not stop having been written; the reopen itself
 * re-checks through the CLI), and a MISS expires, because "not written yet" is a fact about the
 * moment — a session minutes old has an id and no transcript under it.
 */

import type { HarnessId } from '@agentistics/core'
import type { Conversation } from './conversations'
import { transcriptReaderFor } from './harness-transcript'
import { resumableWithId } from './reopen-target'

export const REOPEN_LINK_MISS_TTL_MS = 60_000

async function defaultResolve(harness: HarnessId, ref: { conversationId: string; cwd: string }): Promise<string | null> {
  const reader = transcriptReaderFor(harness)
  return reader ? reader.resolve(ref) : null
}

const found = new Set<string>()
const missedAt = new Map<string, number>()

export interface ReopenLinkCandidate {
  harness?: HarnessId
  cwd?: string
  conversationId?: string
}

/** The ids, among `entries`, whose transcript exists — see the header. Never throws. */
export async function exactLinksOnDisk(
  entries: readonly ReopenLinkCandidate[],
  pool: readonly Conversation[],
  nowMs: number = Date.now(),
  /** The harness's own resolver. Overridable only so a test needs no transcript tree on disk. */
  resolve: (harness: HarnessId, ref: { conversationId: string; cwd: string }) => Promise<string | null> = defaultResolve,
): Promise<Set<string>> {
  // Either id a conversation goes by (gemini: the store key AND the harness's own uuid).
  const inPool = new Set(pool.flatMap(c => c.nativeId ? [c.sessionId, c.nativeId] : [c.sessionId]))
  const out = new Set<string>()
  await Promise.all(entries.map(async e => {
    const id = e.conversationId
    if (!id || inPool.has(id) || !e.cwd || !resumableWithId(e.harness, id)) return
    const key = `${e.harness}\u0000${id}`
    if (found.has(key)) { out.add(id); return }
    const missed = missedAt.get(key)
    if (missed !== undefined && nowMs - missed < REOPEN_LINK_MISS_TTL_MS) return
    const path = await resolve(e.harness!, { conversationId: id, cwd: e.cwd }).catch(() => null)
    if (path) {
      found.add(key)
      missedAt.delete(key)
      out.add(id)
    } else {
      missedAt.set(key, nowMs)
    }
  }))
  return out
}

/** Tests only. */
export function resetReopenLinkMemo(): void {
  found.clear()
  missedAt.clear()
}
