/**
 * session/checkpoint-store.ts — H4: the file checkpoint (`tools/file/checkpoint.ts`) made DURABLE, so
 * an undo survives a resume or a restart of the process that drove the run.
 *
 * ## Where each half lives
 *
 * - The BEFORE and AFTER bodies of every write go into the content store (`content-store.ts`, 0600,
 *   by sha256) — the same place a message body or a tool result lives. A file's content is
 *   conversation-adjacent content and never sits in a database row.
 * - The INDEX — which path, which call, which run, which session, the two `{sha256, bytes}` refs —
 *   lives in its own `checkpoints` table (`sqlite-store.ts`), never inside the session row. A path is
 *   a fact of the kind the journal already carries in `filesTouched`; the content is not.
 *
 * ## A body that could not be stored
 *
 * `ContentSink.put` never throws; it answers `null` on a full disk or a permission error. A write
 * whose body could not be kept is still INDEXED, with `stored: false`: the undo then refuses that
 * file in a sentence ("its checkpoint could not be kept") rather than the file silently falling out
 * of the change set — an undo that quietly reverts four of five files and says nothing about the
 * fifth is the one outcome worse than no undo. A `before`/`after` of `null` keeps its checkpoint
 * meaning (created / deleted) only when `stored` is true.
 */

import type { ContentRef } from '../tools/contract.ts'
import type { CheckpointEntry, CheckpointStore } from '../tools/file/checkpoint.ts'
import type { SessionContentStore } from './runtime.ts'

export type UndoOutcomeKind = 'restored' | 'kept'

export interface CheckpointRow {
  /** Monotonic, assigned by the store: the order the writes happened in. */
  id: number
  sessionId: string | null
  runId: string | null
  toolExecutionId: string
  path: string
  /** `null`: the editor CREATED the file (valid only while `stored`). */
  before: ContentRef | null
  /** `null`: the editor DELETED the file (valid only while `stored`). */
  after: ContentRef | null
  /** `false`: a body could not be kept — this change can never be undone, and the undo says so. */
  stored: boolean
  at: string
  /** Set once an undo has dealt with this row — reverted it, or left it (`kept`) with consent. */
  undoneAt?: string
  undoOutcome?: UndoOutcomeKind
}

export type AppendCheckpointInput = Omit<CheckpointRow, 'id' | 'undoneAt' | 'undoOutcome'>

/** The durable index. `sqlite-store.ts` implements it beside the `SessionStore`. */
export interface CheckpointIndex {
  appendCheckpoint(input: AppendCheckpointInput): Promise<void>
  /**
   * Not-yet-undone rows of the NEWEST run of `sessionId` that still has any, ascending by `id`.
   * Bounded by one run's writes — never the session's whole history.
   */
  latestUndoable(sessionId: string): Promise<CheckpointRow[]>
  markUndone(marks: ReadonlyArray<{ id: number; outcome: UndoOutcomeKind }>, at: string): Promise<void>
  /** Every row, in order — the legacy `Checkpoint.restore` reader only (see `all()` below). */
  allCheckpoints(): Promise<CheckpointRow[]>
}

/**
 * A `CheckpointStore` (what the file tools record through) that writes bodies to the content store
 * and refs to the index. Hand it to `createNativeTools({ file: { checkpointStore } })`.
 */
export function createPersistentCheckpointStore(content: SessionContentStore, index: CheckpointIndex): CheckpointStore {
  async function refOf(text: string | null): Promise<{ ref: ContentRef | null; ok: boolean }> {
    if (text === null) return { ref: null, ok: true }
    const ref = await content.put(text)
    return { ref, ok: ref !== null }
  }

  return {
    async append(entry: CheckpointEntry): Promise<void> {
      const b = await refOf(entry.before)
      const a = await refOf(entry.after)
      await index.appendCheckpoint({
        sessionId: entry.sessionId ?? null,
        runId: entry.runId ?? null,
        toolExecutionId: entry.toolExecutionId,
        path: entry.path,
        before: b.ref,
        after: a.ref,
        stored: b.ok && a.ok,
        at: entry.at,
      })
    },

    /**
     * The whole log, hydrated — what `Checkpoint.restore(scope, …)` reads. The host never calls that
     * path (the undo reads one run through `latestUndoable`); it is implemented faithfully so the
     * store keeps the contract it claims. A row whose body is gone is left out, exactly as
     * `restore` would have nothing to put back.
     */
    async all(): Promise<CheckpointEntry[]> {
      const out: CheckpointEntry[] = []
      for (const row of await index.allCheckpoints()) {
        const entry = await hydrateRow(content, row)
        if (entry) out.push(entry)
      }
      return out
    },
  }
}

/** A row's bodies read back, or `null` when it was never stored or a body is gone. */
export async function hydrateRow(content: SessionContentStore, row: CheckpointRow): Promise<CheckpointEntry | null> {
  if (!row.stored) return null
  const before = row.before === null ? null : await content.get(row.before.sha256)
  const after = row.after === null ? null : await content.get(row.after.sha256)
  if (row.before !== null && before === null) return null
  if (row.after !== null && after === null) return null
  const entry: CheckpointEntry = { path: row.path, before, after, toolExecutionId: row.toolExecutionId, at: row.at }
  if (row.sessionId !== null) entry.sessionId = row.sessionId
  if (row.runId !== null) entry.runId = row.runId
  return entry
}
