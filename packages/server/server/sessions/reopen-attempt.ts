/**
 * reopen-attempt.ts — the ONE row-level "try to reopen this conversation" step, run inside the
 * resume lock (`resume-lock.ts`).
 *
 * Pulled out of `cli-start.ts`'s `reopenEntries` for exactly the reason `resumeSessionLocked` was
 * pulled out of `resumeSession`: the lock has to wrap a plain function, and a function with its I/O
 * injected is one a test can drive without a real registry, a real backend or a real spawner. Before
 * this existed, a revert of the `withResumeLock` wrapping — the actual fix for the double-spawn race
 * — passed the whole `bun test` suite clean; nothing exercised it except a live, manually-driven
 * concurrent request replay.
 *
 * This module holds no IMPLEMENTATION of "fresh state", "who holds it" or "spawn" — those stay in
 * `cli-start.ts`, which is the only place that knows how to ask the real registry, the real backend
 * and the real spawner. What lives here is the ORDER those three questions get asked in, and what
 * each answer means — which is exactly the part a concurrent-request test needs to hold still.
 */

import { conversationAlreadyOpen } from './task-reopen'
import type { ConversationHolder } from './conversation-claim'
import type { ManagedSession } from './types'

export interface ReopenAttemptDeps {
  /**
   * A FRESH read of the registry and of which ids are alive right now.
   *
   * Called ONLY after the lock for this conversation has been acquired — that is what makes it
   * "fresh" relative to a racing attempt that ran first and already landed its own spawn.
   */
  freshState: () => Promise<{ entries: readonly ManagedSession[]; aliveIds: ReadonlySet<string> }>
  /** Who holds the conversation right now — called only when the fresh check says somebody does. */
  holderOf: () => Promise<ConversationHolder | undefined>
  /** Actually spawn the new session. Called only when nobody else has landed first. */
  spawn: () => Promise<{ ok: boolean; id?: string }>
  /** Whatever must happen once the spawn succeeds — retiring the old row, stamping the new one. */
  onSpawned: (newId: string | undefined) => Promise<void>
}

export type ReopenAttemptOutcome =
  | { kind: 'opened' }
  | { kind: 'held'; holder?: ConversationHolder }
  | { kind: 'failed' }

/**
 * Run this INSIDE `withResumeLock(resumeId, ...)` — it does not lock anything itself, and calling it
 * unlocked reproduces the exact race it exists to close (see `reopen-attempt.test.ts`'s planted
 * defect).
 */
export async function attemptReopenRow(
  resumeId: string,
  excludeId: string,
  deps: ReopenAttemptDeps,
): Promise<ReopenAttemptOutcome> {
  const { entries, aliveIds } = await deps.freshState()
  if (conversationAlreadyOpen(entries, aliveIds, resumeId, excludeId)) {
    return { kind: 'held', holder: await deps.holderOf() }
  }
  const r = await deps.spawn()
  if (!r.ok) return { kind: 'failed' }
  await deps.onSpawned(r.id)
  return { kind: 'opened' }
}
