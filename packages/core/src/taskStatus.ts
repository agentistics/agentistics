/**
 * taskStatus.ts — the board's status VOCABULARY: an editable list, not a closed enum. Pure.
 *
 * The board shipped with a fixed seven-value union (`backlog | todo | in_progress | blocked |
 * in_review | done | abandoned`, `task-model.ts`'s old `TaskStatus`). A product owner asked for the
 * list itself to be editable — new statuses, renamed labels, chosen colours, deletion of the ones
 * nobody uses — while FOUR specific words keep meaning what several pieces of business logic already
 * compare against by exact string: `done_needs_session` and `blocked_needs_reason`
 * (`task-web.ts`'s `markTask`/`patchSubtask`) and the status-auto-advance rules
 * (`statusAfterAttach` / `statusAfterSubtaskProgress`, `task-model.ts`). Those four ids —
 * `PROTECTED_STATUS_IDS` — can never be renamed or deleted, on any board, ever; only their LABEL and
 * COLOR may be edited. Everything else — the three legacy words this board also shipped
 * (`backlog`, `in_review`, `abandoned`) and anything a person types in afterward — is an ordinary
 * entry: editable freely, deletable the moment nothing on the board still points at it.
 *
 * `Task.status`/`Subtask.status` themselves stay a plain `string` (see `task-model.ts`) — this
 * module is the one place that decides which strings are REAL statuses right now, and the one place
 * that decides what happens to the list when a board that predates it is opened for the first time.
 */

export interface TaskStatusDef {
  /** Stable key. Never renamed once minted — a status is renamed by changing its LABEL, and a task
   *  pointing at this id must keep resolving to the same entry for as long as the id exists. */
  id: string
  label: string
  /** `#rrggbb`. See `isValidStatusColor`. */
  color: string
  /** Never deletable and its `id` never changes — see `PROTECTED_STATUS_IDS`. Label and color are
   *  editable exactly like any other status. */
  protected: boolean
  /** Left-to-right / column order. Lower sorts first; ties break on `id` (`sortTaskStatuses`). */
  order: number
}

/**
 * The four ids specific business rules compare against by exact string, today:
 *  - `done_needs_session` / `blocked_needs_reason` (`task-web.ts`'s `markTask`, `patchSubtask`)
 *  - `statusAfterAttach` / `statusAfterSubtaskProgress` (`task-model.ts`)
 *
 * A board with no status list yet seeds EXACTLY these four (`DEFAULT_TASK_STATUSES`) and nothing
 * else — see that constant's own note for why the historical seven are not all seeded.
 */
export const PROTECTED_STATUS_IDS = ['todo', 'in_progress', 'blocked', 'done'] as const
export type ProtectedStatusId = (typeof PROTECTED_STATUS_IDS)[number]

export function isProtectedStatusId(id: string): id is ProtectedStatusId {
  return (PROTECTED_STATUS_IDS as readonly string[]).includes(id)
}

/**
 * A fresh install, or a book from before this feature existed, gets EXACTLY these four — never the
 * historical seven. The other three words (`backlog`, `in_review`, `abandoned`) are a MIGRATION
 * SOURCE (`LEGACY_STATUS_HINTS`) and are seeded as ordinary, deletable entries only for a machine
 * that already has a task or subtask actually carrying one of them — see `planStatusMigration`.
 *
 * Colours are the same four the board already used for these columns (`board.ts`'s `STATUS` map,
 * as CSS custom properties there) restated as plain hex — this module has no access to the theme's
 * CSS variables, and a status's colour is a stored fact a user can repaint, not a design token.
 */
export const DEFAULT_TASK_STATUSES: readonly TaskStatusDef[] = [
  { id: 'todo', label: 'To do', color: '#3b82f6', protected: true, order: 0 },
  { id: 'in_progress', label: 'In progress', color: '#e8703a', protected: true, order: 1 },
  { id: 'blocked', label: 'Blocked', color: '#ef4444', protected: true, order: 2 },
  { id: 'in_review', label: 'In review', color: '#8b5cf6', protected: false, order: 3 },
  { id: 'done', label: 'Done', color: '#22c55e', protected: true, order: 4 },
]

/**
 * A status a person already created for the same idea under another id ("Em revisão" from the
 * editor slugifies to `em_revisao`, "Review" to `review`). Adding a second "In review" beside it
 * would be a duplicate column on their board, so the migration treats it as already present.
 */
function namesReview(s: TaskStatusDef): boolean {
  const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return /review|revis/.test(norm(s.id)) || /review|revis/.test(norm(s.label))
}

/**
 * Pure: the entry to ADD to an existing board's list so `in_review` (the hand-back target) exists,
 * or `null` when the list is empty (the seed will carry it), already has it, or a person has
 * custom-named another status. Never edits or reorders anything already there. The caller makes it
 * fire once per book (`inReviewSeeded`), so a deliberate delete is not undone on the next boot.
 */
export function planInReviewAdd(existing: readonly TaskStatusDef[]): TaskStatusDef | null {
  if (existing.length === 0 || existing.some(s => s.id === 'in_review' || namesReview(s))) return null
  const def = DEFAULT_TASK_STATUSES.find(s => s.id === 'in_review')!
  return { ...def, order: Math.max(...existing.map(s => s.order)) + 1 }
}

/**
 * The three words this board also shipped before the status list became editable. A HINT for the
 * migration only — never presented as a default, never re-created once deleted (the migration fires
 * exactly once, when the book carries no list at all; see `planStatusMigration`).
 */
const LEGACY_STATUS_HINTS: Readonly<Record<string, { label: string; color: string }>> = {
  backlog: { label: 'Backlog', color: '#94a3b8' },
  abandoned: { label: 'Abandoned', color: '#94a3b8' },
}

/**
 * Decide the status list a book should carry, given what is on disk and what its tasks/subtasks
 * actually reference right now.
 *
 * Fires ONLY when there is no list yet (`existing` absent or empty) — the seed-once moment on a
 * fresh install or a book written before this feature existed. `null` means "nothing to migrate",
 * which is what every call after the first returns: once a list exists, this function never touches
 * it again, so a status the user has since deleted is not silently re-created on the next boot, and
 * running the migration twice in a row (or from two processes racing to open the same book) is a
 * no-op the second time by construction, not by a separate idempotency check.
 *
 * Any status id actually in use that is not one of the four protected defaults becomes an ordinary,
 * NON-protected entry — using the legacy hint's label/colour when it is one of the three historical
 * words, or the bare id as its own label otherwise (an id this migration has never heard of is still
 * real work sitting on a real task, and dropping it would leave that task pointing at nothing).
 */
export function planStatusMigration(o: {
  existing: readonly TaskStatusDef[] | undefined | null
  /** Every status id currently on a task or subtask, deduplication not required. */
  usedStatusIds: readonly string[]
}): TaskStatusDef[] | null {
  if (o.existing && o.existing.length > 0) return null
  const seeded = DEFAULT_TASK_STATUSES.map(s => ({ ...s }))
  const known = new Set(seeded.map(s => s.id))
  let order = seeded.length
  const extra: TaskStatusDef[] = []
  // Legacy words first, in their own canonical order, so a fresh migration reads the same on every
  // machine; anything else actually in use follows, in first-sighting order.
  const seenExtra = new Set<string>()
  const candidates = [...Object.keys(LEGACY_STATUS_HINTS), ...o.usedStatusIds]
  for (const id of candidates) {
    if (!id || known.has(id) || seenExtra.has(id)) continue
    if (!o.usedStatusIds.includes(id)) continue // only seed what is ACTUALLY in use
    seenExtra.add(id)
    const hint = LEGACY_STATUS_HINTS[id]
    extra.push({
      id,
      label: hint?.label ?? id,
      color: hint?.color ?? '#94a3b8',
      protected: false,
      order: order++,
    })
  }
  return [...seeded, ...extra]
}

/** Left-to-right, by `order` then `id` — a TOTAL order, so a board nobody has re-arranged still
 *  reads the same way on every render (the same discipline `taskSort.ts` applies to rows). */
export function sortTaskStatuses(list: readonly TaskStatusDef[]): TaskStatusDef[] {
  return [...list].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
}

/** Is this string a status this board currently knows? The one gate every WRITE of `Task.status` /
 *  `Subtask.status` must pass — see `task-web.ts`'s `markTask` / `patchSubtask`. */
export function isKnownStatusId(id: string, statuses: readonly TaskStatusDef[]): boolean {
  return statuses.some(s => s.id === id)
}

/**
 * May this status be deleted?
 *
 * A PROTECTED status is refused regardless of usage — even one with zero tasks on it right now,
 * because a board with no `done` column is not a board this product's own rules (`done_needs_session`
 * and the rest) can keep meaning anything on. `isProtectedStatusId` is checked in ADDITION to the
 * stored flag: the flag is the fact this record carries, the id list is the invariant that must hold
 * even if a stored record were ever corrupted into carrying the wrong one.
 *
 * A NON-protected status already referenced by at least one task or subtask is refused too — the
 * usage-based rule the product owner asked for — and is silent about WHICH tasks; the caller states
 * the count, `usageCount`, so the UI can say "in use by N tasks" without a second query.
 */
export function canDeleteStatus(o: {
  status: Pick<TaskStatusDef, 'id' | 'protected'>
  usageCount: number
}): { ok: true } | { ok: false; reason: 'protected' | 'in_use' } {
  if (o.status.protected || isProtectedStatusId(o.status.id)) return { ok: false, reason: 'protected' }
  if (o.usageCount > 0) return { ok: false, reason: 'in_use' }
  return { ok: true }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function isValidStatusColor(c: unknown): c is string {
  return typeof c === 'string' && HEX_COLOR.test(c)
}

function slugifyStatusLabel(label: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return base || 'status'
}

/**
 * A fresh, unused id derived from a label a person just typed — `nextStatusId('Waiting on client',
 * existingIds)` → `'waiting_on_client'`. A collision (two people naming a status the same thing, or
 * a label that slugifies the same as one already on the board) gets a numeric suffix rather than
 * failing outright: the id is a machine detail nobody typed, and refusing the create over it would
 * be refusing the one thing the person DID ask for.
 */
export function nextStatusId(label: string, existingIds: readonly string[]): string {
  const known = new Set(existingIds)
  const base = slugifyStatusLabel(label)
  if (!known.has(base)) return base
  let i = 2
  while (known.has(`${base}_${i}`)) i += 1
  return `${base}_${i}`
}
