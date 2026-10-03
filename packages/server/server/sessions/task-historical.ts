/**
 * task-historical.ts — PURE. A conversation filed on the BOARD with no registry row behind it, turned
 * into the read row every rollup already knows how to walk.
 *
 * See `HistoricalSession` (task-model.ts) for WHY the link lives on the board and never in the fleet
 * registry. This module is the other half: how a link becomes a row, and how a request to file one is
 * judged.
 *
 * ## The synthetic row, and where it may exist
 *
 * `historicalRows` builds a `ManagedSession`-SHAPED row (`HistoricalRow`, flagged `historical: true`)
 * so that everything that walks a task's rows — `rowsOfTask`, `distinctConversations`,
 * `conversationOwners`, the list, the detail, the overview, the stats, the sharing — inherits the
 * conversation with no per-surface code. It is built in memory, per read, from the board, and is
 * handed ONLY to those readers (`TaskWorld.rollupRows`). The fleet registry (`registryRows`,
 * `readRegistry()`) never contains one, so nothing that probes, heartbeats, reconciles, adopts,
 * attaches to or lists a session can see it.
 *
 * ## Ownership, and why `createdAt` is `linkedAt`
 *
 * `conversationOwners` decides which task a conversation belongs to by the NEWEST FILING STATEMENT
 * among its rows. A historical link is a statement made at `linkedAt`, so the row carries that as
 * `createdAt` and the existing rule does the rest, with no special case:
 *
 *  - it OVERRIDES an older registry filing on another task (filing is a MOVE);
 *  - it is overridden by a LATER registry filing (the person re-filed the reopened conversation);
 *  - a reopen that carries no `taskId` says nothing about the id and is ignored, exactly as it is
 *    for two registry rows, so a reopened conversation stays where it was filed;
 *  - on an exact tie the row appended LAST wins (`atLeastAsNew` falls back to array order), and
 *    `historicalRows` is appended after the registry — the link was written after the rows it saw.
 *
 * A registry row's `createdAt` is when it was MINTED, not when it was last filed (`attachSession`
 * patches the same row), so against a registry row the comparison is a lower bound on that row's
 * statement — the same limit `conversationOwners` already lives with between two registry rows.
 * Refusing to file a conversation the fleet already holds (`conversation_in_fleet`) keeps the two
 * kinds of row from meeting in the first place; the read side stays correct when they do.
 */

import { sessionLabel, type SessionMeta } from '@agentistics/core'
import type { HistoricalSession } from './task-model'
import type { BoardRow, ManagedSession } from './types'

/** A read-only row synthesised from a `HistoricalSession`. Never written anywhere. */
export type HistoricalRow = ManagedSession & { historical: true }

export function isHistoricalRow(r: BoardRow): r is HistoricalRow {
  return (r as { historical?: unknown }).historical === true
}

/**
 * One synthetic row per link. `metas` is optional: a caller that only needs the FILING (the sharing
 * path, which never reads the store) gets a row with no label, cwd or end time, and a row whose
 * conversation is not in the store is still a session used with no numbers — the same rule a registry
 * row with a dead link follows (`rollupSessionsFor`'s `meta: null`), never a confident zero.
 */
export function historicalRows(
  links: readonly HistoricalSession[],
  metas?: ReadonlyMap<string, SessionMeta>,
): HistoricalRow[] {
  return links.map(l => {
    const meta = metas?.get(l.conversationId)
    const label = meta ? sessionLabel(meta) : ''
    return {
      id: l.id,
      harness: l.harness,
      cwd: meta?.project_path ?? '',
      // The FILING stamp, deliberately — see this module's header.
      createdAt: l.linkedAt,
      ...(meta?.end_time ? { endedAt: meta.end_time } : {}),
      ...(label ? { label } : {}),
      taskId: l.taskId,
      ...(l.subtaskId ? { subtaskId: l.subtaskId } : {}),
      conversationId: l.conversationId,
      // The board's own statement that this conversation is this one — not a time-and-directory claim.
      conversationLink: 'assigned' as const,
      historical: true as const,
    }
  })
}

/** Why a conversation cannot be filed as a historical one. */
export type ConversationRefusal =
  /** The store holds no meta for this id (or for this harness): nothing to price. */
  | { reason: 'no_such_conversation' }
  /** A registry row already exists for it — file THAT row (`sessionId`) instead. */
  | { reason: 'conversation_in_fleet'; sessionId: string }

/**
 * Can this conversation be filed as a historical one?
 *
 * **`no_such_conversation`** — never accept a link that would price nothing: it would sit on a task as
 * a session with no numbers and read as a delivery that cost nothing, which is the confident zero this
 * repo refuses everywhere. `harness`, when the caller gives one, must match the meta's — the store is
 * keyed by session id alone, so a mismatch names a conversation this id does not belong to.
 *
 * **`conversation_in_fleet`** — the live path already handles a conversation with a row: it takes the
 * managed id and the newest row decides. Answering with THAT row's id (the newest, by `createdAt`
 * then registry order — `atLeastAsNew`'s own rule) tells the caller what to pass instead.
 */
export function planConversationFiling(o: {
  conversationId: string
  harness?: string
  metas: ReadonlyMap<string, SessionMeta>
  registryRows: readonly ManagedSession[]
}): { ok: true; meta: SessionMeta; harness: HistoricalSession['harness'] } | ({ ok: false } & ConversationRefusal) {
  const meta = o.metas.get(o.conversationId)
  const harness = (meta?.harness ?? 'claude') as HistoricalSession['harness']
  if (!meta || (o.harness && o.harness !== harness)) return { ok: false, reason: 'no_such_conversation' }

  let newest: ManagedSession | undefined
  for (const r of o.registryRows) {
    if (r.conversationId !== o.conversationId) continue
    if (!newest) { newest = r; continue }
    const tn = Date.parse(newest.createdAt)
    const tr = Date.parse(r.createdAt)
    // By `createdAt` when both parse and differ; otherwise the LATER row wins (registry order).
    newest = Number.isFinite(tn) && Number.isFinite(tr) && tn !== tr ? (tr > tn ? r : newest) : r
  }
  if (newest) return { ok: false, reason: 'conversation_in_fleet', sessionId: newest.id }
  return { ok: true, meta, harness }
}
