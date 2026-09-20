/**
 * deliveryPickerFilter.ts — PURE. The repo/harness tabs over `SessionFiling.tsx`'s delivery-picker
 * list (the UNFILED branch, picking a delivery when the session has none yet).
 *
 * The direct feedback was "não é separado por repo/projeto/harness" — but `TaskListRow` carries no
 * PROJECT field at all, only `repos` (normalized git remotes, `''` = no linked repository — the same
 * bucket the Repositories page and `repoTasks.ts` already use) and `harnesses` (the fleet's own ids).
 * Offering a project tab here would be the exact defect `HARNESS_CAPABILITIES` exists to prevent,
 * applied to a filter instead of a metric: a control that groups by something the data cannot
 * actually answer. So this offers exactly the two dimensions the board can measure, and nothing else.
 *
 * `tasksOfRepo` is imported rather than restated — it is the SAME membership test the Repositories
 * page's own Tasks tab already uses (`repoTasks.ts`), so a delivery filed under two repositories is
 * counted under both here exactly as it is there.
 */

import { repoShortName } from '@agentistics/core'
import { tasksOfRepo } from '../../lib/repoTasks'
import type { TaskListRow } from '../../lib/tasks'

/** The tab id meaning "no filter on this dimension" — never a real repo or harness value. */
export const ALL = '__all__'

/**
 * Every distinct repo across the given rows, `''` (no linked repository) sorted last. A dimension
 * with at most one real value has nothing to filter — the call site is what decides whether to draw
 * the tab strip at all (`repoFilterOptions(rows).length > 1`), so this always returns the whole set
 * rather than pre-deciding "not worth it" itself.
 */
export function repoFilterOptions(rows: readonly TaskListRow[]): string[] {
  const set = new Set<string>()
  for (const r of rows) for (const repo of r.repos) set.add(repo)
  return [...set].sort((a, b) => {
    if (a === '') return 1
    if (b === '') return -1
    return a.localeCompare(b)
  })
}

/** Every distinct harness across the given rows, alphabetic. */
export function harnessFilterOptions(rows: readonly TaskListRow[]): string[] {
  const set = new Set<string>()
  for (const r of rows) for (const h of r.harnesses) set.add(h)
  return [...set].sort()
}

export function repoTabLabel(repo: string, pt: boolean): string {
  if (repo === ALL) return pt ? 'Todos' : 'All'
  if (repo === '') return pt ? 'Sem repo' : 'No repo'
  return repoShortName(repo)
}

/** `harnessLabel` is passed in (`HARNESS_LABELS`) rather than imported, so this stays dependency-free
 *  the same way `subtaskFiling.ts` does — a pure module with no knowledge of the harness registry. */
export function harnessTabLabel(harness: string, pt: boolean, harnessLabel: (h: string) => string): string {
  return harness === ALL ? (pt ? 'Todos' : 'All') : harnessLabel(harness)
}

/** `ALL` passes every row through unchanged; any other value narrows to rows touching that repo. */
export function filterRowsByRepo(rows: readonly TaskListRow[], repo: string): TaskListRow[] {
  return repo === ALL ? [...rows] : tasksOfRepo(rows, repo)
}

/** `ALL` passes every row through unchanged; any other value narrows to rows that ran on it. */
export function filterRowsByHarness(rows: readonly TaskListRow[], harness: string): TaskListRow[] {
  return harness === ALL ? [...rows] : rows.filter(r => r.harnesses.includes(harness))
}
