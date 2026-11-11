/**
 * filtersToTag.ts — PURE mapping from the dashboard's active `Filters` to a tag draft
 * (`{ sources, filters, window }`) ready to hand to the "New tag" drawer.
 *
 * The two models do not line up for free. A dashboard filter is a flat AND across every active
 * dimension ("project X AND harness Y AND model Z"). A tag's OWN two fields are not that: `sources`
 * is an OR union with no per-type grouping at all (mixing types there computes "X OR Y OR Z", a much
 * BROADER population than the dashboard view), while `filters` narrows grouped by type — OR within
 * a type, AND across types — which is exactly the dashboard's AND semantics, but only once `sources`
 * has already named a population to narrow. An empty `sources` list is not "everything"; per the
 * tag system's own invariant it is nothing at all.
 *
 * So every active dimension is kept — nothing is dropped — but at most ONE of them becomes
 * `sources`; every other active dimension becomes a `filters` entry of its own type. Which one
 * leads is `PRIMARY_PRIORITY` below: identity-shaped dimensions (project, repo) first, since a tag
 * is naturally "about" a codebase; attribute dimensions (harness, model, user, machine, team) are
 * narrower framings of that population and read more naturally as a restriction.
 */
import { subDays, format } from 'date-fns'
import type { Filters, DateRange } from '@agentistics/core'
import type { TagSourceType } from './tagSourceTypes'

export interface TagSource {
  type: TagSourceType
  value: string
}

export interface TagWindow {
  start?: string
  end?: string
}

export interface TagDraft {
  sources: TagSource[]
  filters: TagSource[]
  window: TagWindow | undefined
}

/** Identity-shaped dimensions lead; everything else narrows. See the module doc for why exactly
 *  one type may become `sources`. */
const PRIMARY_PRIORITY: readonly TagSourceType[] = [
  'project', 'repo', 'harness', 'model',
]

/** The 7d/30d/90d presets as an inclusive `yyyy-MM-dd` window ending today. `all` with no custom
 *  dates becomes `undefined` — "no period" already means "the whole history" on a tag, so pinning
 *  one here would say the same thing more fragilely (a tag's "all time" would stop being current
 *  the day after it was created). A custom range is passed through as-is: it is already the
 *  `yyyy-MM-dd` strings a tag window wants. */
function dateRangeToWindow(dateRange: DateRange, customStart: string, customEnd: string): TagWindow | undefined {
  if (dateRange === '7d' || dateRange === '30d' || dateRange === '90d') {
    const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90
    const now = new Date()
    return { start: format(subDays(now, days), 'yyyy-MM-dd'), end: format(now, 'yyyy-MM-dd') }
  }
  if (customStart || customEnd) {
    return { ...(customStart ? { start: customStart } : {}), ...(customEnd ? { end: customEnd } : {}) }
  }
  return undefined
}

/**
 * Build a tag draft from the currently active filters.
 *
 * Returns `sources: []` when nothing mappable is active — the caller's job to treat that as "there
 * is no tag to build here" (see `canCreateTagFromFilters`), never to save an empty tag.
 */
export function filtersToTagDraft(filters: Filters): TagDraft {
  const groups: Partial<Record<TagSourceType, string[]>> = {}
  const put = (type: TagSourceType, values: string[] | undefined) => {
    if (values && values.length > 0) groups[type] = values
  }

  put('project', filters.projects)
  put('repo', filters.repos)
  put('harness', filters.harnesses?.length ? filters.harnesses : (filters.harness ? [filters.harness] : undefined))
  put('model', filters.models)

  const primaryType = PRIMARY_PRIORITY.find(t => groups[t])

  const sources: TagSource[] = []
  const tagFilters: TagSource[] = []
  for (const [type, values] of Object.entries(groups) as [TagSourceType, string[]][]) {
    const list = values.map(value => ({ type, value }))
    if (type === primaryType) sources.push(...list)
    else tagFilters.push(...list)
  }

  return {
    sources,
    filters: tagFilters,
    window: dateRangeToWindow(filters.dateRange, filters.customStart, filters.customEnd),
  }
}

/** Whether the current filters produce a usable tag draft at all — the button's own visibility
 *  check. A date range alone (or nothing) maps to no sources, and a sourceless tag covers nothing. */
export function canCreateTagFromFilters(filters: Filters): boolean {
  return filtersToTagDraft(filters).sources.length > 0
}
