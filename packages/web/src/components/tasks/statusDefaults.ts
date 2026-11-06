/**
 * statusDefaults — which statuses the board and the table SHOW when nobody has chosen.
 *
 * Owner decision 2026-11-06: by default only `blocked → todo → in progress → in review → done`, in
 * that order; every other status (backlog, deferred ideas, abandoned, anything custom) is HIDDEN
 * and can be shown again from the view panel. A person who never touched the columns has no stored
 * `groups`, so this default applies to them as soon as they load the new build — that IS the
 * migration, and it needs no write. A person who did choose keeps exactly what they chose.
 *
 * Matching is by id first, then by the label normalised to the same shape, because a board that
 * created its own "In review" status (instead of the legacy `in_review` id) must not lose it.
 */

import type { TaskStatusDef } from '@agentistics/core'
import { liveStatusOrder } from './board'

/** The canonical default, in reading order. */
export const DEFAULT_STATUS_ORDER = ['blocked', 'todo', 'in_progress', 'in_review', 'done'] as const

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/**
 * PURE: the status ids visible by default on this board, in the default order. A loading list
 * (`null`) yields the canonical ids; a loaded one yields only those it really has.
 */
export function defaultVisibleStatuses(list: readonly TaskStatusDef[] | null): string[] {
  if (!list) return [...DEFAULT_STATUS_ORDER]
  const out: string[] = []
  for (const want of DEFAULT_STATUS_ORDER) {
    const hit = list.find(s => s.id === want) ?? list.find(s => norm(s.label) === want || norm(s.id) === want)
    if (hit && !out.includes(hit.id)) out.push(hit.id)
  }
  return out
}

/** The ids to draw: what the person stored (stale ids dropped), else the default. */
export function visibleStatuses(stored: readonly string[] | null, list: readonly TaskStatusDef[] | null): string[] {
  if (stored === null) return defaultVisibleStatuses(list)
  if (!list) return [...stored]
  const live = new Set(liveStatusOrder(list))
  return stored.filter(id => live.has(id))
}

/** Is this arrangement the default one (so "Restore default" has nothing to do)? */
export function isDefaultVisible(stored: readonly string[] | null, list: readonly TaskStatusDef[] | null): boolean {
  if (stored === null) return true
  const d = defaultVisibleStatuses(list)
  return stored.length === d.length && stored.every((id, i) => id === d[i])
}

/** Statuses that exist but are not shown, in the board's own order. */
export function hiddenStatuses(shown: readonly string[], list: readonly TaskStatusDef[] | null): string[] {
  const on = new Set(shown)
  return liveStatusOrder(list).filter(id => !on.has(id))
}

/** Move `id` one step in the shown list (`-1` earlier, `1` later). Total: out of range = unchanged. */
export function moveStatus(shown: readonly string[], id: string, by: -1 | 1): string[] {
  const i = shown.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= shown.length) return [...shown]
  const next = [...shown]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return next
}

/**
 * PURE: a label per id that is never shown twice. Two real statuses may share a label (the legacy
 * `in_review` plus a later custom "In review"); the first keeps its name, every later one gets its
 * id appended so the panel never lists the same visible name twice.
 */
export function uniqueStatusLabels(list: readonly TaskStatusDef[] | null): Record<string, string> {
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const id of liveStatusOrder(list)) {
    const base = list?.find(s => s.id === id)?.label ?? id
    let label = seen.has(base.trim().toLowerCase()) ? `${base} (${id})` : base
    while (seen.has(label.trim().toLowerCase())) label += '*'
    seen.add(label.trim().toLowerCase())
    out[id] = label
  }
  return out
}
