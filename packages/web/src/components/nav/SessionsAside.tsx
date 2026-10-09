/**
 * SessionsAside — the fleet, in the sidebar's body.
 *
 * It arranges NOTHING itself. Grouping, ordering and search all come from
 * `@agentistics/tui/control/session-fleet` — the very module the terminal cockpit resolves them
 * with — because two implementations of "which band does this row belong to" is exactly the defect
 * this whole branch exists to remove. What this file owns is the drawing.
 *
 * The list is the FLEET, not the stored history: it shows a session that is running with no stored
 * conversation behind it (an `external` assistant, a `lost` row after a reboot, one started a moment
 * ago), which the old page could not, because it listed metrics and hung the fleet off them as
 * decoration.
 */

import { applySummaryFilter, capacityText, summaryCounts, summaryParts, toggleSummaryPart, type SummaryPart } from '../../lib/asideSummary'
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { blurAfterDrag } from '../../lib/dragCleanup'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getActivePane } from '../../lib/paneScope'
import { openBeside, openInPane, readSplitRoute, splitHref } from '../../lib/splitRoute'

import {
  BellOff, ChevronDown, ChevronRight, Clock, Filter, Folder, FolderPlus, GripVertical, MoreVertical, Pin,
  PinOff, Plus, RotateCcw, Search, Send, SquareArrowOutUpRight, X,
} from 'lucide-react'
import type { Filters } from '@agentistics/core'
import {
  ACTIVE_STATES, filterSessions, sessionNotify,
  type ControlSession, type SessionGroup, type SessionState,
} from '@agentistics/tui/control/session-fleet'
import { asideGroups, showsGroupHeadings } from '../../lib/fleetGroups'
import {
  bandCollapseKey, collapseKey, readAsideGroupPrefs, writeAsideGroupPrefs, subscribeAsideGroupPrefs, arrangeChangedCount,
  type AsideBandId, type AsideCardColor, type AsideGroupBy,
} from '../../lib/sessionsAsidePrefs'
import { sessionCardStyle, STATE_COLOR } from '../../lib/sessionCardStyle'
import { SessionsGroupMenu } from './SessionsGroupMenu'
import type { SessionOrder } from '@agentistics/tui/control/session-order'
import { displayName, toggleHidden } from '../../lib/groupNameMask'
import { folderFold } from '../../lib/folderFold'
import { ATTN_BAR_CLASS, ATTN_COUNT_CLASS, attentionCount, attentionIds, pruneDismissed } from './AttentionDot'
import { rowSelected } from '../../lib/fleetSelection'
import { filterFleet, ignoredDimensions } from '../../lib/fleetFilter'
import { NewSessionModal } from '../sessions/NewSessionModal'
import { claimOrphanWizard, onWizardOrphaned } from '../../lib/newSessionWizardStore'
import { SessionPickModal } from '../sessions/SessionPickModal'
import { IdleReviewCard } from '../sessions/IdleReviewCard'
import { PendingSessionCard } from '../sessions/PendingSessionCard'
import { markSessionPending, reconcilePendingSessionsNow } from '../../lib/pendingSessionStore'
import { reopeningLabel, useReopening, withReopening } from '../../lib/reopeningStore'
import { buildPickRows } from '../../lib/sessionPick'
import { NOTIFY_TOGGLE, mutedTooltip, notifyMenuExtras, useMutedKeys } from '../../lib/notifyMenu'
import { toggleSessionMuted } from '../../lib/mutedSessions'
import { mutedSessionRows } from '../../lib/mutedSessionList'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { rowMenuEntries, taskMenuEntries, LINK_TASK, UNLINK_TASK, type MenuEntry, type RowVerb } from '../../lib/rowMenu'
import { SessionRowMenu } from '../sessions/SessionRowMenu'
import { RenameSessionDialog } from '../sessions/RenameSessionDialog'
import { SessionFiling } from '../tasks/SessionFiling'
import { boardCopy } from '../tasks/copy'
import { attachSession, detachSession } from '../../lib/tasks'
import { SessionFacts } from '../sessions/SessionFacts'
import { reopenedSessionRoute, sessionPath } from '../../lib/sessionRoute'
import {
  MAX_PINNED, getPinnedIds, movePinnedSession, pinnedServerSnapshot, resolvePinnedRows,
  subscribePinnedSessions, togglePinnedSession,
} from '../../lib/pinnedSessions'
import { fellGroupDismissed, readDismissedFell, writeDismissedFell, subscribeDismissedFell } from '../../lib/fellDismissal'
import { endDispatch, tryBeginDispatch } from '../../lib/dispatchGuard'
import { sessionIdentityKey } from '../../lib/sessionIdentity'
import {
  type NestRefusal, type SessionUserGroup,
  canNestGroup, createSessionGroup, deleteSessionGroup, getSessionGroups, moveSessionToGroup,
  nestSessionGroup, removeSessionFromGroup, renameSessionGroup, reorderSessionGroups,
  reorderSessionInGroup, resolveGroupRows, sessionGroupsServerSnapshot, stepSessionGroup, folderSessionCount, folderCountLabel, listNarrowed,
  subscribeSessionGroups, setSessionGroupHidden, groupConcealed, hiddenGroups as hiddenFoldersOf,
} from '../../lib/sessionUserGroups'
import {
  hasDragPayload, hasGroupDragPayload, hasGroupNestDragPayload, readDragPayload, readGroupDragPayload,
  readGroupNestDragPayload, setDragPayload, setGroupDragPayload, setGroupNestDragPayload,
} from '../../lib/dragReorder'
import { groupDropOutcome } from '../../lib/sessionGroupDrag'
import { ConfirmModal } from '../../pages/settings/primitives'
// The SAME visual language the subtask board already uses for a group and its members reading as
// one unit (continuous left accent bar + shared tint, header down through the last row) — reused
// rather than invented a second time for user session groups.
import { CLUSTER_ACCENT, CLUSTER_TINT } from '../tasks/subtaskGroups'
import { NAY_UNDOCK_SESSION, requestUndockSession, withUndockEntry } from '../../lib/nayDockBridge'
import { AgentisticsLoader } from '../AgentisticsLoader'

/** The row menu's client-side "open beside" entry — see `openSessionBeside`. */
const OPEN_BESIDE = '__open_beside__'

export interface SessionsAsideProps {
  lang: 'pt' | 'en'
  /** THE CAPACITY HOOK: when a source of "N/M vagas" exists it is passed here; absent draws nothing. */
  capacity?: { used: number; max: number } | null
  rows: readonly ControlSession[]
  finishedTasks: readonly string[]
  /** True until the first poll answers — an empty list before then is "not asked yet". */
  loading: boolean
  /** This machine may not be asked at all: a central, or a profile with no host power. */
  unsupported: boolean
  /** Already-localized reason the list may not be the whole truth. */
  unavailable?: string
  /**
   * The SAME filters the dashboard's header uses — harness/project/repo/model narrow the fleet
   * too now (see `filterFleet.ts`); every other dimension there (date range, tags, members…) is
   * read only where a live row can actually answer it, which today is none of them. Owned by
   * `App.tsx`, not here: the control that edits it (`FiltersBar`, in the shared sticky header) is
   * a sibling of this aside, not a child of it.
   */
  filters: Filters
  /**
   * The fleet's OWN "only what is running" switch — not part of `Filters` (see `fleetFilter.ts`'s
   * header), and also owned by `App.tsx` now so the SAME control in the header can default it ON
   * for this workspace and OFF for the dashboard. This aside only reads it.
   */
  activeOnly: boolean
  /**
   * Already-worded reason the list may not be current (`fleetStale.ts`), or null when it is.
   *
   * Rendered whether or not the list is empty, which is what separates it from `EmptyReason`: the
   * case it exists for is rows on screen that are no longer true.
   */
  stale?: string | null
  /**
   * What clicking a row does, when it is not "open it on THIS machine".
   *
   * The central's Sessions page draws the very same list for a machine's RELAYED rows, where
   * `/sessions/:id` would open a local session that does not exist here. Absent on a machine,
   * where the route is exactly right.
   */
  onOpenRow?: (row: ControlSession) => void
  /**
   * Withholds "New session".
   *
   * Starting one is a LOCAL act (`POST /api/fleet/new` spawns a process on the host), so a central
   * drawing this list for someone else's machine must not offer it — a button whose only outcome
   * is a refusal is a button that teaches the wrong thing.
   */
  hideNew?: boolean
  /**
   * The fleet's own verb-carrying rows, keyed by id — for the row's context menu (Task 6).
   *
   * Absent on a surface that cannot act (a central relaying a machine that has not granted the
   * screen/action switches yet): the menu is then not opened at all, rather than opened inert.
   */
  rowsById?: Map<string, {
    verbs: RowVerb[]
    /** This row is one of the sessions the machine TOOK — see the server's `FleetRow.fell`. */
    fell?: boolean
    title?: string
    project?: string
    cwd?: string
    /** Already localized by the server — the word the fleet list prints for this row's state. */
    stateLabel?: string
  }>
  /** Performs a verb. Absent exactly where `rowsById` is absent. */
  act?: (req: {
    id: string
    action: string
    text?: string
    /** Narrows a GROUP verb (`reopenFell`, `broadcast`). Absent = the whole group. */
    ids?: readonly string[]
  }) => Promise<{ ok: boolean; message: string; id?: string }>
  /**
   * THE FILTROS TRIGGER (design item 4) — "Filtros na linha de botões da lista, visível também
   * com ela minimizada". `App.tsx` owns the open/close state and the panel itself; this aside only
   * carries the BUTTON, the same read-only relationship it already has with `filters`/`activeOnly`
   * above. `filtersButtonRef` is how the caller measures where to anchor the panel.
   *
   * ALL FOUR ABSENT on the MOBILE mount (`SessionsPage.tsx`'s own "Sessions" tab) — a phone already
   * has its own complete Filtros mechanism there (`filterButton` + `filtersSheet`, a full-screen
   * sheet over the SAME `filters`/`activeOnly` state), so a second trigger in this row would be a
   * second, disagreeing way to open filtering on one screen. The button below renders only when
   * `onToggleFilters` is given, which is exactly the desktop mount.
   */
  filtersOpen?: boolean
  filtersCount?: number
  onToggleFilters?: () => void
  filtersButtonRef?: (el: HTMLButtonElement | null) => void
  /**
   * A session this aside just CREATED — reported instead of navigating to `/sessions/:id`, for a
   * mount that is not the sessions workspace (the Nay chat's "Sessões" tab opens it in its own
   * panel). Absent: the workspace behaviour, straight into the new session's route.
   */
  onCreated?: (id: string) => void
  /** The session this mount has open, where that is not the route's — see `onCreated`. */
  selectedId?: string
  /**
   * Given, every row carries a SEPARATE "Go to session" button that calls this with the row's id —
   * for a mount whose row click opens the session somewhere other than the workspace (the Nay
   * dock's Sessões tab). Absent (the workspace itself), rows carry no such button: there, the row
   * click already IS going to the session.
   */
  onGoToSession?: (id: string) => void
}

/**
 * How a row reaches `onGoToSession` without threading it through every band, group and pinned
 * list between the aside and `SessionRow`. `null` = no button.
 */
const GoToSessionContext = createContext<((id: string) => void) | null>(null)

/**
 * What a pin — and a user group (`sessionUserGroups.ts`) — are stored under.
 *
 * `sessionIdentityKey`: the CONVERSATION where the harness reports one, because a managed row's id
 * is its tmux session name and is minted fresh on every reopen — keying by that would unpin (or
 * un-group) a conversation at exactly the moment somebody who filed it wants it back. Where no
 * conversation link can ever exist (codex, kimi, gemini, agy — see `conversationBlind`) the row id
 * is the only key there is, and a reopen of one of THOSE sessions genuinely orphans the record —
 * see `sessionIdentity.ts`'s own header.
 */
const pinKeyOf = sessionIdentityKey

/**
 * The row menu's group-related entries — CLIENT-SIDE, like `link-task`: they open a picker or act
 * locally rather than resolving a server verb, so there is nothing for `rowMenuEntries` to have
 * composed. `undefined` when the row itself cannot be found (a stale menu over a row that just
 * disappeared from the fleet).
 */
function groupMenuExtras(
  row: ControlSession | undefined,
  groupOfKey: ReadonlyMap<string, string>,
  pt: boolean,
): MenuEntry[] {
  if (!row) return []
  const extras: MenuEntry[] = [
    { action: 'move-to-group', label: pt ? 'Mover para grupo…' : 'Move to group…', enabled: true },
  ]
  if (groupOfKey.has(pinKeyOf(row))) {
    extras.push({ action: 'remove-from-group', label: pt ? 'Remover do grupo' : 'Remove from group', enabled: true })
  }
  return extras
}

/** The row menu's notification entry — see `notifyMenuExtras`. Kept beside `groupMenuExtras`, which it
 *  is modelled on: both are client-side entries `rowMenuEntries` takes as `extra`. */
const notifyExtras = notifyMenuExtras

export function SessionsAside({
  lang, capacity, rows, loading, unsupported, unavailable, filters, activeOnly, finishedTasks, stale,
  onOpenRow, hideNew, rowsById, act, filtersOpen, filtersCount, onToggleFilters, filtersButtonRef,
  onCreated, selectedId, onGoToSession,
}: SessionsAsideProps) {
  const pt = lang === 'pt'
  const mutedKeys = useMutedKeys()
  const mutedRows = useMemo(() => mutedSessionRows(rows, mutedKeys), [rows, mutedKeys])
  const navigate = useNavigate()
  // 44px is the MOBILE figure. Applying it on desktop turns a compact list into a row of buttons.
  const isMobile = useIsMobile()
  const tap = isMobile ? 44 : undefined
  const { sessionId: routeSessionId } = useParams()
  const sessionId = selectedId ?? routeSessionId
  /**
   * THE SPLIT VIEW (`lib/splitRoute.ts`). With two sessions open, a pick from this list replaces
   * the one in the pane the person is working in (`getActivePane`) and keeps the other; "Abrir ao
   * lado" puts a session in the right-hand pane. A phone never splits, so there it is the plain
   * route, as it always was.
   */
  const [routeSearch] = useSearchParams()
  const openSessionRoute = (id: string) => {
    const route = readSplitRoute(routeSessionId, routeSearch)
    if (isMobile || route.split === null) { navigate(sessionPath(id)); return }
    navigate(splitHref(openInPane(route, id, getActivePane()), routeSearch))
  }
  const openSessionBeside = (id: string) => {
    navigate(splitHref(openBeside(readSplitRoute(routeSessionId, routeSearch), id), routeSearch))
  }
  const [query, setQuery] = useState('')
  const [mutedPopover, setMutedPopover] = useState<{ x: number; y: number } | null>(null)
  const mutedButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!mutedPopover) return
    const close = (e: MouseEvent) => {
      if (mutedButtonRef.current?.contains(e.target as Node)) return
      setMutedPopover(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [mutedPopover])
  /** The summary line's own filter ("3 ativas · 2 trabalhando · 1 precisa de você"). Memory only. */
  const [summaryFilter, setSummaryFilter] = useState<SummaryPart | null>(null)
  const [creating, setCreating] = useState(false)
  // A layout swap unmounted the open wizard: take it over (see `newSessionWizardStore`).
  useEffect(() => {
    const adopt = () => { if (claimOrphanWizard()) setCreating(true) }
    adopt()
    return onWizardOrphaned(adopt)
  }, [])
  /**
   * The aside's own arrangement — which dimension it sub-groups by, the manual order per
   * dimension, which groups are folded, and how a card shows its status. Seeded on mount and
   * RE-SEEDED when the server's copy lands (see the effect after `hiddenGroups`) — it is a choice
   * that lives server-side, see `sessionsAsidePrefs.ts`.
   */
  const storedGroupPrefs = useMemo(readAsideGroupPrefs, [])
  const [groupBy, setGroupByState] = useState<AsideGroupBy>(storedGroupPrefs.groupBy)
  const setGroupBy = (v: AsideGroupBy) => { setGroupByState(v); writeAsideGroupPrefs({ groupBy: v }) }
  // How the sessions INSIDE each group are ordered. Per-viewer, like the rest of the arrangement.
  const [sortOrder, setSortOrderState] = useState<SessionOrder>(storedGroupPrefs.sort)
  const setSortOrder = (v: SessionOrder) => { setSortOrderState(v); writeAsideGroupPrefs({ sort: v }) }
  const [groupOrder, setGroupOrderState] =
    useState<Partial<Record<AsideGroupBy, string[]>>>(storedGroupPrefs.order)
  const setGroupOrder = (by: AsideGroupBy, keys: string[]) => {
    const next = { ...groupOrder, [by]: keys }
    setGroupOrderState(next)
    writeAsideGroupPrefs({ order: next })
  }
  const [foldedGroups, setFoldedGroupsState] = useState<Set<string>>(new Set(storedGroupPrefs.collapsed))
  // Sessions whose "waiting on you" dot the reader dismissed on a folded group. Deliberately MEMORY
  // ONLY: a restart or a reload starts fresh, which is the point — it answers "I saw this", not
  // "stop telling me". And it is pruned per session the moment that session stops waiting, so the
  // next time it asks, the dot is back.
  const [dismissedAttn, setDismissedAttn] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => { setDismissedAttn(prev => pruneDismissed(prev, rows)) }, [rows])
  // A session the aside is watching for RESOLVES the moment its id (or its conversation id — a
  // spawn can hand back either) appears in this very poll. Run from BOTH mounts of this component:
  // it is the same pure reconcile over the same store, so two mounts converge to one answer rather
  // than disagreeing about it. See `pendingSessionStore.ts`'s own header.
  useEffect(() => {
    const present = new Set<string>()
    for (const r of rows) {
      present.add(r.id)
      if (r.conversationId) present.add(r.conversationId)
    }
    reconcilePendingSessionsNow(present)
  }, [rows])
  const dismissAttn = (ids: readonly string[]) => setDismissedAttn(prev => new Set([...prev, ...ids]))
  const toggleGroupFold = (key: string) => {
    const next = new Set(foldedGroups)
    next.has(key) ? next.delete(key) : next.add(key)
    setFoldedGroupsState(next)
    writeAsideGroupPrefs({ collapsed: [...next] })
  }
  const [cardColor, setCardColorState] = useState<AsideCardColor>(storedGroupPrefs.cardColor)
  const setCardColor = (v: AsideCardColor) => { setCardColorState(v); writeAsideGroupPrefs({ cardColor: v }) }
  /** Which GROUP modal is open, if any. Both are the one picker — see `SessionPickModal`. */
  const [picking, setPicking] = useState<'reopen' | 'send' | null>(null)
  const [groupBusy, setGroupBusy] = useState(false)
  /*
   * A SECOND, SYNCHRONOUS guard against the group verb firing twice.
   *
   * `groupBusy` already disables the modal's confirm button, but that is REACT STATE: it only takes
   * effect once a render has committed, and two `click` events dispatched close enough together (a
   * fast double-click, or a stray double dispatch) can both run their handler before that render
   * lands — both would then call `act()`. The decision itself (`tryBeginDispatch`/`endDispatch`) is
   * a plain, tested function in `dispatchGuard.ts`; this ref is just the mutable box it reads and
   * writes synchronously, in the same tick the first click's handler runs.
   */
  const groupActingRef = useRef(false)
  /** The exact set of fallen ids the "reopen what fell" banner was last dismissed for — see
   *  `fellDismissal.ts`. Read once on mount; a dismiss updates it (and persists it) directly. */
  const [dismissedFell, setDismissedFell] = useState<string[] | null>(readDismissedFell)
  useEffect(() => subscribeDismissedFell(() => setDismissedFell(readDismissedFell())), [])

  /*
   * THE TWO GROUP VERBS, derived from the rows the server already shaped.
   *
   * `fell` is the machine's own crash grouping (`crash-group.ts`), which errs toward EXCLUDING: a
   * session with no evidence it was ever alive is never in it. We do not re-derive it here — a
   * second implementation of "which sessions fell together" is exactly the defect this bridge
   * exists to prevent.
   *
   * Who can receive a prompt is likewise the SERVER's answer, read off each row's own `prompt`
   * verb: it is the same resolution the cockpit acts on, and it already accounts for a session
   * that is not running and for one sitting on an open dialog (where a typed line goes into the
   * dialog's filter and the submit takes the highlighted option).
   */
  const groupRows = useMemo(
    // ONE ROW PER SESSION: `rowsById` is keyed TWICE per row on purpose (by its own id and by its
    // conversation id, so one map answers a link carrying either), and iterating its values offered
    // and counted every session that knows its conversation twice — reported as `Active 22` on a
    // machine running 11. `buildPickRows` owns the dedupe and the rest of this arithmetic.
    () => buildPickRows(rowsById ? rowsById.values() : [], pt),
    [rowsById, pt],
  )

  const canAct = Boolean(act) && !hideNew
  const fellIds = useMemo(() => groupRows.fellRows.map(r => r.id), [groupRows.fellRows])
  // Dismissing hides the banner for the EXACT group it named — the moment the machine reports a
  // different set of fallen ids (one more session fell, or one of these was reopened on its own and
  // the rest are still down), that is a new fact and the banner is shown again. See `fellDismissal.ts`.
  const fellDismissed = fellGroupDismissed(dismissedFell, fellIds)
  const showFell = canAct && groupRows.fellRows.length > 0 && !fellDismissed
  const dismissFell = () => { setDismissedFell(fellIds); writeDismissedFell(fellIds) }
  // One session is not a broadcast — the row's own composer is right there and says so better.
  const showSend = canAct && groupRows.sendable > 1
  /**
   * The pinned set, from the module that already owns it.
   *
   * `useSyncExternalStore` rather than local state because the store is shared — `RecentSessions`
   * reads the same one — and two components holding their own copy is how a pin lands in one list
   * and not the other. Its rules (a hard limit of three, the fourth REFUSED rather than silently
   * swapped) live there and are not re-decided here.
   */
  const pins = useSyncExternalStore(subscribePinnedSessions, getPinnedIds, pinnedServerSnapshot)
  const pinned = useMemo(() => new Set(pins), [pins])
  const flip = (row: ControlSession) => {
    const out = togglePinnedSession(pinKeyOf(row))
    if (!out.ok && out.reason === 'limit') {
      setNotice(pt
        ? `No máximo ${MAX_PINNED} conversas fixadas. Solte uma antes de fixar outra.`
        : `At most ${MAX_PINNED} pinned conversations. Unpin one first.`)
      return
    }
    setNotice(null)
  }
  /** No longer only about pins — the row menu's action results land here too. */
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * USER GROUPS ("Saved to later", …) — same server-side store as pins, for the same reason.
   * See `sessionUserGroups.ts`.
   */
  const groupsValue = useSyncExternalStore(subscribeSessionGroups, getSessionGroups, sessionGroupsServerSnapshot)
  /** Session identity key -> the group id holding it. A session is in at most one. */
  const groupOfKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groupsValue.groups) for (const k of g.sessionKeys) m.set(k, g.id)
    return m
  }, [groupsValue])
  const groupedKeys = useMemo(() => new Set(groupOfKey.keys()), [groupOfKey])
  /**
   * Each group's rows, resolved against the RAW fleet (never `matched`/`searched` — same rule as
   * `pinnedRows`: a group must survive a filter, a search and any session state).
   *
   * A session that is BOTH pinned and grouped shows ONCE, in the Pinned band — pinning is the
   * stronger "always in sight, always first" promise, and showing it twice would leave two bands
   * each claiming to be where it lives. It stays stored in the group; unpinning it brings it back
   * here on its own, with no action needed on the group.
   */
  const groupRowsResolved = useMemo(
    () => groupsValue.groups.map(g => ({
      group: g,
      rows: resolveGroupRows(g, rows, pinKeyOf).filter(r => !pinned.has(pinKeyOf(r))),
    })),
    [groupsValue, rows, pinned],
  )
  /** Which user-group bands are folded on THIS screen — per viewer, alongside the aside's other
   *  arrangement prefs (see `sessionsAsidePrefs.ts`). Membership itself is shared/server-side. */
  const [foldedUserGroups, setFoldedUserGroupsState] =
    useState<Set<string>>(new Set(storedGroupPrefs.collapsedUserGroups))
  const toggleUserGroupFold = (id: string) => {
    const next = new Set(foldedUserGroups)
    next.has(id) ? next.delete(id) : next.add(id)
    setFoldedUserGroupsState(next)
    writeAsideGroupPrefs({ collapsedUserGroups: [...next] })
  }
  /** Dimmed folders (nothing in them matches) the person opened on this screen — see `folderFold`. */
  const [openedDimmed, setOpenedDimmed] = useState<Set<string>>(() => new Set())
  const toggleOpenedDimmed = (id: string) => setOpenedDimmed(cur => {
    const next = new Set(cur)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  /** The "Fixadas" and "Grupos" SECTIONS themselves — distinct from any one row/folder's own fold.
   *  The owner asked that EVERYTHING in this list be collapsible, and these two headings were the
   *  two things that could not fold at all. */
  const [foldedPinned, setFoldedPinnedState] = useState(storedGroupPrefs.foldedPinned)
  const toggleFoldedPinned = () => {
    const next = !foldedPinned
    setFoldedPinnedState(next)
    writeAsideGroupPrefs({ foldedPinned: next })
  }
  const [foldedGroupsSection, setFoldedGroupsSectionState] = useState(storedGroupPrefs.foldedGroupsSection)
  const toggleFoldedGroupsSection = () => {
    const next = !foldedGroupsSection
    setFoldedGroupsSectionState(next)
    writeAsideGroupPrefs({ foldedGroupsSection: next })
  }
  /** The create-group dialog. `forKey` carries a session identity when opened from that row's
   *  "Novo grupo…" path, so submitting both creates the group AND files the session in one step. */
  const [creatingGroup, setCreatingGroup] = useState<{ forKey?: string } | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [renamingGroup, setRenamingGroup] = useState<{ id: string } | null>(null)
  const [renameGroupDraft, setRenameGroupDraft] = useState('')
  const [deletingGroup, setDeletingGroup] = useState<SessionUserGroup | null>(null)
  /** The "⋮" menu on a group's own heading (rename/delete) — reuses `SessionRowMenu`. */
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  // Groups whose name is hidden on THIS screen — see `lib/groupNameMask.ts`.
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<string>>(new Set(storedGroupPrefs.hiddenUserGroups))
  // The arrangement is server-side and the load lands after mount (or a change arrives from
  // another device on refocus): follow it, or this screen keeps the first paint until a reload.
  useEffect(() => subscribeAsideGroupPrefs(() => {
    const p = readAsideGroupPrefs()
    setGroupByState(p.groupBy)
    setSortOrderState(p.sort)
    setGroupOrderState(p.order)
    setFoldedGroupsState(new Set(p.collapsed))
    setCardColorState(p.cardColor)
    setFoldedUserGroupsState(new Set(p.collapsedUserGroups))
    setFoldedPinnedState(p.foldedPinned)
    setFoldedGroupsSectionState(p.foldedGroupsSection)
    setHiddenGroups(new Set(p.hiddenUserGroups))
  }), [])
  const toggleGroupNameHidden = (id: string) => {
    const next = toggleHidden(hiddenGroups, id)
    setHiddenGroups(next)
    writeAsideGroupPrefs({ hiddenUserGroups: [...next] })
  }
  // What the open group menu could silence: only a FOLDED group signals, so only a folded one offers it.
  const menuGroupAttnIds = groupMenu && foldedUserGroups.has(groupMenu.id)
    ? attentionIds(groupRowsResolved.find(g => g.group.id === groupMenu.id)?.rows ?? [], dismissedAttn)
    : []
  const menuGroupAttn = menuGroupAttnIds.length
  /** The "Mover para grupo…" picker opened from a session row's own context menu — also
   *  `SessionRowMenu`, listing the existing groups plus "Novo grupo…". */
  const [groupPicker, setGroupPicker] = useState<{ id: string; x: number; y: number } | null>(null)
  /** Which group heading is a live drop target, and which grouped row (for reordering within a
   *  group) — read from the native drag payload (`dragReorder.ts`), not from a dragged row's own
   *  component state, because the source can be a pinned row, an automatic-section row or another
   *  group's row: three different subtrees that share no React state of their own. */
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)
  const [groupRowDragOver, setGroupRowDragOver] = useState<string | null>(null)
  /** Which group heading is a live drop target for REORDERING THE GROUPS THEMSELVES — a distinct
   *  payload (`GROUP_DRAG_KEY_TYPE`, see `dragReorder.ts`'s own header) from a session being
   *  dropped into a group, so the two never get read as one another. */
  const [groupReorderOver, setGroupReorderOver] = useState<string | null>(null)
  /**
   * NESTING (folder inside a folder, one level max). Two independent drag zones on a folder's own
   * header decide the gesture (`sessionGroupDrag.ts`'s own header): the grip (⋮⋮) reorders — see
   * `groupReorderOver` above, unchanged — and the folder's BODY nests it into whatever it lands on.
   *
   * `draggingGroupId` is the id of the folder CURRENTLY being dragged, by either handle, tracked in
   * React state rather than read off the native event: `dataTransfer.getData()` only returns real
   * values on `drop`, never on `dragover`, so a hover preview that needs to know WHICH folder is
   * being dragged (to call `canNestGroup` before the drop happens) has nowhere else to read it from.
   *
   * `nestOverGroupId` is which folder is the live NEST drop target and whether landing there right
   * now would succeed — that `ok` is what paints it orange (whole, allowed) or red (whole, the
   * one-level rule refuses it) while the drag is over it.
   */
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)
  const [nestOverGroupId, setNestOverGroupId] = useState<{ id: string; ok: boolean } | null>(null)
  /** "Mover para pasta…" — the menu path for nesting, for a phone or a keyboard that cannot drag
   *  one heading's body onto another's. Lists every OTHER top-level folder; a folder that is
   *  itself nested is never offered as a target (it would always fail `target_is_nested`). */
  const [groupParentPicker, setGroupParentPicker] = useState<{ id: string; x: number; y: number } | null>(null)
  /** The refusal shown after a blocked nest — from a drop, or from "Mover para pasta…" on a folder
   *  that already has a child of its own, where EVERY target would fail the same way. Never a
   *  silent no-op: the owner asked for a clear warning naming which rule stopped it. */
  const [nestWarning, setNestWarning] = useState<NestRefusal | null>(null)
  /** A nest a drop (or the menu) is ABOUT to make, held for confirmation before it is applied —
   *  reported after a whole afternoon's worth of folders landing inside each other by accident
   *  ("eu movi um monte de pasta uma pra dentro da outra sem querer"). Only a VALID nest reaches
   *  this state (an invalid one goes straight to `nestWarning`, above); nothing is written to the
   *  store until the confirm button is pressed. */
  const [pendingNest, setPendingNest] = useState<{ childId: string; childName: string; parentId: string; parentName: string } | null>(null)
  /** Which pinned row is being dragged, and which one it is hovering over — by the row's own pin
   *  KEY, never its position in this (filtered) list. See `pinnedSessions.ts`'s `planPinMoveTo` for
   *  why a filtered-list index was the actual §6 bug: `pinnedRows` is the RESOLVED, filtered view,
   *  and the persisted, RAW pin list can hold entries that do not resolve to any row here — so a
   *  drag from filtered index 0 to filtered index 2 is not the same move as raw index 0 to raw index
   *  2 the moment anything ahead of them fails to resolve. Local: a drag is not shared state. */
  const [dragFrom, setDragFrom] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  /*
   * THE END OF ANY DRAG CLEARS EVERY DRAG HIGHLIGHT — see `dragCleanup.ts`. A drop handled by a
   * member row stops propagation, so the folder it landed in never cleared its own orange; this
   * does, for every highlight at once. Deferred a tick so the specific drop handler runs first, and
   * on `drop` as well as `dragend` because a row that MOVED to another folder unmounts, and a
   * detached node's `dragend` never reaches the window.
   */
  useEffect(() => {
    const done = () => {
      setTimeout(() => {
        setDragOverGroupId(null); setGroupRowDragOver(null); setGroupReorderOver(null)
        setNestOverGroupId(null); setDraggingGroupId(null); setDragFrom(null); setDragOver(null)
        const el = document.activeElement as HTMLElement | null
        if (el && el.matches?.(':focus-visible') && blurAfterDrag(el)) el.blur()
      }, 0)
    }
    window.addEventListener('drop', done, true)
    window.addEventListener('dragend', done, true)
    return () => {
      window.removeEventListener('drop', done, true)
      window.removeEventListener('dragend', done, true)
    }
  }, [])
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; state: string; verbs: RowVerb[] } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  /** The task picker, anchored where the menu was — see `pickMenuAction`. */
  const [linking, setLinking] = useState<{ id: string; x: number; y: number } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  /**
   * AUTO-SCROLL WHILE DRAGGING. Native HTML5 drag-and-drop does not scroll a container on its own —
   * dragging a folder or session near the top/bottom edge of this list, with the actual drop target
   * (another folder, the "Grupos" heading) scrolled out of view, could not physically reach it at
   * all. Reported as "não consigo mover pra cima" / "não tá tirando ela de dentro" on a machine
   * whose folder list runs into the thousands of pixels once a busy folder is expanded — the drag
   * itself was correct; there was nothing wrong to fix there. `onDragOverCapture` (not `onDragOver`)
   * so this runs on the way DOWN to whatever specific row or folder is under the pointer, before
   * that element's own handler can `stopPropagation()` on the way back up — auto-scroll must not
   * depend on which particular child the drag happens to be hovering.
   */
  const asideScrollRef = useRef<HTMLDivElement>(null)
  const autoScrollDuringDrag = (e: { clientY: number }) => {
    const el = asideScrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const EDGE = 56
    const SPEED = 18
    if (e.clientY < rect.top + EDGE) el.scrollTop -= SPEED
    else if (e.clientY > rect.bottom - EDGE) el.scrollTop += SPEED
  }

  const openMenu = (session: ControlSession, x: number, y: number, verbs: RowVerb[]) => {
    setMenu({ x, y, id: session.id, state: session.state, verbs })
  }

  const pickMenuAction = (action: string) => {
    if (!menu) return
    const { id } = menu
    if (action === NAY_UNDOCK_SESSION) {
      requestUndockSession(id)
      setMenu(null)
      return
    }
    if (action === OPEN_BESIDE) {
      openSessionBeside(id)
      setMenu(null)
      return
    }
    if (action === UNLINK_TASK) {
      setMenu(null)
      void detachSession(id, id).then(() => setNotice(boardCopy(lang).unfiled))
      return
    }
    if (action === LINK_TASK) {
      // The picker is anchored where the menu was, so the gesture stays in one place on screen.
      setLinking({ id, x: menu.x, y: menu.y })
      setMenu(null)
      return
    }
    if (action === 'rename') {
      const target = rows.find(r => r.id === id)
      setRenaming({ id, title: target?.title ?? '' })
      return
    }
    if (action === 'move-to-group') {
      // Anchored where the menu was, same as `link-task` — the gesture stays in one place.
      setGroupPicker({ id, x: menu.x, y: menu.y })
      setMenu(null)
      return
    }
    if (action === NOTIFY_TOGGLE) {
      const target = rows.find(r => r.id === id)
      if (target) toggleSessionMuted(pinKeyOf(target))
      setMenu(null)
      return
    }
    if (action === 'remove-from-group') {
      const target = rows.find(r => r.id === id)
      if (target) removeSessionFromGroup(pinKeyOf(target))
      setMenu(null)
      return
    }
    if (!act) return
    const call = () => act({ id, action })
    void (action === 'resume' ? withReopening([id], call) : call()).then(out => {
      setNotice(out.message)
      // A REOPEN LANDS SOMEWHERE, here too. It retires the row it was asked about, so a reader
      // sitting on that row is left on an id the next poll drops — and this handler kept only the
      // message. The row it came FROM names the wait; see `reopenedSessionRoute`.
      if (out.ok && action === 'resume' && out.id) {
        const from = rows.find(r => r.id === id)
        const r = reopenedSessionRoute(out.id, from ? { id, harness: from.harness, title: from.title } : { id })
        navigate(r.path, r.options)
      }
    })
  }

  // The top bar's magnifier focuses this field. An event rather than a prop because the button and
  // the field are in two different subtrees, and threading a ref through the whole shell to join
  // them would put layout plumbing in every component between.
  useEffect(() => {
    const focus = () => searchRef.current?.focus()
    window.addEventListener('agentistics:focus-session-search', focus)
    return () => window.removeEventListener('agentistics:focus-session-search', focus)
  }, [])

  // `now` is read once per arrangement rather than per row: two rows landing either side of midnight
  // during one render would be banded against two different "today"s.
  const active = useMemo(() => new Set<string>(ACTIVE_STATES), [])
  // `filterFleet` owns harness/project/repo/model AND `activeOnly`, but the switch needs its OWN
  // withheld count (see `hidden` below) independent of the value filters, so it is applied here as
  // an ordinary array filter rather than through `activeOnly: true`.
  const valueFiltered = useMemo(
    () => filterFleet({ rows, filters, activeOnly: false }).rows,
    [rows, filters],
  )
  const searched = useMemo(() => filterSessions(valueFiltered, query), [valueFiltered, query])
  const capacityLabel = capacityText(capacity, pt)
  // Native sessions are ordinary fleet rows now (UI.UNIFY, `nativeFleetRow.ts`): they are in
  // `searched` like every other harness, so the summary counts them through the same rule.
  const summaryNumbers = useMemo(() => summaryCounts(searched), [searched])
  const matched = useMemo(
    () => applySummaryFilter(activeOnly ? searched.filter(r => active.has(r.state)) : searched, summaryFilter),
    [searched, activeOnly, active, summaryFilter],
  )
  /** How many rows the switch is withholding, so the row can say what turning it off would show. */
  const hidden = useMemo(
    () => (activeOnly ? searched.filter(r => !active.has(r.state)).length : 0),
    [searched, activeOnly, active],
  )
  /*
   * THE FOLDERS FOLLOW THE LIST (owner, 2026-09-29). They were resolved against the raw fleet so a
   * folder would survive a filter — and so a search for "Líder" left every folder showing everything
   * while the rest of the list narrowed. Now what a folder DRAWS is cut by the very same pipeline as
   * the list (value filters → search → active only); `groupRowsResolved` stays whole for the TOTAL
   * in the header (`3/61`) and for the menu's attention count.
   */
  const narrowing = summaryFilter !== null || listNarrowed({ activeOnly, query, valueFiltered: valueFiltered.length, total: rows.length })
  const groupRowsShown = useMemo(() => {
    if (!narrowing) return groupRowsResolved
    const ids = new Set(matched.map(r => r.id))
    return groupRowsResolved.map(e => ({ ...e, rows: e.rows.filter(r => ids.has(r.id)) }))
  }, [narrowing, matched, groupRowsResolved])
  const searching = query.trim() !== ''
  /** Which SET filter dimensions this fleet cannot answer at all, said in one line — never silent. */
  const ignoredNote = useMemo(() => ignoredDimensions(filters, lang), [filters, lang])

  /** The pinned rows, in the order they were pinned. Their own band, above everything. */
  // Resolved from the RAW `rows`, never from `matched` — a filter, a search or "active only" must
  // never remove a row from the pinned band (see the header comment, and `resolvePinnedRows`'s
  // own). Reading from `matched` was the bug: it is already cut by `activeOnly` (on by default
  // here), so a pinned session that finished while the person was away vanished from the band the
  // moment its state left `ACTIVE_STATES` — no reload needed, just the ordinary case of a pinned
  // session finishing.
  const pinnedRows = useMemo(() => resolvePinnedRows(pins, rows, pinKeyOf), [pins, rows])

  /**
   * TWO bands — Active and Inactive.
   *
   * A picker for the cockpit's other dimensions (day/repo/project/task/harness/model) was built,
   * shipped and then REMOVED at the user's request: it read as another filter sitting beside the
   * real ones, and nobody asked the list to be arranged seven ways. What the list is for is what
   * is running, ranked by what needs you most, and everything else beneath it.
   *
   * `DEFAULT_ORDER` (`state`, via `sessionRank`) is the SAME ranking the terminal cockpit breaks
   * ties on, so "sorted by status" means one thing in both places — `asideGroups` applies it
   * inside each sub-group and orders the groups themselves by their most urgent member.
   *
   * Inside a band the rows are grouped by the reader's chosen dimension — project by default —
   * via `lib/fleetGroups.ts`'s `asideGroups`, and a band holding one group draws no heading at
   * all (see that module's header). On a machine whose whole fleet sits in one checkout this
   * therefore looks exactly as it did.
   */
  const bands = useMemo((): { id: AsideBandId; label: string; groups: SessionGroup[] }[] => {
    // A session in a USER GROUP is shown there and not repeated here — same exclusion pinning
    // already gets, and for the same reason: one row, one home.
    const rest = matched.filter(r => !pinned.has(pinKeyOf(r)) && !groupedKeys.has(pinKeyOf(r)))
    const order = groupOrder[groupBy] ?? []
    return [
      {
        id: 'active',
        label: pt ? 'Ativas' : 'Active',
        groups: asideGroups(rest.filter(r => active.has(r.state)), groupBy, lang, order, sortOrder),
      },
      // Never computed while activeOnly is on — those rows are the ones the switch is withholding,
      // not a second list to render beside it.
      {
        id: 'inactive',
        label: pt ? 'Inativas' : 'Inactive',
        groups: activeOnly ? [] : asideGroups(rest.filter(r => !active.has(r.state)), groupBy, lang, order, sortOrder),
      },
    ]
  }, [matched, pinned, groupedKeys, active, activeOnly, pt, lang, groupBy, groupOrder, sortOrder])

  /**
   * "Recolher tudo" / "Expandir tudo" — every fold this list has, at once: the Fixadas section,
   * the Grupos section, every individual folder (parent and child alike), and every automatic
   * project/task/status sub-group currently on screen. Nothing here is a NEW kind of fold; this
   * only sets every EXISTING one together, which is why it can stay two functions instead of a
   * fifth piece of persisted state to keep in sync with the other four.
   */
  const collapseAll = () => {
    setFoldedPinnedState(true)
    writeAsideGroupPrefs({ foldedPinned: true })
    setFoldedGroupsSectionState(true)
    writeAsideGroupPrefs({ foldedGroupsSection: true })
    const allUserGroups = new Set(groupsValue.groups.map(g => g.id))
    setFoldedUserGroupsState(allUserGroups)
    writeAsideGroupPrefs({ collapsedUserGroups: [...allUserGroups] })
    const allAutoKeys = new Set(bands.flatMap(b => [bandCollapseKey(b.id), ...b.groups.map(g => collapseKey(b.id, groupBy, g.key))]))
    setFoldedGroupsState(allAutoKeys)
    writeAsideGroupPrefs({ collapsed: [...allAutoKeys] })
  }
  const expandAll = () => {
    setFoldedPinnedState(false)
    writeAsideGroupPrefs({ foldedPinned: false })
    setFoldedGroupsSectionState(false)
    writeAsideGroupPrefs({ foldedGroupsSection: false })
    setFoldedUserGroupsState(new Set())
    writeAsideGroupPrefs({ collapsedUserGroups: [] })
    setFoldedGroupsState(new Set())
    writeAsideGroupPrefs({ collapsed: [] })
  }

  /** The current dimension's groups, across both bands, deduped by key, in their effective
   *  order — what the popover's reorder list edits. */
  const groupOrderCandidates = useMemo(() => {
    const seen = new Map<string, string>()
    for (const b of bands) for (const g of b.groups) if (!seen.has(g.key)) seen.set(g.key, g.label)
    return [...seen.entries()].map(([key, label]) => ({ key, label }))
  }, [bands])

  const total = bands.reduce(
    (n, b) => n + b.groups.reduce((m, g) => m + g.sessions.length, 0),
    0,
  ) + pinnedRows.length + groupRowsShown.reduce((n, g) => n + g.rows.length, 0)
  const filterCount = (filters.harnesses?.length ?? 0) + filters.projects.length
    + (filters.repos?.length ?? 0) + filters.models.length

  /**
   * Validate a nest before anything is asked or written: an invalid move goes straight to the
   * warning (there is nothing to confirm — it cannot happen), a valid one is held in
   * `pendingNest` for the confirmation dialog. Shared by the drag-drop path and the "Mover para
   * pasta…" menu path, so the two can never drift on when a confirmation is owed.
   */
  /** Is the folder being dragged a NESTED one, and is `target` its own parent or one of its siblings —
   *  i.e. is the pointer still inside the folder it lives in? */
  const draggedIsInsideFolderOf = (target: SessionUserGroup) => {
    const dragged = groupsValue.groups.find(g => g.id === draggingGroupId)
    return dragged?.parentId !== undefined && (dragged.parentId === target.id || dragged.parentId === target.parentId)
  }

  const requestNest = (childId: string, parentId: string) => {
    const check = canNestGroup(groupsValue, childId, parentId)
    if (!check.ok) { setNestWarning(check.code); return }
    const childName = groupsValue.groups.find(g => g.id === childId)?.name ?? ''
    const parentName = groupsValue.groups.find(g => g.id === parentId)?.name ?? ''
    setPendingNest({ childId, childName, parentId, parentName })
  }

  /**
   * Renders one user folder — and, at `depth === 0`, its children indented directly beneath it
   * (max depth 1: a child never has children of its own, so this never recurses past `depth 1`).
   * A closure rather than a component: every drag/menu handler below already lives in this
   * component's own state, and threading fifteen props through a separate component for a shape
   * that recurses exactly one level deep would be the same code, worse to read.
   *
   * COUNTING: a folder's header shows everything it CONTAINS — its own sessions plus its nested
   * folders' (`folderSessionCount`). It used to count direct sessions only, and a parent holding
   * nothing but subfolders read `0`.
   */
  const renderGroupBand = (entry: { group: SessionUserGroup; rows: ControlSession[] }, depth: 0 | 1, parentDimmed = false): React.ReactNode => {
    const { group } = entry
    // What matches in this folder (its nested folders included) — see `groupRowsShown`.
    const shownInFolder = folderSessionCount(group.id, groupRowsShown)
    // A SEARCH opens the folders that hold results, without touching what the person folded: the
    // stored fold is untouched, it is only overridden while there is text in the search box.
    // Nothing here matches: kept, and quieter — never removed (see `listNarrowed`) — and shown as its
    // header alone, since a body that only says "nothing matches" is noise in a filtered list.
    // A dimmed folder is still a folder: it opens and closes (`folderFold` — forcing it folded made
    // the click a no-op), and opened it shows what it holds.
    const fold = folderFold({
      storedFolded: foldedUserGroups.has(group.id), openedDimmed: openedDimmed.has(group.id),
      narrowing, searching, shownCount: shownInFolder,
    })
    const noMatches = fold.dimmed
    const folded = fold.folded
    const source = fold.showAll || parentDimmed ? groupRowsResolved : groupRowsShown
    const gRows = fold.showAll || parentDimmed
      ? (groupRowsResolved.find(g => g.group.id === group.id)?.rows ?? entry.rows)
      : entry.rows
    const isDropTarget = dragOverGroupId === group.id
    const isReorderTarget = groupReorderOver === group.id
    const nestHover = nestOverGroupId?.id === group.id ? nestOverGroupId : null
    const children = depth === 0 ? source.filter(g => g.group.parentId === group.id && !g.group.hidden) : []
    // A folded group hides its rows (and, for a parent, its children too): its own left edge says
    // when one of them is waiting.
    const attn = folded ? attentionCount(gRows, dismissedAttn) : 0
    return (
      <div
        key={group.id}
        style={{ marginLeft: depth * 14, ...(noMatches && !parentDimmed ? { opacity: 0.5 } : {}) }}
      >
        <div
          // Suppressed for the WHOLE list while ANY folder is being dragged, not only for the one
          // currently under the pointer — as the pointer sweeps across the list toward its target,
          // every folder it passes near briefly becomes (and stops being) a drop target, and a CSS
          // animation RESTARTS every time its class is removed and reapplied. Toggling this class
          // once per folder per hover-frame turned the pulse into a strobe ("linhas piscando
          // parecendo uma rave"). One flag for the whole drag, not a per-target one.
          {...(attn > 0 && !isDropTarget && !isReorderTarget && !nestHover && draggingGroupId === null
            ? { className: ATTN_BAR_CLASS } : {})}
          // The drop target is the WHOLE group container now, not only the header line — an
          // empty group's own "drag sessions here" hint sits below the header, and a hint
          // that cannot itself be dropped on is not really a drop target. A member row's own
          // onDragOver/onDrop (below) still `stopPropagation`, so hovering a specific row for
          // reordering does not also light up this outer highlight.
          //
          // THREE DISTINCT PAYLOADS can land here: a SESSION key (add it to this group), a GROUP
          // id dragged by its GRIP (reorder — `GROUP_DRAG_KEY_TYPE`), and a GROUP id dragged by its
          // BODY (nest — `GROUP_NEST_DRAG_KEY_TYPE`, see `dragReorder.ts`'s own header). They are
          // DIFFERENT MIME types on the same native event, checked nest-first because it is the
          // most specific of the three.
          onDragOver={e => {
            if (hasGroupNestDragPayload(e)) {
              e.preventDefault()
              if (!draggingGroupId || draggingGroupId === group.id || draggedIsInsideFolderOf(group)) {
                if (nestOverGroupId) setNestOverGroupId(null)
                return
              }
              const outcome = groupDropOutcome(groupsValue, 'body', draggingGroupId, group.id)
              if (outcome.action !== 'nest') return
              // Always 'move', even on the RED (refused) target: a real mouse-driven drag treats
              // `dropEffect = 'none'` as an instruction to CANCEL the drop outright — no `drop`
              // event reaches this element at all, which is exactly "fica vermelho e não aparece
              // nenhum aviso". The red background + border ALONE says "this will be refused"; the
              // warning dialog explains WHY once the drop is actually let through.
              e.dataTransfer.dropEffect = 'move'
              if (nestOverGroupId?.id !== group.id || nestOverGroupId.ok !== outcome.ok) {
                setNestOverGroupId({ id: group.id, ok: outcome.ok })
              }
              return
            }
            if (hasGroupDragPayload(e)) {
              e.preventDefault()
              if (groupReorderOver !== group.id) setGroupReorderOver(group.id)
              return
            }
            if (!hasDragPayload(e)) return
            e.preventDefault()
            if (dragOverGroupId !== group.id) setDragOverGroupId(group.id)
          }}
          onDragLeave={e => {
            // `dragleave` bubbles up from every CHILD the pointer crosses inside this container, and
            // each one fires it on the container too — clearing the highlight for a frame before the
            // next `dragover` sets it again. That flicker is the "linhas laranjas piscando parecendo
            // uma rave". Only a leave that actually exits the container counts.
            if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
            setDragOverGroupId(cur => (cur === group.id ? null : cur))
            setGroupReorderOver(cur => (cur === group.id ? null : cur))
            setNestOverGroupId(cur => (cur?.id === group.id ? null : cur))
          }}
          onDrop={e => {
            e.preventDefault()
            // Stops here, or the automatic-bands wrapper below would ALSO see this drop
            // bubble past it and read it as "un-group me" the instant it is filed.
            e.stopPropagation()
            if (hasGroupNestDragPayload(e)) {
              const dragId = readGroupNestDragPayload(e) ?? draggingGroupId
              // A nested folder dropped anywhere INSIDE its own parent stays where it is (pinned first
              // there); only leaving that folder takes it out.
              if (dragId && dragId !== group.id && !draggedIsInsideFolderOf(group)) requestNest(dragId, group.id)
              setNestOverGroupId(null)
              setDraggingGroupId(null)
              return
            }
            if (hasGroupDragPayload(e)) {
              const dragId = readGroupDragPayload(e)
              if (dragId) reorderSessionGroups(dragId, group.id)
              setGroupReorderOver(null)
              return
            }
            const key = readDragPayload(e)
            // A pinned row is a valid drop source here too — the drop UNPINS it into the
            // group in one gesture (see `moveSessionToGroup`'s own header for the write
            // order and why).
            if (key) moveSessionToGroup(group.id, key)
            setDragOverGroupId(null)
          }}
          style={{
            marginBottom: 8, borderRadius: 8, paddingBottom: 4,
            // A group and its members read as ONE container, header down through the last
            // row — the same continuous left bar + shared tint the subtask board's own
            // clustered groups use (`CLUSTER_ACCENT`/`CLUSTER_TINT`), so an EMPTY group still
            // reads as a container (its quiet hint below) rather than as a heading floating
            // with nothing under it. Dragging a SESSION over it, or a folder's BODY when the
            // move is ALLOWED, swaps both for the orange "this is about to receive it" state;
            // a folder's body when the one-level rule REFUSES it instead turns red, cursor
            // `not-allowed` (via `dataTransfer.dropEffect`, set above); dragging a folder by
            // its GRIP instead draws a top edge (an insertion line, the same edge indicator
            // the pinned band's own drag uses) — three different gestures landing in the same
            // place get three visibly different answers.
            background: isDropTarget || nestHover?.ok
              ? 'color-mix(in srgb, var(--anthropic-orange) 10%, transparent)'
              : nestHover && !nestHover.ok
                ? 'color-mix(in srgb, #ef4444 10%, transparent)'
                : CLUSTER_TINT,
            boxShadow: isDropTarget || nestHover?.ok
              ? `inset 3px 0 0 0 var(--anthropic-orange), inset 0 0 0 1px var(--anthropic-orange)`
              : nestHover && !nestHover.ok
                ? `inset 3px 0 0 0 #ef4444, inset 0 0 0 1px #ef4444`
                : isReorderTarget
                  ? `inset 3px 0 0 0 ${CLUSTER_ACCENT}, inset 0 2px 0 0 var(--anthropic-orange)`
                  : `inset 3px 0 0 0 ${CLUSTER_ACCENT}`,
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: 2, borderRadius: 7,
            padding: '4px 4px 4px 5px', minHeight: tap,
          }}>
            {/* The grip — the ONLY drag source that reorders, and only TOP-LEVEL folders have one. A
                nested folder is pinned first under its parent and has no order of its own to change;
                dragging it out of its parent is what un-nests it. Esc cancels a native drag exactly
                like any other; nothing here needs to handle that itself. */}
            {depth === 0 && (
              <span
                draggable
                onDragStart={e => { e.stopPropagation(); setGroupDragPayload(e, group.id); setDraggingGroupId(group.id) }}
                onDragEnd={() => { setGroupReorderOver(null); setDraggingGroupId(null) }}
                aria-hidden="true"
                title={pt ? 'Arrastar para reordenar' : 'Drag to reorder'}
                style={{
                  display: 'flex', alignItems: 'center', flexShrink: 0, cursor: 'grab',
                  color: 'var(--text-tertiary)', padding: '0 2px', minHeight: tap,
                  ...(tap ? { touchAction: 'none' as const } : {}),
                }}
              >
                <GripVertical size={13} />
              </span>
            )}
            {/* The body — everything else on the row. Dragging THIS nests the folder into
                whatever it lands on; it never reorders. */}
            <div
              draggable
              onDragStart={e => { setGroupNestDragPayload(e, group.id); setDraggingGroupId(group.id) }}
              onDragEnd={() => { setNestOverGroupId(null); setDraggingGroupId(null) }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, cursor: 'grab' }}
            >
              <button
                onClick={() => (fold.toggles === 'dimmed' ? toggleOpenedDimmed(group.id) : toggleUserGroupFold(group.id))}
                aria-expanded={!folded}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
                  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  padding: 0, textAlign: 'left', minHeight: tap,
                  // A `<button>` with no `color` of its own falls back to the UA `buttontext`
                  // default, which `index.html`'s `color-scheme: dark` pins to WHITE regardless
                  // of this app's own light/dark toggle — so the chevron (bare `currentColor`,
                  // no style of its own) and the count span below (same) rendered invisible on
                  // the light theme's white background. Same tertiary tone the automatic
                  // section sub-headings use (`SessionBand`'s own folding button, a few hundred
                  // lines below) so a user group's heading reads like every other one.
                  color: 'var(--text-tertiary)',
                }}
              >
                {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                <Folder size={11} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
                {/* Hidden: the name stays in the layout (so the block is exactly as long as it) and
                    a grey block is painted over it. `role="img"` makes a reader announce the
                    label instead of reading the text out. */}
                <span
                  {...(hiddenGroups.has(group.id)
                    ? { className: 'ag-name-mask', role: 'img', 'aria-label': pt ? 'Nome oculto' : 'Name hidden' }
                    : {})}
                  style={{
                    fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
                    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {group.name}
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 600, opacity: 0.65 }}>{folderCountLabel(shownInFolder, folderSessionCount(group.id, groupRowsResolved), narrowing)}</span>
              </button>
              <button
                onClick={e => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setGroupMenu({ id: group.id, x: r.left, y: r.bottom + 4 })
                }}
                aria-label={pt ? 'Opções do grupo' : 'Group options'}
                title={pt ? 'Opções do grupo' : 'Group options'}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: tap ?? 24, height: tap ?? 24, flexShrink: 0, borderRadius: 6,
                  border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
                }}
              >
                <MoreVertical size={13} />
              </button>
            </div>
          </div>
          {!folded && (
            <>
              {/* Subfolders read BEFORE the parent's own sessions — the same "folders before files"
                  order a file explorer uses, and the reason a freshly nested folder becoming the
                  FIRST child (`moveToFrontAmongSiblings`, core) actually reads as "first" on screen
                  instead of sitting after every session the parent already held. */}
              {children.map(c => renderGroupBand(c, 1, noMatches || parentDimmed))}
              {gRows.length === 0 && children.length === 0 ? (
                <p style={{ margin: '2px 9px 4px 21px', fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                  {/* Empty because of the FILTERS is not an empty folder — telling someone to drag
                      sessions into a folder that holds sixty would be wrong. */}
                  {noMatches && folderSessionCount(group.id, groupRowsResolved) > 0
                    ? (pt ? 'Nada aqui corresponde aos filtros ou à busca.' : 'Nothing here matches the filters or the search.')
                    : pt
                    ? 'Arraste uma sessão até aqui, ou use "Mover para grupo" no menu dela.'
                    : 'Drag a session here, or use "Move to group" on its menu.'}
                </p>
              ) : gRows.length > 0 && (
                // Indented under the header — a MEMBER, not another top-level row — the same
                // modest offset the empty-group hint above already lines up with.
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 12, paddingRight: 4, minWidth: 0 }}>
                  {gRows.map(s => {
                    const key = pinKeyOf(s)
                    return (
                      <div
                        key={`grp-${group.id}-${s.id}`}
                        draggable
                        onDragStart={e => setDragPayload(e, key)}
                        onDragOver={e => {
                          if (!hasDragPayload(e)) return
                          e.preventDefault()
                          e.stopPropagation()
                          if (groupRowDragOver !== key) setGroupRowDragOver(key)
                        }}
                        onDragEnd={() => setGroupRowDragOver(null)}
                        onDrop={e => {
                          // Only a SESSION drop is this row's to handle. A FOLDER dropped over a member
                          // row must reach the folder's own container (nest / reorder / pop out), so it
                          // is neither prevented nor stopped here — this used to swallow every drop
                          // unconditionally, which is why nothing at all happened whenever the target
                          // folder had a session under the pointer ("nada aparece"), while empty
                          // folders (the only ones the earlier checks used) worked.
                          if (!hasDragPayload(e)) return
                          e.preventDefault()
                          e.stopPropagation()
                          const dragKey = readDragPayload(e)
                          if (dragKey && dragKey !== key) {
                            if (groupOfKey.get(dragKey) === group.id) reorderSessionInGroup(group.id, dragKey, key)
                            else moveSessionToGroup(group.id, dragKey)
                          }
                          setGroupRowDragOver(null)
                        }}
                        style={{
                          boxShadow: groupRowDragOver === key ? 'inset 0 2px 0 var(--anthropic-orange)' : undefined,
                          // No touch-action opt-out here: it made a swipe that STARTS on a row a no-op, so
                          // the list would not scroll from a session. Native drag starts on long-press.
                        }}
                      >
                        <SessionRow
                          session={s}
                          selected={rowSelected(s, sessionId)}
                          {...(tap ? { tap } : {})}
                          onPin={() => flip(s)}
                          onOpen={() => (onOpenRow ? onOpenRow(s) : openSessionRoute(s.id))}
                          {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
                          onOpenMenu={(x, y, verbs) => openMenu(s, x, y, verbs)}
                          onFile={(x, y) => setLinking({ id: s.id, x, y })}
                          lang={lang}
                          cardColor={cardColor}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <GoToSessionContext.Provider value={onGoToSession ?? null}>
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 10, paddingTop: 4 }}>
      {/* THE IDLE-REVIEW CARD — the FIRST thing in the column, right under the Dashboard/Sessions
          tabs (desktop) and the Sessions/Metrics tabs (mobile). Owner decision 2026-09-27: it sat
          above Groups, halfway down a list that scrolls, and read as one more row. At the top it
          is a notice about the list rather than an item in it. See `IdleReviewCard.tsx` for why
          mounting it in this component covers the desktop aside and the mobile list at once. */}
      <IdleReviewCard lang={lang} tap={tap} />
      {/* A session just started but not yet in `rows` — see `PendingSessionCard.tsx`. Right under
          the idle card, for the same reason: a notice about the list, not an item in it. */}
      <PendingSessionCard lang={lang} tap={tap} />
      {/*
        * THE SEARCH, on its own row.
        *
        * Search is what the column is used for on every visit; starting a session and writing to
        * several are things somebody does occasionally. Two full-width dashed buttons stacked above
        * the field spent three rows of a 268px column on that ranking inverted — and those rows come
        * straight out of the list, which is the thing being searched.
        *
        * An icon may not carry the meaning alone, so both keep `title` AND `aria-label` with the
        * words they used to print. `+` is the one solid accent control in the aside because it is
        * the only one that CREATES something; "send to several" stays quiet beside it. "Reopen what
        * fell" is deliberately NOT here and keeps its full-width button below: it names a COUNT, and
        * a count is not something an icon can say.
        */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, padding: '0 2px', minHeight: tap }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          <Search
            size={13}
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}
          />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={pt ? 'Buscar sessão…' : 'Search sessions…'}
            style={{
              flex: 1, minWidth: 0, boxSizing: 'border-box',
              padding: '9px 26px 9px 30px', borderRadius: 9,
              border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
              color: 'var(--text-primary)', fontFamily: 'inherit',
              // 16px on mobile or iOS Safari zooms the viewport; the global guard in index.css
              // handles it, so this stays the desktop figure and is not overridden inline.
              fontSize: 12.5, outline: 'none',
            }}
          />
          {query !== '' && (
            <button
              onClick={() => setQuery('')}
              aria-label={pt ? 'Limpar busca' : 'Clear search'}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                display: 'flex', border: 'none', background: 'transparent',
                color: 'var(--text-tertiary)', cursor: 'pointer', padding: 2,
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* THE SUMMARY LINE: what the fleet is doing right now. Each part is a filter (press again to
          clear it); the capacity slot stays empty until a source provides "N/M vagas". */}
      <div
        role="group"
        aria-label={pt ? 'Resumo das sessões' : 'Sessions summary'}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 0', padding: '0 2px', fontSize: 11, color: 'var(--text-tertiary)' }}
      >
        {summaryParts(summaryNumbers, pt).map((v, i) => (
          <span key={v.part} style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}>
            {i > 0 && <span aria-hidden>·</span>}
            <button
              type="button"
              onClick={() => setSummaryFilter(toggleSummaryPart(summaryFilter, v.part))}
              aria-pressed={summaryFilter === v.part}
              style={{
                border: 'none', background: summaryFilter === v.part ? 'var(--bg-elevated)' : 'transparent',
                color: summaryFilter === v.part ? 'var(--text-primary)' : v.part === 'needs' && v.count > 0 ? 'var(--anthropic-orange)' : 'inherit',
                font: 'inherit', cursor: 'pointer', borderRadius: 6,
                padding: isMobile ? '12px 5px' : '2px 4px', minHeight: tap,
                fontWeight: summaryFilter === v.part || (v.part === 'needs' && v.count > 0) ? 600 : 400,
              }}
            >
              {v.text}
            </button>
          </span>
        ))}
        {capacityLabel && (<><span aria-hidden>·</span><span data-testid="aside-capacity">{capacityLabel}</span></>)}
      </div>

      {/*
        * THE THREE STANDING VERBS, one row under the search: start a session, write to several, and
        * arrange the list. They share the column's width equally with a small gap, so three icons
        * are big targets and read as one control rather than three stray squares. "New session"
        * is the solid accent because it is the only one that CREATES something. A verb this
        * surface cannot perform is ABSENT (a central has no New session, a machine with nothing to
        * broadcast to has no send) and the ones left simply share the width.
        */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, padding: '0 2px' }}>
        {!hideNew && (
          <button
            onClick={() => setCreating(true)}
            aria-label={pt ? 'Nova sessão' : 'New session'}
            title={pt ? 'Nova sessão' : 'New session'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flex: 1, minWidth: 0, minHeight: tap ?? 36, padding: 0, borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
              color: '#141414', fontFamily: 'inherit',
            }}
            onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.1)' }}
            onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
          >
            <Plus size={18} />
          </button>
        )}
        {showSend && (
          <button
            onClick={() => setPicking('send')}
            aria-label={pt ? 'Enviar prompt em massa' : 'Send a prompt to several'}
            title={pt ? 'Enviar prompt em massa' : 'Send a prompt to several'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, minWidth: 0, minHeight: tap ?? 36,
              padding: 0, borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
              color: 'var(--text-tertiary)', fontFamily: 'inherit',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'var(--anthropic-orange)'
              e.currentTarget.style.color = 'var(--anthropic-orange)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--border-subtle)'
              e.currentTarget.style.color = 'var(--text-tertiary)'
            }}
          >
            <Send size={14} />
          </button>
        )}
        {/* FILTROS (design item 4) — "Filtros na linha de botões da lista, visível também com ela
            minimizada". `App.tsx` owns the open/close state and the panel that actually opens; this
            button only toggles it and reports its own position through `filtersButtonRef`, so the
            caller can anchor the panel beside it (a popover, not a control this component draws
            itself — see `App.tsx`'s own `sessionsFiltersAnchor`). Absent on mobile — see the prop's
            own header. */}
        {onToggleFilters && (
        <button
          ref={filtersButtonRef}
          onClick={onToggleFilters}
          aria-expanded={filtersOpen}
          aria-label={pt ? 'Filtros — restringe a lista de sessões' : 'Filters — narrows the fleet list'}
          title={pt ? 'Filtros — restringe a lista de sessões' : 'Filters — narrows the fleet list'}
          style={{
            position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flex: 1, minWidth: 0, minHeight: tap ?? 36, padding: 0, borderRadius: 9, cursor: 'pointer',
            border: `1px solid ${filtersOpen ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
            background: filtersOpen ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
            color: filtersOpen ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', fontFamily: 'inherit',
          }}
          onMouseEnter={e => { if (!filtersOpen) { e.currentTarget.style.borderColor = 'var(--anthropic-orange)'; e.currentTarget.style.color = 'var(--anthropic-orange)' } }}
          onMouseLeave={e => { if (!filtersOpen) { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.color = 'var(--text-tertiary)' } }}
        >
          <Filter size={14} />
          {!!filtersCount && filtersCount > 0 && (
            <span style={{
              position: 'absolute', top: 3, right: 3,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 13, height: 13, padding: '0 3px', borderRadius: 7,
              background: 'var(--anthropic-orange)', color: '#fff',
              fontSize: 8.5, fontWeight: 700, lineHeight: 1,
            }}>
              {filtersCount}
            </span>
          )}
        </button>
        )}
        <SessionsGroupMenu
          fill
          lang={lang}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
          sort={sortOrder}
          onSort={setSortOrder}
          groups={groupOrderCandidates}
          onReorder={keys => setGroupOrder(groupBy, keys)}
          cardColor={cardColor}
          onCardColor={setCardColor}
          onCollapseAll={collapseAll}
          onExpandAll={expandAll}
          hiddenFolders={hiddenFoldersOf(groupsValue).map(g => {
            const parent = g.parentId ? groupsValue.groups.find(x => x.id === g.parentId) : undefined
            const name = displayName(g.name, hiddenGroups.has(g.id))
            return { id: g.id, name: parent ? `${displayName(parent.name, hiddenGroups.has(parent.id))} › ${name}` : name }
          })}
          onShowFolder={id => setSessionGroupHidden(id, false)}
          changed={arrangeChangedCount({
            groupBy, sort: sortOrder, cardColor,
            order: groupOrder[groupBy] ?? [], hiddenFolders: hiddenFoldersOf(groupsValue).length,
          })}
        />
        {mutedRows.length > 0 && (
          <button
            ref={mutedButtonRef}
            type="button"
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              setMutedPopover(cur => cur ? null : { x: r.right, y: r.bottom + 6 })
            }}
            aria-label={pt ? 'Sessões silenciadas' : 'Muted sessions'}
            title={pt ? 'Sessões silenciadas' : 'Muted sessions'}
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flex: 1, minWidth: 0, minHeight: tap ?? 36, padding: 0, borderRadius: 9,
              border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
              color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <BellOff size={14} />
            <span style={{
              position: 'absolute', top: 3, right: 3, minWidth: 13, height: 13, padding: '0 3px',
              borderRadius: 7, background: 'var(--anthropic-orange)', color: '#fff',
              fontSize: 8.5, fontWeight: 700, lineHeight: 1, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
            }}>{mutedRows.length}</span>
          </button>
        )}
      </div>
      {mutedPopover && createPortal(
        <div
          role="dialog"
          aria-label={pt ? 'Sessões silenciadas' : 'Muted sessions'}
          style={{
            position: 'fixed', left: Math.max(10, Math.min(mutedPopover.x, window.innerWidth - 300)),
            top: Math.min(mutedPopover.y, window.innerHeight - 260), width: 'min(290px, calc(100vw - 20px))',
            maxHeight: 'min(250px, calc(100vh - 20px))', overflowY: 'auto', zIndex: 5000,
            padding: 8, borderRadius: 10, border: '1px solid var(--border)',
            background: 'var(--bg-card)', boxShadow: '0 12px 32px rgba(0,0,0,.35)',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '3px 4px 7px' }}>
            <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>{pt ? 'Sessões silenciadas' : 'Muted sessions'}</strong>
            <button
              type="button"
              onClick={() => {
                for (const row of mutedRows) toggleSessionMuted(sessionIdentityKey(row))
                setMutedPopover(null)
              }}
              style={{
                border: 'none', background: 'transparent', color: 'var(--anthropic-orange)',
                cursor: 'pointer', font: 'inherit', fontSize: 11, padding: '6px 4px',
              }}
            >
              {pt ? 'Reativar todas' : 'Unmute all'}
            </button>
          </div>
          {mutedRows.map(row => {
            const color = (HARNESS_COLORS as Record<string, string>)[row.harness] ?? 'var(--text-tertiary)'
            const label = (HARNESS_LABELS as Record<string, string>)[row.harness] ?? row.harness
            return (
              <div key={sessionIdentityKey(row)} style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 44, padding: '3px 2px' }}>
                <button
                  type="button"
                  onClick={() => openSessionRoute(row.id)}
                  style={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, textAlign: 'left',
                    border: 'none', background: 'transparent', color: 'var(--text-secondary)',
                    cursor: 'pointer', font: 'inherit', padding: '7px 4px',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{row.title}</span>
                  <span style={{ flexShrink: 0, color, fontSize: 10 }}>{label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleSessionMuted(sessionIdentityKey(row))}
                  style={{
                    flexShrink: 0, minWidth: 44, minHeight: 44, border: 'none', background: 'transparent',
                    color: 'var(--text-tertiary)', cursor: 'pointer', font: 'inherit', fontSize: 11,
                  }}
                >
                  {pt ? 'Reativar' : 'Unmute'}
                </button>
              </div>
            )
          })}
        </div>,
        document.body,
      )}

      {/*
        * THE GROUP VERBS, under "New session" because that is where starting work lives.
        *
        * "Reopen what fell" appears only when something DID fall, and it names the count: a button
        * that is always there teaches nothing, and a bare "reopen" is a different promise from
        * "reopen 6 sessions". Neither is offered on a surface that cannot act — a button whose only
        * outcome is a refusal is a button that teaches the wrong thing.
        */}
      {showFell && (
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, margin: '0 2px' }}>
          <button
            onClick={() => setPicking('reopen')}
            style={{
              flex: 1, minWidth: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              padding: '9px 12px', borderRadius: 9, cursor: 'pointer', minHeight: tap,
              border: '1px solid var(--anthropic-orange)', background: 'rgba(232,146,90,0.08)',
              color: 'var(--anthropic-orange)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            }}
          >
            <RotateCcw size={14} />
            {pt
              ? (groupRows.fellRows.length === 1 ? 'Reabrir 1 sessão que caiu' : `Reabrir ${groupRows.fellRows.length} sessões que caíram`)
              : (groupRows.fellRows.length === 1 ? 'Reopen 1 session that fell' : `Reopen ${groupRows.fellRows.length} sessions that fell`)}
          </button>
          {/* Hides the banner until a DIFFERENT crash group shows up — never on the server, never
              discarding anything. Every row stays reopenable one at a time from its own menu. */}
          <button
            onClick={dismissFell}
            aria-label={pt ? 'Dispensar' : 'Dismiss'}
            title={pt ? 'Dispensar' : 'Dismiss'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              width: tap ?? 30, minHeight: tap, padding: 0, borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'transparent',
              color: 'var(--text-tertiary)', fontFamily: 'inherit',
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {picking && act && (
        <SessionPickModal
          kind={picking}
          lang={lang}
          rows={picking === 'reopen' ? groupRows.fellRows : groupRows.sendRows}
          busy={groupBusy}
          onClose={() => { if (!groupBusy) setPicking(null) }}
          onConfirm={(ids, text) => {
            // Checked and set SYNCHRONOUSLY, before anything async or any state update — see
            // `groupActingRef`'s own comment and `dispatchGuard.ts`. `groupBusy` still drives the
            // modal's disabled look.
            if (!tryBeginDispatch(groupActingRef)) return
            setGroupBusy(true)
            /*
             * The GROUP is addressed, never a row: the id is the anchor the route needs and `ids`
             * is what narrows it. Sending `ids` even when every row is ticked is deliberate — the
             * fleet polls every five seconds, and "all of them" resolved on the server a moment
             * later is not the list this person just read and agreed to.
             */
            const call = () => act({ id: ids[0] ?? '', action: picking === 'reopen' ? 'reopenFell' : 'broadcast', ids, ...(text ? { text } : {}) })
            void (picking === 'reopen' ? withReopening(ids, call) : call())
              .then(out => { setNotice(out.message); setPicking(null) })
              .finally(() => { endDispatch(groupActingRef); setGroupBusy(false) })
          }}
        />
      )}

      {creating && (
        <NewSessionModal
          lang={lang}
          onClose={() => setCreating(false)}
          onStarted={(id, started) => {
            setCreating(false)
            // Straight into it. The row will arrive on the next poll; navigating now means the
            // panel is already open on it when it does.
            //
            // The `creating` state travels WITH the navigation, and that is what stops the metrics
            // screen flashing in between: this browser's fleet does not hold the row yet, so
            // `SessionsPage` would fall through to its "nothing selected" branch — the overview —
            // for exactly as long as it takes a poll to land. The state says "this id is on its
            // way", so the page shows the creation loader instead of answering a question nobody
            // asked. Router state and not a prop: the modal that knows this is unmounting.
            //
            // `markSessionPending` is the LIST's own copy of that same fact — the placeholder row
            // right above, drawn from the store rather than this navigation's state, since the
            // aside is visible before and after this navigation settles.
            if (id) {
              markSessionPending({ id, ...started })
              if (onCreated) onCreated(id)
              else navigate(sessionPath(id), { state: { creating: started ?? {} } })
            }
          }}
        />
      )}

      {notice && (
        <p role="status" style={{
          margin: '0 4px', fontSize: 11, lineHeight: 1.45, color: 'var(--anthropic-orange)',
        }}>
          {notice}
        </p>
      )}

      {/* The list is real but not current — either the machine stopped answering, or these rows
          came out of the stored snapshot and no poll has confirmed them yet. `fleetStale.ts` owns
          which of the two it is and words each differently; here it is only drawn.

          ABOVE the scroller, not inside it: a caveat about every row below has to be readable
          wherever the reader has scrolled to, and one that scrolls away is one seen once. It is
          also drawn whether or not there are rows — this is the case of rows on screen that are no
          longer true, which is precisely what an empty-state message cannot cover.

          Deliberately NOT `--accent-red`: nothing has failed in the seeded case, and in the stale
          case the machine being unreachable is a fact about the connection, not a fault in the
          fleet. Same reasoning the cockpit's central pill applies to `stale`. */}
      {stale && (
        <p role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          margin: '0 2px', padding: '7px 9px', borderRadius: 8,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)',
        }}>
          <Clock size={12} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{stale}</span>
        </p>
      )}

      {/* A filter dimension that is SET but cannot narrow a live fleet (date range, tags, members,
          teams, machines) is said here, above the scroller — the same placement `stale` uses, and
          for the same reason: a caveat about every row below must be readable wherever the reader
          has scrolled. Silence here reads as a broken filter, not an honest one. */}
      {ignoredNote && (
        <p role="status" style={{
          margin: '0 2px', padding: '7px 9px', borderRadius: 8,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)',
        }}>
          {ignoredNote}
        </p>
      )}

      <div
        ref={asideScrollRef}
        className="ag-noscroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
        onDragOverCapture={autoScrollDuringDrag}
        // LEAVING A FOLDER: a nested folder dragged by its body and dropped ANYWHERE that is not a
        // folder (blank space, a heading, the pinned band, the automatic sections) comes back out
        // to the top level. Drops that land on a folder never get here — that folder's own
        // container stops them — so "on another folder" still means "move it into that one".
        onDragOver={e => {
          if (!hasGroupNestDragPayload(e)) return
          if (groupsValue.groups.find(g => g.id === draggingGroupId)?.parentId === undefined) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={e => {
          if (!hasGroupNestDragPayload(e)) return
          const dragId = readGroupNestDragPayload(e) ?? draggingGroupId
          if (dragId && groupsValue.groups.find(g => g.id === dragId)?.parentId !== undefined) {
            e.preventDefault()
            nestSessionGroup(dragId, null)
          }
          setNestOverGroupId(null)
          setDraggingGroupId(null)
        }}
      >
        {/* The pinned band, above everything — that is what pinning is for: the two or three
            sessions that must not move when the arrangement changes. */}
        {pinnedRows.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <button
              onClick={toggleFoldedPinned}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                padding: '6px 9px 7px', fontSize: 10.5, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--anthropic-orange)',
                background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                minHeight: tap,
              }}
            >
              {foldedPinned ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <Pin size={11} />
              <span>{pt ? 'Fixadas' : 'Pinned'}</span>
              <span style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.75 }}>{pinnedRows.length}</span>
            </button>
            {!foldedPinned && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {pinnedRows.map((s, i) => {
                const key = pinKeyOf(s)
                return (
                <div
                  key={`pin-${s.id}`}
                  draggable
                  onDragStart={e => {
                    setDragFrom(key)
                    // ALSO published on the cross-component channel (`dragReorder.ts`'s shared
                    // payload), so a pinned row can be dropped onto a user group's heading exactly
                    // like a row from anywhere else in this aside — see the group bands below.
                    setDragPayload(e, key)
                  }}
                  onDragOver={e => {
                    // A FOLDER dragged across the pinned band is not a pinned-row reorder: leave it to
                    // bubble to the list's own drop handling (a nested folder dropped here leaves its parent).
                    if (hasGroupNestDragPayload(e) || hasGroupDragPayload(e)) return
                    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(key)
                  }}
                  onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                  onDrop={e => {
                    if (hasGroupNestDragPayload(e) || hasGroupDragPayload(e)) return
                    e.preventDefault()
                    // Never lets a group's own drop handler ALSO see this drop bubble past it — not
                    // load-bearing here (the pinned band is a sibling of the groups block, not a
                    // descendant), kept for the same reason every internal reorder drop stops here.
                    e.stopPropagation()
                    if (dragFrom !== null) movePinnedSession(dragFrom, key)
                    setDragFrom(null); setDragOver(null)
                  }}
                  style={{
                    // The drop target is shown as an EDGE, not by moving the rows: a list that
                    // reflows under the cursor moves the target you were aiming at.
                    boxShadow: dragOver === key && dragFrom !== null && dragFrom !== key
                      ? 'inset 0 2px 0 var(--anthropic-orange)'
                      : undefined,
                    opacity: dragFrom === key ? 0.45 : 1,
                  }}
                >
                  <SessionRow
                    session={s}
                    selected={rowSelected(s, sessionId)}
                    pinned
                    {...(tap ? { tap } : {})}
                    onPin={() => flip(s)}
                    onOpen={() => (onOpenRow ? onOpenRow(s) : openSessionRoute(s.id))}
                    onMoveBy={d => {
                      // The step buttons move relative to the VISIBLE neighbor — same key-based
                      // rule as the drag above; there is no raw-array index to step by here either.
                      const neighbor = pinnedRows[i + d]
                      if (neighbor) movePinnedSession(key, pinKeyOf(neighbor))
                    }}
                    {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
                    onOpenMenu={(x, y, verbs) => openMenu(s, x, y, verbs)}
                    onFile={(x, y) => setLinking({ id: s.id, x, y })}
                    lang={lang}
                    cardColor={cardColor}
                  />
                </div>
                )
              })}
            </div>
            )}
          </div>
        )}

        {/*
          * USER GROUPS — named, manually curated sets ("Saved to later", …), below Pinned and above
          * the automatic Active/Inactive sections. The header (with "+ Novo grupo") always renders,
          * even with zero groups, so the control is discoverable rather than appearing only once
          * something has already been filed.
          */}
        <div style={{ marginBottom: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 2px 6px 9px', minHeight: tap,
            borderRadius: 8,
          }}>
            <button
              onClick={toggleFoldedGroupsSection}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
                cursor: 'pointer', fontFamily: 'inherit', padding: 0, minHeight: tap,
                color: 'var(--text-tertiary)',
              }}
            >
              {foldedGroupsSection ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <span style={{
                fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                {pt ? 'Grupos' : 'Groups'}
              </span>
            </button>
            <button
              onClick={() => { setNewGroupName(''); setCreatingGroup({}) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto',
                padding: tap ? '0 8px' : '3px 7px', minHeight: tap, borderRadius: 7, cursor: 'pointer',
                border: '1px dashed var(--border-subtle)', background: 'transparent',
                color: 'var(--text-tertiary)', fontFamily: 'inherit', fontSize: 10.5, fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--anthropic-orange)'
                e.currentTarget.style.color = 'var(--anthropic-orange)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--border-subtle)'
                e.currentTarget.style.color = 'var(--text-tertiary)'
              }}
            >
              <FolderPlus size={12} />
              {pt ? 'Novo grupo' : 'New group'}
            </button>
          </div>

          {/* A HIDDEN folder (and everything inside it) is not drawn; it is listed, with a way back,
              in the arrange panel's "Pastas ocultas". */}
          {!foldedGroupsSection && groupRowsShown.filter(g => !g.group.parentId && !groupConcealed(groupsValue, g.group.id)).map(entry => renderGroupBand(entry, 0))}
        </div>

        {total === 0 ? (
          <EmptyReason
            pt={pt} loading={loading} unsupported={unsupported}
            unavailable={unavailable} searching={query !== ''}
            withheld={activeOnly ? hidden : 0}
            filterNarrowed={filterCount > 0 && valueFiltered.length < rows.length}
          />
        ) : (
          <div
            // Dropping a GROUPED row anywhere in the automatic sections takes it out of its group —
            // the drag-out half of moving a session, alongside the row menu's own "Remover do
            // grupo". A row that was never grouped is unaffected: removing a key from no group is a
            // no-op (`planRemoveFromGroup`).
            onDragOver={e => { if (hasDragPayload(e)) e.preventDefault() }}
            onDrop={e => {
              const key = readDragPayload(e)
              if (key) removeSessionFromGroup(key)
            }}
          >
            {bands.map((b, i) => (
              <SessionBand
                // The label is not unique — two dimensions can legitimately produce one word, and
                // an empty band still holds its place in the order.
                key={`${i}-${b.label}`}
                bandId={b.id}
                label={b.label} groups={b.groups} groupBy={groupBy} pinned={pinned}
                sessionId={sessionId} tap={tap} onPin={flip}
                onOpen={s => (onOpenRow ? onOpenRow(s) : openSessionRoute(s.id))}
                {...(rowsById ? { rowsById } : {})}
                onOpenMenu={openMenu}
                onFile={(s, x, y) => setLinking({ id: s.id, x, y })}
                lang={lang}
                foldedGroups={foldedGroups}
                onToggleGroupFold={toggleGroupFold}
                dismissedAttn={dismissedAttn}
                onDismissAttn={dismissAttn}
                cardColor={cardColor}
              />
            ))}
          </div>
        )}
      </div>

      {linking && (
        <SessionFiling
          session={(() => {
            const r = rows.find(x => x.id === linking.id)
            return {
              id: linking.id,
              title: r?.title ?? linking.id,
              ...(r?.harness ? { harness: r.harness } : {}),
              ...(r?.task ? { task: r.task } : {}),
            }
          })()}
          lang={lang}
          onChanged={() => { setNotice(boardCopy(lang).filed) }}
          onOpenTask={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
          onClose={() => setLinking(null)}
        />
      )}

      {/* The row's context menu (Task 6) — rename / stop / reopen, plus the group entries
          ("Mover para grupo…" / "Remover do grupo"), exactly the row's own verbs plus the two
          client-side ones `rowMenuEntries` accepts as `extra` — see `groupMenuExtras`. */}
      {menu && (
        <SessionRowMenu
          x={menu.x} y={menu.y}
          entries={withUndockEntry(rowMenuEntries(
            menu.verbs, menu.state,
            [
              // The split view (desktop only, and only where this list opens sessions itself —
              // a mount that routes picks elsewhere via `onOpenRow` has no side to open beside).
              ...(!isMobile && !onOpenRow ? [{
                action: OPEN_BESIDE,
                label: pt ? 'Abrir ao lado' : 'Open beside',
                enabled: menu.id !== routeSessionId,
                ...(menu.id === routeSessionId ? { reason: pt ? 'Já está aberta à esquerda.' : 'Already open on the left.' } : {}),
              }] : []),
              ...taskMenuEntries(rows.find(r => r.id === menu.id)?.task, pt),
              ...groupMenuExtras(rows.find(r => r.id === menu.id), groupOfKey, pt),
              ...notifyExtras(rows.find(r => r.id === menu.id), mutedKeys, pt),
            ],
          ), pt, !isMobile)}
          onPick={pickMenuAction}
          onClose={() => setMenu(null)}
        />
      )}

      {/* "Mover para grupo…" — opened from the row menu above. Lists the existing groups plus
          "Novo grupo…", anchored where the menu was, same gesture as `link-task`'s picker. */}
      {groupPicker && (
        <SessionRowMenu
          x={groupPicker.x} y={groupPicker.y}
          entries={[
            // A hidden group stays hidden here too: this menu prints the name as text.
            ...groupsValue.groups.map(g => ({ action: g.id, label: displayName(g.name, hiddenGroups.has(g.id)), enabled: true })),
            { action: '__new_group__', label: pt ? 'Novo grupo…' : 'New group…', enabled: true },
          ]}
          onPick={action => {
            const target = rows.find(r => r.id === groupPicker.id)
            if (target) {
              const key = pinKeyOf(target)
              if (action === '__new_group__') {
                setNewGroupName('')
                setCreatingGroup({ forKey: key })
              } else {
                // The menu path (mandatory on a phone, which cannot drag): "Move to group…" on a
                // pinned row must also unpin it — same gesture as the drag, without a mouse.
                moveSessionToGroup(action, key)
              }
            }
            setGroupPicker(null)
          }}
          onClose={() => setGroupPicker(null)}
        />
      )}

      {/* A group's own "⋮" — rename / delete / reorder. Reuses `SessionRowMenu`, anchored under the
          button rather than at a pointer position (there is no right-click gesture on a heading).
          "Mover para cima"/"Mover para baixo" are the non-drag path for a phone or a keyboard,
          which cannot drag one header onto another — disabled at either end, same as the pinned
          band's own up/down chevrons refuse past their ends. */}
      {groupMenu && (() => {
        const menuGroup = groupsValue.groups.find(x => x.id === groupMenu.id)
        const isChild = menuGroup?.parentId !== undefined
        // "Move up"/"move down" step within the SAME sibling list a drag would (top-level, or one
        // parent's children) — never the raw storage array, which can interleave a child of some
        // OTHER folder between two siblings and make the button look like it did nothing.
        const siblingIds = groupsValue.groups.filter(g => g.parentId === menuGroup?.parentId).map(g => g.id)
        const menuIndex = siblingIds.indexOf(groupMenu.id)
        const hasChildren = groupsValue.groups.some(g => g.parentId === groupMenu.id)
        return (
        <SessionRowMenu
          x={groupMenu.x} y={groupMenu.y}
          entries={[
            { action: 'rename', label: pt ? 'Renomear' : 'Rename', enabled: true },
            {
              action: 'toggle-hide-name',
              label: hiddenGroups.has(groupMenu.id) ? (pt ? 'Mostrar nome' : 'Show name') : (pt ? 'Ocultar nome' : 'Hide name'),
              enabled: true,
            },
            // EVERY folder can step, nested ones included (owner, 2026-09-29): a nested folder moves
            // among its OWN parent's children — `planStepGroup` already scopes the step to that
            // sibling list, so it can never leave its parent this way ("Tirar da pasta" does that).
            { action: 'move-up', label: pt ? 'Mover para cima' : 'Move up', enabled: menuIndex > 0 },
            {
              action: 'move-down', label: pt ? 'Mover para baixo' : 'Move down',
              enabled: menuIndex !== -1 && menuIndex < siblingIds.length - 1,
            },
            // NESTING (one level max): a folder already nested only offers "take it out"; a
            // top-level one only offers "move it into" — the two are never both meaningful for the
            // same folder, since a child cannot itself hold a folder.
            isChild
              ? { action: 'unnest', label: pt ? 'Tirar da pasta' : 'Take out of folder', enabled: true }
              : { action: 'nest', label: pt ? 'Mover para pasta…' : 'Move to folder…', enabled: true },
            ...(menuGroupAttn > 0
              // Only offered while the group is actually signalling: a verb with nothing to act on
              // is the dead control this product refuses everywhere.
              ? [{ action: 'dismiss-attn', label: pt ? 'Marcar como visto (silenciar aviso)' : 'Mark as seen (silence alert)', enabled: true }]
              : []),
            // Takes the whole folder off the list (its sessions stay in it); it comes back from the
            // arrange panel's "Pastas ocultas". Distinct from "Ocultar nome", which keeps the folder
            // and masks only its name.
            { action: 'hide-folder', label: pt ? 'Ocultar pasta' : 'Hide folder', enabled: true },
            { action: 'delete', label: pt ? 'Excluir grupo…' : 'Delete group…', enabled: true },
          ]}
          onPick={action => {
            const g = groupsValue.groups.find(x => x.id === groupMenu.id)
            if (action === 'rename') {
              setRenameGroupDraft(g?.name ?? '')
              setRenamingGroup({ id: groupMenu.id })
            }
            if (action === 'toggle-hide-name') toggleGroupNameHidden(groupMenu.id)
            if (action === 'hide-folder') setSessionGroupHidden(groupMenu.id, true)
            if (action === 'move-up') stepSessionGroup(groupMenu.id, -1)
            if (action === 'move-down') stepSessionGroup(groupMenu.id, 1)
            if (action === 'unnest') nestSessionGroup(groupMenu.id, null)
            if (action === 'nest') {
              // Every OTHER target would fail the SAME way when this folder already has a child of
              // its own — show the warning once, right away, instead of opening a picker whose
              // every option is doomed.
              if (hasChildren) setNestWarning('source_has_children')
              else setGroupParentPicker({ id: groupMenu.id, x: groupMenu.x, y: groupMenu.y })
            }
            if (action === 'delete' && g) setDeletingGroup(g)
            if (action === 'dismiss-attn') dismissAttn(menuGroupAttnIds)
            setGroupMenu(null)
          }}
          onClose={() => setGroupMenu(null)}
        />
        )
      })()}

      {/* "Mover para pasta…" — the menu path for nesting. Lists every OTHER top-level folder; one
          already nested is never offered (it would always fail `target_is_nested`). */}
      {groupParentPicker && (
        <SessionRowMenu
          x={groupParentPicker.x} y={groupParentPicker.y}
          entries={groupsValue.groups
            .filter(g => !g.parentId && g.id !== groupParentPicker.id)
            .map(g => ({ action: g.id, label: displayName(g.name, hiddenGroups.has(g.id)), enabled: true }))}
          onPick={action => {
            requestNest(groupParentPicker.id, action)
            setGroupParentPicker(null)
          }}
          onClose={() => setGroupParentPicker(null)}
        />
      )}

      {/* The one-level-deep refusal, drag or menu — never a silent no-op. A plain notice, not
          `ConfirmModal`: nothing here is destructive, and that component's confirm button is
          always red, which would read as a second "are you sure" over a move that simply cannot
          happen. */}
      {nestWarning !== null && (
        <div
          role="alertdialog"
          aria-label={pt ? 'Não é possível' : 'Not possible'}
          style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={() => setNestWarning(null)}
            style={{ position: 'absolute', inset: 0, background: 'var(--ag-scrim, rgba(0,0,0,0.4))' }}
          />
          <div style={{
            position: 'relative', zIndex: 1, minWidth: 260, maxWidth: 340,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
            boxShadow: 'var(--ag-shadow-menu)',
          }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Não é possível' : 'Not possible'}
            </span>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              {nestWarning === 'target_is_nested'
                ? (pt
                  ? 'Não é possível: essa pasta já está dentro de outra pasta.'
                  : 'Not possible: that folder is already inside another folder.')
                : (pt
                  ? 'Não é possível: esta pasta já tem outra pasta dentro.'
                  : 'Not possible: this folder already has another folder inside it.')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button" autoFocus onClick={() => setNestWarning(null)}
                style={{
                  padding: '6px 12px', borderRadius: 8, border: 'none',
                  background: 'var(--anthropic-orange)', color: '#fff',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 650, cursor: 'pointer',
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm before a folder actually moves into another — a drag lands on its target the
          instant the mouse is released, with no "are you sure" the way a keyboard action would
          have. Reported after several folders were dropped into each other by accident in one
          sitting; nothing is written to the store until this is confirmed. */}
      {pendingNest && (
        <div
          role="dialog"
          aria-label={pt ? 'Mover pasta' : 'Move folder'}
          style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={() => setPendingNest(null)}
            style={{ position: 'absolute', inset: 0, background: 'var(--ag-scrim, rgba(0,0,0,0.4))' }}
          />
          <div style={{
            position: 'relative', zIndex: 1, minWidth: 260, maxWidth: 360,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
            boxShadow: 'var(--ag-shadow-menu)',
          }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Mover pasta' : 'Move folder'}
            </span>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              {pt
                ? <>Mover a pasta <strong>{pendingNest.childName}</strong> para dentro de <strong>{pendingNest.parentName}</strong>?</>
                : <>Move the folder <strong>{pendingNest.childName}</strong> inside <strong>{pendingNest.parentName}</strong>?</>}
            </p>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                type="button" onClick={() => setPendingNest(null)}
                style={{
                  padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid var(--border-subtle)', background: 'transparent',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
                }}
              >
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                type="button" autoFocus
                onClick={() => {
                  const result = nestSessionGroup(pendingNest.childId, pendingNest.parentId)
                  if (!result.ok) setNestWarning(result.code)
                  setPendingNest(null)
                }}
                style={{
                  padding: '6px 12px', borderRadius: 8, border: 'none',
                  background: 'var(--anthropic-orange)', color: '#fff',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 650, cursor: 'pointer',
                }}
              >
                {pt ? 'Mover' : 'Move'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A tiny rename prompt, seeded with the row's current title — the same shape the panel's own
          rename flow uses (`SessionActions`'s `asking` form), reachable here for a row that may not
          be the one currently open. */}
      {renaming && act && (
        <RenameSessionDialog
          lang={lang}
          title={renaming.title}
          onCancel={() => setRenaming(null)}
          onSubmit={text => act({ id: renaming.id, action: 'rename', text }).then(out => {
            setNotice(out.message)
            setRenaming(null)
          })}
        />
      )}

      {/* Create a group — from the "+ Novo grupo" control, or from a row menu's "Novo grupo…", in
          which case `forKey` files that session into it the moment it is created. */}
      {creatingGroup && (
        <div
          role="dialog"
          aria-label={pt ? 'Novo grupo' : 'New group'}
          style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={() => setCreatingGroup(null)}
            style={{ position: 'absolute', inset: 0, background: 'var(--ag-scrim, rgba(0,0,0,0.4))' }}
          />
          <form
            onSubmit={e => {
              e.preventDefault()
              const id = createSessionGroup(newGroupName)
              if (id && creatingGroup.forKey) moveSessionToGroup(id, creatingGroup.forKey)
              setNewGroupName('')
              setCreatingGroup(null)
            }}
            style={{
              position: 'relative', zIndex: 1, minWidth: 260, maxWidth: 340,
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
              boxShadow: 'var(--ag-shadow-menu)',
            }}
          >
            <label style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.05em', color: 'var(--text-tertiary)',
            }}>
              {pt ? 'Nome do grupo' : 'Group name'}
            </label>
            <input
              autoFocus
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setCreatingGroup(null) }}
              placeholder={pt ? 'ex.: Saved to later' : 'e.g. Saved to later'}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
                border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                type="button" onClick={() => setCreatingGroup(null)}
                style={{
                  padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid var(--border-subtle)', background: 'transparent',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
                }}
              >
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={newGroupName.trim() === ''}
                style={{
                  padding: '6px 12px', borderRadius: 8, border: 'none',
                  background: 'var(--anthropic-orange)', color: '#fff',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 650,
                  cursor: newGroupName.trim() === '' ? 'not-allowed' : 'pointer',
                  opacity: newGroupName.trim() === '' ? 0.5 : 1,
                }}
              >
                {pt ? 'Criar' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename a group — same shape as the session rename dialog above. */}
      {renamingGroup && (
        <div
          role="dialog"
          aria-label={pt ? 'Renomear grupo' : 'Rename group'}
          style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={() => setRenamingGroup(null)}
            style={{ position: 'absolute', inset: 0, background: 'var(--ag-scrim, rgba(0,0,0,0.4))' }}
          />
          <form
            onSubmit={e => {
              e.preventDefault()
              renameSessionGroup(renamingGroup.id, renameGroupDraft)
              setRenamingGroup(null)
            }}
            style={{
              position: 'relative', zIndex: 1, minWidth: 260, maxWidth: 340,
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
              boxShadow: 'var(--ag-shadow-menu)',
            }}
          >
            <label style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.05em', color: 'var(--text-tertiary)',
            }}>
              {pt ? 'Novo nome do grupo' : 'New group name'}
            </label>
            <input
              autoFocus
              value={renameGroupDraft}
              onChange={e => setRenameGroupDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setRenamingGroup(null) }}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
                border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                type="button" onClick={() => setRenamingGroup(null)}
                style={{
                  padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid var(--border-subtle)', background: 'transparent',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
                }}
              >
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={renameGroupDraft.trim() === ''}
                style={{
                  padding: '6px 12px', borderRadius: 8, border: 'none',
                  background: 'var(--anthropic-orange)', color: '#fff',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 650,
                  cursor: renameGroupDraft.trim() === '' ? 'not-allowed' : 'pointer',
                  opacity: renameGroupDraft.trim() === '' ? 0.5 : 1,
                }}
              >
                {pt ? 'Salvar' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Deleting a group is ALWAYS behind a confirmation — it never deletes a session, only the
          grouping, and the message says so explicitly. */}
      <ConfirmModal
        open={deletingGroup !== null}
        title={pt ? 'Excluir grupo' : 'Delete group'}
        message={pt
          ? `Excluir o grupo "${deletingGroup ? displayName(deletingGroup.name, hiddenGroups.has(deletingGroup.id)) : ''}"? As sessões não são apagadas, só saem do grupo.`
          : `Delete the group "${deletingGroup ? displayName(deletingGroup.name, hiddenGroups.has(deletingGroup.id)) : ''}"? Sessions are not deleted, they only leave the group.`}
        confirmLabel={pt ? 'Excluir' : 'Delete'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => {
          if (deletingGroup) deleteSessionGroup(deletingGroup.id)
          setDeletingGroup(null)
        }}
        onCancel={() => setDeletingGroup(null)}
      />
    </div>
    </GoToSessionContext.Provider>
  )
}

/** One band of the two-way (active/inactive) split. Absent when it would be empty — an empty
 *  band with a heading and no rows under it is a label pretending to be information. */
function SessionBand({
  bandId, label, groups, groupBy, pinned, sessionId, tap, onPin, onOpen, rowsById, onOpenMenu,
  onFile, lang, foldedGroups, onToggleGroupFold, dismissedAttn, onDismissAttn, cardColor,
}: {
  bandId: AsideBandId
  label: string
  /** The band's rows, already grouped by the chosen dimension and ordered — see
   *  `lib/fleetGroups.ts`. */
  groups: readonly SessionGroup[]
  groupBy: AsideGroupBy
  pinned: ReadonlySet<string>
  sessionId?: string
  tap?: number
  onPin: (row: ControlSession) => void
  onOpen: (row: ControlSession) => void
  rowsById?: Map<string, { verbs: RowVerb[] }>
  onOpenMenu: (session: ControlSession, x: number, y: number, verbs: RowVerb[]) => void
  /** File a row under a delivery — the visible half of the gesture the menu also offers. */
  onFile: (session: ControlSession, x: number, y: number) => void
  lang: 'pt' | 'en'
  /** Collapse keys already toggled shut — see `collapseKey` in `sessionsAsidePrefs.ts`. */
  foldedGroups: ReadonlySet<string>
  onToggleGroupFold: (key: string) => void
  /** Session ids whose waiting dot was dismissed, and how to dismiss more. */
  dismissedAttn: ReadonlySet<string>
  onDismissAttn: (ids: readonly string[]) => void
  cardColor: AsideCardColor
}) {
  const count = groups.reduce((n, g) => n + g.sessions.length, 0)
  if (count === 0) return null
  // One group under this band names it twice — the band heading is directly above. See the rule
  // in `fleetGroups.ts`; it is the same one the cockpit's cascade applies to its own root.
  const headings = showsGroupHeadings(groups)
  const bandKey = bandCollapseKey(bandId)
  const bandFolded = foldedGroups.has(bandKey)
  const bandAttn = bandFolded ? groups.reduce((n, g) => n + attentionCount(g.sessions, dismissedAttn), 0) : 0
  return (
    <div style={{ marginBottom: 16 }}>
      {/* The band folds like every other heading on this list (it used to be the one that did not).
          Its key lives in the same per-viewer `collapsed` list as its sub-groups. */}
      <button
        type="button"
        aria-expanded={!bandFolded}
        onClick={() => {
          if (bandFolded) onDismissAttn(groups.flatMap(g => attentionIds(g.sessions, dismissedAttn)))
          onToggleGroupFold(bandKey)
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', minHeight: tap,
          padding: '6px 9px 7px', fontSize: 10.5, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)',
        }}
      >
        {bandFolded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span
          {...(bandFolded && bandAttn > 0 ? { className: ATTN_COUNT_CLASS } : {})}
          style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.75 }}
        >{count}</span>
      </button>
      {!bandFolded && groups.map(g => {
        const ck = collapseKey(bandId, groupBy, g.key)
        const folded = foldedGroups.has(ck)
        // A small dot naming the state's own color, ONLY when grouping by status — free, and
        // consistent with the dot every row already wears. Not part of the card-color preference
        // below, which is about the ROW cards, not this heading.
        const dotColor = groupBy === 'status' ? STATE_COLOR[g.key as SessionState] : undefined
        return (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: headings ? 10 : 0 }}>
            {headings && (
              // Deliberately quieter than the band above it — lowercase, no letter-spacing — so
              // the two headings read as a hierarchy rather than as two lists. Clicking it folds
              // this group, per your instruction — the click target is the heading itself.
              <button
                // A folded band with a session waiting on you breathes its count; opening it is how
                // it is marked seen (it has no ⋮ menu of its own, unlike a user group).
                onClick={() => {
                  if (folded) onDismissAttn(attentionIds(g.sessions, dismissedAttn))
                  onToggleGroupFold(ck)
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  padding: '4px 9px 2px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
                  minHeight: tap,
                }}
              >
                {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                {dotColor && (
                  <span aria-hidden style={{
                    width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: dotColor,
                  }} />
                )}
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.label}
                </span>
                <span
                  {...(folded && attentionCount(g.sessions, dismissedAttn) > 0 ? { className: ATTN_COUNT_CLASS } : {})}
                  style={{ marginLeft: 'auto', opacity: 0.7 }}
                >{g.sessions.length}</span>
              </button>
            )}
            {(!headings || !folded) && g.sessions.map(s => (
              // Draggable so a row here can be filed INTO a user group (see the group bands in
              // `SessionsAside`, which read this via the shared `dragReorder.ts` payload — never by
              // component state, since a group band and this band share no state of their own).
              <div key={s.id} draggable onDragStart={e => setDragPayload(e, pinKeyOf(s))}>
                <SessionRow
                  session={s}
                  selected={rowSelected(s, sessionId)}
                  pinned={pinned.has(pinKeyOf(s))}
                  {...(tap ? { tap } : {})}
                  onPin={() => onPin(s)}
                  onOpen={() => onOpen(s)}
                  {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
                  onOpenMenu={(x, y, verbs) => onOpenMenu(s, x, y, verbs)}
                  onFile={(x, y) => onFile(s, x, y)}
                  lang={lang}
                  cardColor={cardColor}
                />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Why the list is empty, in words.
 *
 * Five different facts, and rendering any of them as the others is the confident-zero defect: not
 * asked yet, this machine may not be asked, the poll failed, your search matched nothing, the
 * fleet's own filters (harness/project/repo/model or "active only", now both in the shared header
 * above) are withholding rows, and there are genuinely none. Each sends a reader somewhere
 * different — the switch that would fix it is named rather than repeated as a second control here,
 * since the real one already sits in the header this list scrolls under.
 */
function EmptyReason({
  pt, loading, unsupported, unavailable, searching, withheld, filterNarrowed,
}: {
  pt: boolean; loading: boolean; unsupported: boolean; unavailable?: string; searching: boolean
  /** How many rows the "active only" switch (now in the shared header) is holding back. */
  withheld: number
  /** The shared header's harness/project/repo/model filter hid every row — a SEPARATE fact from
      the "active only" switch, and checked first: with the filter narrowing to nothing, the switch
      and the search both read as empty too, and blaming either would point at a control that was
      never the cause. */
  filterNarrowed: boolean
}) {
  const text = loading
    ? (pt ? 'Lendo as sessões desta máquina…' : 'Reading this machine’s sessions…')
    : unsupported
      ? (pt
          ? 'Esta instalação não lista sessões próprias — um central agrega várias máquinas e não hospeda as sessões de nenhuma delas.'
          : 'This install lists no sessions of its own — a central aggregates many machines and hosts none of their sessions.')
      : unavailable
        ? unavailable
        : filterNarrowed
          ? (pt ? 'Nenhuma sessão corresponde aos filtros no topo.' : 'No session matches the filters above.')
          : withheld > 0
            ? (pt
                ? `Nada rodando agora. ${withheld} ${withheld === 1 ? 'conversa está' : 'conversas estão'} escondida${withheld === 1 ? '' : 's'} por "Só ativas".`
                : `Nothing is running right now. ${withheld} ${withheld === 1 ? 'conversation is' : 'conversations are'} hidden by "Active only".`)
            : searching
              ? (pt ? 'Nenhuma sessão corresponde à busca.' : 'No session matches that search.')
              : (pt ? 'Nenhuma sessão nesta máquina ainda.' : 'No sessions on this machine yet.')

  return (
    <div style={{
      padding: '14px 10px', fontSize: 11.5, lineHeight: 1.55,
      color: 'var(--text-tertiary)',
    }}>
      {text}
    </div>
  )
}


function SessionRow({ session, selected, pinned, tap, onPin, onOpen, onMoveBy, verbs, onOpenMenu, onFile, lang, cardColor }: {
  session: ControlSession; selected: boolean
  /** Minimum row height on mobile — 44px, and undefined on desktop. */
  tap?: number
  pinned?: boolean
  onPin?: () => void
  onOpen: () => void
  /** Reorder this pinned row by `delta` places. Only ever passed for a row in the Pinned band. */
  onMoveBy?: (delta: number) => void
  /** This row's own verbs, for the context menu (Task 6). Absent where the caller has none to offer. */
  verbs?: RowVerb[]
  /** Opens the context menu at a point, carrying the verbs it was opened with. */
  onOpenMenu?: (x: number, y: number, verbs: RowVerb[]) => void
  /** File this row under a delivery — the visible half of the gesture the menu also offers. */
  onFile?: (x: number, y: number) => void
  lang?: 'pt' | 'en'
  /** How this card shows its state — see `sessionCardStyle.ts`. */
  cardColor: AsideCardColor
}) {
  const mutedKeys = useMutedKeys()
  const wants = sessionNotify(session)
  const reopening = useReopening().has(session.id)
  const goTo = useContext(GoToSessionContext)
  const cardStyle = sessionCardStyle(session.state, cardColor, selected)
  const color = STATE_COLOR[session.state] ?? 'var(--text-tertiary)'
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Where the last pointer event landed, so a picker opened from inside the row is anchored. */
  const lastPoint = useRef({ x: 0, y: 0 })
  const clearLongPress = () => {
    if (longPress.current !== null) { clearTimeout(longPress.current); longPress.current = null }
  }
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        // Left padding is deliberately wider than the right: a live row carries a state edge on its left
        // and the text needs air beside it (the row's own dot used to provide it).
        padding: '9px 9px 9px 18px', borderRadius: 9, border: 'none', textAlign: 'left', minHeight: tap,
        // SELECTED is NOT orange. Orange is already the state colour for a row that needs a person
        // (`STATE_COLOR.waiting`), so the selected row wore the same tint as the alarm and the two
        // became one signal: selecting a working session made it look like it was asking for you.
        // Selection is a fact about where the READER is, so it uses the neutral surface tokens —
        // a lifted background and a full-height accent-free edge — and leaves every colour on this
        // list to mean exactly one thing about the SESSION.
        background: cardStyle.background,
        // Two different edges, and they never collide: the STATE edge is the left rule a live row
        // carries in `wash`/`stripe` mode, and SELECTION replaces it with a brighter, full one
        // plus an outline — `sessionCardStyle` already resolves that precedence.
        boxShadow: cardStyle.edge,
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
        cursor: 'pointer', fontFamily: 'inherit', minWidth: 0,
        transition: 'background 0.15s',
      }}
      onPointerDown={e => { lastPoint.current = { x: e.clientX, y: e.clientY } }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={e => {
        if (!selected) e.currentTarget.style.background = cardStyle.background
      }}
      onKeyDown={e => {
        // alt+arrows, so the plain arrows keep whatever the browser and the list do with them. A
        // reorder that exists only for a mouse is a reorder half the readers do not have.
        if (onMoveBy && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          onMoveBy(e.key === 'ArrowUp' ? -1 : 1)
        }
      }}
      onContextMenu={e => {
        // No verbs to show is not an error — it lets the browser's own menu through rather than
        // opening one with nothing in it.
        if (!verbs || verbs.length === 0 || !onOpenMenu) return
        e.preventDefault()
        onOpenMenu(e.clientX, e.clientY, verbs)
      }}
      onTouchStart={e => {
        if (!verbs || verbs.length === 0 || !onOpenMenu) return
        const touch = e.touches[0]
        if (!touch) return
        const x = touch.clientX
        const y = touch.clientY
        longPress.current = setTimeout(() => onOpenMenu(x, y, verbs), 500)
      }}
      onTouchMove={clearLongPress}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}
      aria-current={selected ? 'true' : undefined}
      title={session.model ? `${session.title}\n${session.model}` : session.title}
    >
      {reopening && (
        <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, fontSize: 11, color: 'var(--anthropic-orange)' }}>
          <AgentisticsLoader size={12} label={reopeningLabel(lang !== 'en')} />
          {reopeningLabel(lang !== 'en')}
        </span>
      )}
      <SessionFacts
        session={session}
        selected={selected}
        {...(lang ? { lang } : {})}
        {...(cardStyle.stateTextColor ? { metaColor: cardStyle.stateTextColor } : {})}
      />
      {/* The assistant, NAMED. It was a 5px dot, which carries the fact in colour alone — and a
          colour is not a name. The model sits with it on the meta line below. */}
      {/* The pin lives on the row rather than in a menu: it is a one-click decision about the row
          you are looking at. `role="button"` on a span, because a <button> inside a <button> is
          invalid HTML and browsers resolve it by dropping one of them. */}
      {goTo && (() => {
        // A SEPARATE control: the row click keeps doing what this mount does with it. Always
        // visible (unlike the pin): it is the one way out of the dock to the workspace, and a
        // control that appears only on hover does not exist on a phone.
        const label = lang === 'en' ? 'Go to session' : 'Ir para a sessão'
        const hint = lang === 'en' ? 'Open this session in the Sessions workspace' : 'Abrir esta sessão na tela de Sessões'
        const go = (e: { stopPropagation(): void; preventDefault(): void }) => { e.preventDefault(); e.stopPropagation(); goTo(session.id) }
        return (
          <span
            role="button"
            tabIndex={0}
            aria-label={label}
            title={hint}
            onClick={go}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') go(e) }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              // 44px PAINTED on touch (`tap` is only given there): the row has the height, and a
              // projected `.ag-tap-icon` box would reach into the pin beside it.
              width: tap ? 44 : 22, height: tap ? 44 : 22, borderRadius: 6, cursor: 'pointer', color: 'var(--text-tertiary)',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--anthropic-orange)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)' }}
          >
            <SquareArrowOutUpRight size={13} />
          </span>
        )
      })()}
      {mutedKeys.includes(pinKeyOf(session)) && (
        // Not a control: the toggle lives in the row menu. It states a fact about this row, so it
        // carries a tooltip and a label, and never changes the row's own state colour.
        <span
          role="img"
          aria-label={mutedTooltip(lang !== 'en')}
          title={mutedTooltip(lang !== 'en')}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 18, height: 20, color: 'var(--text-tertiary)' }}
        >
          <BellOff size={12} />
        </span>
      )}
      {onPin && (
        <span
          role="button"
          tabIndex={0}
          aria-label={pinned ? 'Unpin' : 'Pin'}
          title={pinned ? 'Unpin' : 'Pin'}
          onClick={e => { e.stopPropagation(); onPin() }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPin() }
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: 20, height: 20, borderRadius: 6, cursor: 'pointer',
            color: pinned ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
            // A pin nobody set is faint until the row is hovered: a column of pin glyphs down an
            // unpinned list is noise beside the titles they sit next to.
            // There is no hover on a touch screen, so the pin is always visible there. On desktop
            // it appears with the row — see `.ag-row-pin` in index.css.
            opacity: pinned || tap ? 1 : 0,
            transition: 'opacity 0.15s',
          }}
          className="ag-row-pin"
        >
          {pinned ? <Pin size={12} /> : <PinOff size={12} />}
        </span>
      )}
    </button>
  )
}
