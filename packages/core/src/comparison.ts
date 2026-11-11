/**
 * comparison.ts — saved comparisons: N filter scopes measured against each other.
 *
 * A comparison is a QUESTION the user asked once and will ask again — "is Codex cheaper than
 * Claude for me", "did last month cost more than the one before". Keeping it means not rebuilding
 * two filter sets every time, and pinning it to the Home page means the answer is simply there.
 *
 * ── THE FIRST SIDE IS THE BASELINE ───────────────────────────────────────────────────────────
 * With two sides a delta is symmetric and the order barely matters. With three or more it does:
 * every other side is reported RELATIVE TO THE FIRST, so reordering changes what the numbers mean.
 * That is why sides are an ordered list and why the first one is labelled as the baseline in the
 * UI rather than left to be inferred.
 *
 * ── LOCAL ONLY ───────────────────────────────────────────────────────────────────────────────
 * These live in `preferences.json` beside the billing timeline. They describe how one person
 * looks at their own data; nothing here leaves the machine.
 */

import type { Filters } from './types'
import type { CostBasis } from './billing'

export interface ComparisonSide {
  id: string
  /** The user's own name for this side. Absent means "describe it from its filters". */
  label?: string
  filters: Filters
  /** The cost basis THIS side is measured in.
   *
   *  Per side, not per comparison: "what my plan cost" against "what the same work would have
   *  cost at API prices" is the core question this whole feature exists for, and a single
   *  comparison-wide basis made it unaskable. Absent reads as `'api'`. */
  basis?: CostBasis
}

export interface SavedComparison {
  id: string
  name: string
  /** Ordered, at least two. Index 0 is the baseline every delta is measured against. */
  sides: ComparisonSide[]
  /** @deprecated The comparison-wide basis, kept only to READ saves written before the basis
   *  moved onto each side. `normalizeComparisons` migrates it down and nothing writes it. */
  basis?: CostBasis
  /** Pin it to the Home page. */
  onHome?: boolean
}

/** The most sides a comparison may hold. Past this the table stops being readable on any screen,
 *  and the honest fix is a second comparison rather than a wider one. */
export const MAX_COMPARISON_SIDES = 6
export const MIN_COMPARISON_SIDES = 2

function normalizeFilters(raw: unknown): Filters | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') as string[] : [])
  const dateRange = r.dateRange
  if (dateRange !== '7d' && dateRange !== '30d' && dateRange !== '90d' && dateRange !== 'all') return null
  const out: Filters = {
    dateRange,
    customStart: typeof r.customStart === 'string' ? r.customStart : '',
    customEnd: typeof r.customEnd === 'string' ? r.customEnd : '',
    projects: strArray(r.projects),
    models: strArray(r.models),
  }
  if (Array.isArray(r.repos)) out.repos = strArray(r.repos)
  if (Array.isArray(r.tags)) out.tags = strArray(r.tags)
  if (Array.isArray(r.harnesses)) out.harnesses = strArray(r.harnesses) as Filters['harnesses']
  return out
}

/**
 * Read whatever is in `preferences.json` into comparisons we can render.
 *
 * Total, and never throws. A comparison whose sides cannot be read is DROPPED rather than
 * repaired: a half-read comparison would answer a question the user never asked, which is worse
 * than the comparison being gone and re-creatable in three clicks.
 */
export function normalizeComparisons(raw: unknown): SavedComparison[] {
  if (!Array.isArray(raw)) return []
  const out: SavedComparison[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id === '') continue
    if (typeof r.name !== 'string' || r.name.trim() === '') continue
    if (!Array.isArray(r.sides)) continue

    const sides: ComparisonSide[] = []
    for (const s of r.sides) {
      if (!s || typeof s !== 'object') continue
      const sr = s as Record<string, unknown>
      const filters = normalizeFilters(sr.filters)
      if (!filters || typeof sr.id !== 'string' || sr.id === '') continue
      // A save written before the basis moved onto each side carries one comparison-wide value;
      // it migrates down to every side, which is exactly what it meant.
      const legacy = r.basis === 'plan' ? 'plan' : 'api'
      sides.push({
        id: sr.id,
        filters,
        basis: sr.basis === 'plan' ? 'plan' : sr.basis === 'api' ? 'api' : legacy,
        ...(typeof sr.label === 'string' && sr.label !== '' ? { label: sr.label } : {}),
      })
    }
    if (sides.length < MIN_COMPARISON_SIDES) continue

    out.push({
      id: r.id,
      name: r.name.trim(),
      sides: sides.slice(0, MAX_COMPARISON_SIDES),
      ...(r.onHome === true ? { onHome: true } : {}),
    })
  }
  return out
}

/** Insert or replace by id, preserving order. A save is an UPSERT: editing a pinned comparison
 *  must not move it to the end of the Home page. */
export function upsertComparison(list: readonly SavedComparison[], next: SavedComparison): SavedComparison[] {
  const at = list.findIndex(c => c.id === next.id)
  if (at === -1) return [...list, next]
  const out = [...list]
  out[at] = next
  return out
}

export function removeComparison(list: readonly SavedComparison[], id: string): SavedComparison[] {
  return list.filter(c => c.id !== id)
}

/** The ones pinned to Home, in saved order. */
export function comparisonsOnHome(list: readonly SavedComparison[]): SavedComparison[] {
  return list.filter(c => c.onHome === true)
}
