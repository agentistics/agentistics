/**
 * tools/file/checkpoint.ts — §5 recovery: "record what the editor itself wrote (path, before,
 * after, event id) … and skip any file changed since, saying so". This is the answer to one
 * agent's own mistake, not to concurrent work (worktree isolation is that answer — see CLAUDE.md's
 * "Concurrent work" section) and NOT a substitute for git: it covers only writes made THROUGH
 * `file.patch` / `file.write` in THIS runtime. Anything the shell did (§5's own stated limit,
 * repeated in `restore`'s result below) is invisible here by construction.
 *
 * ## Storage
 *
 * Entries are kept IN MEMORY by default (`createCheckpoint()` with no argument constructs one), a
 * a plain array — cheap, and correct for the process lifetime a session runs in. A caller that
 * needs the log to survive a restart passes its own `CheckpointStore` (`createCheckpoint(store)`);
 * `memoryCheckpointStore()` is the reference implementation the default wraps, exported so a host
 * can compose a persistent one against the same shape.
 *
 * ## Restore, one rule
 *
 * `restore(scope)` groups the matching entries BY PATH, in recorded order, and reduces each group
 * to `{before: first.before, after: last.after}` — the state before this scope's FIRST touch and
 * the state its LAST touch should have left on disk. That one reduction is what makes `restore`
 * correct for both a single `toolExecutionId` (one entry per path, trivially) and `'all'` (several
 * edits to the same path over a session): current disk content is compared against `after`
 * (proving nothing else has touched the file since), and a match is reverted to `before`.
 *
 * A RENAME is recorded as two entries at once — the old path `{before: original, after: null}` and
 * the new path `{before: null, after: finalContent}` (`../file/patch.ts` writes both under one
 * `toolExecutionId`) — so restoring composes into "recreate the old path, remove the new one"
 * without `restore` needing to know renames exist.
 */

export interface CheckpointEntry {
  path: string
  /** `null` means the editor CREATED this file (there was nothing to restore it to). */
  before: string | null
  /** `null` means the editor DELETED this file (restoring means recreating `before`). */
  after: string | null
  toolExecutionId: string
  at: string
}

export interface CheckpointStore {
  append(entry: CheckpointEntry): Promise<void>
  all(): Promise<CheckpointEntry[]>
}

export function memoryCheckpointStore(): CheckpointStore {
  const entries: CheckpointEntry[] = []
  return {
    async append(entry) {
      entries.push(entry)
    },
    async all() {
      return [...entries]
    },
  }
}

export interface RestoreOutcome {
  restored: string[]
  skipped: Array<{ path: string; reason: string }>
}

/** What `restore` actually does to disk — kept apart from the pure decision (`planRestore`) so the
 *  decision can be tested without a filesystem. */
export interface DiskAccess {
  /** Current content, or `null` when the path does not exist / cannot be read. */
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

interface RestoreTarget {
  path: string
  before: string | null
  after: string | null
}

/** Pure: which of `entries` (already filtered to the requested scope) to act on, and how. */
export function planRestore(entries: CheckpointEntry[]): RestoreTarget[] {
  const byPath = new Map<string, CheckpointEntry[]>()
  for (const e of entries) {
    const list = byPath.get(e.path)
    if (list) list.push(e)
    else byPath.set(e.path, [e])
  }
  const targets: RestoreTarget[] = []
  for (const [path, group] of byPath) {
    targets.push({ path, before: group[0]!.before, after: group[group.length - 1]!.after })
  }
  return targets
}

export interface Checkpoint {
  /** Records one write. Called once per file the editor touched in a call (twice for a rename). */
  record(entry: Omit<CheckpointEntry, 'at'>, now?: () => Date): Promise<void>
  /**
   * Reverts what the editor wrote — `toolExecutionId` for one call, `'all'` for the whole session.
   * A file whose current content does not match what the editor last left there is SKIPPED, named,
   * never overwritten: something else touched it since, and silently reverting would discard that.
   * Covers only writes this checkpoint recorded — a shell edit is invisible here, by construction.
   */
  restore(scope: string | 'all', disk: DiskAccess): Promise<RestoreOutcome>
}

export function createCheckpoint(store: CheckpointStore = memoryCheckpointStore()): Checkpoint {
  return {
    async record(entry, now = () => new Date()) {
      await store.append({ ...entry, at: now().toISOString() })
    },
    async restore(scope, disk) {
      const all = await store.all()
      const scoped = scope === 'all' ? all : all.filter(e => e.toolExecutionId === scope)
      const targets = planRestore(scoped)
      const restored: string[] = []
      const skipped: Array<{ path: string; reason: string }> = []
      for (const t of targets) {
        const current = await disk.read(t.path)
        const matchesAfter = t.after === null ? current === null : current === t.after
        if (!matchesAfter) {
          skipped.push({ path: t.path, reason: 'the file changed since the editor wrote it' })
          continue
        }
        if (t.before === null) {
          await disk.remove(t.path)
        } else {
          await disk.write(t.path, t.before)
        }
        restored.push(t.path)
      }
      return { restored, skipped }
    },
  }
}
