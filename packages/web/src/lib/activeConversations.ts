/**
 * activeConversations.ts — PURE: which STORED sessions are running right now.
 *
 * "Active only" means one thing on the Sessions page (keep the rows in an active state) and has to
 * mean the same thing on the dashboard, where the rows are stored metrics rather than live
 * processes. The bridge is the conversation id: a live row that knows which conversation it is
 * writing names exactly one stored session.
 *
 * A running row with NO conversation link is ignored rather than guessed at. `spawn-spec.ts`
 * records why the link is exact where it exists and absent where it cannot: for codex, kimi,
 * gemini and agy no link can ever be recorded, and the harness-and-directory inference that
 * `claimResume` falls back to gives every session of one repository the same conversation. A
 * dashboard total is read at a glance and believed; an inferred one would silently attribute one
 * session's spend to another.
 *
 * The consequence the caller must carry: this scope is CACHE-BLIND. `stats-cache.json` has no
 * per-conversation granularity, so a filtered total must come from per-session sums — the same
 * rule the project and repo dimensions already follow.
 */

import type { SessionMeta } from '@agentistics/core'

const ACTIVE = new Set(['working', 'waiting', 'waiting-approval'])

export function runningConversationIds(
  rows: readonly { state: string; conversationId?: string }[],
): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (!ACTIVE.has(r.state)) continue
    if (r.conversationId === undefined || r.conversationId === '') continue
    out.add(r.conversationId)
  }
  return out
}

export function keepRunning(sessions: readonly SessionMeta[], ids: ReadonlySet<string>): SessionMeta[] {
  return sessions.filter(s => ids.has(s.session_id))
}

/** Shared by every caller that does not need the running set, so a memo keyed on it never misses. */
export const NO_RUNNING_IDS: ReadonlySet<string> = new Set()

/**
 * The set the dashboard's derived stats are keyed on. A fleet poll rebuilds the rows (and so the
 * Set) far more often than the CONVERSATIONS running change, and a new Set identity re-runs the
 * whole derivation (date-fns over every stored session — over a second on a phone). Returns `prev`
 * when `next` holds the same ids, and the shared empty set when nobody reads it (`needed` false).
 */
export function stableRunningIds(
  prev: ReadonlySet<string> | undefined,
  next: ReadonlySet<string>,
  needed: boolean,
): ReadonlySet<string> {
  if (!needed) return NO_RUNNING_IDS
  if (prev && prev.size === next.size && [...next].every(id => prev.has(id))) return prev
  return next
}
