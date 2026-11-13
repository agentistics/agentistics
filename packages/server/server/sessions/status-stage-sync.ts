/**
 * sessions/status-stage-sync.ts — the IO half of the STORED status stage (S0c, spec §2.2).
 *
 * `@agentistics/core`'s `planStatusStages` decides; this file reads and writes. The stage lives on the status in
 * tasks.json AND is mirrored in `guarantees.json` (`statusStages`), a file an older binary never opens: the v2.210.1
 * task writer drops `stage` from every status, so after an old-writer round trip the mirror is what restores it
 * (never the label). The mirror sits NEXT TO the tasks file, like `guards.json` does.
 *
 * A plain read of a fully-staged board does no IO here at all. The mirror write is best effort — a busy or unreadable
 * guarantees.json costs the mirror its freshness (the next write retries), never the board.
 */
import { dirname, join } from 'node:path'
import { isStatusStage, planStatusStages, type TaskStatusDef } from '@agentistics/core'
import { createGuaranteesStore } from '../delivery/activation'
import { withGuardLocks } from '../delivery/guard-locks'
import type { TaskStore } from './task-store'
import type { TaskBook } from './task-model'

export const mirrorPathFor = (tasksFile: string): string => join(dirname(tasksFile), 'guarantees.json')

/** Write the whole mirror from the board's current statuses, under the guards lock. Best effort. */
export async function writeStatusStageMirror(tasksFile: string, statuses: readonly TaskStatusDef[]): Promise<boolean> {
  const dir = dirname(tasksFile)
  try {
    await withGuardLocks(['guards'], () => createGuaranteesStore(mirrorPathFor(tasksFile)).writeStatusStages(statuses), {
      paths: { tasks: tasksFile, deliveries: join(dir, 'deliveries.json'), guards: join(dir, 'guards.json') },
    })
    return true
  } catch { return false }
}

/**
 * The load-time pass: every status gets a valid stored stage (restored from the mirror, else classified once) and the
 * mirror is brought in line. Returns true when it WROTE the board (so the caller re-reads).
 */
export async function ensureStatusStages(store: TaskStore, book: TaskBook, tasksFile: string): Promise<boolean> {
  // One small read of the mirror per load (the book parse it rides on costs far more); the WRITES happen only on a difference.
  const { doc } = await createGuaranteesStore(mirrorPathFor(tasksFile)).read()
  const plan = planStatusStages(book.statuses, doc.statusStages)
  const wrote = plan.restored.length + plan.classified.length > 0
  if (wrote) await store.setStatusStages(Object.fromEntries(plan.statuses.map(s => [s.id, s.stage!])))
  if (!sameMirror(doc.statusStages, plan.statuses)) await writeStatusStageMirror(tasksFile, plan.statuses)
  return wrote
}

function sameMirror(mirror: Readonly<Record<string, string>> | undefined, statuses: readonly TaskStatusDef[]): boolean {
  const m = mirror ?? {}
  const keys = Object.keys(m)
  return keys.length === statuses.length && statuses.every(s => m[s.id] === s.stage)
}
