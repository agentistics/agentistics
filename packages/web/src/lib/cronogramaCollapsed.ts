/**
 * cronogramaCollapsed.ts — which rows of the Cronograma tree the person folded (▶). A personal choice, so it rides
 * `/api/user-prefs` (`cronogramaCollapsed`), never `/api/preferences`; the browser copy is only the first paint.
 * Only folded rows are stored: a row with no entry is open.
 */
import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'

export function parseCollapsed(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  return raw.filter((x): x is string => typeof x === 'string').slice(0, 500)
}

export const toggleCollapsed = (list: readonly string[], id: string): string[] =>
  list.includes(id) ? list.filter(x => x !== id) : [...list, id]

export const cronogramaCollapsedStore = createSharedPref<string[]>({
  key: 'agentistics-cronograma-collapsed', prefKey: 'cronogramaCollapsed', fallback: [], adoptLocalWhenAbsent: true, parse: parseCollapsed,
})

export function useCronogramaCollapsed(): [ReadonlySet<string>, (id: string) => void] {
  const list = useSyncExternalStore(cronogramaCollapsedStore.subscribe, cronogramaCollapsedStore.get, cronogramaCollapsedStore.get)
  return [new Set(list), id => cronogramaCollapsedStore.set(toggleCollapsed(cronogramaCollapsedStore.get(), id))]
}
