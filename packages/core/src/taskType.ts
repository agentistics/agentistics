/**
 * taskType.ts — the board's TYPE vocabulary: an editable list shaped exactly like the status one
 * (`taskStatus.ts`), seeded with CORE. Pure.
 *
 * A type is a second, orthogonal way to classify a task ("what kind of work is it") beside the
 * status ("where is it"). Unlike a status nothing in the product's business rules compares against
 * a type by exact string, so there is no PROTECTED set: every type can be renamed, repainted and —
 * once no task carries it — deleted. `Task.type` is absent for a task nobody classified, and that is
 * a real answer ("No type"), never defaulted.
 *
 * The shared helpers (`isValidStatusColor`, `nextStatusId`) are the same arithmetic over a
 * different list; they are re-used rather than restated.
 */
import { isValidStatusColor, nextStatusId } from './taskStatus'

export interface TaskTypeDef {
  /** Stable key, never renamed — a type is renamed by changing its LABEL. */
  id: string
  label: string
  /** `#rrggbb`. */
  color: string
  /** Left-to-right / band order. Lower first; ties break on `id`. */
  order: number
}

/** The one type a fresh book carries. */
export const CORE_TYPE_ID = 'core'

export const DEFAULT_TASK_TYPES: readonly TaskTypeDef[] = [
  { id: CORE_TYPE_ID, label: 'CORE', color: '#8b5cf6', order: 0 },
]

/** A TOTAL order, like `sortTaskStatuses`. */
export function sortTaskTypes(list: readonly TaskTypeDef[]): TaskTypeDef[] {
  return [...list].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
}

export function isKnownTypeId(id: string, types: readonly TaskTypeDef[]): boolean {
  return types.some(t => t.id === id)
}

/** Deletable only while no task carries it; the caller states the count. */
export function canDeleteType(o: { usageCount: number }): { ok: true } | { ok: false; reason: 'in_use' } {
  return o.usageCount > 0 ? { ok: false, reason: 'in_use' } : { ok: true }
}

export const isValidTypeColor = isValidStatusColor
export const nextTypeId = nextStatusId

/**
 * Decide the type list a book should carry. Fires ONLY when there is no list yet, like
 * `planStatusMigration`: seeds CORE, plus any type id a task already carries.
 */
export function planTypeMigration(o: {
  existing: readonly TaskTypeDef[] | undefined | null
  usedTypeIds: readonly string[]
}): TaskTypeDef[] | null {
  if (o.existing && o.existing.length > 0) return null
  const seeded = DEFAULT_TASK_TYPES.map(t => ({ ...t }))
  const known = new Set(seeded.map(t => t.id))
  let order = seeded.length
  for (const id of o.usedTypeIds) {
    if (!id || known.has(id)) continue
    known.add(id)
    seeded.push({ id, label: id, color: '#94a3b8', order: order++ })
  }
  return seeded
}

/**
 * The one-time data migration: a task whose STATUS is the old `core` column becomes type=core with
 * status in_progress. Returns the patch, or null when the task is not in that state. Idempotent:
 * once the status is rewritten the task no longer matches.
 */
export function coreStatusMigration(t: { status: string; type?: string }): { status: string; type: string } | null {
  if (t.status !== CORE_TYPE_ID) return null
  return { status: 'in_progress', type: t.type || CORE_TYPE_ID }
}
