/**
 * sessionsAsidePrefs.ts — how the Sessions workspace's aside arranges its own list.
 *
 * A CHOICE, so it lives on the SERVER (`/api/user-prefs`, `sessionsAside`, through
 * `sharedPref.ts`) and reads the same on every device (owner, 2026-09-30: "o estilo das sessões
 * listadas no aside"). It used to be `localStorage` because on a central `preferences.json` is
 * shared by every signed-in user; `/api/user-prefs` is per ACCOUNT there, so one person's collapsed
 * groups still never collapse them for the team. The browser copy under the same key is the first
 * paint and the one-time migration source.
 *
 * Every read and write is guarded: a private window, cleared site data, or blocked storage makes
 * the accessor throw, and an aside that will not render because it could not remember its
 * arrangement is worse than one that opens on the defaults.
 */

import { useMemo, useSyncExternalStore } from 'react'
import { createPersonalDoc } from './sharedPref'
import { DEFAULT_ORDER, SESSION_SORTS, type SessionOrder } from '@agentistics/tui/control/session-order'
import { isAsideTab, type AsideTab } from './asideTabs'

const doc = createPersonalDoc('agentistics-sessions-aside-v1', 'sessionsAside')

/** Fires when the arrangement changes — here or, after a load, on another device. */
export const subscribeAsideGroupPrefs = (fn: () => void): (() => void) => doc.subscribe(fn)

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
  /** Collapsed USER groups (`sessionUserGroups.ts`), keyed by the group's own id. Part of the
   *  arrangement, so it travels with the rest of this document (server-side since 2026-10-01).
   *  Membership itself is a separate store (`sessionUserGroups.ts`). */
  collapsedUserGroups: string[]
  /** What the sessions INSIDE each group are ordered by (the cockpit's own `SessionOrder`, so the two
   *  surfaces answer "sort by recent" the same way). The default is the one that puts what is
   *  blocked on you first — the reason the list exists. Per-viewer, like the rest of the arrangement. */
  sort: SessionOrder
  /** User groups whose NAME is hidden (a grey block instead of text). Per-viewer: it is about what is
   *  on THIS screen — a shared one, a recording — not a fact about the work. */
  hiddenUserGroups: string[]
  /** Is the "Fixadas" (pinned) section itself folded — separate from any one row inside it. */
  foldedPinned: boolean
  /** Is the "Grupos" section itself folded — hides every top-level folder (the heading and "Novo
   *  grupo" stay, so a folder can still be added without unfolding first), distinct from any one
   *  folder's own fold (`collapsedUserGroups`). */
  foldedGroupsSection: boolean
  /** Folders whose "Ended (N)" block is EXPANDED — absent means collapsed (the default). */
  expandedEndedGroups: string[]
  /** Has the person ever picked a sort? Until then folders keep their drag order. */
  sortExplicit: boolean
  /** Show only the sessions whose role is "leader" (`leadersFilter.ts`). A FILTER, persisted like the
   *  rest of how this person reads the list — pins stay and folders keep their place. */
  leadersOnly: boolean
  /** Which of the three tabs (Ativas | Grupos | Encerradas) the aside — and the rail — shows. */
  tab: AsideTab
  /** Leader teams folded in Ativas, keyed by the leader's identity key (`sessionIdentityKey`). */
  foldedTeams: string[]
}

export const DEFAULT_ASIDE_GROUP_PREFS: AsideGroupPrefs = {
  groupBy: 'project', order: {}, collapsed: [], cardColor: 'wash', collapsedUserGroups: [],
  sort: DEFAULT_ORDER, hiddenUserGroups: [], foldedPinned: false, foldedGroupsSection: false,
  expandedEndedGroups: [], sortExplicit: false, leadersOnly: false, tab: 'active', foldedTeams: [],
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

/**
 * The key a whole BAND (Ativas / Inativas) is folded under, in the same `collapsed` list as its
 * sub-groups. It cannot collide with `collapseKey` — that one always has three `:`-separated parts.
 */
export function bandCollapseKey(band: AsideBandId): string {
  return `band:${band}`
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

function sortDiffersFromDefault(o: SessionOrder): boolean {
  return o.by !== DEFAULT_ORDER.by || o.dir !== DEFAULT_ORDER.dir
}

export function readAsideGroupPrefs(): AsideGroupPrefs {
  return parseAsideGroupPrefs(doc.get())
}

/** PURE: a stored arrangement (already JSON-parsed) as `AsideGroupPrefs`. Total — junk yields the
 *  defaults, field by field. */
export function parseAsideGroupPrefs(stored: unknown): AsideGroupPrefs {
  try {
    if (!stored || typeof stored !== 'object') return DEFAULT_ASIDE_GROUP_PREFS
    const p = stored as Record<string, unknown>
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
      foldedPinned: p.foldedPinned === true,
      foldedGroupsSection: p.foldedGroupsSection === true,
      // A stored sort that is not the default, from before the flag existed, WAS a choice.
      sortExplicit: typeof p.sortExplicit === 'boolean' ? p.sortExplicit : sortDiffersFromDefault(readSessionSort(p.sort)),
      leadersOnly: p.leadersOnly === true,
      tab: isAsideTab(p.tab) ? p.tab : DEFAULT_ASIDE_GROUP_PREFS.tab,
      foldedTeams: Array.isArray(p.foldedTeams)
        ? p.foldedTeams.filter((x): x is string => typeof x === 'string')
        : [],
      expandedEndedGroups: Array.isArray(p.expandedEndedGroups)
        ? p.expandedEndedGroups.filter((x): x is string => typeof x === 'string')
        : [],
    }
  } catch { return DEFAULT_ASIDE_GROUP_PREFS }
}

export function writeAsideGroupPrefs(patch: Partial<AsideGroupPrefs>): void {
  try {
    doc.set({ ...readAsideGroupPrefs(), ...patch } as unknown as Record<string, unknown>)
  } catch { /* storage unavailable — the arrangement lasts this visit and no longer */ }
}

/**
 * PURE: how many of the list's arrangement options differ from the default — the count the arrange
 * button wears, so a list that is quietly grouped, sorted or missing folders says so on the button
 * that changes it. One per OPTION, never per value: a manual group order is one change however many
 * groups it moved, and hidden folders are one change however many are hidden.
 */
export function arrangeChangedCount(o: {
  groupBy: AsideGroupBy
  sort: SessionOrder
  cardColor: AsideCardColor
  /** The manual group order for the CURRENT dimension (empty = automatic). */
  order: readonly string[]
  hiddenFolders: number
}): number {
  const d = DEFAULT_ASIDE_GROUP_PREFS
  return [
    o.groupBy !== d.groupBy,
    o.sort.by !== d.sort.by || o.sort.dir !== d.sort.dir,
    o.order.length > 0,
    o.cardColor !== d.cardColor,
    o.hiddenFolders > 0,
  ].filter(Boolean).length
}

/** Is the leaders-only filter on — followed live, so the Filtros badge in App and the aside agree. */
export function useLeadersOnly(): boolean {
  return useSyncExternalStore(subscribeAsideGroupPrefs, () => readAsideGroupPrefs().leadersOnly, () => false)
}

/** The aside's current tab — followed live, so the open aside and the 64px rail always agree. */
export function useAsideTab(): AsideTab {
  return useSyncExternalStore(subscribeAsideGroupPrefs, () => readAsideGroupPrefs().tab, () => DEFAULT_ASIDE_GROUP_PREFS.tab)
}

/** The folded leader teams, joined so the snapshot is a stable primitive for `useSyncExternalStore`. */
export function useFoldedTeams(): readonly string[] {
  const joined = useSyncExternalStore(subscribeAsideGroupPrefs, () => readAsideGroupPrefs().foldedTeams.join('\u0000'), () => '')
  return useMemo(() => (joined === '' ? [] : joined.split('\u0000')), [joined])
}

/** Fold or unfold one leader's team (shared by the open aside and the rail). */
export function toggleFoldedTeam(key: string): void {
  const cur = readAsideGroupPrefs().foldedTeams
  writeAsideGroupPrefs({ foldedTeams: cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key] })
}
