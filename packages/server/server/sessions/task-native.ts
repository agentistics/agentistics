/**
 * task-native.ts — PURE. A NATIVE session filed on the board (`NativeSessionLink`), turned into the
 * read row every rollup already walks — the same move `task-historical.ts` makes for a conversation
 * with no registry row, for the same reason: a native session has no fleet row either.
 *
 * ## The row
 *
 * `nativeRows` builds a `BoardRow` flagged `native: true`, with `harness: 'agentistics'` (the native
 * runtime is a `RunHarness`, not a `HarnessId` — `BoardRow` is the one place the board's rows admit
 * it). It is built in memory, per read, and handed ONLY to the board's readers (`TaskWorld.rollupRows`):
 * nothing that probes, reopens, attaches to or ships a fleet session ever sees one, and the team
 * sharing path (`loadTaskBoard`) leaves them out (a central's model has no native harness).
 *
 * `id` and `conversationId` are both the native session id: one session is one conversation, so the dedupe and
 * ownership rules (`distinctConversations`, `conversationOwners`) apply unchanged, and `createdAt` is
 * the FILING stamp (`linkedAt`) exactly as for a historical link.
 *
 * ## The money
 *
 * The cost is the ENGINE's snapshot (`link.usage`), never re-derived here from tokens and a rate
 * table: the engine priced each response and knows whether the provider stated it. No snapshot yet
 * means "not measured" — `nativeRollupSession` returns `costUSD: null`, never a confident zero.
 */
import type { NativeSessionLink, NativeSessionUsage } from './task-model'
import type { RollupSession } from './task-rollup'
import type { BoardRow } from './types'

/** A read-only row synthesised from a `NativeSessionLink`. Never written anywhere. */
export type NativeRow = BoardRow & { native: true; harness: 'agentistics'; nativeUsage?: NativeSessionUsage }

export function isNativeRow(r: BoardRow): r is NativeRow {
  return (r as { native?: unknown }).native === true
}

export function nativeRows(links: readonly NativeSessionLink[]): NativeRow[] {
  return links.map(l => ({
    // The SESSION id, not the link's own (`native:<id>`): every surface opens a row at
    // `/sessions/<id>` and unfiles it by id, and both already resolve a native session by it.
    id: l.sessionId,
    harness: 'agentistics' as const,
    cwd: l.cwd ?? '',
    createdAt: l.linkedAt,
    ...(l.label ? { label: l.label } : {}),
    ...(l.usage?.model ? { model: l.usage.model } : {}),
    taskId: l.taskId,
    ...(l.subtaskId ? { subtaskId: l.subtaskId } : {}),
    conversationId: l.sessionId,
    conversationLink: 'assigned' as const,
    native: true as const,
    ...(l.usage ? { nativeUsage: l.usage } : {}),
  }))
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown): v is number => finite(v) && v >= 0 && Number.isInteger(v)

/**
 * A usage snapshot as the board keeps it, or null when it cannot be trusted. Every number is checked
 * (an engine is a separate build; a hand-edited file is not bound by either): a negative or non-finite
 * figure drops the whole snapshot — a cost that might be wrong is not shown as a cost.
 */
export function sanitizeNativeUsage(raw: unknown): NativeSessionUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  if (!count(u.responses) || !count(u.rounds)) return null
  if (u.tokens !== null && !count(u.tokens)) return null
  if (u.costUSD !== null && !(finite(u.costUSD) && u.costUSD >= 0)) return null
  if (typeof u.updatedAt !== 'string' || !Number.isFinite(Date.parse(u.updatedAt))) return null
  return {
    responses: u.responses,
    rounds: u.rounds,
    tokens: u.tokens as number | null,
    costUSD: u.costUSD as number | null,
    costMeasured: u.costMeasured === true && u.costUSD !== null,
    ...(typeof u.model === 'string' && u.model.trim() ? { model: u.model.trim().slice(0, 200) } : {}),
    updatedAt: u.updatedAt,
  }
}

/**
 * The rollup entry of a native row: the engine's snapshot, or — with none yet — a session used with
 * no numbers (`costUSD: null`), exactly like a registry row whose conversation is not in the store.
 * Cost is keyed by the native harness, so a plan basis (which covers adapter harnesses) never rescales it.
 */
export function nativeRollupSession(r: NativeRow): RollupSession {
  const u = r.nativeUsage
  return {
    rowId: r.id,
    provenance: 'assigned',
    meta: null,
    costUSD: u ? u.costUSD : null,
    ...(u && u.costUSD !== null ? { costMeasured: u.costMeasured } : {}),
    native: { harness: 'agentistics', tokens: u ? u.tokens : null, rounds: u ? u.rounds : null, reported: u !== undefined },
  }
}
