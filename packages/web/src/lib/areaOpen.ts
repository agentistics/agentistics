/**
 * areaOpen.ts — which area rows the person opened or closed BY HAND in the navigation tree.
 *
 * Only explicit choices are stored (`areaId -> boolean`); an area with no entry follows the default
 * rule in `isAreaOpen` — open when it holds the current URL. A personal choice, so it rides
 * `/api/user-prefs` (per account on a central), never `/api/preferences`.
 */
import { createSharedPref } from './sharedPref'

export type AreaOpenMap = Record<string, boolean>

export function parseAreaOpen(raw: unknown): AreaOpenMap | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: AreaOpenMap = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'boolean') out[k] = v
  return out
}

export function isAreaOpen(map: AreaOpenMap, id: string, active: boolean): boolean {
  return map[id] ?? active
}

/**
 * The chevron. Closing just closes. OPENING by hand is the accordion too (QA r3): every other area
 * held open closes, including the current one, which is open by default and so needs an explicit
 * `false` (`activeId`). Hand-closed areas stay closed.
 */
export function toggledAreaOpen(map: AreaOpenMap, id: string, active: boolean, activeId?: string): AreaOpenMap {
  if (isAreaOpen(map, id, active)) return { ...map, [id]: false }
  const out = openedArea(map, id)
  return activeId && activeId !== id ? { ...out, [activeId]: false } : out
}

/**
 * Selecting an area row opens it — going somewhere is also asking to see what is inside — and
 * closes every other area held open, so the tree is an accordion (the prototype): visiting areas one
 * after another must not stack their pages until Repositórios, Cofre and Ajustes fall below the fold.
 * A hand-CLOSED area stays closed; only stale opens are dropped.
 */
export function openedArea(map: AreaOpenMap, id: string): AreaOpenMap {
  const out: AreaOpenMap = {}
  for (const [k, v] of Object.entries(map)) if (k !== id && v === false) out[k] = false
  out[id] = true
  const same = Object.keys(out).length === Object.keys(map).length && Object.entries(out).every(([k, v]) => map[k] === v)
  return same ? map : out
}

export const areaOpenStore = createSharedPref<AreaOpenMap>({
  key: 'agentistics-area-open', prefKey: 'areaOpen', fallback: {}, adoptLocalWhenAbsent: true, parse: parseAreaOpen,
})
