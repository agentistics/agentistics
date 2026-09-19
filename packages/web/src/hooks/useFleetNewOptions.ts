/**
 * useFleetNewOptions — the new-session wizard's own data source: what `/api/fleet/new` answers,
 * searched as the person types.
 *
 * Pulled out of `NewSessionModal` so a second dialog that only needs "which assistant, which
 * folder" (the staged-session compose panel, t-918cc82233) does not restate the fetch, the
 * debounce or the per-kind budget reading — see `formBits.tsx`'s own note on what happens when a
 * second dialog restates a piece instead of importing it.
 *
 * Harness AUTO-SELECTION is deliberately NOT done here: `NewSessionModal` wants to pre-pick a
 * preset's harness or the sole one available, while the staged-session compose panel wants neither
 * (a staged draft is allowed to sit with no harness chosen at all, asked at fire time). That
 * decision stays with each caller, over the `harnesses` this hook returns.
 */
import { useEffect, useState } from 'react'
import type { ProjectKind } from '@agentistics/core'
import { SEARCH_DEBOUNCE_MS } from '../lib/projectTabs'
import type { HarnessAnswer } from '../lib/wizardSteps'

export interface FleetProjectOption {
  path: string
  label: string
  repo?: string
  detail: string
  source: string
  /** True only for a LINKED worktree — never its own main checkout. See `ProjectKind`. */
  worktree?: boolean
}

export interface FleetNewOptions {
  /** `null` while the first fetch is in flight — a "checking what is installed" state, not an
   *  empty list. */
  harnesses: HarnessAnswer[] | null
  projects: FleetProjectOption[]
  /** How many places of each kind MATCHED, before the server's per-kind cap. `undefined` means this
   *  server does not say. */
  projectTotals: Record<ProjectKind, number> | undefined
  /** The field's own value — answers instantly, one keystroke behind the actual search. */
  query: string
  setQuery: (q: string) => void
  /** A search is in flight for a query the list has not caught up with yet. */
  searching: boolean
}

export function useFleetNewOptions(lang: 'pt' | 'en'): FleetNewOptions {
  const [harnesses, setHarnesses] = useState<HarnessAnswer[] | null>(null)
  const [projects, setProjects] = useState<FleetProjectOption[]>([])
  const [projectTotals, setProjectTotals] = useState<Record<ProjectKind, number> | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query === debouncedQuery) return
    setSearching(true)
    const t = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, debouncedQuery])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`/api/fleet/new?lang=${lang}&q=${encodeURIComponent(debouncedQuery)}`)
        if (!res.ok || !alive) return
        const json = await res.json() as {
          harnesses: HarnessAnswer[]; projects: FleetProjectOption[]
          projectTotals?: Record<ProjectKind, number>
        }
        if (!alive) return
        setHarnesses(json.harnesses)
        setProjects(json.projects)
        setProjectTotals(json.projectTotals)
      } catch {
        /* transient — the picker keeps what it had, which is better than an empty list */
      } finally {
        if (alive) setSearching(false)
      }
    }
    void load()
    return () => { alive = false }
  }, [lang, debouncedQuery])

  return { harnesses, projects, projectTotals, query, setQuery, searching }
}
