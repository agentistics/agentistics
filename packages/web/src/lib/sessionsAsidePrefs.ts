/**
 * sessionsAsidePrefs.ts — how the Sessions workspace's aside arranges its own list.
 *
 * `localStorage`, deliberately not `/api/preferences` — the same rule and the same reason
 * `boardPrefs.ts` states: on a central, `preferences.json` is shared by every signed-in user, and
 * this is a per-viewer arrangement of a list (which grouping, in what order, which groups are
 * folded, how a card shows its status), not a fact about the work like a pin. One person's
 * collapsed groups must not collapse them for the whole team looking at that central's relayed
 * fleet.
 *
 * Every read and write is guarded: a private window, cleared site data, or blocked storage makes
 * the accessor throw, and an aside that will not render because it could not remember its
 * arrangement is worse than one that opens on the defaults.
 */

const KEY = 'agentistics-sessions-aside-v1'

/** The sub-grouping inside each Active/Inactive band. */
export type AsideGroupBy = 'project' | 'task' | 'status'

export const ASIDE_GROUP_BY_VALUES: readonly AsideGroupBy[] = ['project', 'task', 'status']

/** How a session's card shows its state — see `sessionCardStyle.ts`. */
export type AsideCardColor = 'wash' | 'neutral' | 'stripe'

export const ASIDE_CARD_COLOR_VALUES: readonly AsideCardColor[] = ['wash', 'neutral', 'stripe']

/** The band a group lives under — never the localized label, or PT/EN would split one
 *  preference in two. */
export type AsideBandId = 'active' | 'inactive'

export interface AsideGroupPrefs {
  groupBy: AsideGroupBy
  /** Manual order of group KEYS, per dimension. An absent dimension is fully automatic. */
  order: Partial<Record<AsideGroupBy, string[]>>
  /** Collapsed groups, keyed `${band}:${groupBy}:${key}` — see `collapseKey`. */
  collapsed: string[]
  cardColor: AsideCardColor
}

export const DEFAULT_ASIDE_GROUP_PREFS: AsideGroupPrefs = {
  groupBy: 'project', order: {}, collapsed: [], cardColor: 'wash',
}

/** The stable key one group's collapsed state is stored under. */
export function collapseKey(band: AsideBandId, groupBy: AsideGroupBy, key: string): string {
  return `${band}:${groupBy}:${key}`
}

const isGroupBy = (v: unknown): v is AsideGroupBy =>
  typeof v === 'string' && (ASIDE_GROUP_BY_VALUES as readonly string[]).includes(v)

const isCardColor = (v: unknown): v is AsideCardColor =>
  typeof v === 'string' && (ASIDE_CARD_COLOR_VALUES as readonly string[]).includes(v)

function readOrder(v: unknown): Partial<Record<AsideGroupBy, string[]>> {
  if (!v || typeof v !== 'object') return {}
  const out: Partial<Record<AsideGroupBy, string[]>> = {}
  for (const by of ASIDE_GROUP_BY_VALUES) {
    const list = (v as Record<string, unknown>)[by]
    if (Array.isArray(list)) out[by] = list.filter((x): x is string => typeof x === 'string')
  }
  return out
}

export function readAsideGroupPrefs(): AsideGroupPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_ASIDE_GROUP_PREFS
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      groupBy: isGroupBy(p.groupBy) ? p.groupBy : DEFAULT_ASIDE_GROUP_PREFS.groupBy,
      order: readOrder(p.order),
      collapsed: Array.isArray(p.collapsed)
        ? p.collapsed.filter((x): x is string => typeof x === 'string')
        : [],
      cardColor: isCardColor(p.cardColor) ? p.cardColor : DEFAULT_ASIDE_GROUP_PREFS.cardColor,
    }
  } catch { return DEFAULT_ASIDE_GROUP_PREFS }
}

export function writeAsideGroupPrefs(patch: Partial<AsideGroupPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAsideGroupPrefs(), ...patch }))
  } catch { /* storage unavailable — the arrangement lasts this visit and no longer */ }
}
