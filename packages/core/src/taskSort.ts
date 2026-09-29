/**
 * task-sort.ts — how a board is ORDERED. Pure, and shared by every surface that draws a task.
 *
 * The table's column headers and the kanban's order picker are two front doors onto this one
 * function, deliberately: a board that ranks its cards one way in the grid and another in the
 * columns is two boards, and the reader has to hold both.
 *
 * Three rules the sort obeys, each because the alternative is worse:
 *
 *  - **`null` is not zero, and it sorts LAST in both directions.** A task nobody could price is not
 *    the cheapest task; putting it at the top of an ascending "cost" sort is the same confident-zero
 *    this product refuses everywhere else. Reversing the direction moves the measured rows and
 *    leaves the unmeasurable ones at the bottom, where they read as "no answer" rather than "least".
 *  - **Every sort is TOTAL.** Ties break on the manual rank, then on creation, then on id, so the
 *    order is the same on every render and on every machine. A board whose rows shuffle when you
 *    change nothing is a board people stop trusting to have shown them everything.
 *  - **`manual` is a real key, not the absence of one.** It reads `Task.rank` (see `task-rank.ts`);
 *    tasks nobody has dragged have no rank and follow the ranked ones, oldest first.
 */

/**
 * It lives in `@agentistics/core` and not beside the store because the BROWSER sorts too: the
 * table's headers and the kanban's picker are the two front doors onto it, and a second
 * implementation in `packages/web` is a second set of rules for the same question — which is how a
 * grid and a set of columns end up ranking the same cards differently.
 */

/** Most urgent first. The one place the order is stated; every sort and every picker reads it. */
export type TaskPriorityId = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export const PRIORITY_ORDER: readonly TaskPriorityId[] =
  ['urgent', 'high', 'medium', 'low', 'none'] as const

export type SortKey =
  | 'manual' | 'priority' | 'title' | 'status' | 'created' | 'updated' | 'due'
  | 'started' | 'cost' | 'tokens' | 'rounds' | 'sessions' | 'attempts' | 'comments'
  | 'subtasks' | 'progress' | 'harnesses' | 'delivered'

export type SortDir = 'asc' | 'desc'

export interface SortSpec {
  key: SortKey
  dir: SortDir
}

/** What a row must carry to be sorted. Deliberately narrower than `TaskListRow`, so the browser's
 *  own row type satisfies it without importing the server's. */
export interface SortableRow {
  task: {
    id: string
    title: string
    status: string
    createdAt: string
    updatedAt: string
    priority?: TaskPriorityId | string
    dueDate?: string
    deliveredAt?: string
    /**
     * When real work actually began — stamped once, system-side, never user-editable. See
     * `task-model.ts`'s `Task.startedAt`. `'started'` is the sort key that reads it.
     */
    startedAt?: string
    rank?: string
  }
  attempts?: number
  rollup?: {
    costUSD: number | null
    tokens: number | null
    rounds: number | null
    sessionsUsed: number
  }
  counts?: { comments: number; subtasks: number; subtasksDone: number; files: number }
  harnesses?: string[]
}

export const DEFAULT_SORT: SortSpec = { key: 'manual', dir: 'asc' }

/**
 * What a comparison may need to know that the rows themselves do not carry.
 *
 * `statusOrder` is the board's pipeline (`liveStatusOrder`). Without it `status` compares the raw
 * ids, which is alphabetical — `blocked` before `done` before `todo` — and says nothing a reader can
 * check against the board. With it, "sort by status" means what the columns of the kanban mean: the
 * order the work moves through. A status the list does not know (deleted since, or one a central
 * cannot see) sorts AFTER every known one, deterministically, never as a crash.
 */
export interface SortContext {
  statusOrder?: readonly string[]
}

/** The rank of a status in `order`, or one past the end when it is not in it. */
export function statusRank(order: readonly string[], status: string): number {
  const i = order.indexOf(status)
  return i === -1 ? order.length : i
}

const priorityIndex = (p: string | undefined): number => {
  const i = PRIORITY_ORDER.indexOf((p ?? 'none') as TaskPriorityId)
  // An unknown word ranks with "nobody has said" rather than at the top: a typo in a stored
  // priority must not promote a task above every triaged one.
  return i === -1 ? PRIORITY_ORDER.length - 1 : i
}

/**
 * The comparable value of a row on one key: a number, a string, or `null` for "no answer".
 *
 * `null` is the whole reason this is a separate function — it is checked once, in `compare`, rather
 * than by every key remembering to.
 */
function valueOf(row: SortableRow, key: SortKey, ctx?: SortContext): number | string | null {
  const t = row.task
  switch (key) {
    case 'manual': return t.rank ?? null
    case 'priority': return priorityIndex(t.priority)
    case 'title': return t.title.toLowerCase()
    case 'status': return ctx?.statusOrder ? statusRank(ctx.statusOrder, t.status) : t.status
    case 'created': return t.createdAt || null
    case 'updated': return t.updatedAt || null
    case 'due': return t.dueDate || null
    case 'delivered': return t.deliveredAt || null
    case 'started': return t.startedAt || null
    case 'cost': return row.rollup?.costUSD ?? null
    case 'tokens': return row.rollup?.tokens ?? null
    case 'rounds': return row.rollup?.rounds ?? null
    case 'sessions': return row.rollup?.sessionsUsed ?? null
    case 'attempts': return row.attempts ?? null
    case 'comments': return row.counts?.comments ?? null
    case 'subtasks': return row.counts?.subtasks ?? null
    // The FRACTION closed, not the count: "Progress" ordered by how many subtasks a task has would
    // rank a 1-of-9 above a 2-of-2. A task nobody broke up has no progress — `null`, sorted last,
    // never a 0% (the same reason `taskProgress` draws no bar for it).
    case 'progress': return row.counts && row.counts.subtasks > 0
      ? row.counts.subtasksDone / row.counts.subtasks
      : null
    case 'harnesses': return row.harnesses?.length ?? null
  }
}

/** The total, deterministic tiebreak. Manual rank, then creation, then id. */
function tiebreak(a: SortableRow, b: SortableRow): number {
  const ra = a.task.rank
  const rb = b.task.rank
  if (ra !== rb) {
    // A ranked card outranks an unranked one — dragging a card must move it above the ones nobody
    // has touched, not merely reorder it among its equals.
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra < rb ? -1 : 1
  }
  const ca = a.task.createdAt
  const cb = b.task.createdAt
  if (ca !== cb) return ca < cb ? -1 : 1
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0
}

export function compareBy(spec: SortSpec, a: SortableRow, b: SortableRow, ctx?: SortContext): number {
  const va = valueOf(a, spec.key, ctx)
  const vb = valueOf(b, spec.key, ctx)
  // Unmeasurable rows sit at the bottom whichever way the arrow points — see the header.
  if (va === null && vb === null) return tiebreak(a, b)
  if (va === null) return 1
  if (vb === null) return -1
  let d = 0
  if (typeof va === 'number' && typeof vb === 'number') d = va - vb
  else d = String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0
  if (d === 0) return tiebreak(a, b)
  return spec.dir === 'asc' ? d : -d
}

export function sortRows<T extends SortableRow>(
  rows: readonly T[], spec: SortSpec, ctx?: SortContext,
): T[] {
  return [...rows].sort((a, b) => compareBy(spec, a, b, ctx))
}

/**
 * `sortRows` over a row that is not itself a `SortableRow`, through a projection.
 *
 * A screen sorts by what it DISPLAYS, and that is not always what the shared row type reads: the
 * repository tab and the central's board print `sessionsLinked` (what this view can actually see)
 * in the "Sessions" column while `SortableRow.rollup.sessionsUsed` is the count of every session
 * filed. Ordering a column by a number other than the one printed in it is a table that looks
 * shuffled, so the projection says which number the column means and the comparator stays one.
 */
export function sortRowsBy<T>(
  rows: readonly T[], spec: SortSpec, project: (row: T) => SortableRow, ctx?: SortContext,
): T[] {
  return rows
    .map(row => ({ row, sortable: project(row) }))
    .sort((a, b) => compareBy(spec, a.sortable, b.sortable, ctx))
    .map(x => x.row)
}

/**
 * A header click: none → ascending → descending → back to the board's own order.
 *
 * Three states rather than two, because "I did not choose a sort" has to be reachable without
 * remembering what the default key was — and on this board the default IS a key (`manual`), which a
 * two-state toggle can only leave you stuck outside of.
 */
export function nextSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return DEFAULT_SORT
}

/**
 * `nextSort`'s twin for a list with NO board order of its own — the central's board, a subtask list
 * (whose "own order" is creation) — where the way back from a sort is "no sort at all", not a key.
 * none → ascending → descending → none, generic over the key type so a subtask list, whose columns
 * are not `SortKey`s, cycles through the same three states with the same rule.
 */
export function cycleSort<K extends string>(
  current: { key: K; dir: SortDir } | null, key: K,
): { key: K; dir: SortDir } | null {
  if (!current || current.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return null
}

/**
 * The `aria-sort` a column header carries: `ascending`/`descending` on the ONE column the list is
 * ordered by and `none` on every other. A header with no sort state at all (`null`) is `none`
 * everywhere — a screen reader is told a column is sortable by the button in it, and told which one
 * is in force by this.
 */
export function ariaSortOf<K extends string>(
  current: { key: K; dir: SortDir } | null, key: K,
): 'ascending' | 'descending' | 'none' {
  if (!current || current.key !== key) return 'none'
  return current.dir === 'asc' ? 'ascending' : 'descending'
}

/**
 * May a card be dragged to a NEW POSITION in a list ordered like this?
 *
 * Only the hand order is a position a person can set: a drop writes a rank (`moveTask`), and a rank
 * only means something under the sort that reads it. Under any other key the drop would be applied
 * to an order the reader is not looking at — the card lands somewhere other than where it was put —
 * so the board refuses in words instead (see the kanban's column note). Descending hand order is
 * refused too: its indices count from the other end, which a drop cannot express.
 */
export function canReorderBy(spec: SortSpec): boolean {
  return spec.key === 'manual' && spec.dir === 'asc'
}
