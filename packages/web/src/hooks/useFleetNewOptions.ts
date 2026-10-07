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
import { fetchFleetNewWithRetry } from '../lib/fleetNewRetry'

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
  projectIndexing: boolean
  /** The field's own value — answers instantly, one keystroke behind the actual search. */
  query: string
  setQuery: (q: string) => void
  /** A search is in flight for a query the list has not caught up with yet. */
  searching: boolean
  /** The server's sentence for why it cannot offer anything (`FleetNewOptions.unavailable`). */
  unavailable: string | undefined
  retry: () => void
  retryable: boolean
}

export function useFleetNewOptions(lang: 'pt' | 'en'): FleetNewOptions {
  const [harnesses, setHarnesses] = useState<HarnessAnswer[] | null>(null)
  const [projects, setProjects] = useState<FleetProjectOption[]>([])
  const [projectTotals, setProjectTotals] = useState<Record<ProjectKind, number> | undefined>(undefined)
  const [projectIndexing, setProjectIndexing] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined)
  const [retryNumber, setRetryNumber] = useState(0)
  const [retryable, setRetryable] = useState(false)

  useEffect(() => {
    if (query === debouncedQuery) return
    setSearching(true)
    const t = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, debouncedQuery])

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setUnavailable(undefined)
    setRetryable(false)
    setHarnesses(null)
    const load = async () => {
      try {
        const json = await fetchFleetNewWithRetry<{
          harnesses: HarnessAnswer[]; projects: FleetProjectOption[]
          projectTotals?: Record<ProjectKind, number>
          projectIndexing?: boolean
          unavailable?: string
        }>(`/api/fleet/new?lang=${lang}&q=${encodeURIComponent(debouncedQuery)}`, { signal: controller.signal })
        if (!alive) return
        setHarnesses(json.harnesses)
        setProjects(json.projects)
        setProjectTotals(json.projectTotals)
        setProjectIndexing(json.projectIndexing === true)
        setUnavailable(json.unavailable)
      } catch {
        if (alive) {
          setHarnesses([])
          setProjects([])
          setProjectTotals(undefined)
          setProjectIndexing(false)
          setUnavailable(lang === 'pt'
            ? 'Não consegui ver o que está instalado.'
            : 'I could not see what is installed.')
          setRetryable(true)
        }
      } finally {
        if (alive) setSearching(false)
      }
    }
    void load()
    return () => { alive = false; controller.abort() }
  }, [lang, debouncedQuery, retryNumber])

  return { harnesses, projects, projectTotals, projectIndexing, query, setQuery, searching, unavailable,
    retry: () => setRetryNumber(n => n + 1), retryable }
}
