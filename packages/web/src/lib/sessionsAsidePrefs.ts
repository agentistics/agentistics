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

import { DEFAULT_ORDER, SESSION_SORTS, type SessionOrder } from '@agentistics/tui/control/session-order'

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
  /** Collapsed USER groups (`sessionUserGroups.ts`), keyed by the group's own id. Per-viewer, same
   *  as `collapsed` above — a person's folded "Saved to later" band on their phone must not fold
   *  it on their desktop too, the same reasoning `boardPrefs.ts` states for the board's columns.
   *  Membership itself lives on the SERVER (`sessionUserGroups.ts`); only "is it folded right now
   *  on THIS screen" lives here. */
  collapsedUserGroups: string[]
  /** What the sessions INSIDE each group are ordered by (the cockpit's own `SessionOrder`, so the two
   *  surfaces answer "sort by recent" the same way). The default is the one that puts what is
   *  blocked on you first — the reason the list exists. Per-viewer, like the rest of the arrangement. */
  sort: SessionOrder
  /** User groups whose NAME is hidden (a grey block instead of text). Per-viewer: it is about what is
   *  on THIS screen — a shared one, a recording — not a fact about the work. */
  hiddenUserGroups: string[]
}

export const DEFAULT_ASIDE_GROUP_PREFS: AsideGroupPrefs = {
  groupBy: 'project', order: {}, collapsed: [], cardColor: 'wash', collapsedUserGroups: [],
  sort: DEFAULT_ORDER, hiddenUserGroups: [],
}

/** Total: anything that is not a known key and direction reads as the default. */
export function readSessionSort(v: unknown): SessionOrder {
  if (!v || typeof v !== 'object') return DEFAULT_ORDER
  const o = v as Record<string, unknown>
  const by = (SESSION_SORTS as readonly string[]).includes(o.by as string) ? (o.by as SessionOrder['by']) : DEFAULT_ORDER.by
  const dir = o.dir === 'asc' || o.dir === 'desc' ? o.dir : DEFAULT_ORDER.dir
  return { by, dir }
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
      collapsedUserGroups: Array.isArray(p.collapsedUserGroups)
        ? p.collapsedUserGroups.filter((x): x is string => typeof x === 'string')
        : [],
      sort: readSessionSort(p.sort),
      hiddenUserGroups: Array.isArray(p.hiddenUserGroups)
        ? p.hiddenUserGroups.filter((x): x is string => typeof x === 'string')
        : [],
    }
  } catch { return DEFAULT_ASIDE_GROUP_PREFS }
}

export function writeAsideGroupPrefs(patch: Partial<AsideGroupPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAsideGroupPrefs(), ...patch }))
  } catch { /* storage unavailable — the arrangement lasts this visit and no longer */ }
}
