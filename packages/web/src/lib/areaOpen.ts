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

export function toggledAreaOpen(map: AreaOpenMap, id: string, active: boolean): AreaOpenMap {
  return { ...map, [id]: !isAreaOpen(map, id, active) }
}

/** Selecting an area row opens it: going somewhere is also asking to see what is inside. */
export function openedArea(map: AreaOpenMap, id: string): AreaOpenMap {
  return map[id] === true ? map : { ...map, [id]: true }
}

export const areaOpenStore = createSharedPref<AreaOpenMap>({
  key: 'agentistics-area-open', prefKey: 'areaOpen', fallback: {}, adoptLocalWhenAbsent: true, parse: parseAreaOpen,
})
