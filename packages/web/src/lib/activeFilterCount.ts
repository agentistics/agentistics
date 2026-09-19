/**
 * activeFilterCount.ts — the ONE count of how many filter DIMENSIONS are currently narrowing what
 * is on screen.
 *
 * `FiltersBar` imports this for its own "+ Filtro" and "Ver filtros ativos" badges (see its
 * `activeFilterCount`, next to `clearAllFilters` — the two are kept side by side there so a
 * dimension added to one is answered by the other). The Sessions workspace's Filtros tab imports it
 * too, for the badge on its own collapsed trigger, BEFORE the panel holding `FiltersBar` is ever
 * mounted — which is why this lives as a standalone function rather than something read off the
 * component: a value that only exists once a component has mounted cannot back a badge that must be
 * right on the very first paint. Every term here is a plain read of `filters.*`, so the function
 * needs no state of its own.
 *
 * `dateRange` / `customStart` / `customEnd` are deliberately NOT dimensions here: the date presets
 * sit outside the "+ Filtro" menu and are always visible, so `FiltersBar` never counted them either.
 */
import type { Filters } from '@agentistics/core'

/**
 * `activeOnly` is passed as a plain boolean rather than re-deriving `FiltersBar`'s
 * `Boolean(onActiveOnlyChange && activeOnly)` guard: every caller of this helper always wires the
 * switch through, so the callback is never the missing half.
 */
export function countActiveFilters(filters: Filters, activeOnly: boolean): number {
  return [
    (filters.users?.length ?? 0) > 0,
    (filters.harnesses?.length ?? 0) > 0,
    filters.presence !== undefined,
    (filters.repos?.length ?? 0) > 0,
    (filters.tags?.length ?? 0) > 0,
    filters.projects.length > 0,
    (filters.models?.length ?? 0) > 0,
    (filters.teams?.length ?? 0) > 0,
    (filters.machines?.length ?? 0) > 0,
    activeOnly,
  ].filter(Boolean).length
}
