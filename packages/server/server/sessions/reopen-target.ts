/**
 * reopen-target.ts — PURE. Which conversation a managed row reopens, if any.
 *
 * FOUR copies of this decision existed — the fleet row's `claimResume` (session-view.ts), the task
 * reopen and the fell offer in cli-start.ts, and `agentop session open` in cli-session.ts — and they
 * had drifted: the fleet refused to guess for a row that knew its conversation, while the other
 * three fell back to "some conversation in this directory" for exactly that row. One rule now.
 *
 * THE RULE, in order:
 *  1. A row that KNOWS its conversation (the harness's own statement, else the id the registry
 *     recorded) reopens THAT conversation or nothing. Never the directory guess: "not in the store
 *     yet" and "some other conversation in this folder" are different answers, and taking the second
 *     is what once handed three rows one conversation after a crash.
 *  2. The store holds it → it reopens when its harness can resume by id.
 *  3. The store does NOT hold it → it STILL reopens, from the exact link, when (a) the harness can
 *     resume by id, (b) the row has a directory to reopen in, and (c) the harness's own transcript
 *     for that id was found on disk (`onDisk`, decided by the IO half, `reopen-link.ts`). This is
 *     the path an Antigravity session agentop started needs: agy writes `history.jsonl` only for a
 *     prompt typed in its own UI, so such a conversation can be in the store with no project path —
 *     which `loadConversations` drops — or not in the store at all, while the row holds the exact
 *     id agy itself wrote into the log it opened. (c) is what keeps a CLI that was handed an id at
 *     spawn (`claude --session-id`) and died before writing anything from being offered a reopen
 *     whose only outcome is "no conversation found".
 *  4. A row that knows nothing falls back to the directory guess, over conversations nobody in this
 *     pass has claimed yet — offered to a person who can read the title and decline.
 */

import type { HarnessId } from '@agentistics/core'
import { sessionAtCwd } from '../live-sessions'
import type { Conversation } from './conversations'
import { SPAWN_SPECS } from './spawn-spec'

export interface ReopenEntry {
  harness?: HarnessId
  cwd?: string
  conversationId?: string
  /** The harness's own `/rename` name, persisted — the title an exact-link target wears. */
  harnessName?: string
}

export interface ReopenTarget {
  sessionId: string
  title: string
  /** How it was resolved — `store` and `exact-link` are exact, `directory` is the guess. */
  via: 'store' | 'exact-link' | 'directory'
}

/** Whether this harness can reopen a conversation BY ID. */
export function resumableById(harness: HarnessId | undefined): boolean {
  return harness !== undefined && SPAWN_SPECS[harness]?.resume !== undefined
}

export function reopenTargetFor(o: {
  entry: ReopenEntry
  /** What the harness itself says this row drives — outranks the registry's record. */
  exactId?: string
  pool: readonly Conversation[]
  /** Exact ids whose transcript the harness's own reader found on disk. */
  onDisk?: ReadonlySet<string>
  /** Conversations already handed out in this pass. Read for the GUESS, written by every claim. */
  taken: Set<string>
}): ReopenTarget | null {
  const { entry, pool, taken } = o
  const knownId = o.exactId ?? entry.conversationId
  if (knownId) {
    const own = pool.find(c => c.sessionId === knownId)
    if (own) {
      if (!own.resumable) return null
      taken.add(own.sessionId)
      return { sessionId: own.sessionId, title: own.title, via: 'store' }
    }
    if (!resumableById(entry.harness) || !entry.cwd || !o.onDisk?.has(knownId)) return null
    taken.add(knownId)
    return { sessionId: knownId, title: entry.harnessName ?? '', via: 'exact-link' }
  }
  if (!entry.harness) return null
  const conv = pool.find(c =>
    !taken.has(c.sessionId)
    && c.harness === entry.harness
    && sessionAtCwd({ current_cwd: c.cwd, project_path: c.cwd }, entry.cwd ?? ''))
  if (!conv?.resumable) return null
  taken.add(conv.sessionId)
  return { sessionId: conv.sessionId, title: conv.title, via: 'directory' }
}
