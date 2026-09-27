/**
 * subtaskSort.ts — how a delivery's SUBTASKS are ordered when a person clicks a column title.
 *
 * `taskSort.ts` orders TASKS and reads a `SortableRow`. A subtask is not one: it has no rank, no
 * priority, and the numbers next to it (cost, tokens, sessions) are not on the record — they are
 * measured through the sessions filed under it and arrive beside it, keyed by its id. So the comparator
 * is its own, but it obeys the same three rules, for the same reasons:
 *
 *  - **`null` is not zero, and it sorts LAST in both directions.** A subtask nobody has filed a
 *    session under has no cost; it is not the cheapest one. Reversing the arrow moves the measured
 *    rows and leaves the unmeasurable ones at the bottom, where they read as "no answer".
 *  - **Every sort is TOTAL.** Ties fall back to the position the subtask had in the list it was
 *    given — which is creation order, the list's own order — so the result is the same on every
 *    render, and equal values never reshuffle each other.
 *  - **No sort at all is a state** (`null`), and it is the list exactly as it came. The default of a
 *    subtask list is "the order I made them in", and a header that could only ever pick a key would
 *    leave that unreachable once touched.
 *
 * It sorts the FLAT list and knows nothing about groups. That is deliberate and it is what keeps a
 * group whole: the renderer (`clusterSubtaskRows`, in the web package) walks the list once, places a
 * group's header where the list puts it and pulls every member to sit under it, in the order the list
 * gives the members. So a sorted flat list already means "loose rows and group blocks ordered among
 * themselves, members ordered inside their group" — the cluster is rebuilt from the sorted list, never
 * shattered by it. `subtaskGroups.test.ts` pins that composition.
 */

import { statusRank, type SortDir } from './taskSort'

export type SubtaskSortKey =
  | 'title' | 'status' | 'started' | 'completed' | 'sessions' | 'rounds' | 'cost' | 'tokens'

export interface SubtaskSortSpec {
  key: SubtaskSortKey
  dir: SortDir
}

/** What a subtask must carry to be sorted. Narrower than the web's `Subtask`, so it satisfies it. */
export interface SortableSubtask {
  id: string
  title: string
  status: string
  /** System-stamped, read-only — see `task-model.ts`'s `Subtask.startedAt`/`deliveredAt`. */
  startedAt?: string
  deliveredAt?: string
}

/**
 * The MEASURED half of a subtask, resolved by the caller (it lives in `TaskDetail.subtaskRollups`
 * and `TaskDetail.sessions`, which the core package has no business knowing the shape of).
 *
 * Each field is `null` when it cannot be produced — no session filed yet, a linked session whose
 * cost cannot be priced, a Copilot-credits row with no dollar figure to compare — and `null` is the
 * only thing that means "no answer".
 */
export interface SubtaskMeasure {
  sessions: number | null
  rounds: number | null
  costUSD: number | null
  tokens: number | null
}

export interface SubtaskSortContext<T> {
  /** The board's pipeline (`liveStatusOrder`) — see `SortContext.statusOrder`. */
  statusOrder?: readonly string[]
  /** The measured numbers of one subtask, or `undefined` when the list has none for it. */
  measureOf?: (subtask: T) => SubtaskMeasure | undefined
}

function valueOf<T extends SortableSubtask>(
  s: T, key: SubtaskSortKey, ctx: SubtaskSortContext<T> | undefined,
): number | string | null {
  switch (key) {
    case 'title': return s.title.toLowerCase()
    case 'status': return ctx?.statusOrder ? statusRank(ctx.statusOrder, s.status) : s.status
    case 'started': return s.startedAt || null
    case 'completed': return s.deliveredAt || null
    case 'sessions': return ctx?.measureOf?.(s)?.sessions ?? null
    case 'rounds': return ctx?.measureOf?.(s)?.rounds ?? null
    case 'cost': return ctx?.measureOf?.(s)?.costUSD ?? null
    case 'tokens': return ctx?.measureOf?.(s)?.tokens ?? null
  }
}

/**
 * The subtasks ordered by `spec`, or the list as it came for `null`. Never mutates its input.
 * Ties, and rows nobody could measure, keep the relative order the list already had.
 */
export function sortSubtasks<T extends SortableSubtask>(
  subtasks: readonly T[], spec: SubtaskSortSpec | null, ctx?: SubtaskSortContext<T>,
): T[] {
  if (!spec) return [...subtasks]
  const indexed = subtasks.map((s, i) => ({ s, i, v: valueOf(s, spec.key, ctx) }))
  indexed.sort((a, b) => {
    if (a.v === null && b.v === null) return a.i - b.i
    if (a.v === null) return 1
    if (b.v === null) return -1
    let d = 0
    if (typeof a.v === 'number' && typeof b.v === 'number') d = a.v - b.v
    else d = String(a.v) < String(b.v) ? -1 : String(a.v) > String(b.v) ? 1 : 0
    if (d === 0) return a.i - b.i
    return spec.dir === 'asc' ? d : -d
  })
  return indexed.map(x => x.s)
}
