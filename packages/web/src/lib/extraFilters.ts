/**
 * extraFilters.ts — PURE. The shape of the page-specific dimensions a page may hand to the fixed filters bar.
 *
 * The bar owns the dimensions every page shares (period, harness, …). A page whose numbers react to MORE than that
 * (the Delivery evolution page: version, stage, author model, QA result, priority, task, "group by") passes them
 * here and the bar draws them in its own "+ Filter" menu, its own chip rows, its own count and its own "clear" —
 * so there is ONE bar, never a second filter row under it. Nothing here knows what a delivery is.
 */

export interface ExtraOption { value: string; label: string; color?: string }

export interface ExtraDimension {
  /** Stable id; the picker is keyed by it. */
  id: string
  label: string
  /** `multi` toggles any number of values; `single` keeps at most one (picking the chosen one again clears it). */
  mode: 'multi' | 'single'
  options: readonly ExtraOption[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  /**
   * A value that means "not filtering" (the default "group by" is `day`). A selection equal to it is not counted as an
   * active filter, draws no chip, and "clear" returns to it.
   */
  neutral?: string
  /** Search box in the picker — worth it once the list is long (tasks). */
  searchable?: boolean
}

export interface ExtraFilters {
  dims: readonly ExtraDimension[]
  /** Return every extra dimension to its neutral value. */
  clear: () => void
}

/** Is this dimension narrowing anything? (A `neutral` selection is not a filter.) */
export function extraActive(d: ExtraDimension): boolean {
  if (d.selected.length === 0) return false
  return !(d.neutral !== undefined && d.selected.length === 1 && d.selected[0] === d.neutral)
}

/** How many extra dimensions are narrowing — added to the bar's badge. */
export function extraActiveCount(extra: ExtraFilters | undefined): number {
  return extra ? extra.dims.filter(extraActive).length : 0
}

/** The next selection after the user picks `value` in `d`. */
export function pickExtra(d: ExtraDimension, value: string): string[] {
  if (d.mode === 'multi') return d.selected.includes(value) ? d.selected.filter(v => v !== value) : [...d.selected, value]
  if (d.selected.length === 1 && d.selected[0] === value) return d.neutral !== undefined ? [d.neutral] : []
  return [value]
}
