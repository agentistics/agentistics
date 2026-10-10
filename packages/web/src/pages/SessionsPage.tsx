/**
 * SessionsPage — the CENTRE of the sessions workspace.
 *
 * On DESKTOP the list is not here: it is the aside's body (`SessionsAside`), because in this
 * workspace the sidebar IS the list, the way the chat applications this is shaped after do it. So
 * the page has two states — nothing selected, which shows what the fleet is doing, and one session
 * selected, which shows that session as a conversation or as its terminal.
 *
 * On MOBILE there is no aside at all — `App.tsx` renders `SideNav` only above the breakpoint — so
 * the page carries both halves and shows ONE AT A TIME, which is the convention every other
 * full-screen surface here follows. Nothing selected is the list; a selection is the session, with
 * a way back. The same components either way: a phone-only list would be a second implementation of
 * the arrangement, and it would drift.
 *
 * What it does NOT do is fetch. `useFleet` is a shared, refcounted store: the aside and this page
 * read the same snapshot from the same poll, so a list and a detail pane can never disagree about
 * a session's state by one poll interval — which is a bug people report as flicker.
 */

import { sessionLinks } from '../lib/sessionParent'
import { SessionLinkInfo } from '../components/sessions/SessionLinkInfo'
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactElement, type ReactNode,
} from 'react'
import { useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import {
  ChevronLeft, Eye, FileText, FolderTree, MessagesSquare, Plus, TerminalSquare,
  X as XIcon, ArrowRight, MessageCircle,
} from 'lucide-react'
import { setNayFabShownInSession, useNayFabShownInSession } from '../lib/nayFabVisibility'
import { StudioHost, type StudioHostProps } from '../components/sessions/StudioHost'
import { PanelGap, PanelGapDots, PanelJunction, armGap } from '../components/sessions/PanelGap'
import { SplitPaneHeader } from '../components/sessions/SplitPaneHeader'
import { mainPaneWidth, parseSplitRatio, ratioFromWidth, SPLIT_DEFAULT_RATIO, SPLIT_MIN_PX, SPLIT_RATIO_KEY } from '../lib/splitLayout'
import { activeJunctions, isDragEndEvent, junctionHitRect, OUTER_GAP, PANEL_BORDER, PANEL_GAP, PANEL_RADIUS } from '../lib/panelLayout'
import {
  bottomPanels, hiddenPanels, isPanelShown, isTabPanelId, mountPanel, overlayOutsideAction,
  railPanels, resolveForGates, resolveForViewport, usePanelSlots,
  type OpenPlacement, type PanelGates, type PanelId, type TabPanelId,
  unpinPanel,
} from '../lib/panelSlots'
import { panelIconFor } from '../lib/panelIcons'
import {
  floatPanel, minimizeFloatingPanel, placePanel, raisePanel, setFloatingArea, setFloatingSession,
  useFloatingPanels,
} from '../lib/floatingPanels'
import { FloatingPanelLayer } from '../components/sessions/FloatingPanelLayer'
import { sessionIdentityKey } from '../lib/sessionIdentity'
import { panelTitle } from '../lib/panelMeta'
import { tabStripEdgeFade, tabStripFadeMask } from '../lib/tabStripEdge'
import { PanelRail, panelTile } from '../components/sessions/PanelRail'
import { MENTION_ADDED_TOAST } from '../lib/mentionInsert'
import type { HarnessId, SessionPreset } from '@agentistics/core'
import { freedBytes } from '@agentistics/core'
import type { AppContext } from '../lib/app-context'
import { loadClosedFleet, useFleet, useFleetIndex, type FleetActionId } from '../lib/fleet'
import { useIsMobile } from '../hooks/useIsMobile'
import { FleetOverview } from '../components/sessions/FleetOverview'
import { SessionCreating } from '../components/sessions/SessionCreating'
import { NewSessionModal } from '../components/sessions/NewSessionModal'
import { PresetLaunchConfirm } from '../components/sessions/PresetLaunchConfirm'

// How long a navigation may keep claiming its session is still coming is `ARRIVAL_WAIT_MS` in
// `lib/sessionRoute.ts`, beside the rest of the arrival rule. It lived here as `CREATE_WAIT_MS`
// while creating was the only thing that could announce a session; a reopen announces one too, and
// two constants for one budget is two answers.
import { SessionStatsMenu } from '../components/sessions/SessionStatsMenu'
import type { SessionComposerMetrics } from '../components/sessions/SessionChat'
import { SessionTitleFlag } from '../components/sessions/SessionTitleFlag'
import { ChatSelectionOverlay } from '../components/sessions/ChatSelectionBar'
import { MagnifierButton } from '../components/a11y/MagnifierButton'
import { HideLensesButton } from '../components/a11y/HideLensesButton'
import { NotificationBell } from '../components/NotificationBell'
import { ArtifactsAside } from '../components/sessions/ArtifactsAside'
import { HardwarePanel } from '../components/sessions/HardwarePanel'
import { UnsavedChangesGuard } from '../components/sessions/UnsavedChangesGuard'
import { PanelFixedControls, PanelPinButton, PanelTileDropdown } from '../components/sessions/bandControls'
import { ShellCloseStatus } from '../components/sessions/ShellCloseStatus'
import { panelClosable, requestShellClose, useShellClose } from '../lib/shellClose'
import { shellApiUrl } from '../lib/shellBand'
import { fullscreenModeFor, panelMinimizeAction } from '../lib/panelMenu'
import {
  artifactsPanelMax, ASIDE_ANIM_MS, ASIDE_EASE, currentAction, edgeHint, PANEL_MIN_WIDTH, panelWidth,
  resolveArtifactLayout, type ArtifactLayout,
} from '../lib/artifactLayout'
import {
  openArtifacts, setArtifactCount, setArtifactLive, useArtifactLive, usePanelFocusRequest,
} from '../lib/artifactsStore'
import { studioMenuRow } from '../lib/studioMenuRow'
import { closedRightEdge, restingLeftEdge, setRightAsideEdge, useRightAsideEdge } from '../lib/rightAsideEdge'
import { PaneScope, paneDomId, setActivePane, type PaneId } from '../lib/paneScope'
import { closePane, readSplitRoute, replaceInPane, splitHref, SPLIT_VIEW_PARAM, type SplitRoute } from '../lib/splitRoute'
import { useLeftAsideEdge } from '../lib/leftAsideEdge'
import { useLeftAsideOpen } from '../lib/leftAsideOpen'
import { useViewportWidth } from '../hooks/useViewportWidth'
import { railActivityFromHint } from '../lib/railActivity'
import { useHardwarePressureWatch } from '../hooks/useHardwarePressureWatch'
import { useIdleSessions } from '../hooks/useIdleSessions'
import { forcedNote, isAdmissionRefusal } from '../lib/spawnAdmission'
import { pushNotification } from '../lib/notifications'
import { takeIdleReviewRequest } from '../lib/idleReviewRequest'
import { publishIdleReview } from '../lib/idleReviewStore'
import { IdleSessionsModal } from '../components/sessions/IdleSessionsModal'
import type { SessionDrilldownProps } from '../components/SessionDrilldown'
import type { Artifact } from '../lib/sessionArtifacts'
import { liveEvents, type LiveTurn } from '../lib/artifactTabs'
import { FiltersBar } from '../components/FiltersBar'
import { PANEL_FULLSCREEN_Z, SessionPanel, type SessionView } from '../components/sessions/SessionPanel'
import { initialSessionView } from '../lib/sessionView'
import { SessionsAside } from '../components/nav/SessionsAside'
import { SessionActions } from '../components/sessions/SessionActions'
import { filterFleet } from '../lib/fleetFilter'
import { FiltersSheet } from '../components/sessions/FiltersSheet'
import {
  arrivalFor, reopenedSessionRoute, sessionPath, stillArriving, type SessionArrival,
} from '../lib/sessionRoute'
import { markSessionPending } from '../lib/pendingSessionStore'
import { dedicatedTerminalPath, paneForTarget, readTerminalPane } from '../lib/terminalSurface'
import { ShellBand } from '../components/sessions/ShellBand'
import { targetLabel } from '../lib/terminalTarget'
import { sessionPlanFactor } from '../lib/costBasis'

/** The dimensions a live fleet row can be narrowed by — the same set on both layouts. */
const FLEET_FILTER_DIMS: Array<'harnesses' | 'repos' | 'projects' | 'models'> =
  ['harnesses', 'repos', 'projects', 'models']

/** Everything the Studio's one mount site (below) needs — see `mountStudioHostPanel`. */
export interface StudioHostMountParams {
  shown: boolean
  sessionId: string
  lang: 'pt' | 'en'
  autosave: boolean
  turns: readonly LiveTurn[]
  onExit: () => void
  target: HTMLElement | null
  /** The session's own harness — picks the mention format for §6's "Mencionar seleção"/"Mencionar
   *  na conversa" via `mentionSpec.ts`. */
  harness?: HarnessId
  /** Whether the composer is on screen right now — the centre's `chat`/`terminal` choice. */
  composerMounted: boolean
  /** Fired after either mention gesture queues a reference — see `Studio.tsx`'s own `onMention`. */
  onMention: (result: { text: string; needsSwitch: boolean }) => void
  /** TRUE full screen for the Studio, in either slot — see `SessionsPage`'s own `studioFullscreen`. */
  fullscreen?: boolean
  /** Offered in EITHER slot as of 2026-09-19 — see the call site's own comment. */
  onToggleFullscreen?: () => void
  /** Where the Studio sits right now — see `Studio.tsx`'s own `slot` prop. */
  slot: 'right' | 'bottom'
  /** The Studio's own REAL placement, never folded for mobile — see `Studio.tsx`'s own `placement`
   *  prop (rail-loose-ends, item 4). */
  placement: OpenPlacement
  /** Move it to the other slot — see `Studio.tsx`'s own `onMove` prop. */
  onMove: () => void
  /** The always-visible minimize icon, right-slot only — see `Studio.tsx`'s own `onMinimizeRight`. */
  onMinimizeRight?: () => void
  /** PIN = FLOAT (`lib/floatingPanels.ts`) — see `Studio.tsx`'s own `pinned` prop. */
  pinned?: { active: boolean; onToggle: () => void }
  /**
   * NEVER A REAL FIELD (I4, fix wave 3) — declared `never` so a stray `key` on this params object is
   * a TYPE ERROR at every route a value can reach `mountStudioHostPanel` through, not only a literal
   * written directly at the call site. Before this field existed, `tsc`'s excess-property check only
   * ever caught a `key` on a FRESH object literal passed straight into the call or a directly-typed
   * variable declaration; a value routed through an intermediate `const params: StudioHostMountParams
   * = {...}` first, or merged in later via `{ ...base, ...{ key } }`, is no longer "fresh" by the time
   * it reaches the parameter, and excess-property checking does not follow it there. Naming `key` in
   * this interface closes that: it turns the check from "is this property excess" (freshness-gated)
   * into "is this property's type compatible" (`never`, so anything but absence fails), which TS
   * enforces on every structural comparison regardless of literal freshness. See
   * `studioHostMountParams.types.test.ts` for the three shapes this closes, each pinned with
   * `// @ts-expect-error`.
   */
  key?: never
}

/**
 * THE STUDIO'S ONE MOUNT SITE, pulled out to a MODULE-LEVEL function (I4) — the re-review's own
 * finding was that `panelSlots.mountPanel.test.ts` proves `mountPanel` itself never reads a `key`
 * out of its props, but only ever against a `Dummy` stand-in it builds by hand; the reviewer's
 * planted regression (`key: rightIsStudio ? 'right' : 'bottom',` slipped into the literal props
 * object at THIS call site) sailed through it untouched, and only `sessionsPage.lint.test.ts`'s
 * source-text scan caught it. A source scan is not nothing, but the brief for this fix was explicit
 * that it is not enough on its own.
 *
 * Extracting the call is what lets a test reach it: `studioHostMount.test.ts` imports this SAME
 * function — the one `SessionsPage` itself renders below — and inspects the real
 * `React.ReactElement` it returns, exactly as `panelSlots.mountPanel.test.ts` already does for
 * `mountPanel` in isolation. Two changes make the regression class harder to reintroduce, not just
 * easier to catch:
 *  - the fields are picked EXPLICITLY rather than spread from `params` — a stray `key` added to the
 *    params object at the call site below is dropped here before it ever reaches `mountPanel` /
 *    `createElement`, so that half of the old gap is closed by construction, not merely detected;
 *  - a `key` added directly to the object literal INSIDE this function (the equivalent regression,
 *    moved one level in) is exactly what `studioHostMount.test.ts` calls this function to catch.
 *
 * **Neither of those made a stray `key` on the object literal AT THE CALL SITE below fail anything
 * by itself** (fix wave 3's re-review finding) — this function's explicit field-picking absorbs it
 * silently at runtime, so the only things that could ever notice were the source scan below
 * (`sessionsPage.lint.test.ts`, and only for a `key` inside the LITERAL, not one routed through a
 * variable) and a human reading the diff. `StudioHostMountParams.key: never` (its own doc comment,
 * above) is what makes the call site itself fail to type-check for every shape measured, including
 * the two a source scan structurally cannot see.
 */
export function mountStudioHostPanel(params: StudioHostMountParams): ReactElement<StudioHostProps> | null {
  return mountPanel(params.shown, StudioHost, {
    sessionId: params.sessionId,
    lang: params.lang,
    autosave: params.autosave,
    turns: params.turns,
    onExit: params.onExit,
    target: params.target,
    harness: params.harness,
    composerMounted: params.composerMounted,
    onMention: params.onMention,
    fullscreen: params.fullscreen,
    onToggleFullscreen: params.onToggleFullscreen,
    slot: params.slot,
    placement: params.placement,
    onMove: params.onMove,
    onMinimizeRight: params.onMinimizeRight,
    pinned: params.pinned,
  })
}

/**
 * One side of the split view: the scope every store inside it reads (`lib/paneScope.ts`), and the
 * CAPTURE-phase mark that makes it the active pane before any handler inside it runs — so a pick
 * from the list, a keyboard shortcut or an "open the Gallery" note lands in the side the person is
 * working in.
 */
function PaneFrame({ pane, style, children }: { pane: PaneId; style: CSSProperties; children: ReactNode }) {
  const mark = () => setActivePane(pane)
  return (
    <PaneScope pane={pane}>
      <div
        data-split-pane={pane}
        onPointerDownCapture={mark}
        onFocusCapture={mark}
        style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, ...style }}
      >
        {children}
      </div>
    </PaneScope>
  )
}

/**
 * THE SESSIONS WORKSPACE — one session, or two side by side.
 *
 * The main session is the route's own `/sessions/:id`; the second is `?split=<id>`
 * (`lib/splitRoute.ts`). Each side is a whole `SessionsPageBody` — its own header, chat and
 * composer, artifacts rail, bottom band and floating windows — scoped by `PaneFrame`, and the gap
 * between them is a resize handle, as every other seam in the floating-panels design is. Never more
 * than two. A phone never splits: there the route's session is the only one, exactly as before.
 */
export default function SessionsPage() {
  const { lang } = useOutletContext<AppContext>()
  const { sessionId } = useParams()
  const [search] = useSearchParams()
  const isMobile = useIsMobile()
  const route = readSplitRoute(sessionId, search)
  const splitId = isMobile ? null : route.split
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [rowWidth, setRowWidth] = useState(0)
  const [ratio, setRatio] = useState(() => {
    try { return parseSplitRatio(localStorage.getItem(SPLIT_RATIO_KEY)) } catch { return SPLIT_DEFAULT_RATIO }
  })

  useEffect(() => { if (splitId === null) setActivePane('main') }, [splitId])
  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setRowWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [splitId])

  if (splitId === null) {
    return <SessionsPageBody pane="main" sessionId={sessionId} splitRoute={null} publishesRightEdge />
  }

  const room = Math.max(0, rowWidth - PANEL_GAP)
  const mainWidth = room > 0 ? mainPaneWidth(ratio, room) : 0
  return (
    <div ref={rowRef} style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
      <PaneFrame pane="main" style={{ flex: room > 0 ? `0 0 ${mainWidth}px` : 1 }}>
        <SessionsPageBody pane="main" sessionId={sessionId} splitRoute={route} publishesRightEdge={false} />
      </PaneFrame>
      <PanelGap
        orientation="vertical"
        label={lang === 'pt' ? 'Redimensionar a divisão entre as sessões' : 'Resize the split between the sessions'}
        value={mainWidth}
        min={SPLIT_MIN_PX}
        max={Math.max(SPLIT_MIN_PX, room - SPLIT_MIN_PX)}
        sign={1}
        onChange={w => setRatio(ratioFromWidth(w, room))}
        onCommit={w => {
          const next = ratioFromWidth(w, room)
          try { localStorage.setItem(SPLIT_RATIO_KEY, String(next)) } catch { /* a convenience */ }
        }}
      />
      <PaneFrame pane="split" style={{ flex: 1 }}>
        <SessionsPageBody key={splitId} pane="split" sessionId={splitId} splitRoute={route} publishesRightEdge />
      </PaneFrame>
    </div>
  )
}

interface SessionsPageBodyProps {
  /** Which side of a split view this is (`lib/paneScope.ts`) — `'main'` outside a split. */
  pane: PaneId
  /** The session this body shows: the route's own for the main pane, `?split=` for the other. */
  sessionId: string | undefined
  /** The whole route, ONLY while the workspace is split (`lib/splitRoute.ts`), so every gesture —
   *  a reopen, a close, a session that disappears — lands in this pane's own place. */
  splitRoute: SplitRoute | null
  /** Only the RIGHTMOST pane reports the right edge the App's Filtros tab anchors to. */
  publishesRightEdge: boolean
}

function SessionsPageBody({ pane, sessionId, splitRoute, publishesRightEdge }: SessionsPageBodyProps) {
  const ctx = useOutletContext<AppContext>()
  const {
    lang, isCentral, theme, filters, setFilters, activeOnly, setActiveOnly,
    availableProjects, sessionCountByProject, models, availableHarnesses, derived,
    data, currency, brlRate, sessionPresets,
  } = ctx
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const nayFabShown = useNayFabShownInSession()
  /**
   * Which of the phone's two screens is showing when no session is open.
   *
   * `list` by default: a phone opens this page to reach a session, and the metrics are the thing
   * you go and look at. Not in the URL — it is a view preference on one screen, not a place.
   */
  const [mobileTab, setMobileTab] = useState<'list' | 'overview'>('list')
  /**
   * The mobile filters live in a SHEET, and this is whether it is open.
   *
   * Both mobile bars — the list's and the open session's — raise the same one: which filters are on
   * is a property of the workspace, not of the screen you happen to be on, and two sheets would be
   * two states to keep in step.
   */
  const [sheetOpen, setSheetOpen] = useState(false)

  /**
   * The preset launch shelf's own state — see `PresetShelf.tsx` / `PresetLaunchConfirm.tsx`.
   *
   * TWO PATHS, decided by whether the preset already names a folder: one WITH a `cwd` goes through
   * `launchingPreset` (a confirm-then-POST straight to `/api/fleet/new`, the same route the wizard
   * itself calls); one WITHOUT opens `presetPrefill`, the ordinary `NewSessionModal` pre-filled with
   * everything but the folder — the wizard's own review step is that preset's consent gate. A
   * preset is never launched by clicking it alone; see the board note on s-d85c7d9d9d for why.
   */
  const [launchingPreset, setLaunchingPreset] = useState<SessionPreset | null>(null)
  const [presetLaunchBusy, setPresetLaunchBusy] = useState(false)
  const [presetLaunchError, setPresetLaunchError] = useState<string | null>(null)
  /**
   * Set exactly when `presetLaunchError` came from the machine's memory-budget refusal
   * (`isAdmissionRefusal`) rather than an ordinary spawn error — the only case `PresetLaunchConfirm`
   * offers its second, deliberate "start anyway" button (re-posts with `force: true`). Cleared
   * whenever a fresh preset is selected, so the override never survives into a different launch.
   */
  const [presetLaunchForceable, setPresetLaunchForceable] = useState(false)
  const [presetPrefill, setPresetPrefill] = useState<NonNullable<
    Parameters<typeof NewSessionModal>[0]['initialPreset']
  > | null>(null)
  // PLAN.LIMITS: "continue in another harness" (the Nay card at 100%) lands here with the harness
  // to pre-select — the ordinary wizard, nothing started on its own.
  const routeLocation = useLocation()
  const newSessionPreset = (routeLocation.state as { newSessionPreset?: { harness?: string } } | null)?.newSessionPreset
  useEffect(() => {
    if (!newSessionPreset) return
    setPresetPrefill(newSessionPreset)
    navigate(routeLocation.pathname, { replace: true, state: null })
  }, [newSessionPreset, navigate, routeLocation.pathname])

  function selectPreset(preset: SessionPreset) {
    if (preset.cwd) {
      setLaunchingPreset(preset)
      setPresetLaunchError(null)
      setPresetLaunchForceable(false)
    } else {
      setPresetPrefill({
        harness: preset.harness, prompt: preset.promptTemplate,
        ...(preset.model ? { model: preset.model } : {}),
        ...(preset.effort ? { effort: preset.effort } : {}),
        label: preset.label,
      })
    }
  }

  /**
   * `force` is the deliberate second click on "start anyway" — see `PresetLaunchConfirm`'s
   * `onForce`. The ordinary "Launch" button never passes it; only a prior memory-budget refusal on
   * THIS exact request offers the option at all.
   */
  async function confirmPresetLaunch(force = false) {
    if (!launchingPreset) return
    setPresetLaunchBusy(true)
    setPresetLaunchError(null)
    try {
      // The SAME route the wizard itself calls (`fleet-spawn.ts`'s `planFleetSpawn`) — never a
      // second, unvalidated path. A spawn is the most powerful thing this server does.
      const res = await fetch(`/api/fleet/new?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: launchingPreset.harness,
          cwd: launchingPreset.cwd,
          prompt: launchingPreset.promptTemplate,
          ...(launchingPreset.model ? { model: launchingPreset.model } : {}),
          ...(launchingPreset.effort ? { effort: launchingPreset.effort } : {}),
          label: launchingPreset.label,
          ...(force ? { force: true as const } : {}),
        }),
      })
      const json = await res.json() as { ok: boolean; message: string; id?: string }
      if (!json.ok) {
        setPresetLaunchError(json.message)
        setPresetLaunchForceable(isAdmissionRefusal(json))
        setPresetLaunchBusy(false)
        return
      }
      // Forced through despite the budget — surfaced through the persisted notification store
      // (never silently), the same "already-localized sentence, meta-carried" pattern
      // `hardware.pressure` uses for its own server-computed sentence.
      const note = forcedNote(json)
      if (note) pushNotification({ type: 'success', code: 'sessions.forced_start', meta: { note } })
      const started = launchingPreset
      setLaunchingPreset(null)
      setPresetLaunchBusy(false)
      setPresetLaunchForceable(false)
      if (json.id) {
        navigate(sessionPath(json.id), { state: { creating: { harness: started.harness, label: started.label } } })
      }
    } catch {
      setPresetLaunchError(pt ? 'Erro de rede ao falar com esta máquina.' : 'Network error talking to this machine.')
      setPresetLaunchForceable(false)
      setPresetLaunchBusy(false)
    }
  }

  // Never on a central: it aggregates many machines and hosts none of their sessions, so the only
  // fleet it could read is its own box's, drawn under someone else's rows.
  const { fleet, loading, unsupported: pollUnsupported, stale, act, refresh } = useFleet(pt ? 'pt' : 'en')
  useEffect(() => {
    if (sessionId && !loading && !fleet.sessions.some(r => r.id === sessionId || r.conversationId === sessionId)) loadClosedFleet()
  }, [sessionId, loading, fleet.sessions])
  /**
   * A CENTRAL cannot list a fleet, and must SAY so.
   *
   * `useFleet`'s second argument only stops the polling, and its `unsupported` is reported as false
   * whenever polling is off — so on a central the page fell through every branch to "No sessions on
   * this machine yet.", which is false twice over: a central hosts no sessions, and the machines'
   * sessions it CAN reach are one screen away in Settings → Machines. The one sentence that would
   * have said the true thing was switched off by the very flag that makes it true.
   *
   * The same N/A-versus-a-confident-0 rule the dashboard applies to harness capabilities: an empty
   * list may never stand in for "this install cannot answer".
   */
  // NOT `|| isCentral` any more: on a central the fleet is answered by the RELAY for the machine
  // the aside's picker has chosen, so `unsupported` is again exactly what the poller reports —
  // including the machine's own named refusal.
  const unsupported = pollUnsupported
  const rowIndex = useFleetIndex(fleet.sessions)

  /**
   * IDLE SESSIONS (Task 6) — the review modal, and the candidates published for the card in
   * `SessionsAside` (see `lib/idleReviewStore.ts`).
   *
   * `useHardwarePressureWatch` is called HERE, ahead of the rail's own use of `hardwareCritical`
   * further down this file, so `ramUnderPressure` — the SAME 5s hardware poll the rail's red icon
   * already reads, never a second interval (see that hook's own header and `useIdleSessions.ts`'s) —
   * is available before `useIdleSessions` needs it. The hook itself is unchanged; only where its one
   * call sits in this component moved, which is safe precisely because nothing between here and its
   * old position is a conditional hook call.
   */
  const { critical: hardwareCritical, ramUnderPressure } = useHardwarePressureWatch(pt ? 'pt' : 'en', pane === 'main')
  const { candidates: idleCandidates } = useIdleSessions({
    rows: fleet.rows,
    finishedTasks: fleet.finishedTasks,
    openSessionId: sessionId ?? null,
    underPressure: ramUnderPressure,
    // Never on a central (it relays another machine's fleet; the feature is local-only), never while
    // the poll itself cannot be trusted, and never before the first answer has arrived — the same
    // three facts `unsupported`/`loading` already state elsewhere on this page.
    enabled: pane === 'main' && !isCentral && !pollUnsupported && !loading,
  })
  const [idleOpen, setIdleOpen] = useState(false)
  useEffect(() => {
    const open = () => setIdleOpen(true)
    window.addEventListener('agentistics:open-idle-sessions', open)
    // A request made before this mount existed at all — see `lib/idleReviewRequest.ts`'s own header
    // for the race this closes (the bell's `navigate('/sessions')` only schedules the route change).
    if (takeIdleReviewRequest()) setIdleOpen(true)
    return () => window.removeEventListener('agentistics:open-idle-sessions', open)
  }, [])
  // Publish the summary the idle-review CARD reads (`SessionsAside.tsx`, mounted twice — the
  // desktop sidebar and the mobile list) — see `lib/idleReviewStore.ts`'s own header for why the
  // card cannot simply take these as props. Snooze and dismiss live in that store too, so this page
  // no longer owns any idle-review state beyond the modal's own open/closed flag.
  useEffect(() => {
    publishIdleReview(
      { count: idleCandidates.length, freedBytes: freedBytes(idleCandidates), candidateKeys: idleCandidates.map(c => c.key) },
      idleOpen,
    )
  }, [idleCandidates, idleOpen])

  // Matched on BOTH ids for the same reason `fleetIndex` is keyed on both: a managed row is named
  // by its tmux session, while a closed conversation is named by its own conversation id, and a
  // link may carry either.
  const selected = sessionId === undefined
    ? undefined
    : fleet.rows.find(r => r.id === sessionId || r.conversationId === sessionId)

  /**
   * THE DEDICATED TERMINAL — the same page at its own route, showing one screen and nothing else.
   *
   * Detected off the path rather than carried in state, which is the whole reason it is a route:
   * a reload lands back here, the link can be sent, and on a phone the router's own back gesture
   * already means "leave the terminal". `?pane=` says which screen; an unrecognised value resolves
   * to the assistant rather than blanking one (`readTerminalPane`).
   */
  const onTerminalRoute = useLocation().pathname.endsWith('/terminal')
  const dedicatedTerminal = pane === 'main' && onTerminalRoute
  const dedicatedPane = readTerminalPane(useSearchParams()[0].get('pane'))
  const shellEnabled = ctx.shellEnabled === true
  // `CAPS.localShell` alone, never narrowed by the preference — the disabled-shell empty state's
  // own two sub-states (buttons vs. a plain sentence) need this apart from the combined value
  // above. Undefined (older server, or the context has not loaded yet) reads as capable, the same
  // reading `capabilities?.localShell` gets everywhere else in this file.
  const shellCapable = ctx.capabilities?.localShell !== false
  // The disabled-shell empty state's two buttons need to make `ctx.shellEnabled` (and
  // `ctx.shellOverride`) catch up the instant either succeeds — this is the one way to do that
  // without a reload, the same call `SessionsSettings`'s own toggle already makes.
  const onShellEnabledChange = ctx.refreshTeamSession
  /**
   * The repository explorer's two switches, both already resolved upstream.
   *
   * `editorEnabled` is the server's own answer — the capability AND the user's switch, combined by
   * `sessions/editor-gate.ts` and reported on `GET /api/team/session`. It is never re-derived here
   * from `capabilities.localShell` plus a preference, and when it is not `true` the Studio is
   * ABSENT rather than an entry that refuses. `editorAutosave` is a plain preference, loaded with
   * the rest in `App.tsx`; absent reads as OFF for both.
   *
   * **THE CENTRAL TERM IS ALREADY IN IT, AND IS NOT RE-APPLIED HERE.** The whole `/api/fleet`
   * prefix is refused on a central, so every request the Studio makes is refused there — while
   * `editor-gate.ts` carries no central term at all, so a central on a `local` profile with the
   * preference on reports `true`. That subtraction happens where the value is PUBLISHED
   * (`lib/editorGate.ts`, spent in `App.tsx`'s `appCtx`), which is what closes every consumer at
   * once: this page's two entries, the desktop button beside them, and the `editorEnabled` prop
   * `ArtifactsAside` gates its strip entry and its Studio layer on — that component has no notion of
   * a central and must not grow one. Re-subtracting it here would be harmless arithmetic and a
   * harmful statement: that the published value is not to be trusted.
   */
  const editorEnabled = ctx.editorEnabled === true
  const editorAutosave = ctx.editorAutosave
  /**
   * Is THIS session reached through a central's relay? The same fact `SessionPanel` reads for the
   * same reason: a relayed session's `cli`/`shell` panes have no stream here at all (`/api/fleet` is
   * refused whole on a central), so those two switcher entries — and a `bottom`/`right` slot that
   * still names one from before the connection changed — must read as absent, never as present and
   * refusing. See `lib/panelSlots.ts`'s `resolveForGates`.
   */
  const relayed = false

  /**
   * WHERE A REOPEN LANDS — one place, for all three controls on this page that can perform one.
   *
   * A reopen mints a new managed row and RETIRES the one it was asked about, so staying on the id
   * in the URL leaves the reader on a session the next poll drops. The state it carries is what
   * makes the wait a wait instead of the fleet overview; the row it came FROM is what names it.
   */
  const goToReopened = (id: string) => {
    const r = reopenedSessionRoute(id, selected
      ? { id: selected.id, harness: selected.harness, title: selected.title }
      : undefined)
    // SPLIT: only THIS pane follows the new id; the other side is left exactly where it is. The
    // arrival state rides along for the main pane, whose route it describes.
    if (splitRoute) {
      navigate(splitHref(replaceInPane(splitRoute, pane, id), viewParams), pane === 'main' ? r.options : undefined)
      return
    }
    navigate(r.path, r.options)
  }

  /** This pane's session is gone or was closed: in a split only this side closes (the main pane's
   *  closing promotes the other session); otherwise back to the fleet, as always. */
  const closeThisPane = () => {
    if (splitRoute) navigate(splitHref(closePane(splitRoute, pane), viewParams))
    else navigate('/sessions')
  }

  /**
   * THE STORE'S RECORD for the open conversation — read ONCE, for the two surfaces that show it.
   *
   * The metrics card in the bar and the aside's METRICS tab are the small reading and the full one
   * of the same thing, so they must never be looked up apart: the card's link is what opens the
   * tab, and a card offering a link to a tab that does not exist is the dead control this product
   * refuses everywhere. `undefined` means the store has not seen this conversation yet, and then
   * BOTH are absent.
   *
   * By CONVERSATION id, never the managed one: a row is reopened under a new managed id and keeps
   * its conversation, which is what the record is keyed on.
   */
  const selectedMeta = selected?.conversationId !== undefined
    ? data?.sessions?.find(x => x.session_id === selected.conversationId)
    : undefined
  const sessionMetrics: SessionDrilldownProps | undefined = selectedMeta && data
    ? {
        session: selectedMeta,
        globalModelUsage: data.statsCache?.modelUsage ?? {},
        currency,
        brlRate,
        lang: pt ? 'pt' : 'en',
        ...(data.workflows ? { workflows: data.workflows } : {}),
      }
    : undefined

  /**
   * THE COMPOSER'S CONTEXT GAUGE (design item 3) — the SAME reading `selected`'s own mobile-header
   * `SessionStatsMenu` call takes, below, bundled through `SessionComposerMetrics` so `SessionChat`
   * gets it as one prop rather than five. `undefined` whenever there is no selected session at all;
   * the component itself withholds `onOpenFull` further when the store has no record, exactly as
   * the mobile card does.
   */
  const composerMetrics: SessionComposerMetrics | undefined = selected
    ? {
        meta: selectedMeta,
        currency,
        brlRate,
        costBasis: ctx.costBasis,
        planFactor: sessionPlanFactor(ctx.planBasis.basis, selected.harness),
        onOpenTask: ref => navigate(`/tasks/${encodeURIComponent(ref)}`),
        onOpenLive: ref => openArtifacts('live', ref),
        ...(sessionMetrics ? { onOpenFull: () => openArtifacts('metrics') } : {}),
      }
    : undefined

  /**
   * A SESSION THAT IS ON ITS WAY IS NOT A SESSION THAT IS MISSING.
   *
   * `NewSessionModal` navigates here the moment the spawn returns, and this browser's fleet does
   * not hold the row until its next poll — so `selected` is undefined and this page fell through
   * to its "nothing selected" branch, which is the fleet OVERVIEW. Creating a session therefore
   * flashed the metrics screen and jumped to the session a poll later. The overview was not wrong
   * about anything; it was answering a question nobody had asked.
   *
   * The router state is what tells the two apart, and it is BOUNDED: past the budget this stops
   * claiming the session is coming and the page says what it has always said — that the id names
   * nothing here. A loader with no end is the worse failure, because it cannot be told from a
   * session that simply never started.
   */
  /**
   * THE BUDGET BELONGS TO THE ID, NOT TO THE MOUNT — `sessionRoute.ts` carries the whole account.
   *
   * `creatingSince` was a `useState` taken once and never reset, so it measured from the moment the
   * PAGE was opened. Creating from the overview remounts this page (`sessions` and
   * `sessions/:sessionId` are different `<Route>`s), which is why it always looked right. A REOPEN
   * is `/sessions/A` -> `/sessions/B`: the same route, no remount, the stamp long spent — so the
   * guard did nothing and the fleet overview showed for the whole poll interval.
   *
   * Set during RENDER rather than in an effect: this is state derived from the URL, and an effect
   * would paint the overview for one frame before correcting itself, which is the flash being
   * fixed. `arrivalFor` returns the previous record unchanged for the same id, so it settles at
   * once instead of looping.
   */
  const routeCreatingState = (useLocation().state as { creating?: { harness?: string; label?: string } } | null)?.creating
  const creatingState = pane === 'main' ? routeCreatingState : undefined
  const [arrival, setArrival] = useState<SessionArrival | null>(null)
  const nextArrival = arrivalFor(arrival, sessionId, creatingState !== undefined, Date.now())
  if (nextArrival !== arrival) setArrival(nextArrival)
  const arriving = stillArriving(nextArrival, sessionId, Date.now())
  const creating = arriving && selected === undefined
  /**
   * ONE FRAME, and only so the finish is real.
   *
   * The bar can only reach 100 and turn orange on `ready`, and `ready` is the row arriving — which
   * is the same instant this page would swap in the session. Handing over on the next animation
   * frame lets that state be painted instead of existing only in the types. It is a frame, not a
   * beat: nothing here is watched to the end, and showing the session fast is the whole point.
   */
  // Keyed on the ARRIVAL, for the reason the budget is: a `useState(false)` flipped once per mount
  // stayed true for every later arrival on the same page, so only the first one got a finish frame.
  const [handedOver, setHandedOver] = useState<string | null>(null)
  const finishing = arriving && selected !== undefined && handedOver !== nextArrival?.id
  const arrivingId = nextArrival?.id
  useEffect(() => {
    if (!finishing) return
    const raf = requestAnimationFrame(() => setHandedOver(arrivingId ?? null))
    return () => cancelAnimationFrame(raf)
  }, [finishing, arrivingId])

  // The Chat/Terminal choice, in the URL — the SAME `?view=` the shared header in `App.tsx` reads
  // and writes on desktop. Independent `useSearchParams()` calls on the one search string, not a
  // prop threaded down from there: the header and this page can never disagree about which view is
  // showing without a context wire built just to carry two strings.
  const [viewParams, setViewParams] = useSearchParams()
  // Per pane: the split side's own choice is `?splitView=`, beside the main pane's `?view=`.
  const viewKey = pane === 'split' ? SPLIT_VIEW_PARAM : 'view'
  const sessionView: SessionView = initialSessionView({ requested: viewParams.get(viewKey) })
  const setSessionView = (v: SessionView) => setViewParams(prev => {
    const next = new URLSearchParams(prev)
    if (v === 'chat') next.delete(viewKey)
    else next.set(viewKey, v)
    return next
  }, { replace: true })

  /**
   * "Adicionado à mensagem" (§6, `mentionInsert.ts`'s `MENTION_ADDED_TOAST`) — a LOCAL, ephemeral
   * acknowledgement, not the server-side notification bell (`lib/notifications.ts`'s
   * `pushNotification`, which persists a row and is for account-wide events, not a one-off UI
   * confirmation). Shown only when a mention gesture fired `needsSwitch` — the composer was not on
   * screen, so the reader has nothing else telling them the reference landed. `useState` + a plain
   * `setTimeout`, the same shape `RepoFileEditor.tsx`'s own `SAVED_NOTICE_MS` already uses.
   */
  const [mentionNotice, setMentionNotice] = useState(false)
  useEffect(() => {
    if (!mentionNotice) return
    const t = setTimeout(() => setMentionNotice(false), 3000)
    return () => clearTimeout(t)
  }, [mentionNotice])
  /**
   * The ONE handler both Studio mention gestures fire through (the tree's "Mencionar na conversa"
   * and, via `EditorStack`, Monaco's "Mencionar seleção") — see `Studio.tsx`'s own `onMention` prop.
   * The reference is queued into the draft store either way (`composerStore.ts` survives the
   * composer not being mounted yet); this only switches the centre and raises the toast when the
   * composer was NOT on screen to show the reader anything happened.
   */
  const onStudioMention = (result: { text: string; needsSwitch: boolean }) => {
    if (!result.needsSwitch) return
    setSessionView('chat')
    setMentionNotice(true)
  }

  /** The fleet as the aside is showing it — one narrowing, read by both. */
  const overviewRows = useMemo(
    () => filterFleet({ rows: fleet.rows, filters, activeOnly }).rows,
    [fleet.rows, filters, activeOnly],
  )

  /**
   * THE ARTIFACTS PANEL.
   *
   * The list arrives from `SessionChat`, which already polls the conversation it is derived from —
   * a second poller for the same turns would be two readers disagreeing about one session. The open
   * flag lives in `artifactsStore` because the BUTTON is in the header, which is not an ancestor of
   * this page.
   */
  const [artifacts, setArtifacts] = useState<readonly Artifact[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(true)
  const [artifactsUnavailable, setArtifactsUnavailable] = useState<string | undefined>(undefined)
  /** The conversation behind these lists is the END of a longer one — see `chat-web.ts`'s `older`. */
  const [artifactsOlder, setArtifactsOlder] = useState<string | undefined>(undefined)
  /** The conversation's turns, for the LIVE tab — the same ones the chat renders. */
  const [artifactTurns, setArtifactTurns] = useState<readonly LiveTurn[]>([])
  /**
   * The session wrote through commands whose paths cannot be read AT ALL, so those files are in no
   * count anywhere.
   *
   * `SessionChat` has always computed it (`hasUnlistedWrites`) and for one release nothing read it:
   * its two surfaces went with the Files tab, and a computed-and-discarded honesty flag is worse
   * than either keeping it or deleting the producer. Re-homed beside the aside's header count, which
   * is the thing it qualifies — see `artifactShortfall`.
   */
  const [artifactsUnlisted, setArtifactsUnlisted] = useState(false)

  /**
   * WHICH of the recorded paths are still readable files with content — the server's answer, because
   * only it can look at the disk. A transcript records temporary files that were deleted, writes by
   * commands that failed, and redirections into directories that never existed; all three read like
   * a file somebody would want to open, and all three refuse when clicked.
   *
   * Keyed by the path AS RECORDED, which is the key the browser's own list is built on.
   */
  const [onDisk, setOnDisk] = useState<Map<string, { bytes: number; scope: 'project' | 'temp' }>>(new Map())
  /**
   * The route's `outside` sentence, already localized and carrying a COUNT rather than the paths.
   *
   * IT QUALIFIES OPENING, NOT LISTING, and a previous pass dropped it on the opposite reading. The
   * server's own words are `N file(s) this session wrote are outside its own folder and cannot be
   * OPENED here` (`fleet-web.ts`), and opening is still live in the aside: the gallery's produced
   * block, and a WROTE row in the live feed whose path was dropped — which renders as plain text
   * with nothing else to explain it, the exact report that made this sentence exist. The aside's
   * header count is short for the same reason. So it is re-homed beside that count, VERBATIM: the
   * server worded it and a second wording here would be a second answer to one question.
   */
  const [outsideNote, setOutsideNote] = useState<string | undefined>(undefined)
  /**
   * `onDisk` is now a FILTER and nothing else — what the aside drew as a per-row size and scope went
   * with the Files and Docs tabs. The read stays because the filter does: the aside's gallery and its
   * live feed both link to paths, and a link whose only outcome is a refusal is worse than no link.
   */
  useEffect(() => {
    // A relayed session's files are on ANOTHER machine; `/api/fleet/artifacts` is refused on a
    // central, and polling it every 15s only produced 403s. See `lib/relayedAside.ts`.
    if (!selected || relayed) { setOnDisk(new Map()); setOutsideNote(undefined); return }
    let alive = true
    // The sentence holds a count about ONE session, so it is cleared the moment the session changes
    // — unlike `onDisk`, which is deliberately kept so the list is never empty for the length of a
    // request. A count carried over from the previous session is a wrong claim, not a stale one.
    setOutsideNote(undefined)
    const read = async () => {
      try {
        const r = await fetch(`/api/fleet/artifacts?id=${encodeURIComponent(selected.id)}&lang=${pt ? 'pt' : 'en'}`)
        if (!r.ok || !alive) return
        const d = await r.json() as {
          files?: { raw: string; bytes: number; scope: 'project' | 'temp' }[]
          outside?: string
        }
        setOnDisk(new Map((d.files ?? []).map(f => [f.raw, { bytes: f.bytes, scope: f.scope }])))
        setOutsideNote(d.outside)
      } catch { /* the list simply stays as it was */ }
    }
    void read()
    // Slower than the conversation poll: a file's EXISTENCE changes far less often than the
    // conversation does, and this one stats every recorded path.
    const t = setInterval(read, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [selected?.id, pt, relayed])

  /**
   * The panel's width, dragged and remembered — the right aside was fixed while the left one has
   * always been resizable, and a reader comparing a file with the conversation needs to choose
   * which of the two gets the room.
   */
  const [artWidth, setArtWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('agentistics:artifacts-w'))
    // 620 by default, not 440: the panel's job is reading a FILE, and code at 440px wraps or
    // scrolls sideways on nearly every line. A reader who wants the conversation wider can drag it
    // back, and that choice is remembered.
    //
    // THE CAP IS THE VIEWPORT'S OWN ROOM (design item 6), not a flat 900px any more — that ceiling
    // was reported too narrow on a wide monitor, where it was barely half the screen. See
    // `artifactsPanelMax`.
    const cap = artifactsPanelMax(typeof window === 'undefined' ? 1440 : window.innerWidth)
    return Number.isFinite(v) && v >= PANEL_MIN_WIDTH ? Math.min(v, cap) : 620
  })
  const dragArt = useRef<{ x: number; w: number } | null>(null)
  /** A resize in progress. Only used to suspend the open/close animation — see `asideMotion`. */
  const [artDragging, setArtDragging] = useState(false)
  // The value actually being persisted on release — read through a ref, not the `artWidth` state
  // itself, so the effect below never needs `artWidth` as a dependency. See the ref's own comment.
  const artWidthRef = useRef(artWidth)
  artWidthRef.current = artWidth
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragArt.current) return
      // The panel grows as the pointer moves LEFT, so the delta is inverted. The cap is read FRESH
      // on every move rather than captured once — a window resized mid-drag is the same situation
      // `artifactsPanelMax` already handles for an ordinary reflow.
      const cap = artifactsPanelMax(window.innerWidth)
      const next = Math.max(PANEL_MIN_WIDTH, Math.min(cap, dragArt.current.w + (dragArt.current.x - e.clientX)))
      setArtWidth(next)
    }
    // Every event that must end a drag (`isDragEndEvent`), not `mouseup` alone — and, LOAD-BEARING,
    // this effect is now REGISTERED ONCE (`[]` below) rather than on `[artWidth]`. It used to tear
    // its window listeners down and rebuild them on every `setArtWidth` call inside `move` — i.e. on
    // every single `mousemove` of the drag — which is harmless on its own (teardown and resubscribe
    // happen back to back) but is exactly the failure mode a T-junction (`PanelGap.tsx`'s `armGap`)
    // exposes: this gap and the band's own drag are armed together off ONE synthetic `mousedown`, and
    // a release landing in the gap between one side's teardown and its resubscribe left this panel
    // still tracking the pointer after the mouse button had already come up.
    const up = (e: Event) => {
      if (!dragArt.current) return
      if (!isDragEndEvent(e.type)) return
      dragArt.current = null
      setArtDragging(false)
      document.body.style.userSelect = ''
      try { localStorage.setItem('agentistics:artifacts-w', String(artWidthRef.current)) } catch { /* private mode */ }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
    }
  }, [])
  /**
   * WHERE THE STUDIO, CLI AND SHELL SIT — `lib/panelSlots.ts`, design §1. `resolveForViewport` is
   * the phone reading: a stored `bottom: 'studio'` becomes the fullscreen right sheet without
   * rewriting what a desktop would see. `rightSlotEl` / `bottomStudioEl` are the physical DOM boxes
   * `StudioHost` moves its persistent carrier into — see that component's own header for why a MOVE
   * must never be a remount.
   *
   * `resolveForGates` is applied on TOP of that, for the same reason and the same way: a layout
   * stored while `editorEnabled` (or `shellEnabled`, or a local session) was true must not render an
   * empty, unclosable pane the moment the gate closes — turning the switch off in Settings, opening
   * a different, relayed session, reloading on a machine where the preference has changed. Neither
   * resolution rewrites storage; turning the gate back on restores the layout exactly as it was left.
   */
  const {
    layout: rawSlotLayout, openPanel: openSlotPanel, closePanel: closeSlotPanel,
    movePanel: moveSlotPanel, dropPanel: dropSlotPanel, setRightOpen,
    hidePanelToConfig: hideSlotPanel, restorePanel: revealSlotPanel, setRailWidth,
    setBottomOpen: setSlotBandOpen,
  } = usePanelSlots()
  /**
   * PINNED PANELS FLOAT (`lib/floatingPanels.ts`, owner 2026-09-27). The windows belong to the
   * session on screen — keyed by `sessionIdentityKey`, so a reopen keeps them — and nothing floats
   * on a phone. Declared to the store in a LAYOUT effect, before paint, because `usePanelSlots()`
   * reads it to take the floating panels out of their docked slots for every consumer at once.
   */
  const floatingKey = !isMobile && selected ? sessionIdentityKey(selected) : null
  useLayoutEffect(() => { setFloatingSession(floatingKey, pane) }, [floatingKey, pane])
  useLayoutEffect(() => () => setFloatingSession(null, pane), [pane])
  const floating = useFloatingPanels()
  const panelFocus = usePanelFocusRequest()
  const panelGates: PanelGates = { editorEnabled, shellEnabled, relayed }
  const slotLayout = resolveForGates(resolveForViewport(rawSlotLayout, isMobile), panelGates)
  const rightIsStudio = slotLayout.right === 'studio'
  /**
   * THE STUDIO'S OWN REAL PLACEMENT — `rawSlotLayout`, never `slotLayout` (which
   * `resolveForViewport` has already folded for a phone's viewport: a `bottom`-placed, bottom-
   * band-active Studio reads as `slotLayout.right === 'studio'` there too, with nothing left in
   * this fact to tell "genuinely on the rail" apart from "placed at the bottom, shown as the
   * phone's full sheet because there is no bottom band to hold it"). `rightIsStudio` answers a
   * VISUAL question (what is currently drawn where) and stays correct for that; this answers a
   * PLACEMENT question, and the gear's move label/verb need the second one — see `Studio.tsx`'s
   * own `placement` prop for the bug this fixes (rail-loose-ends, item 4: the mobile gear kept
   * reading "Mover Studio para baixo" even once the Studio's real placement already was 'bottom').
   */
  const studioPlacement: OpenPlacement = rawSlotLayout.placement.studio === 'bottom' ? 'bottom' : 'rail'
  const rightIsCli = slotLayout.right === 'cli'
  const rightIsShell = slotLayout.right === 'shell'
  const rightIsHardware = slotLayout.right === 'hardware'
  /** Is the right slot showing one of the ten former Contents tabs right now? Replaces the old
   *  `rightIsContents` — every one of the ten now carries its own occupancy directly. */
  const rightIsTab = slotLayout.right !== null && isTabPanelId(slotLayout.right)
  const bottomIsStudio = slotLayout.bottom === 'studio'
  const bottomIsTab = slotLayout.bottom !== null && isTabPanelId(slotLayout.bottom)
  const bottomIsHardware = slotLayout.bottom === 'hardware'
  const [rightSlotEl, setRightSlotEl] = useState<HTMLDivElement | null>(null)
  const [bottomStudioEl, setBottomStudioEl] = useState<HTMLDivElement | null>(null)
  /** The floating window's box, when the Studio floats — a third place `StudioHost` can move its
   *  carrier into, so floating it is a MOVE (buffers survive), never a remount. */
  const [floatStudioEl, setFloatStudioEl] = useState<HTMLDivElement | null>(null)
  const studioFloating = floating.studio !== undefined
  /** Floating AND on screen — a MINIMIZED Studio window parks its carrier like a collapsed band. */
  const studioWindowShown = studioFloating && floating.studio?.min !== true
  /** `null` PARKS the Studio — mounted, hidden, taking no space — which is also what a COLLAPSED
   *  bottom band, or a MINIMIZED right slot (`slotLayout.rightOpen`, the right slot's own analogue
   *  of `bottomOpen` — see `panelSlots.ts`'s own doc comment), holding it means: collapsing or
   *  minimizing must not be a way to lose a buffer. */
  const studioTarget: HTMLElement | null = studioFloating ? (studioWindowShown ? floatStudioEl : null)
    : rightIsStudio && slotLayout.rightOpen
    ? rightSlotEl
    : bottomIsStudio && slotLayout.bottomOpen ? bottomStudioEl : null
  /**
   * TRUE FULL SCREEN for the Studio — the whole viewport, not merely "fills the centre column"
   * (`SessionPanel`'s own `heightPrefs.full`, untouched by this). Held HERE, not inside `StudioBand`
   * itself, because `Studio.tsx`'s own gear menu (the deliberate, non-drag way to ask for the same
   * thing, and the one place its own exit control lives) is a SIBLING mount reached through
   * `StudioHost`'s portal below — the two can only ever agree on which state is current if something
   * above both of them owns the one flag.
   *
   * OFFERED IN EITHER SLOT AS OF 2026-09-19 (`fullscreenModeFor`'s own `'overlay'` mode) — it used
   * to be bottom-only, because the right slot had no wrapper that would cover the viewport for it;
   * `rightSlotContent`'s own wrapper below is that missing piece. The SAME flag drives both, so
   * moving the Studio between slots while full screen carries the state across rather than silently
   * dropping it.
   *
   * RESET the moment the Studio is shown NOWHERE at all (closed, displaced by another panel in both
   * slots at once — which cannot really happen, but the check costs nothing) — a lingering `true`
   * would silently reopen full screen the next time it is shown again, from a plain "Expandir" press
   * nobody asked to mean that.
   */
  const [studioFullscreen, setStudioFullscreen] = useState(false)
  useEffect(() => {
    if (!rightIsStudio && !bottomIsStudio) setStudioFullscreen(false)
  }, [rightIsStudio, bottomIsStudio])

  /**
   * TRUE FULL SCREEN for any of the ten former Contents tabs, or Hardware (owner, 2026-09-19 — same
   * request as the Studio's own: "botões que ficaram fixos... tela cheia"). None of these panels has
   * a dedicated screen of its own to navigate to (`fullscreenModeFor` — `'overlay'`), so this is the
   * exact same in-place viewport overlay the Studio already uses.
   *
   * ONE SHARED FLAG, exactly like `studioFullscreen` ("OFFERED IN EITHER SLOT... The SAME flag
   * drives both") — widened here from "one flag per fixed panel type" to "one flag for the whole
   * eleven-panel domain", since only one of them is ever meaningfully full screen at a time from a
   * reader's perspective. Reset the moment NEITHER slot shows one of them, for the same reason
   * `studioFullscreen` resets.
   */
  const [tabFullscreen, setTabFullscreen] = useState(false)
  useEffect(() => {
    const rightIsTabOrHardware = rightIsTab || rightIsHardware
    const bottomIsTabOrHardware = bottomIsTab || bottomIsHardware
    if (!rightIsTabOrHardware && !bottomIsTabOrHardware) setTabFullscreen(false)
  }, [rightIsTab, rightIsHardware, bottomIsTab, bottomIsHardware])
  const onArtifacts = useCallback((a: { artifacts: Artifact[]; loading: boolean; unavailable?: string; older?: string; unlisted: boolean; turns: readonly LiveTurn[] }) => {
    setArtifacts(a.artifacts)
    setArtifactTurns(a.turns)
    setArtifactsLoading(a.loading)
    setArtifactsUnavailable(a.unavailable)
    setArtifactsOlder(a.older)
    setArtifactsUnlisted(a.unlisted)
    if (selected) {
      setArtifactCount(selected.id, a.artifacts.length)
      // WHAT THE SESSION IS DOING NOW, for the metrics card's Live reference — drawn from `App.tsx`,
      // outside this page, so it cannot read these turns. Published from HERE because this callback
      // carries the turns of the conversation that is actually mounted: reading `artifactTurns`
      // state in an effect would publish the PREVIOUS session's turns under the new one's id for
      // the first poll after a switch.
      setArtifactLive(selected.id, currentAction(liveEvents(a.turns)))
    }
  }, [selected])
  /**
   * NOBODY IS READING THE CONVERSATION, SO NOBODY CAN SAY WHAT IT IS DOING.
   *
   * The Terminal view unmounts the chat that publishes the live fact, and leaving the page unmounts
   * this one; either would leave the last "running bun test" in the store for as long as the page is
   * away. A stale claim of activity on the metrics card is worse than none, so the fact is cleared
   * whenever its reader goes — and a chat that mounts afterwards publishes again on its own first
   * report (child effects run after this cleanup).
   */
  const selectedId = selected?.id
  useEffect(() => {
    if (selectedId === undefined) return
    if (sessionView !== 'chat') setArtifactLive(selectedId, null)
    return () => setArtifactLive(selectedId, null)
  }, [selectedId, sessionView])

  /**
   * NOTHING OPENS THIS PANEL BUT A PERSON.
   *
   * It used to open itself when a file started being written — asked for, in those words, and then
   * asked to stop: "a barra de contents ta abrindo sozinha as vezes, nao quero que isso aconteça".
   * Both asks are the same underlying want, and the second one names the part that matters: what a
   * reader wants is to KNOW something is happening, not to have the conversation they are reading
   * shoved aside by a panel taking half the screen.
   *
   * The strip carries that now. It appears while the session is writing or running, says what and
   * where, and opens the panel on the live feed when it is pressed — an announcement, and then a
   * choice, instead of an interruption. `shouldAutoOpen` is gone rather than left unused: a rule
   * nothing calls is a rule that gets called again by somebody who finds it. The strip's own
   * condition is `edgeHint` further down, over the live EVENTS — a broader signal than "a file is
   * being written", which is what makes it able to announce a command and its output too.
   */

  /**
   * ON THE DEDICATED TERMINAL SCREEN, THE RIGHT SLOT MUST NEVER SHOW THE SAME PANE THAT IS ALREADY
   * FULL SCREEN (change #2 — respecting the artifacts aside means the dedicated CLI/Shell screen
   * now renders it BESIDE itself, below, whenever it was already open; see the dedicated-terminal
   * branch's own header). `cli`/`shell` can sit in the right slot independently of what this route
   * shows (`fullscreenModeFor`'s `'navigate'` mode never removes them from `panelSlots` on the way
   * in), so without this a session whose CLI pane happened to also be assigned to the right slot
   * would show its own terminal TWICE — once as the dedicated page, once as a redundant aside beside
   * it. Contents/Studio/Hardware are unaffected: those genuinely are something ELSE to show beside
   * the terminal, not a copy of it.
   */
  const dedicatedRightRedundant = dedicatedTerminal
    && ((dedicatedPane === 'assistant' && rightIsCli) || (dedicatedPane === 'shell' && rightIsShell))

  const artLayout = resolveArtifactLayout({
    // The RIGHT SLOT is open whenever Contents wants it OR panelSlots has put the Studio, Claude
    // Code, the Shell or Hardware there — opening any of them from a switcher must show the box
    // even though none of them touch `art.open`; see `StudioHost.tsx` and `lib/panelSlots.ts`.
    // Missing one of these here is exactly the shape of bug this comment already warns about for
    // the Studio: the switcher can pick the panel and the box never opens to show it — measured
    // live for `hardware` (design item 3): the header tab lit, `rightSlotContent` correctly chose
    // the `HardwarePanel` branch, and the aside stayed at ZERO width because nothing here had told
    // `resolveArtifactLayout` this was a reason to open it at all.
    //
    // `rightPanelOpen` is the box's own MINIMIZE state (owner, 2026-09-19): only the Studio ever
    // reads `false` here — Contents/Hardware/CLI/Shell minimize by a genuine `closePanel`
    // (`panelMenu.ts`'s own `panelMinimizeAction`), which already reads as "not occupying the slot"
    // through the flags above, so `slotLayout.rightOpen` only ever narrows the ONE case those flags
    // cannot already see: the Studio still assigned to the slot, parked rather than shown.
    open: slotLayout.right !== null
      && (!rightIsStudio || slotLayout.rightOpen) && selected !== undefined
      && !dedicatedRightRedundant,
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    isMobile,
    // Phase B ships without the reversal control; the split-rail default is what the plan measured.
    listExpandedByUser: false,
  })

  /**
   * THE PANEL SLIDES, and it slides like the nav does.
   *
   * Two things are needed for a width to animate, and the panel had neither: the element must be
   * MOUNTED while it shrinks (a closed panel was returning a different tree entirely, so closing
   * was an unmount and nothing could tween), and it must OPEN from a width it was rendered at
   * (mounting straight at 620px is a jump, not a transition).
   *
   * So `asideAlive` keeps it on screen for the length of the animation after it is closed, and
   * `asideIn` is flipped a frame LATER, which is what gives the browser a from-value. Two frames,
   * not one: React can commit the mount and the flag in the same paint, and then there is nothing
   * to interpolate between.
   *
   * `ASIDE_ANIM_MS` is read for BOTH the transition and the unmount delay — a second constant is a
   * second chance for the content to vanish while its box is still shrinking.
   */
  const asideShown = artLayout.layout !== 'closed'
  const [asideAlive, setAsideAlive] = useState(asideShown)
  const [asideIn, setAsideIn] = useState(asideShown)
  useEffect(() => {
    if (asideShown) {
      setAsideAlive(true)
      let inner = 0
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setAsideIn(true)) })
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
    }
    setAsideIn(false)
    const t = setTimeout(() => setAsideAlive(false), ASIDE_ANIM_MS)
    return () => clearTimeout(t)
  }, [asideShown])
  /**
   * WHICH exit to play. A layout is decided by the window width, so a panel closed after the window
   * narrowed must not slide out as the layout it is no longer in — the split shrinks its width and
   * the overlay slides off the right edge, and playing the wrong one leaves the panel jumping to
   * full width before it goes. Held in a ref, so remembering it never costs a render.
   */
  const closingAs = useRef<ArtifactLayout>('split')
  if (asideShown) closingAs.current = artLayout.layout
  /** The width the split animates between. Zero while closing; the drag suspends the tween. */
  const asideMotion = artDragging ? 'none' : `width ${ASIDE_ANIM_MS}ms ${ASIDE_EASE}`
  /**
   * The room the split actually has, MEASURED — not `window.innerWidth` minus a guess at the nav.
   *
   * It is what `panelWidth` clamps the stored width against, and it has to be observed rather than
   * computed once: the nav collapses, the fleet list becomes a rail when the panel opens, and the
   * window is resized. Each of those changes the room without changing anything this component
   * renders, so a value read at mount would be wrong by the second frame.
   */
  const splitRef = useRef<HTMLDivElement | null>(null)
  const [splitRoom, setSplitRoom] = useState(0)
  useEffect(() => {
    const el = splitRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setSplitRoom(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  })
  /** What the panel may take here, as opposed to what it remembers wanting. See `panelWidth`. */
  const shownArtWidth = panelWidth(splitRoom, artWidth)

  /**
   * THE EDGE MARKER — what the harness is doing right now, with the panel shut.
   *
   * Asked for directly: a session that starts working should say so from the edge of the screen,
   * and clicking it should open the live view. `edgeHint` decides whether there is anything worth
   * saying; this only draws it.
   */
  const hint = edgeHint({
    // Is ONE of the ten former Contents tabs already visible somewhere — the reader can already
    // see what is happening, so the hint has nothing left to announce.
    open: rightIsTab || bottomIsTab,
    events: liveEvents(artifactTurns),
    isMobile,
  })
  const HINT_VERB: Record<string, string> = {
    wrote: pt ? 'escrevendo' : 'writing',
    read: pt ? 'lendo' : 'reading',
    ran: pt ? 'rodando' : 'running',
    thought: pt ? 'pensando' : 'thinking',
    delegated: pt ? 'delegando' : 'delegating',
    // An MCP or any other tool no rule above recognises. Without it the verb was blank and the label
    // read `undefined · <tool>`; the references list already says "usando" for the same kind.
    used: pt ? 'usando' : 'using',
  }
  const edgeMarker = hint === null || selected === undefined ? null : (
    <button
      // LIVE, not wherever the panel was last left: this control says the harness is running
      // something, so the answer to pressing it is the feed of what it is doing.
      // LIVE, and ON THE ACTION IT NAMES. Landing on the top of the feed made the strip a
      // navigation control rather than an answer: it says "running bun test", and the row saying
      // so is somewhere in a list the reader then has to search. `hint.ref` is absent for an event
      // with no step behind it (reasoning carries its own text), and then this opens the feed
      // exactly as it did before.
      onClick={() => openArtifacts('live', hint.ref)}
      className="ag-edge-hint"
      title={`${HINT_VERB[hint.kind]} · ${hint.text} — ${pt ? 'acompanhar' : 'follow'}`}
      aria-label={`${HINT_VERB[hint.kind]} ${hint.text}. ${pt ? 'Abrir o acompanhamento ao vivo' : 'Open the live view'}`}
      style={{
        // THIRD PLACE, and the first two were both wrong for the same reason: it FLOATED.
        // Hanging off the middle of the right edge it covered the conversation's text; sitting
        // above the composer it covered the composer — "ficou ULTRA em cima do input de prompt".
        // Anything absolutely positioned over a chat is over SOMETHING, because a chat has no
        // reliably empty region: the messages grow up from the composer and the gap between them
        // closes as soon as there is anything to read.
        // So it stopped floating. It is a strip at the TOP of the conversation, in the flow, under
        // the header — the place a status line lives in every application that has one, pushing
        // the messages down by its own height instead of hiding one of them. It is also where the
        // eye goes when something changes, which is the whole reason it exists.
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        width: '100%', padding: '7px 14px', textAlign: 'left', cursor: 'pointer',
        // On the desktop board the strip is its OWN small panel — border, 10px corners and the
        // same inner gap (`PANEL_GAP`) below it every other panel seam uses — instead of a square
        // band laid across the top of the conversation.
        ...(isMobile
          ? { border: 'none', borderBottom: '1px solid var(--border-subtle)' }
          : { border: PANEL_BORDER, borderRadius: PANEL_RADIUS, marginBottom: PANEL_GAP, boxSizing: 'border-box' as const }),
        background: 'var(--anthropic-orange-dim)', color: 'var(--text-primary)',
        fontFamily: 'inherit', fontSize: 11.5,
      }}
    >
      {/* It PULSES, because the fact it reports is that something is happening right now — a
          static dot beside a static line is indistinguishable from a label. */}
      <span aria-hidden className="ag-hint-pulse" style={{
        width: 7, height: 7, borderRadius: 4, flexShrink: 0,
        background: 'var(--anthropic-orange)',
      }} />
      <span style={{ fontWeight: 700, color: 'var(--anthropic-orange)', flexShrink: 0 }}>
        {HINT_VERB[hint.kind]}
      </span>
      {/* The THING, not a count: a path or a command says whether this is worth watching. It takes
          the room its text needs and no more, so the arrow can sit right after it instead of a
          screen away at the far end. */}
      <span className="ag-edge-hint-text" style={{
        minWidth: 0, flex: '0 1 auto', color: 'var(--text-tertiary)', fontSize: 11,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
      }}>{hint.text}</span>
      {/* THE AFFORDANCE. The whole strip is the control, and a line of text with a dot in front of
          it does not say so. The arrow is what says "this goes somewhere", it nudges on hover, and
          the text underlines with it — the pair that says "clickable" on any link. The words
          "acompanhar →" that used to close the bar are gone: they said it a screen away from the
          thing they were about. */}
      <ArrowRight
        aria-hidden
        className="ag-edge-hint-arrow"
        size={13}
        style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }}
      />
      <span style={{ flex: 1 }} />
    </button>
  )

  /**
   * THE PANEL'S OWN FULL-SCREEN/MINIMIZE/GEAR TRIO — the SAME `PanelFixedControls` cluster every
   * panel in this workspace draws, in the SAME order, through the SAME shared builder
   * (`lib/panelMenu.ts`), so this can never disagree with what `ShellBand`'s own bar or a bottom
   * band says about an identical gesture.
   *
   * MOVED AHEAD OF `tabPane` (fix-wave review, item 5: "every panel drawn in the right slot has ONE
   * header row — the panel's own title and its counts on the left, the controls right-aligned in
   * that same row. No separate strip above it. Do it once, in the shared chrome that wraps a
   * right-slot panel"). This trio used to be built INSIDE `rightSlotBar`, a separate strip drawn
   * ABOVE whatever the panel itself rendered — for `cli`/`shell` (which draw no header of their
   * own) that cost nothing, but Hardware and the ten former Contents tabs each ALSO draw their own
   * title row, so the two together were a mostly-empty controls-only strip sitting on top of a
   * second, real header — exactly the "empty header" the owner's Hardware/Skills screenshots show.
   * Pulled out here as its own function, this trio is now handed to those two as a PROP
   * (`HardwarePanelProps.controls`, `ArtifactsAsideProps.headerControls`) and merged into the ONE
   * header row they already draw, and `rightSlotBar` (further down, where `cli`/`shell` still need
   * a wrapper row of their own) is left as a thin caller of this same function — one builder, never
   * two answers about what the trio looks like.
   *
   * The STUDIO is deliberately absent from every caller of this: it already carries this exact trio
   * — its own gear (tree options + close), its own minimize icon, and its own fixed full-screen
   * button — inside its OWN toolbar (`Studio.tsx`), because that toolbar is what stays visible
   * across the tree/search/editor views a generic header row would otherwise sit above. Calling this
   * for Studio too would be two bars for one panel.
   *
   * FULL SCREEN (2026-09-19) is `fullscreenModeFor(panel)`-dependent: `cli`/`shell` NAVIGATE to
   * their existing dedicated screen (never a toggle — there is nothing to read back as "active"
   * from here), `contents`/`hardware` toggle the local in-place overlay this page now owns for them.
   *
   * Minimizing here is a genuine CLOSE (`panelMenu.ts`'s own `panelMinimizeAction` — `close-right`),
   * which is SAFE for exactly these four: none holds client-only state a remount could lose. The
   * outcome a reader sees is identical to a soft minimize either way — released from view, restored
   * with one click on the panel bar's own tab.
   */
  const panelFixedControlsFor = (
    panel: Exclude<PanelId, 'studio'>, panelName: string, onMinimize: () => void,
  ): ReactNode => {
    if (isMobile || !selected) return null
    // NO GEAR (addendum, 2026-09-21): every panel this trio is ever built for (`Exclude<...,
    // 'studio'>`) had exactly ONE gear row — move to the bottom — and that row now lives on the
    // rail ICON'S OWN right-click menu instead (`PanelRail`'s `onMove`, reachable for the exact
    // same panel since it is this slot's active occupant). A gear with nothing left to hold is
    // absent, never empty and present (`BandOverflowMenu`'s own rule) — this simply never builds
    // one.
    const gearEntries: never[] = []
    const fullscreen = fullscreenModeFor(panel) === 'navigate'
      ? {
        active: false,
        onToggle: () => navigate(dedicatedTerminalPath(selected.id, panel === 'cli' ? 'assistant' : 'shell')),
      }
      : {
        active: tabFullscreen,
        onToggle: () => setTabFullscreen(f => !f),
      }
    return (
      <PanelFixedControls
        lang={pt ? 'pt' : 'en'}
        panelName={panelName}
        fullscreen={fullscreen}
        onMinimize={onMinimize}
        minimizeLabel={pt ? `Minimizar ${panelName}` : `Minimize ${panelName}`}
        // PIN = FLOAT (`lib/floatingPanels.ts`): the panel leaves the right slot and becomes a
        // window over the session area. Desktop only — this function already returns null on a phone.
        pinned={{ active: false, onToggle: () => floatPanel(panel) }}
        gearLabel={pt ? `Opções — ${panelName}` : `${panelName} options`}
        gearEntries={gearEntries}
      />
    )
  }

  /**
   * ONE OF THE TEN FORMER CONTENTS TABS, AS ITS OWN PANEL — the function every mount site (the
   * right slot, and the bottom band when a different one of the ten is docked there) calls, bound
   * to the one tab id it is showing (`ArtifactsAsideProps.activeTab`). Two mounts can exist at
   * once, each fetching only for its own tab — see `ArtifactsAside`'s own module header.
   *
   * `key={selected.id}` alone, deliberately NOT keyed on `id` too: switching WHICH tab is active in
   * one slot reuses the same mounted instance (matching the historical behaviour, before each tab
   * was its own panel, where switching the internal `tab` state never remounted anything); switching
   * SESSION does reset it, since every per-session cache/effect in `ArtifactsAside` is keyed there.
   */
  const tabPane = (
    id: TabPanelId, opts?: { hideCloseButton?: boolean; headerControls?: ReactNode },
  ): ReactNode => selected === undefined ? null : (
    <ArtifactsAside
      key={selected.id}
      {...(opts?.hideCloseButton ? { hideCloseButton: true } : {})}
      {...(opts?.headerControls ? { headerControls: opts.headerControls } : {})}
      sessionId={selected.id}
      activeTab={id}
      // The MCP tab's per-directory scopes are resolved against this; with no directory they are
      // absent from the picker rather than silently widened to "this machine".
      {...(selected.cwd ? { cwd: selected.cwd } : {})}
      lang={pt ? 'pt' : 'en'}
      // Only what the server confirmed is still a file with content. Until it has answered the
      // list is shown as recorded, so the panel is never empty for the length of a request.
      artifacts={onDisk.size === 0 ? artifacts : artifacts.filter(a => onDisk.has(a.path))}
      loading={artifactsLoading}
      {...(artifactsUnavailable ? { unavailable: artifactsUnavailable } : {})}
      {...(artifactsOlder ? { older: artifactsOlder } : {})}
      // WHY THE HEADER COUNT IS SHORT — the two facts, each to the surface that qualifies the
      // claim. `outsideNote` is the server's sentence, passed through untouched.
      unlistedWrites={artifactsUnlisted}
      {...(outsideNote ? { outsideNote } : {})}
      turns={artifactTurns}
      // A REQUEST for a DIFFERENT tab than `id` is not this mount's concern — see
      // `artifactsStore.ts`'s own `PanelFocusRequest` header.
      focusRequest={panelFocus && panelFocus.tab === id
        ? { ...(panelFocus.ref ? { ref: panelFocus.ref } : {}), at: panelFocus.at } : null}
      // The session itself, for the TASKS tab: what it is filed under, and the composer that files
      // it somewhere new without leaving the session you are sitting in.
      session={{
        id: selected.id,
        title: selected.title,
        harness: selected.harness,
        ...(selected.task ? { task: selected.task } : {}),
      }}
      onOpenTask={taskId => navigate(`/tasks/${encodeURIComponent(taskId)}`)}
      // The badge on the row is the fleet's; re-poll so it agrees with what the tab just did.
      onTaskChanged={refresh}
      // See `sessionMetrics`: present exactly when the store has a record, which is the same fact
      // that decides whether the metrics card offers its link.
      {...(sessionMetrics ? { metrics: sessionMetrics } : {})}
      onClose={() => closeSlotPanel(id)}
      // The search handed a message to the chat (go to it / forward it). On a phone the panel covers
      // the chat, so get out of the way — collapsing the BAND when it is docked there: taking the
      // panel out of the band alone leaves the band open on its terminal tab.
      onHandedToChat={() => (slotLayout.bottom === id ? setSlotBandOpen(false) : closeSlotPanel(id))}
    />
  )
  // ADDENDUM ITEM 4 — the right slot's own header close button is hidden on DESKTOP, where
  // `rightSlotBar`'s `PanelFixedControls` minimize already calls the exact same `closeSlotPanel(id)`
  // (`panelMinimizeAction`'s `close-right` — every one of these ten panels closes outright on
  // minimize there, never merely collapses). On MOBILE there is no `rightSlotBar` at all
  // (`rightSlotBar` itself returns `null` there), so the header's own button stays the only way out.
  const rightTabPane = slotLayout.right !== null && isTabPanelId(slotLayout.right)
    ? tabPane(slotLayout.right, {
      hideCloseButton: !isMobile,
      // THE TRIO, folded into `ArtifactsAside`'s own header row now — see `panelFixedControlsFor`'s
      // own header for why this used to be `rightSlotBar`'s separate, mostly-empty strip instead.
      headerControls: panelFixedControlsFor(
        slotLayout.right, panelTitle(slotLayout.right, pt), () => closeSlotPanel(slotLayout.right!),
      ),
    })
    : null
  // THE BOTTOM BAND HIDES IT TOO (owner, 2026-09-29: a panel moved to the bottom bar showed the
  // aside's own "close the panel" button, which read as a stray "minimize the aside" control inside
  // the bar). The band's own bar already carries the minimize for whatever it docks, right above
  // this header — the same duplicate the right slot removed. Mobile keeps it, for the same reason
  // the right slot does: there is no such bar there.
  const bottomTabPane = slotLayout.bottom !== null && isTabPanelId(slotLayout.bottom)
    ? tabPane(slotLayout.bottom, { hideCloseButton: !isMobile }) : null

  /**
   * THE SAME `HardwarePanel` ELEMENT, reused for the BOTTOM band too (owner, 2026-09-19: "o hardware
   * nao ta com a opcao de abrir no componente inferior"). One figure, one poll, one close action —
   * never a second implementation forked for the band, exactly as `artifactsPane` above is shared
   * between the right slot and (below) the bottom one.
   *
   * THE RIGHT SLOT GETS ITS OWN SEPARATE ELEMENT NOW (`hardwarePaneRightEl`, below this one) rather
   * than reusing this one — the two placements need different props (`hideCloseButton`/`controls`
   * for the merged single-header-row right slot; neither for the bottom band, whose own
   * `SimpleDockedBand` bar already draws the trio in its OWN row — which is also why the bottom
   * element hides its own close button on desktop, like the right one: that bar's minimize is right
   * above it).
   */
  const hardwarePaneEl = <HardwarePanel lang={pt ? 'pt' : 'en'} onClose={() => closeSlotPanel('hardware')} hideCloseButton={!isMobile} />
  const hardwarePaneRightEl = (
    <HardwarePanel
      lang={pt ? 'pt' : 'en'}
      onClose={() => closeSlotPanel('hardware')}
      hideCloseButton={!isMobile}
      controls={panelFixedControlsFor('hardware', pt ? 'Hardware' : 'Hardware', () => closeSlotPanel('hardware'))}
    />
  )

  /**
   * THE RIGHT SLOT'S OWN SWITCHER (design §1.3) used to draw the picker tabs — `Conteúdo · Studio ·
   * Claude Code · Shell` — ABOVE this same box on EVERY viewport. Item 2 of the UX pass folds those
   * tabs into the FIXED HEADER on desktop instead (`App.tsx`'s `sessionTopBar`, which reads
   * `usePanelSlots()` and `appCtx` independently — no new prop threaded through this file), so on
   * desktop this box draws no picker of its own any more: a picker here AND one in the header would
   * be the exact "two lit controls for one slot" defect item 2 exists to remove.
   *
   * MOBILE HAS NO FIXED HEADER FOR IT (`sessionTopBar` is desktop-only), so the picker survives here,
   * UNCHANGED in shape, for exactly that viewport — `rightSwitcherMobile` below. `hardware` joins the
   * set (design item 3): right-slot only, ABSENT on a central the same way the header chip always
   * was (`hardwareOffered`).
   */
  const hardwareOffered = !isCentral
  /**
   * THE GATE — a single predicate, shared by the rail's own icon list AND its hidden list (spec
   * §5's eye): the same server/per-session gates `panelBarEntries` applies to the bottom band's
   * tabs, so a panel this machine cannot actually serve never gets a clickable icon OR a tile in the
   * eye's dropdown (a "restore" verb for a panel that could never be shown here would be a control
   * that is present and refusing, the one shape this codebase always avoids).
   */
  const railGateOpen = (id: PanelId): boolean => {
    if (id === 'studio') return editorEnabled === true
    if (id === 'cli') return !relayed
    if (id === 'shell') return shellEnabled === true && !relayed
    if (id === 'hardware') return hardwareOffered
    return true
  }
  /** The floating windows this session can actually serve right now — `railGateOpen` again, so a
   *  window is never drawn for a panel whose gate has closed since it was floated. */
  const floatingShown = Object.fromEntries(
    Object.entries(floating).filter(([id]) => railGateOpen(id as PanelId)),
  ) as typeof floating
  /** THE RAIL'S OWN LIST (spec §2) — `panelSlots.railPanels` already sorts by the stored order. */
  const gatedRailPanels = railPanels(slotLayout).filter(railGateOpen)
  /** THE EYE'S OWN LIST (spec §5) — everything currently `hidden`, gated the same way. */
  const gatedHiddenPanels = hiddenPanels(slotLayout).filter(railGateOpen)
  /** THE ACTIVITY DOT (addendum item 5) — the session's own live hint, already published to
   *  `artifactsStore.ts` a few lines below (`setArtifactLive`) for the metrics card's References
   *  section; read back here through the SAME store rather than recomputed, so the rail can never
   *  disagree with what that card is currently saying about this exact session. */
  const railActivity = railActivityFromHint(useArtifactLive(selected?.id))
  // THE HARDWARE ICON'S OWN RED (addendum item 6) — `hardwareCritical` is read from the single
  // `useHardwarePressureWatch` call this page makes, moved up beside the idle-sessions hook (see
  // that block's own comment) so `ramUnderPressure` is available before it is needed. Runs whenever
  // this workspace is mounted, not only while the rail itself is on screen — a reader on a phone
  // still gets the notification even though there is no rail icon here for them to see.
  const rightActivePanel: PanelId | null = slotLayout.right
  // The 44px mobile touch target is PROJECTED by the `.ag-tap-icon` class already on both buttons
  // below (`index.css`'s invisible-hitbox rule), never painted here — a literal `width/height:
  // isMobile ? 44` on an icon button is the exact shape `touchTarget.lint.test.ts` refuses: the
  // painted box would be three times the icon inside it.
  const rightSlotIconBtn: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 22, flexShrink: 0, borderRadius: 6, padding: 0,
    border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)', cursor: 'pointer',
  }
  /**
   * THE MOBILE PANEL MENU (the mobile pass's own item 2: "the rail has no place at 390px — the
   * panels are reached through the existing mobile panel menu, make sure ALL fourteen are reachable
   * there, each with its own title and icon").
   * Before the rail this offered three entries — Conteúdo/Studio/Hardware — because `contents`
   * covered the other ten under one button with its own internal strip. That strip is gone
   * everywhere now, so this switcher is what replaces it on a viewport with no rail to replace it
   * WITH — built from the same shared `panelMeta.ts`/`panelIcons.tsx` tables the rail itself reads,
   * so a title or icon can never read differently on the two surfaces.
   *
   * ALL FOURTEEN, `cli`/`shell` INCLUDED — they used to be left out on the (correct, at the time)
   * reasoning that the session panel's own `ShellBand` already offers them at the foot of the
   * screen. But that is a SEPARATE control answering a separate question ("what is docked below the
   * conversation right now"), and `panelIcons.tsx`'s own header already names this exact switcher
   * as one of the three readers `cli`/`shell` carry a `PANEL_META` entry FOR — the omission was the
   * bug, not the design. Opening either one here goes through the very same `openSlotPanel(id)`
   * every other tab uses: `cli`/`shell` default to `bottom` placement, so picking one just makes
   * `ShellBand` show THAT pane and ensures the band is open (exactly what tapping its own embedded
   * tab does); if either was ever moved to the rail on a wider viewport first, picking it here opens
   * it as a full-screen overlay instead — the very same `rightIsCli`/`rightIsShell` branch already
   * used when a desktop reader moves one to the rail. One click handler, both destinations, decided
   * entirely by the panel's own placement — never a fact this switcher has to know.
   *
   * WHICH FOURTEEN ARE OFFERED follows PLACEMENT, not a hardcoded list: `railPanels`/`bottomPanels`
   * already exclude anything `hidden` (spec's own rule — "a hidden panel must not appear in the
   * mobile menu either"), so a panel hidden on a wider viewport of this same browser stays hidden
   * here too, and one moved between rail and bottom on desktop is reachable here exactly the same
   * either way — "moving" has no separate meaning on a phone with no rail to move BETWEEN, so this
   * switcher simply shows every panel that is placed anywhere reachable, which is what "moved" comes
   * down to once the rail itself is gone.
   *
   * `on` reads `isPanelShown`, not `slotLayout.right === id` — the old test, correct only for a
   * rail-placed panel opened into the right slot, went permanently false for a bottom-placed one
   * (the ordinary case for `cli`/`shell`) even while `ShellBand` was genuinely showing it.
   *
   * NO OVERFLOW CONTROL: `flexWrap: 'wrap'` lets the row grow to as many lines as fourteen tiles
   * need rather than clipping — the rail's own "more" button (spec §4) exists because the RAIL
   * cannot grow (a fixed-height column, `overflow: hidden`, spec's own rule), while this row sits in
   * NORMAL FLOW above a column that already scrolls; a control whose only reason to exist is "some
   * icons do not fit" has nothing to answer here, and porting it would be a button that always says
   * zero.
   */
  const gatedMobilePanels = [...railPanels(slotLayout), ...bottomPanels(slotLayout)]
    .filter(railGateOpen)
    .filter(id => id !== 'metrics' || sessionMetrics !== undefined)
  const [mobileHiddenAt, setMobileHiddenAt] = useState<{ x: number; y: number } | null>(null)
  /**
   * THE MOBILE TAB STRIP SCROLLS IN ONE ROW rather than wrapping into a grid (owner screenshot,
   * iPhone 390pt: fourteen tabs wrapped four rows deep ate roughly a quarter of the screen). It is a
   * single `overflow-x: auto` row (`.tabscroll`, the same hidden-scrollbar class `RepoDetailPage`'s
   * own tab strip already uses) rather than a second overflow control: unlike the desktop rail (a
   * fixed-height COLUMN that genuinely cannot grow, spec §4's own reason for its "more" button), this
   * row sits in normal flow above a column that already scrolls, so a row that simply grows wide and
   * lets the finger move it needs nothing else.
   *
   * THE ACTIVE TAB IS KEPT ON SCREEN, centred, whenever it changes AND whenever the switcher itself
   * mounts (the aside opening) — a tab picked from a chip/deep link must not land off the visible
   * edge of its own picker. `activeMobileTab` prefers the right slot's occupant (the one usually
   * shown full-screen on a phone) and falls back to the bottom band's, since only one of the two
   * genuinely reflects "what a tap here would return you to".
   */
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const tabButtonRefs = useRef<Map<PanelId, HTMLButtonElement>>(new Map())
  const [tabStripEdges, setTabStripEdges] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const updateTabStripEdges = useCallback(() => {
    const el = tabStripRef.current
    if (!el) return
    setTabStripEdges(tabStripEdgeFade({ scrollLeft: el.scrollLeft, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }))
  }, [])
  const activeMobileTab: PanelId | null = rightActivePanel
    ?? (slotLayout.bottom !== null && gatedMobilePanels.includes(slotLayout.bottom) ? slotLayout.bottom : null)
  const scrollActiveMobileTabIntoView = useCallback((id: PanelId | null) => {
    if (id === null) return
    tabButtonRefs.current.get(id)?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [])
  /**
   * THE STRIP'S FIRST MEASUREMENT CANNOT WAIT FOR AN EFFECT KEYED ON `activeMobileTab`. This
   * container is not always in the tree — it mounts only once the aside itself opens (gated deeper
   * in this render tree, by `artShell`), so on the very render where a tap on "Session contents"
   * both picks the first tab AND creates this DOM node for the first time, `activeMobileTab` can
   * already read that tab's id BEFORE the container exists (an intermediate render this component
   * legitimately produces while `artShell` itself is still settling) — a `useEffect` on
   * `[activeMobileTab]` then never re-fires once the node finally mounts, because the value it
   * watches never changed a second time. A REF CALLBACK has no such gap: it runs at the exact
   * moment this node is attached, whatever render that happens to be, so the strip is centred on
   * whatever `activeMobileTab` is holding right then and its overflow is measured immediately —
   * "the aside opens" no longer needs a second event to notice it happened. Child buttons attach
   * their own refs (`tabButtonRefs`) before this parent's, in the same commit, so the lookup below
   * never races an empty map.
   *
   * MEMOIZED ON `activeMobileTab` — an inline (non-memoized) ref function is a NEW function identity
   * every render, and React detaches-then-reattaches a ref whose identity changed even when the DOM
   * node itself did not move. `updateTabStripEdges` always commits a fresh `EdgeFade` object (it is
   * a new object literal on every call, equal by value but not by reference), so every one of those
   * spurious reattachments re-ran it, which re-rendered this component, which built yet another new
   * inline function — measured live as React's own "Maximum update depth exceeded" (error #185) the
   * instant this panel opened. Keying the callback on `activeMobileTab` (plus the two already-stable
   * `useCallback`s below) means React only calls it again when the tab this strip should be centred
   * on actually changes, which is also the one moment this module wants it to run again anyway.
   */
  const attachTabStrip = useCallback((el: HTMLDivElement | null) => {
    tabStripRef.current = el
    if (el === null) return
    updateTabStripEdges()
    scrollActiveMobileTabIntoView(activeMobileTab)
  }, [activeMobileTab, updateTabStripEdges, scrollActiveMobileTabIntoView])
  // The ONGOING case: the strip is already mounted and the active tab changes underneath it (a
  // chip/deep link opening a different panel while the aside stays open, or the gated panel list
  // itself changing shape). The mount-time case above and this one are deliberately separate — one
  // reacts to the DOM appearing, the other to the DATA changing once it already has.
  useEffect(() => {
    if (tabStripRef.current === null) return
    scrollActiveMobileTabIntoView(activeMobileTab)
    updateTabStripEdges()
  }, [activeMobileTab, gatedMobilePanels.length, updateTabStripEdges, scrollActiveMobileTabIntoView])
  const tabStripFade = tabStripFadeMask(tabStripEdges)
  const rightSwitcherMobile = (isMobile && selected) ? (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 4, flexShrink: 0,
      padding: '4px 6px', borderBottom: '1px solid var(--border)',
    }}>
      <div
        ref={attachTabStrip}
        className="tabscroll"
        role="tablist"
        aria-label={pt ? 'O que mostrar' : 'What to show'}
        onScroll={updateTabStripEdges}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', overflowX: 'auto',
          WebkitOverflowScrolling: 'touch', scrollSnapType: 'x proximity',
          flex: 1, minWidth: 0,
          ...(tabStripFade !== null
            ? { maskImage: tabStripFade, WebkitMaskImage: tabStripFade }
            : null),
        }}
      >
        {gatedMobilePanels.map(id => {
          const on = isPanelShown(slotLayout, id)
          // THE HARDWARE TAB'S OWN RED (addendum item 6, carried to the phone) — the rail's icon
          // recolors and its tooltip states "sob pressão"/"under pressure" in words; a phone has
          // neither a rail nor a hover tooltip, so the WORDS move onto the tab's own visible label
          // instead of being dropped. Never a color-only signal — the same rule the rail's own
          // tooltip states for itself.
          const hot = id === 'hardware' && hardwareCritical === true
          return (
            <button
              key={id}
              ref={el => {
                if (el) tabButtonRefs.current.set(id, el)
                else tabButtonRefs.current.delete(id)
              }}
              role="tab"
              aria-selected={on}
              onClick={() => openSlotPanel(id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
                minHeight: 44, padding: '0 14px', scrollSnapAlign: 'center',
                borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 11.5, fontWeight: (on || hot) ? 700 : 500, whiteSpace: 'nowrap',
                background: on ? 'var(--bg-elevated)' : 'transparent',
                // Inactive tabs read as TAPPABLE (owner: they were faded to the point of looking
                // disabled) — `--text-secondary`, the same token `RepoDetailPage`'s own scrolling tab
                // strip already uses for its inactive tabs, never the fainter `--text-tertiary`.
                color: hot ? 'var(--accent-red)' : (on ? 'var(--text-primary)' : 'var(--text-secondary)'),
              }}
            >{panelIconFor(id, 12, selected.harness)}{panelTitle(id, pt)}{hot ? ` — ${pt ? 'sob pressão' : 'under pressure'}` : ''}</button>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {/* THE EYE (the mobile pass's own item 2: "a way to see and restore hidden panels on a
            phone — the same tile list the desktop's eye opens"). Absent while nothing is hidden —
            same rule as the rail's own config area, a control with one permanently-disabled state
            trains readers to ignore it. There is no HIDE verb here (drag/right-click/the rail's
            config area stay desktop-only, the gear covers those verbs there) — this is
            restore-only, and a panel a reader wants gone on a phone is reachable through the same
            gear other panels already carry once it is genuinely a bottom/rail occupant. */}
        {gatedHiddenPanels.length > 0 && (
          <button
            type="button"
            className="ag-tap-icon"
            aria-haspopup="menu"
            aria-label={pt ? `${gatedHiddenPanels.length} painéis ocultos` : `${gatedHiddenPanels.length} hidden panels`}
            title={pt ? `${gatedHiddenPanels.length} ocultos — toque para restaurar` : `${gatedHiddenPanels.length} hidden — tap to restore`}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              setMobileHiddenAt(s => (s ? null : { x: r.left, y: r.bottom + 4 }))
            }}
            style={{ ...rightSlotIconBtn, color: 'var(--anthropic-orange)' }}
          ><Eye size={13} /></button>
        )}
        {/* CLOSE — a phone has no fixed header to close this from any other way, so this stays the
            one door out here. Closing the Studio asks first when dirty, through the very `hidePanel`
            `closeSlotPanel` already calls. */}
        {rightActivePanel && (
          <button className="ag-tap-icon"
            onClick={() => closeSlotPanel(rightActivePanel)}
            title={pt ? 'Fechar' : 'Close'}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={rightSlotIconBtn}
          ><XIcon size={13} /></button>
        )}
      </div>
      {mobileHiddenAt && (
        <PanelTileDropdown
          at={mobileHiddenAt}
          label={pt ? `${gatedHiddenPanels.length} ocultos` : `${gatedHiddenPanels.length} hidden`}
          tiles={gatedHiddenPanels.map(id => panelTile(id, pt, selected.harness, pt ? 'Restaurar' : 'Restore'))}
          onPick={id => revealSlotPanel(id as PanelId)}
          onClose={() => setMobileHiddenAt(null)}
        />
      )}
    </div>
  ) : null

  /**
   * DESKTOP HAS NO PANEL SWITCHER HERE — the ONE panel bar stays the bottom band's (owner feedback,
   * 2026-09-17: "there must be exactly ONE panel switcher on desktop"). What desktop DOES get, for
   * the four right-slot panels that carry no toolbar of their own, is `PanelFixedControls` — the SAME
   * fixed trio (full screen, minimize, gear) every panel now carries, in the SAME order, through the
   * SAME shared builder (`lib/panelMenu.ts`) `ShellBand`'s own bar and the new bottom bands use, so
   * this can never disagree with what those say about an identical gesture. `panelFixedControlsFor`
   * (this trio, computed above — moved ahead of `tabPane` since that function now needs it to build
   * `rightTabPane`'s own `headerControls`) is the shared answer; see its own header there for the
   * "one header row" split this page went through.
   *
   * `cli`/`shell` ALONE — the two right-slot panels with no header of their own for the trio to
   * fold into. This is now THEIR one header row: the panel's own name on the left (so it is no
   * longer a controls-only strip — the same "title, then controls, right-aligned" shape every
   * other panel's own header now carries), `minWidth: 0` plus `textOverflow: ellipsis` on that
   * span so a long name truncates instead of pushing the trio off the row, and the trio on the
   * right. `null` (never an empty div) wherever `panelFixedControlsFor` has nothing to draw —
   * mobile, or no session selected.
   */
  const rightSlotBar = (
    panel: Exclude<PanelId, 'studio'>, panelName: string, onMinimize: () => void,
  ) => {
    const controls = panelFixedControlsFor(panel, panelName, onMinimize)
    if (controls === null) return null
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        padding: '6px 8px 0', flexShrink: 0,
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-primary)',
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {panelName}
        </span>
        <span style={{ flex: 1 }} />
        {controls}
      </div>
    )
  }
  const rightSlotHeader = isMobile ? rightSwitcherMobile : null

  /**
   * WHAT A FLOATING WINDOW HOLDS (`lib/floatingPanels.ts`) — the SAME content the right slot mounts
   * for each panel, with the pin shown pressed: pressing it docks the panel back into the slot its
   * placement names, and opens it there. A panel whose gate has closed since it was floated (the
   * Studio switched off, a relayed session with no terminal) draws no window — the same read-time
   * rule `resolveForGates` applies to the docked slots.
   */
  const dockBack = (id: PanelId) => { unpinPanel(id) }
  /** THE FLOATING WINDOW'S OWN CONTROLS (owner, 2026-09-29): minimize (the window goes back into
   *  the bottom band's tab strip, keeping where and how big it was) and — only where the item is
   *  really closable (`panelClosable`: the Shell) and there is a shell to end — the X beside it. The
   *  gear that used to hold "close" is gone; the pin (dock back) leads the header, see `floatingBar`. */
  const shellCloseEntry = useShellClose(selected?.id)
  const dockControls = (id: PanelId, name: string, withPin = false): ReactNode => {
    const closable = panelClosable(id) && selected !== undefined && selected !== null
      && shellCloseEntry.live !== null
    return (
      <PanelFixedControls
        lang={pt ? 'pt' : 'en'}
        panelName={name}
        {...(withPin ? { pinned: { active: true, onToggle: () => dockBack(id) } } : {})}
        onMinimize={() => minimizeFloatingPanel(id)}
        minimizeLabel={pt ? `Minimizar ${name} para a barra inferior` : `Minimize ${name} to the bottom bar`}
        {...(closable ? {
          close: {
            onClose: () => { void requestShellClose(selected!.id, shellApiUrl('/api/shell/close', pt ? 'pt' : 'en')) },
            busy: shellCloseEntry.flow.phase === 'closing',
          },
        } : {})}
        gearLabel={pt ? `Opções — ${name}` : `${name} options`}
        gearEntries={[]}
      />
    )
  }
  const floatingTitle = (id: PanelId): string => (id === 'cli' || id === 'shell') && selected
    ? targetLabel(id, selected.harness, pt ? 'pt' : 'en')
    : panelTitle(id, pt)
  const floatingBar = (id: PanelId): ReactNode => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: '6px 8px 0 8px', flexShrink: 0,
    }}>
      <PanelPinButton
        lang={pt ? 'pt' : 'en'}
        panelName={floatingTitle(id)}
        pinned={{ active: true, onToggle: () => dockBack(id) }}
      />
      <span style={{
        fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-primary)',
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{floatingTitle(id)}</span>
      <span style={{ flex: 1 }} />
      {id === 'shell' && <ShellCloseStatus sessionId={selected?.id} lang={pt ? 'pt' : 'en'} />}
      {dockControls(id, floatingTitle(id))}
    </div>
  )
  const floatingBody = (id: PanelId): ReactNode => {
    if (!selected) return null
    if (id === 'studio') {
      return <div ref={setFloatStudioEl} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }} />
    }
    if (id === 'cli') {
      return (
        <>
          {floatingBar('cli')}
          <div style={{ flex: 1, minHeight: 0, padding: 10, display: 'flex', flexDirection: 'column' }}>
            <ShellBand
              key={`float-cli-${selected.id}`}
              placement="aside"
              fixedTarget="cli"
              sessionId={selected.id}
              {...(selected.cwd ? { cwd: selected.cwd } : {})}
              {...(selected.harness ? { harness: selected.harness } : {})}
              lang={pt ? 'pt' : 'en'}
              theme={theme === 'light' ? 'light' : 'dark'}
            />
          </div>
        </>
      )
    }
    if (id === 'shell') {
      return (
        <>
          {floatingBar('shell')}
          <div style={{ flex: 1, minHeight: 0, padding: 10, display: 'flex', flexDirection: 'column' }}>
            <ShellBand
              key={`float-${selected.id}`}
              placement="aside"
              fixedTarget="shell"
              sessionId={selected.id}
              {...(selected.cwd ? { cwd: selected.cwd } : {})}
              {...(selected.harness ? { harness: selected.harness } : {})}
              lang={pt ? 'pt' : 'en'}
              theme={theme === 'light' ? 'light' : 'dark'}
            />
          </div>
        </>
      )
    }
    if (id === 'hardware') {
      return (
        <HardwarePanel
          lang={pt ? 'pt' : 'en'}
          onClose={() => dockBack('hardware')}
          hideCloseButton
          controls={dockControls('hardware', panelTitle('hardware', pt), true)}
        />
      )
    }
    return tabPane(id, { hideCloseButton: true, headerControls: dockControls(id, panelTitle(id, pt), true) })
  }

  /**
   * IS THE RIGHT SLOT'S OWN CONTENT CURRENTLY FULL SCREEN — `fullscreenModeFor`'s `'overlay'` mode
   * (Studio, or any of the ten former Contents tabs, or Hardware) applied to whichever of them
   * actually occupies the right slot right now. `cli`/`shell` are never included: their full screen
   * NAVIGATES to a dedicated screen instead (`rightSlotBar`'s own `fullscreen` object), so there is
   * no "currently overlaying" state for them to read here.
   */
  const rightSlotFullscreen =
    (rightIsStudio && studioFullscreen) || ((rightIsTab || rightIsHardware) && tabFullscreen)

  /** What the right box actually shows: the Studio's own target (StudioHost re-parents its carrier
   *  into it) while `panelSlots` says so; `cli`/`shell` render their own `ShellBand`
   *  with `placement="aside"` (design §1.5) — ordinary mounts, no persistent carrier needed since
   *  neither holds a buffer that must survive the move; `hardware` its own `HardwarePanel`; any of
   *  the ten former Contents tabs its own `ArtifactsAside` mount (`rightTabPane`, bound to
   *  `slotLayout.right`). */
  const rightSlotContentRaw = rightIsStudio ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      <div ref={setRightSlotEl} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }} />
    </div>
  ) : rightIsCli && selected ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      {rightSlotBar('cli', targetLabel('cli', selected.harness, pt ? 'pt' : 'en'), () => closeSlotPanel('cli'))}
      <div style={{ flex: 1, minHeight: 0, padding: 10, display: 'flex', flexDirection: 'column' }}>
        <ShellBand
          key={`aside-cli-${selected.id}`}
          placement="aside"
          fixedTarget="cli"
          sessionId={selected.id}
          {...(selected.cwd ? { cwd: selected.cwd } : {})}
          {...(selected.harness ? { harness: selected.harness } : {})}
          lang={pt ? 'pt' : 'en'}
          theme={theme === 'light' ? 'light' : 'dark'}
        />
      </div>
    </div>
  ) : rightIsShell && selected ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      {rightSlotBar('shell', targetLabel('shell', selected.harness, pt ? 'pt' : 'en'), () => closeSlotPanel('shell'))}
      <div style={{ flex: 1, minHeight: 0, padding: 10, display: 'flex', flexDirection: 'column' }}>
        <ShellBand
          key={`aside-${selected.id}`}
          placement="aside"
          fixedTarget="shell"
          sessionId={selected.id}
          {...(selected.cwd ? { cwd: selected.cwd } : {})}
          {...(selected.harness ? { harness: selected.harness } : {})}
          lang={pt ? 'pt' : 'en'}
          theme={theme === 'light' ? 'light' : 'dark'}
        />
      </div>
    </div>
  ) : rightIsHardware ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      {hardwarePaneRightEl}
    </div>
  ) : slotLayout.right !== null && isTabPanelId(slotLayout.right) ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      {rightTabPane}
    </div>
  ) : null

  /**
   * THE RIGHT SLOT'S OWN "COVER THE VIEWPORT" WRAPPER — the exact same technique `SessionPanel.tsx`'s
   * `StudioBand` already uses for the bottom band (`PANEL_FULLSCREEN_Z`, `position: fixed; inset:
   * 0`), applied here so Studio and every former Contents tab (or Hardware) can ALSO go full screen
   * while sitting on the right. `background: var(--bg-surface)` because the raw content underneath
   * assumes it is painted over the page's own surface, which a `position: fixed` escape hatch no
   * longer guarantees on its own.
   *
   * STOPS SHORT OF THE RAIL (spec §2: "full screen respects the rail") — `right` follows the rail's
   * LIVE width (`rawSlotLayout.railWidth`, owner, 2026-09-21: the rail is resizable now) on desktop
   * rather than reaching `inset: 0`'s own viewport edge, or the overlay would paint straight over the
   * one control that could get the reader back out of it.
   *
   * STOPS SHORT OF THE LEFT SESSIONS LIST TOO (owner: "a esquerda da listagem de sessoes deveria
   * continuar visivel") — this is the THIRD `PANEL_FULLSCREEN_Z` overlay in the sessions workspace,
   * beside `StudioBand`'s and `SimpleDockedBand`'s own two in `SessionPanel.tsx`; all three must
   * agree on what "full screen" leaves alone, so `left` reads the same `useLeftAsideEdge()` bridge
   * those two already read rather than the `left: 0` this one still had.
   */
  const leftAsideEdge = useLeftAsideEdge()
  /** Whether the left list is actually resizable right now — the bottom-left T-junction (below)
   *  exists only then; see `leftAsideOpen.ts`'s own header for why this needs its own bridge rather
   *  than a comparison against `leftAsideEdge` above. */
  const leftAsideOpenNow = useLeftAsideOpen()
  /** The artifacts aside's own live left edge, REACTIVELY — the bottom-right T-junction's own X
   *  coordinate is this minus half the 6px gap, matching the gap's own centre line exactly. `null`
   *  when there is no aside on screen (see `rightAsideEdge.ts`'s own header) — the junction has
   *  nothing to sit beside then and is withheld, same as the plain vertical gap a few lines below. */
  const rightAsideEdgeNow = useRightAsideEdge()
  const rightSlotContent = rightSlotFullscreen ? (
    <div style={{
      position: 'fixed', top: 0, left: isMobile ? 0 : leftAsideEdge, bottom: 0,
      right: isMobile ? 0 : rawSlotLayout.railWidth,
      zIndex: PANEL_FULLSCREEN_Z,
      display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)',
    }}>
      {rightSlotContentRaw}
    </div>
  ) : rightSlotContentRaw

  /**
   * THE QUESTION BEFORE A NAVIGATION DROPS THE STUDIO — asked at THIS level because this is where
   * the page can still hold it. `artShell === 'none'` unmounts `ArtifactsAside`, which owns no Monaco
   * buffers of its own any more: the Studio is its own panel now (`lib/panelSlots.ts`), and closing
   * or displacing IT asks first through `showPanel` / `hidePanel` at the point it is closed or
   * displaced — the very same `unsavedBuffers.ts` this guard also watches. What this guard is for is
   * the drop NEITHER of those functions can see: the page navigating away while the Studio, wherever
   * it currently sits, still holds unsaved buffers.
   *
   * It holds every such drop: every router navigation that leaves this session's page — another session,
   * the dedicated terminal, `SideNav`, and on a phone the arrival of a new session, which is a
   * navigation first — the browser's own Back/Forward (a `popstate` listener
   * registered in `main.tsx` BEFORE the first render, because in Chromium window listeners run in
   * insertion order whatever their phase — see `lib/historyPopGuard.ts`), and a reload or closed tab (`beforeunload`). It keeps nothing mounted:
   * the answer "discard" drops the pane exactly as before. STATED LIMITS: a REOPEN of this session
   * is deliberately not held — the server has already retired the row, so "keep editing" could keep
   * nothing (`navigationRetiresStudio`) — and a selected row that vanishes from the fleet with no
   * navigation at all still drops the pane unasked.
   */
  const leaveGuard = (
    <UnsavedChangesGuard
      lang={pt ? 'pt' : 'en'}
      // SPLIT: one guard, on the main pane, answering for BOTH sessions (`active` below).
      sessionKeys={[sessionId, selected?.id, selected?.conversationId, splitRoute?.split ?? undefined]
        .filter((k): k is string => typeof k === 'string' && k !== '')}
      active={pane === 'main'}
    />
  )

  const panel = selected === undefined ? null : (
    <SessionPanel
      session={selected}
      {...(rowIndex.get(selected.id) ? { row: rowIndex.get(selected.id)! } : {})}
      lang={pt ? 'pt' : 'en'}
      theme={theme === 'light' ? 'light' : 'dark'}
      act={act}
      onGone={closeThisPane}
      // Follow a reopen to the row it created. Without it the panel keeps an id the fleet no longer
      // carries — see `SessionPanel`'s own `onOpened`.
      onOpened={goToReopened}
      {...(composerMetrics ? { metrics: composerMetrics } : {})}
      // CONTROLLED on both layouts now. Passing `onViewChange` is what suppresses SessionPanel's
      // own header, and mobile draws the same three things in the row that already holds the back
      // button — one bar instead of two stacked ones saying overlapping things.
      view={sessionView}
      onViewChange={setSessionView}
      onArtifacts={onArtifacts}
      // The capability AND the user's switch, as the server reports them. Absent reads as OFF.
      shellEnabled={shellEnabled}
      shellCapable={shellCapable}
      {...(onShellEnabledChange ? { onShellEnabledChange } : {})}
      // Gates whether the BOTTOM band may ever show the Studio, and hands it the DOM box
      // `StudioHost` (mounted once, here in `SessionsPage`) moves its persistent carrier into.
      editorEnabled={editorEnabled}
      onStudioBandRef={setBottomStudioEl}
      // TRUE full screen for the Studio's bottom band — see `studioFullscreen`'s own header above.
      studioFullscreen={studioFullscreen}
      onStudioFullscreenChange={setStudioFullscreen}
      // Any of the ten former Contents tabs, or Hardware, docked at the bottom — the SAME reused
      // content elements the right slot renders (`tabPane`/`hardwarePaneEl`), plus the ONE shared
      // full-screen state (see `tabFullscreen`'s own header above).
      bottomTabPane={bottomIsHardware ? hardwarePaneEl : bottomTabPane}
      bottomTabFullscreen={tabFullscreen}
      onBottomTabFullscreenChange={setTabFullscreen}
      // The terminal's own screen. A route, so it survives a reload and can be sent to somebody.
      onOpenTerminal={() => navigate(dedicatedTerminalPath(selected.id))}
      // WHICHEVER PANE the band is showing right now (`target`) — never a fixed `'shell'`. See
      // `paneForTarget`'s own header for the defect this closes.
      onOpenShellFullscreen={target => navigate(dedicatedTerminalPath(selected.id, paneForTarget(target)))}
      // Hardware is meaningless (and refused) on a central — the same fact `hardwareOffered` already
      // names for this page's own mobile switcher.
      hardwareOffered={hardwareOffered}
      // The Studio entry's first-open dot — one flag, read wherever the bar renders it.
      studioSeen={ctx.studioSeen}
    />
  )

  /**
   * How many dimensions are narrowing the list — the badge on the filter icon.
   *
   * `activeOnly` counts. It is not a `Filters` dimension (see `FiltersBar`'s doc comment on
   * `onActiveOnlyChange`) but it is the one that removes the most rows, and a badge that ignored it
   * would read `0` on the arrangement the workspace SHIPS with, which is the arrangement people
   * would be trying to explain to themselves.
   */
  const filterCount =
    (activeOnly ? 1 : 0) +
    [
      (filters.harnesses?.length ?? 0) > 0,
      (filters.repos?.length ?? 0) > 0,
      filters.projects.length > 0,
      (filters.models?.length ?? 0) > 0,
    ].filter(Boolean).length

  /** The filter icon both mobile bars carry. Same sheet, same count, same target size. */
  /**
   * THE SAME CONTROL THE DESKTOP HAS, said the same way.
   *
   * It was a sliders icon, which is the shape every other product uses for SETTINGS — and this page
   * already has a settings gear elsewhere, so the one control that narrows the list read as the one
   * that configures it. The desktop bar has always called it `+ Filtro`; asked for, and it is the
   * cheaper half of "make the two layouts the same feature".
   *
   * The 44px height stays — it is the mobile target this repo holds everything to — and the label
   * only costs width, which this bar has once the sliders icon's dead space is spent on it.
   */
  /**
   * THE MAGNIFIER, IN THE BAR — it was floating over the middle of the conversation.
   *
   * `MagnifierLayer` draws its own fixed button at `top: 50%` when no chrome offers it a slot, and
   * this workspace was the one mobile screen that offered none (`headerHostsMagnifier` excludes it
   * by name). So on a phone it sat in the vertical centre, over the message somebody was reading —
   * reported as "ta perdida no meio da tela", with a screenshot of it on top of a paragraph.
   *
   * It belongs in the bar for the same reason it is in the desktop's strip, and it costs this bar
   * nothing when it is not wanted: `MagnifierButton` returns null unless the magnifiers have been
   * turned on, so a phone that never enabled them never gives up the width.
   */
  const magnifierButton = isMobile
    ? (
      <>
        <MagnifierButton ctx={ctx} />
        {/* Its pair. The floating fallback drew BOTH, and taking over the slot means taking over
            both — a phone that had opened lenses here would otherwise have no way to hide them,
            because a pinned lens takes no pointer events of its own. It renders nothing until
            there is a lens to hide. */}
        <HideLensesButton ctx={ctx} />
        {/* The bell, same reasoning: this workspace draws no <header>, so without a slot here it
            has no way onto a phone at all. Painted at the same 32×32 its neighbours use, with the
            44px mobile touch target coming from the invisible `.ag-tap-icon` hit zone (index.css)
            rather than a grown painted control — `NotificationBell.buttonClassName` exists for
            exactly this. */}
        <NotificationBell lang={pt ? 'pt' : 'en'} buttonClassName="ag-tap-icon" buttonStyle={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: 8,
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-tertiary)', cursor: 'pointer', position: 'relative',
        }} />
      </>
    )
    : null

  const filterButton = (
    <button
      onClick={() => setSheetOpen(true)}
      aria-label={pt ? 'Filtros' : 'Filters'}
      aria-haspopup="dialog"
      style={{
        display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
        height: 44, padding: '0 10px',
        border: 'none', background: 'transparent',
        color: filterCount > 0 ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
        fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
      }}
    >
      <Plus size={15} style={{ flexShrink: 0 }} />
      <span>{pt ? 'Filtro' : 'Filter'}</span>
      {filterCount > 0 && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, flexShrink: 0,
          background: 'var(--anthropic-orange)', color: '#fff', fontSize: 10, fontWeight: 700,
        }}>{filterCount}</span>
      )}
    </button>
  )

  /**
   * The sheet itself — rendered by BOTH mobile branches, built once here.
   *
   * The bar inside is the ordinary `compact` `FiltersBar`, unchanged, on the same shared state the
   * desktop strip edits. `Clear` is offered only when there is something set, and it clears the
   * fleet's own dimension too: leaving "active only" on after a "clear" that says nothing about it
   * is a filter still narrowing the list under a control that claims to have stopped.
   */
  const filtersSheet = (
    <FiltersSheet
      open={sheetOpen}
      onClose={() => setSheetOpen(false)}
      {...(filterCount > 0
        ? {
            onClear: () => {
              setActiveOnly(false)
              setFilters({ ...filters, harnesses: [], repos: [], projects: [], models: [] })
            },
          }
        : {})}
      lang={pt ? 'pt' : 'en'}
    >
      <FiltersBar
        compact
        only={FLEET_FILTER_DIMS}
        activeOnly={activeOnly}
        onActiveOnlyChange={setActiveOnly}
        filters={filters}
        onChange={setFilters}
        projects={availableProjects}
        sessionCountByProject={sessionCountByProject}
        models={models}
        harnesses={availableHarnesses}
        users={[]}
        lang={lang}
      />
    </FiltersSheet>
  )

  // ---------------------------------------------------------------------------
  // ONE PANE, POSITIONED BY THE LAYOUT — never one pane per layout.
  //
  // `artifactsPane` used to be written into FOUR separate `return`s, one per `ArtifactLayout`, and
  // React reconciles by POSITION: four positions are four different elements, so crossing a
  // breakpoint unmounted the whole aside and mounted a new one. That is not a flicker. The Studio's
  // entire composition — `Layer`, `mountedEditors`, `StudioBody`'s one DOM shape — exists to make
  // sure an unsaved buffer survives every move a reader can make inside it, and the surface holding
  // it was throwing the lot away the moment the WINDOW changed size. On a phone the window changes
  // size when you turn it over, or when the keyboard opens.
  //
  // Measured at 390x844 on a live session, before this: two files open in the Studio, the second
  // one edited and the strip reading `artifactLayout.test.ts — não salvo`, 1 Monaco instance. One
  // resize to 1600x900 and the same reads gave `openTabs: []`, `monaco: 0`, and a re-fetched tree.
  // The typed text was gone, with nothing on screen having said so.
  //
  // So the pane is ONE element in ONE slot and the LAYOUT is a style. Everything that differed
  // between the four branches — fixed over the phone, absolute over the conversation, a column in a
  // flex row — is `artOuter`/`artInner` below, and every other slot in this return is always
  // present (`null` when it draws nothing) so no sibling can shift the pane's index either.
  //
  // WHAT THIS DOES NOT FIX, stated rather than discovered: the CENTRE still changes shape across
  // 768px (a phone has a back bar and a title; a desktop has the edge strip), so `SessionPanel`
  // remounts on that crossing exactly as it always has. The conversation is re-read from the
  // server and a half-typed prompt is held by `composerStore`, so nothing is lost there — which is
  // precisely what was NOT true of the Studio, whose buffers live nowhere but in its own DOM. (So a
  // drop that is not a layout change — the panel closing, the page navigating — is ASKED about
  // first; see `leaveGuard`.)
  // ---------------------------------------------------------------------------

  /**
   * Which box the pane sits in, or `none` when it is not on screen at all.
   *
   * `asideAlive` is the mount gate and it is deliberately the same one on every layout. The mobile
   * branch used to render the pane whenever a session was selected — mounted and hidden behind
   * `translateX(100%)` forever — which kept the whole aside, Monaco and all, alive on the weakest
   * device in the product: measured at 390px with the Studio CLOSED, the live feed's own scroller
   * reported `scrollHeight: 32942` for a column nobody could see. It bought one thing, that the
   * first open could slide in from a box that already existed, and `asideIn` (two frames, see
   * above) is what buys that on the desktop without keeping anything mounted. So mobile uses
   * `asideIn` too and pays the same price as everything else: closing the panel really does close
   * it, and reopening reads the tree again.
   */
  const artShell: 'fullscreen' | 'overlay' | 'split' | 'none' =
    selected === undefined || !asideAlive || !panel || (isMobile && (creating || finishing))
      ? 'none'
      : isMobile
        ? 'fullscreen'
        // WHICH exit to play when it is on its way out — `closingAs` holds the layout it was in, so
        // a panel closed after the window narrowed does not slide out as the shape it is no longer.
        : (artLayout.layout === 'closed' ? closingAs.current : artLayout.layout) === 'overlay'
          ? 'overlay'
          : 'split'
  /** The split is the only shape that lays the pane out BESIDE something; everything else covers. */
  const split = artShell === 'split'

  /**
   * THE PANE'S OWN BOX, per shape. The three rules that were spread over three branches:
   *
   * - `fullscreen` (a phone) is `fixed` over everything, above the bottom nav, and carries the
   *   status-bar band itself because it is the topmost thing on the screen. The way out is the
   *   panel's own close, which `ArtifactsAside` draws — the bar's back arrow would leave the
   *   session. It slides on `transform`, from `asideIn` rather than from its own mount, and is
   *   `pointer-events: none` on the way out so a closing panel cannot take a tap.
   * - `overlay` covers the conversation but leaves its edge visible, which is the only affordance
   *   saying what closing returns you to. It slides ACROSS rather than growing: `transform` is the
   *   one property that animates without laying the page out again every frame.
   * - `split` animates its WIDTH and clips, while `artInner` holds the contents at full width the
   *   whole time — text rewrapping mid-animation is what makes a collapse look like a stutter.
   */
  const artOuter: CSSProperties = artShell === 'fullscreen'
    ? {
      position: 'fixed', inset: 0, zIndex: 70,
      display: 'flex', flexDirection: 'column',
      paddingTop: 'var(--safe-top)',
      background: 'var(--bg-surface)',
      transform: asideIn ? 'translateX(0)' : 'translateX(100%)',
      transition: `transform ${ASIDE_ANIM_MS}ms ${ASIDE_EASE}`,
      // `ASIDE_ANIM_MS` and not a second duration of its own: that constant IS the unmount delay,
      // so a longer transition here would be cut off mid-slide by the element going away.
      pointerEvents: asideIn ? undefined : 'none',
      willChange: 'transform',
    }
    : artShell === 'overlay'
      ? {
        position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(440px, 88%)', zIndex: 20,
        background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)',
        boxShadow: '-12px 0 32px rgba(0,0,0,0.45)',
        display: 'flex', flexDirection: 'column', minHeight: 0,
        transform: asideIn ? 'translateX(0)' : 'translateX(100%)',
        transition: `transform ${ASIDE_ANIM_MS}ms ${ASIDE_EASE}`,
        willChange: 'transform',
      }
      : {
        display: 'flex', flexDirection: 'column', width: asideIn ? shownArtWidth : 0,
        flexShrink: 0, minHeight: 0, background: 'var(--bg-surface)',
        overflow: 'hidden',
        // A panel on the board like every other: border and 10px corners (its top corners were
        // square). No border while collapsed to width 0, or a 2px sliver would remain.
        ...(asideIn ? { border: PANEL_BORDER, borderRadius: PANEL_RADIUS, boxSizing: 'border-box' as const } : {}),
        // TOP ALIGNMENT (owner, 2026-09-27): this panel used to start flush against the header, the
        // one panel on the board with no gap above it at all. It takes the SAME outer-gap figure the
        // centre column's own `marginTop` uses (`OUTER_GAP`, `lib/panelLayout.ts`).
        marginTop: OUTER_GAP,
        transition: asideMotion,
      }
  const artInner: CSSProperties = split
    ? {
      display: 'flex', flexDirection: 'column', width: shownArtWidth, flexShrink: 0,
      height: '100%', minHeight: 0,
    }
    : { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }

  /**
   * THE ASIDE'S OWN LEFT EDGE, MEASURED — reported through `rightAsideEdge.ts` so `App.tsx`'s
   * Filtros panel (a different file, no ancestor of this one) can stop short of it. See that
   * module's own doc comment for why this is not folded into `artifactsStore`.
   *
   * Re-measured on every cause the edge can move: the aside's OWN box changing size (the drag
   * handle above, or the `split` shell's own width transition — `ResizeObserver` on `artOuter`
   * itself) and the ROOM around it changing without the aside's own box changing size at all (a
   * sidebar drag or a window resize shrinks `splitRef`, which shifts an `overlay` aside's `right: 0`
   * position with no size change of its own — `ResizeObserver` would miss that, `splitRoom` catches
   * it, because it is already recomputed for exactly that set of causes; see `panelWidth`, above).
   *
   * **The `overlay` shell (below `SPLIT_MIN_WIDTH`) opens on `transform` alone — `width` never
   * changes — so `ResizeObserver` never fires for it at all**, reported by review as a Critical: the
   * one synchronous `report()` this effect used to make was also the LAST one, taken while the aside
   * still sat translated off-screen (its mount-time `translateX(100%)`), and nothing corrected it
   * until an unrelated cause re-ran the effect — the Filtros panel then measured "plenty of room"
   * against a box that had since visually slid into view, reproducing the original occlusion on an
   * ordinary first open. Two changes close it: `report()` reads `restingLeftEdge`, which discounts
   * the box's own `translateX` and so answers with the SETTLED position regardless of where the
   * slide currently sits (correct even at that very first off-screen frame); and the effect also
   * re-measures on the box's own `transitionend`/`transitioncancel` (filtered to the `transform`
   * property, so an unrelated child transition cannot trigger it) and whenever `asideIn` itself
   * flips, as a second line of defense for whatever `restingLeftEdge` cannot see.
   *
   * `getBoundingClientRect()`, not the observer's own `contentRect` — that rect is relative to the
   * element's OWN padding box, not the viewport, so it cannot answer "where is this on screen."
   */
  const rightAsideRef = useRef<HTMLDivElement | null>(null)
  const viewportWidth = useViewportWidth()
  useEffect(() => {
    const el = rightAsideRef.current
    // NOTHING OPEN ON THE RIGHT (`artShell === 'none'`) is NOT the same fact as "nothing on the
    // right at all" — the RAIL (`PanelRail`, mounted exactly under `!isMobile && selected`, right
    // below this effect's own JSX) is still there the instant a session is selected on desktop, so
    // this reports the rail's own edge instead of `null` in that case (`closedRightEdge` in
    // `rightAsideEdge.ts` — see that module's own header for the regression this fixes: the Filtros
    // chips' closed-aside fallback painted 12px into the rail's icons because this used to report
    // `null` here unconditionally, and their own margin was 12px short of the rail's width).
    if (isMobile || artShell === 'none') {
      // The rail's LIVE width (owner, 2026-09-21) — a rail dragged out to its ceiling must push
      // this fallback edge with it, or the Filtros chips paint back into the wider icons exactly
      // the way the original regression `closedRightEdge`'s own header describes did.
      if (publishesRightEdge) setRightAsideEdge(closedRightEdge(!isMobile && selected !== undefined, viewportWidth, rawSlotLayout.railWidth))
      return
    }
    if (artShell === 'fullscreen' || !el) {
      if (publishesRightEdge) setRightAsideEdge(null)
      return
    }
    const report = () => {
      const rect = el.getBoundingClientRect()
      if (publishesRightEdge) setRightAsideEdge(restingLeftEdge(rect.left, getComputedStyle(el).transform))
    }
    report()
    const onTransformSettled = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') report()
    }
    el.addEventListener('transitionend', onTransformSettled)
    el.addEventListener('transitioncancel', onTransformSettled)
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(report)
      ro.observe(el)
    }
    return () => {
      ro?.disconnect()
      el.removeEventListener('transitionend', onTransformSettled)
      el.removeEventListener('transitioncancel', onTransformSettled)
    }
  }, [isMobile, artShell, splitRoom, asideIn, selected, viewportWidth, rawSlotLayout.railWidth])
  useEffect(() => () => { if (publishesRightEdge) setRightAsideEdge(null) }, [publishesRightEdge])

  /**
   * THE NARROW-WIDTH OVERLAY'S CLICK-OUTSIDE-MINIMIZES (spec §11 items 2-3) — `artShell ===
   * 'overlay'` ONLY, THE RAIL ONLY (item 4: "the bottom band keeps today's behaviour exactly;
   * nothing there changes"). Neither branch of this effect ever touches `bottomOpen`, `ShellBand` or
   * `SessionPanel.tsx`'s own bands — the bottom band's own minimize/collapse machinery is a
   * completely separate code path this effect never reaches, which is the rule
   * `panelSlots.overlayOutsideAction.test.ts`'s own "the bottom band is untouched" test pins from
   * the OUTSIDE (this effect simply never runs unless the overlay shell is showing).
   *
   * WHAT "OUTSIDE" MEANS, stated once and handed to the pure `overlayOutsideAction` (`panelSlots.ts`)
   * as three facts: is the panel PINNED (wins outright, spec item 3); did the click land INSIDE the
   * overlay's own box (`rightAsideRef`, the exact element `artOuter` renders — its own header row,
   * including the PIN button itself, is inside this and so never counts as "away"); did it land on
   * THE RAIL (`closest('[data-panel-rail]')`) or on ANY portaled menu this workspace draws
   * (`closest('[role="menu"]')` — the rail's own right-click move/hide menu and its overflow/eye
   * tile dropdowns are portaled to `document.body`, outside the rail's own DOM subtree, so without
   * this a right-click on the rail's icon and then a pick from its OWN menu would minimize the very
   * panel the picked verb was about). Clicking the rail is SWITCHING panels, never "clicking away".
   *
   * ESC IS THE SAME DECISION (item 2, "Esc deveria fazer o mesmo") — it did not exist at all before
   * this pass (there was no `'Escape'` handler anywhere in this file). It shares `overlayOutsideAction`
   * rather than a bare unconditional minimize, so a PINNED panel is left alone by Esc too — the same
   * "this stays until I say so" promise the pin makes against an accidental click.
   */
  useEffect(() => {
    if (artShell !== 'overlay') return
    const panel = slotLayout.right
    if (panel === null) return
    const minimize = () => {
      if (panelMinimizeAction(panel, 'rail') === 'collapse-right-park') setRightOpen(false)
      else closeSlotPanel(panel)
    }
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target
      const overlayEl = rightAsideRef.current
      const insideOverlay = !!(overlayEl && target instanceof Node && overlayEl.contains(target))
      // A floating window counts as part of the workspace's own chrome here, like the rail: working
      // in one is not "clicking away" from the overlay.
      const insideRail = target instanceof Element
        && (target.closest('[data-panel-rail]') !== null || target.closest('[role="menu"]') !== null
          || target.closest('[data-floating-panel]') !== null)
      // The pin no longer keeps an overlay open — it floats the panel (`lib/floatingPanels.ts`).
      const action = overlayOutsideAction({ pinned: false, insideOverlay, insideRail })
      if (action === 'minimize') minimize()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const action = overlayOutsideAction({ pinned: false, insideOverlay: false, insideRail: false })
      if (action === 'minimize') minimize()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [artShell, slotLayout.right, closeSlotPanel, setRightOpen])

  /**
   * What the pane sits beside or under. A VALUE, never a `return`: the moment one of these is
   * returned on its own, the pane it was meant to share a parent with is at a different index.
   */
  let centre: ReactNode
  // ---------------------------------------------------------------------------
  // The DEDICATED terminal — one screen, one pane, both layouts. FIRST in the chain because it is
  // the SAME screen at 390px and at 1440px: a terminal that fills what it is given needs no second
  // version, and the key strip it gets on a phone is decided by `keyStripShown`.
  //
  // ONLY THE ONE CONTROL LEAVING FULL SCREEN NEEDS TO EXIST HERE — a control removed must not take
  // away the only way to do something, so it is worth stating what this screen does NOT offer any
  // more and why that is still complete. It used to carry its own `Claude Code | Shell` tab
  // switcher, on top of the panel bar the session itself already has — two controls for one
  // question, in two vocabularies, on the one screen whose whole point is showing ONE of them at
  // full size (owner: "ele deveria ter apenas o botao de fullscreen e de desfullscreen"). Switching
  // panes now means going BACK to the session (this screen's own "Voltar" arrow) and picking the
  // other one from the band's panel bar there, then pressing full screen again — one extra step, for
  // a control this screen otherwise duplicated.
  //
  // ON DESKTOP THIS NOW RESPECTS THE ARTIFACTS ASIDE TOO (change #2): the terminal falls through to
  // `centre` below instead of returning early, so whatever the right slot was independently showing
  // (Contents, Studio, Hardware) keeps showing beside it, through the SAME `artOuter`/`rightAsideRef`
  // composition every other layout on this page shares — no second aside implementation to agree
  // with the first. `dedicatedRightRedundant` (above) is the one case this deliberately EXCLUDES:
  // the right slot showing the very CLI/Shell pane this screen already fills whole would be the same
  // terminal drawn twice, not a companion. ON MOBILE there is no room for a companion aside at all,
  // and `artShell` would otherwise draw one as a FULL-SCREEN OVERLAY on top of the very screen this
  // route exists to show — so mobile keeps the original early `return`, unaffected by any of this.
  // ---------------------------------------------------------------------------

  /**
   * THE T-JUNCTIONS (design item, owner requirement) — where the band's own horizontal gap meets a
   * vertical one. `activeJunctions` (`lib/panelLayout.ts`) says WHICH exist for the current
   * open/closed combination; this effect answers the one question that module deliberately leaves
   * to its caller, WHERE — the band's own horizontal gap's Y (`bandGapY`), since nothing else in
   * this codebase already tracks it (unlike the two vertical gaps' X, which are already live,
   * reactive bridges: `leftAsideEdge`/`rightAsideEdgeNow`, read above). Placed BEFORE the
   * `dedicatedTerminal` early `return` below, like every other hook in this component — a hook
   * after it would only run on SOME renders, which is the crash `sessionsPage.lint.test.ts`'s own
   * "hook-order" describe block exists to catch.
   *
   * The band gap's OWN size never changes (a fixed 6px strip), so `ResizeObserver` on the element
   * itself would never fire for a REPOSITION — only its containing row resizing (a window resize, an
   * aside width change) moves it without changing its own box, which is exactly the case
   * `ResizeObserver` on `splitRef` catches. A band-height drag (through the band's own gap directly,
   * never through a junction) is the one case neither that nor the dependency list below catches
   * live — accepted, because nothing here is VERIFIED against dragging the plain band gap while a
   * junction sits on screen; the junction re-measures on its own next open/close.
   */
  const [bandGapY, setBandGapY] = useState<number | null>(null)
  const measureBandGapY = useCallback(() => {
    const el = document.getElementById(paneDomId('ag-gap-band-height', pane))
    if (!el) { setBandGapY(null); return }
    const r = el.getBoundingClientRect()
    setBandGapY(r.top + r.height / 2)
  }, [])
  useEffect(() => {
    if (isMobile) { setBandGapY(null); return }
    measureBandGapY()
    const el = splitRef.current
    let ro: ResizeObserver | undefined
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measureBandGapY)
      ro.observe(el)
    }
    window.addEventListener('resize', measureBandGapY)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measureBandGapY) }
  }, [isMobile, measureBandGapY, slotLayout.bottom, slotLayout.bottomOpen, split, asideIn, artWidth])
  /**
   * A junction drag is in progress from the moment its own `mousedown` arms the two real gaps
   * (`onJunctionDown`, below) until the NEXT `mouseup` anywhere — the same moment either armed gap's
   * own listener stops applying, so this never outlives the drag it tracks. While it is true, a
   * `requestAnimationFrame` loop keeps `bandGapY` current AS the band's own height changes under the
   * junction's own drag; the dependency-driven effect above is what re-measures for every OTHER
   * reason a junction can move (a window resize, the OTHER axis changing outside a junction drag).
   */
  const junctionDraggingRef = useRef(false)
  const onJunctionDown = useCallback((bandId: string, asideId: string) => (e: { clientX: number; clientY: number }) => {
    armGap(bandId, e)
    armGap(asideId, e)
    if (junctionDraggingRef.current) return
    junctionDraggingRef.current = true
    const step = () => {
      if (!junctionDraggingRef.current) return
      measureBandGapY()
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
    const unsubscribe = () => {
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
    }
    const stop = (e: Event) => {
      if (!isDragEndEvent(e.type)) return
      junctionDraggingRef.current = false
      unsubscribe()
    }
    window.addEventListener('mouseup', stop)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  }, [measureBandGapY])
  const junctionIds = isMobile ? [] : activeJunctions({
    leftOpen: leftAsideOpenNow,
    rightOpen: split && asideIn,
    // NOT `slotLayout.bottom !== null && slotLayout.bottomOpen` — which of `StudioBand`/`ShellBand`/
    // `SimpleDockedBand`/`PanelBarBand` actually renders is `bottomBandFor` (`lib/panelBar.ts`),
    // a function of MORE than `slotLayout.bottom` (relayed status, the session's own harness), so
    // `slotLayout.bottom` can read `null` while a real, open, resizable band sits on screen —
    // measured live: `bottom: null, bottomOpen: true` on a perfectly ordinary docked Shell. Whether
    // the band's own gap actually EXISTS (`bandGapY`, which mirrors it exactly — see that state's
    // own effect) is the one true signal, and it is `null` for a `PanelBarBand` (a relayed session's
    // bar-only band, which draws no `BandResizeHandle` at all — there is nothing there to junction
    // with, which is the correct answer for it too).
    bandOpen: bandGapY !== null,
  })

  if (dedicatedTerminal && selected) {
    const back = () => navigate(sessionPath(selected.id))
    const dedicated = (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 10px',
          flexShrink: 0, paddingTop: 'var(--safe-top)',
          borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
        }}>
          <button
            onClick={back}
            aria-label={pt ? 'Voltar para a sessão' : 'Back to the session'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              // 44px is the mobile figure, and this is the only way back from a full screen.
              width: 44, height: 44, flexShrink: 0, marginLeft: -6,
              border: 'none', background: 'transparent', color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <ChevronLeft size={20} />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <SessionLinkInfo session={selected} links={sessionLinks(selected, fleet.rows)} lang={pt ? 'pt' : 'en'} isMobile onGo={p => navigate(p)} />
              <div style={{
                fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{selected.title}</div>
              <SessionTitleFlag
                session={{
                  id: selected.id, title: selected.title,
                  ...(selected.harness ? { harness: selected.harness } : {}),
                  ...(selected.task ? { task: selected.task } : {}),
                }}
                lang={pt ? 'pt' : 'en'}
                onLinked={refresh}
              />
            </div>
            <div style={{
              fontSize: 10.5, color: 'var(--text-tertiary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {selected.stateLabel}
              {selected.project ? ` · ${selected.project}` : ''}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 10 }}>
          {/* A link to `?pane=shell` on a machine that serves no shell must not quietly draw the
              ASSISTANT's pane under a shell's name. There is no selector here to say so any more
              (see this branch's own header) — so this sentence is the only thing that can. */}
          {dedicatedPane === 'shell' && !shellEnabled && (
            <div role="status" style={{ fontSize: 11, color: 'var(--accent-red)', flexShrink: 0 }}>
              {pt
                ? 'Esta máquina não está servindo shell — abaixo está o terminal do assistente.'
                : 'This machine is not serving a shell — below is the assistant’s terminal.'}
            </div>
          )}
          {dedicatedPane === 'shell' && shellEnabled ? (
            <ShellBand
              key={`shell-${selected.id}`}
              placement="dedicated"
              fixedTarget="shell"
              sessionId={selected.id}
              {...(selected.cwd ? { cwd: selected.cwd } : {})}
              lang={pt ? 'pt' : 'en'}
              theme={theme === 'light' ? 'light' : 'dark'}
              {...(selected.harness ? { harness: selected.harness } : {})}
            />
          ) : (
            <ShellBand
              /* DEDICATED: you asked for this screen, so focus is the consent; on a phone it carries
                 the key strip. The same terminal the bottom band draws — see `fixedTarget`. */
              key={`cli-${selected.id}`}
              placement="dedicated"
              fixedTarget="cli"
              sessionId={selected.id}
              {...(selected.cwd ? { cwd: selected.cwd } : {})}
              lang={pt ? 'pt' : 'en'}
              theme={theme === 'light' ? 'light' : 'dark'}
              {...(selected.harness ? { harness: selected.harness } : {})}
            />
          )}
        </div>
      </div>
    )
    // MOBILE: unchanged from before this change — its own screen, nothing else on it, no room for
    // a companion aside. DESKTOP: falls through to `centre` so the shared split/aside composition
    // below can add the artifacts aside beside it exactly as it does for every other layout.
    if (isMobile) return dedicated
    centre = dedicated
  } else if (isMobile && (creating || finishing)) {
    // A session that is on its way owns the whole surface — before the panel case, because
    // `finishing` is the one moment BOTH are true, and before the list, which is the metrics screen
    // this replaced. One rule, both layouts: the loader is the same on a phone.
    //
    // THIS SCREEN OWNS THE STATUS-BAR BAND TOO, the same rule every other mobile top-of-screen
    // in this workspace already follows (the list header, the open-session header, the dedicated
    // terminal header — all pad `--safe-top`). This one was missed: with nothing but a centered
    // loader on a dark ground it read as harmless, but a session that takes a moment to start
    // (a cold harness, a slow host) leaves a reader looking at this screen under the real
    // status-bar band with no reservation for it at all.
    centre = (
      <div style={{
        display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
        paddingTop: 'var(--safe-top)',
      }}>
        <SessionCreating
          lang={pt ? 'pt' : 'en'}
          ready={finishing}
          {...(creatingState?.harness ? { harness: creatingState.harness } : {})}
          {...(creatingState?.label ? { label: creatingState.label } : {})}
        />
      </div>
    )
  } else if (isMobile && panel && selected) {
    centre = (
      <>
      {/* ONE bar. It used to be two: this back row, and SessionPanel's own header directly
          under it carrying the title, the tabs and the verbs. On a 390px screen that spent
          ~100px of a 664px viewport on chrome before a single message — and the back arrow
          already says where you are, so the word beside it was the least useful thing there.
          The arrow keeps its own 44px target; the title takes the room the label gave up. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        minHeight: 44, padding: '0 10px', flexShrink: 0,
        // Installed as a PWA this is the topmost thing on the screen, so it carries the
        // status-bar band itself — without it the arrow and the tabs sat under the clock and
        // the taps went to the status bar. See `--safe-top`.
        paddingTop: 'var(--safe-top)',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
        position: 'relative',
      }}>
        {/* Selection mode's face for this bar — see `ChatSelectionOverlay`. */}
        <ChatSelectionOverlay lang={pt ? 'pt' : 'en'} padX={10} />
        <button
          onClick={() => navigate('/sessions')}
          aria-label={pt ? 'Voltar para as sessões' : 'Back to sessions'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            // 44px is the mobile figure, and this is the only way back from this screen.
            width: 44, height: 44, flexShrink: 0, marginLeft: -6,
            border: 'none', background: 'transparent', color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <ChevronLeft size={20} />
        </button>

        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <SessionLinkInfo session={selected} links={sessionLinks(selected, fleet.rows)} lang={pt ? 'pt' : 'en'} isMobile onGo={p => navigate(p)} />
            <span style={{
              fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {selected.title}
            </span>
            <SessionTitleFlag
              session={{
                id: selected.id, title: selected.title,
                ...(selected.harness ? { harness: selected.harness } : {}),
                ...(selected.task ? { task: selected.task } : {}),
              }}
              lang={pt ? 'pt' : 'en'}
              onLinked={refresh}
            />
          </span>
          {/* The state stays, on its own line: it is the one fact that changes while you read,
              and the row below is a conversation that does not repeat it. */}
          <span style={{
            fontSize: 10.5, color: 'var(--text-tertiary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {selected.stateLabel}
            {selected.project ? ` · ${selected.project}` : ''}
          </span>
        </div>

        {/* ONLY THE TITLE AND THE METRICS, and that is the whole of this bar's rule.
            It carried the back arrow, `+ Filtro` with its word and badge, the view toggle, the
            metrics with their percentage, the panel button and the verbs — about 382px of a
            390px screen. The title block is `flex: 1, minWidth: 0`, so it was squeezed to
            nothing and the one thing saying WHICH session you are looking at was not on screen.

            Everything that is not the title or the metrics moved into the verbs' OWN menu —
            not a second popover beside it, which would be the same accumulation rearranged.
            The METRICS stay out here because the context percentage is read at a GLANCE and
            changes what you do next: a conversation near its window is one to finish rather
            than extend, and a figure you have to open a menu for is a figure nobody watches.
            The view toggle went in with the rest: asked for directly, after it had been left
            out here on the argument that two taps per switch was too many. */}
        {magnifierButton}
        {/* THE ONE CONTROL THAT STAYS BESIDE THE TITLE. Its own button, its own percentage —
            the figure is the reason it is out here rather than in the menu. */}
        {selected.conversationId !== undefined && (
          <SessionStatsMenu
            harness={selected.harness}
            sessionId={selected.conversationId}
            meta={selectedMeta}
            lang={pt ? 'pt' : 'en'}
            currency={currency}
            brlRate={brlRate}
            costBasis={ctx.costBasis}
            planFactor={sessionPlanFactor(ctx.planBasis.basis, selected.harness)}
            touch
            // THE DELIVERY, one tap away. The name IS the ref the board resolves, so this
            // costs no id lookup — see `lib/sessionTaskLink.ts`.
            {...(selected.task ? { task: selected.task } : {})}
            onOpenTask={ref => navigate(`/tasks/${encodeURIComponent(ref)}`)}
            // The Live tab, on the running step when there is one — read from the artifacts store
            // under this row's id, published by `onArtifacts` below.
            rowId={selected.id}
            onOpenLive={ref => openArtifacts('live', ref)}
            // The full reading is a TAB in the aside, not a second dialog over the session —
            // withheld when there is no record, exactly as the tab is.
            {...(sessionMetrics ? { onOpenFull: () => openArtifacts('metrics') } : {})}
            {...(selected.model ? { startedModel: selected.model } : {})}
            {...(selected.effort ? { startedEffort: selected.effort } : {})}
          />
        )}

        {rowIndex.get(selected.id) && (
          <SessionActions
            row={rowIndex.get(selected.id)!}
            lang={pt ? 'pt' : 'en'}
            act={act}
            onGone={() => navigate('/sessions')}
            onOpened={goToReopened}
            /* THE VIEW SWITCH, AS THE SWITCH IT IS. It came off the bar and was briefly two
               rows in this list, which is a different statement: two rows read as two things
               you could pick, while a segmented control says they are ALTERNATIVES and which
               one you are in. It is the same control the bar carried, with its labels back —
               there is room for words in a 240px menu and there was none in a 390px bar.
               Absent for a harness that can never name its conversation, exactly as before. */
            /* `!isCentral` is dev's gate, kept: on a central the conversation is not relayed, so a
               Chat tab there cannot do what it says. It moves with the control. */
            {...(!isCentral ? {
              extraTop: (close: () => void) => (
                <div role="tablist" style={{
                  display: 'flex', gap: 3, padding: 3, borderRadius: 10,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                }}>
                  {([
                    ['chat', pt ? 'Conversa' : 'Chat', <MessagesSquare key="c" size={15} />],
                    ['terminal', 'Terminal', <TerminalSquare key="t" size={15} />],
                  ] as const).map(([id, label, icon]) => (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={sessionView === id}
                      onClick={() => { setSessionView(id); close() }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        // 44px, the figure this repo holds every mobile target to — and this
                        // menu is opened with a thumb.
                        flex: 1, minHeight: 44, borderRadius: 8, border: 'none',
                        cursor: 'pointer', minWidth: 0,
                        background: sessionView === id ? 'var(--bg-surface)' : 'transparent',
                        color: sessionView === id ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                        fontFamily: 'inherit', fontSize: 12.5,
                        fontWeight: sessionView === id ? 650 : 400,
                      }}
                    >
                      {icon}
                      <span style={{
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{label}</span>
                    </button>
                  ))}
                </div>
              ),
            } : {})}
            extra={[
              /* THE FLOATING NAY BUTTON, on a phone. Inside a session it is hidden by default — it
                 sat on the composer's send button — and this row brings it back (per viewer,
                 `lib/nayFabVisibility.ts`). Desktop never hides it, so the row is phone-only. */
              ...(isMobile ? [{
                id: 'nay-fab',
                label: pt ? 'Exibir chat flutuante' : 'Show floating chat',
                icon: <MessageCircle size={15} />,
                on: nayFabShown,
                onSelect: () => setNayFabShownInSession(!nayFabShown),
              }] : []),
              {
                id: 'filters',
                label: pt ? 'Filtros' : 'Filters',
                icon: <Plus size={15} />,
                ...(filterCount > 0 ? { badge: String(filterCount) } : {}),
                on: filterCount > 0,
                onSelect: () => setSheetOpen(true),
              },
              {
                id: 'artifacts',
                label: pt ? 'Conteúdos da sessão' : 'Session contents',
                icon: <FileText size={15} />,
                // Reflects whether one of the ten former Contents tabs is the right slot's own
                // active occupant right now — `panelSlots.isTabPanelId` names that domain, the
                // in-panel switcher (`rightSwitcherMobile`) below already lets the reader pick a
                // SPECIFIC one; this row is the quick "some content is showing" shortcut.
                on: rightActivePanel !== null && isTabPanelId(rightActivePanel),
                onSelect: () => {
                  if (rightActivePanel !== null && isTabPanelId(rightActivePanel)) {
                    closeSlotPanel(rightActivePanel)
                  } else openSlotPanel('live')
                },
              },
              /* AGENTISTICS STUDIO, on a phone. The desktop entry is a button on the sessions
                 strip (`App.tsx`), which this layout does not render — the actions live in this
                 menu instead, which is where the panel's own entry already is. A tile in the
                 bottom nav's "More" sheet was the other candidate and is wrong: that sheet is
                 machine-wide chrome and the Studio is about the SESSION you have open, which
                 only this menu has.
                 ABSENT when the gate is closed, never greyed — the same `editorEnabled` the
                 aside reads, the server's own already-resolved answer with a CENTRAL already
                 subtracted where the app publishes it (`lib/editorGate.ts`): the `/api/fleet`
                 prefix is refused on a central, and this row used to be the one entry that
                 offered the Studio there.
                 NO `badge` ANY MORE (see §2 of the slots/references design): the desktop button
                 dropped its `NewTag` for a dot that clears after the first open, and a row with
                 no icon corner to put a dot on just drops the mark rather than keeping a word the
                 other nav lost. The beta caveat stays on the Studio's own top bar, one tap away.
                 `on: isPanelShown(slotLayout, 'studio')` mirrors the desktop button's pressed
                 state — the same `panelSlots.ts` layout, so a reader who opened the Studio from
                 THIS row and then came back to the menu finds it marked current. Built by
                 `studioMenuRow` (above `SessionsPage`) rather than as a literal here, so its `on`
                 wiring is asserted directly — see `SessionsPage.test.tsx`. */
              ...(editorEnabled
                ? [studioMenuRow(isPanelShown(slotLayout, 'studio'), <FolderTree size={15} />, () => openArtifacts('studio'))]
                : []),
            ]}
          />
        )}
      </div>
      {/* `display: flex` is the load-bearing part, not `flex: 1`.
          This div had `flex: 1, minHeight: 0` and no display, so it was a BLOCK. Its child —
          SessionPanel's own `flex: 1 1 0%` column — was therefore not a flex item at all, and
          a block child ignores its parent's height and grows to its content. Measured on an
          iPhone 12 viewport: this div sat at the correct 620px while the panel inside it was
          40.319px tall, which put the composer 40.305px down the page. The input was not
          hidden — it was rendered far below the fold, and the conversation could not scroll
          because the box that was supposed to scroll had no bounded height to scroll within.
          `flex: 1` on a child means nothing until its PARENT is a flex container. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{panel}</div>
      </>
    )
  } else if (isMobile) {
    centre = (
      <>
      {/* ONE bar, matching the open-session one above it. The filters used to be a fixed band
          here — two or three rows of controls that are consulted occasionally and read never,
          out of a 664px viewport — so they moved into a sheet that costs nothing until it is
          asked for and has the whole screen once it is. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        minHeight: 44, padding: '0 10px', flexShrink: 0,
        // Same reason as the open-session bar: the shared header is hidden on this layout, so
        // this row IS the top of the screen and owns the status-bar band.
        paddingTop: 'var(--safe-top)',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
      }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>
          {pt ? 'Sessões' : 'Sessions'}
        </span>
        {filterButton}
        {magnifierButton}
      </div>
      {/* `display: flex` again, and for the third time in this file's history the SAME rule:
          `flex: 1` on a child means nothing until its PARENT is a flex container. This div had
          `flex: 1, minHeight: 0` and no display, so `SessionsAside`'s own `flex: 1 1 0%` column
          was an ordinary block that grew to its content — and with it the scrolling box inside.
          Measured on an iPhone 12 with "Active only" off: the scroller reported
          clientHeight 16.567px against a 664px viewport, `scrollTop` could not move, and the 306
          inactive rows sat below the fold with no way to reach them. The band heading counted
          them correctly the whole time, which is what made it read as "the rows are missing"
          rather than "the list cannot scroll". */}
      {/* TWO SCREENS, one bar. The list is what a phone opens on — it is why you came — and the
          OVERVIEW is the same cards the desktop draws in the centre when nothing is selected.
          Asked for: "a tela inicial de quando n tem sessao selecionada que mostra as metricas,
          quero isso tbm na versao mobile".

          A segmented control rather than a scroll: the cards are tall, and putting them above 300
          rows would make the list unreachable on the screen whose whole problem is height. Both
          read the SAME `overviewRows` the desktop uses, so the two layouts can never count
          different sets — the defect this page has already hit twice. */}
      <div role="tablist" style={{
        display: 'flex', gap: 2, padding: '6px 12px 0', flexShrink: 0,
      }}>
        {([
          ['list', pt ? 'Sessões' : 'Sessions'],
          ['overview', pt ? 'Métricas' : 'Metrics'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={mobileTab === id}
            onClick={() => setMobileTab(id)}
            style={{
              flex: 1, minHeight: 40, borderRadius: 9, border: 'none', cursor: 'pointer',
              background: mobileTab === id ? 'var(--bg-elevated)' : 'transparent',
              color: mobileTab === id ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              fontFamily: 'inherit', fontSize: 13,
              fontWeight: mobileTab === id ? 650 : 400,
            }}
          >{label}</button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 12px' }}>
        {mobileTab === 'overview' ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            <FleetOverview
              lang={pt ? 'pt' : 'en'}
              rows={overviewRows}
              loading={loading}
              unsupported={unsupported}
              heatmap={derived.heatmapData}
              heatmapByHarness={derived.heatmapByHarness}
              baseline={fleet.baseline}
              sessionPresets={sessionPresets}
              onSelectPreset={selectPreset}
              {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
            />
          </div>
        ) : (
          <SessionsAside
            lang={pt ? 'pt' : 'en'}
            rows={fleet.rows}
            finishedTasks={fleet.finishedTasks}
            loading={loading}
            unsupported={unsupported}
            filters={filters}
            activeOnly={activeOnly}
            {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
            stale={stale}
            rowsById={rowIndex}
            act={req => act({ ...req, action: req.action as FleetActionId })}
          />
        )}
      </div>
      </>
    )
  } else if (creating || finishing) {
    // THE DESKTOP HALF OF THE SAME FIX (`isMobile && (creating || finishing)` above is the phone
    // one) — this branch did not exist at all, so a desktop reader fell straight through every
    // condition below to the LAST `else`, the plain fleet overview: `panel` is `null` while
    // `selected` is still `undefined` (the fleet has not polled the new row in yet), so nothing
    // before this point matched. Worse than a blank screen, that `else` ALSO carries the "that
    // session is no longer in this machine's list" notice (`sessionId !== undefined && !loading`),
    // which a moment-old, perfectly healthy spawn made read as already gone — this is the reported
    // "parece que não criou nada" in full: not merely a missing loader, but an actively wrong one.
    centre = (
      <SessionCreating
        lang={pt ? 'pt' : 'en'}
        ready={finishing}
        {...(creatingState?.harness ? { harness: creatingState.harness } : {})}
        {...(creatingState?.label ? { label: creatingState.label } : {})}
      />
    )
  } else if (panel) {
    // THE WRAPPER IS UNCONDITIONAL, and that is a focus bug rather than a style. It used to be
    // `edgeMarker === null ? panel : <div>{edgeMarker}{panel}</div>`: swapping the root between
    // `panel` and a div CONTAINING it changes the shape of the tree, so every DOM node under it was
    // recreated, the composer's textarea among them. Typing while a session worked lost the caret
    // the moment the strip appeared and lost it AGAIN when it went away — "quando essa barra
    // aparece ele desfoca e quando ela some o input tambem desfoca". `{null}` occupies the slot
    // without drawing anything, which is what makes the two cases the same SHAPE.
    //
    // The marker waits for the pane to be gone: the control and the thing it opens live in the same
    // place, and both being there at once reads as two panels.
    centre = (
      <>
        {artShell === 'none' ? edgeMarker : null}
        {panel}
      </>
    )
  } else {
    centre = (
      <>
      {/* A link to a session that is no longer in the list is not the same as no link at all, and
          the overview would silently swallow the difference — so it is said, once, above it. */}
      {sessionId !== undefined && !loading && (
        <p role="status" style={{
          margin: 0, padding: '12px 20px', fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)',
        }}>
          {pt
            ? 'Essa sessão não está mais na lista desta máquina.'
            : 'That session is no longer in this machine’s list.'}
        </p>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <FleetOverview
          lang={pt ? 'pt' : 'en'}
          // THE SAME ROWS THE ASIDE IS SHOWING, through the same `filterFleet`.
          //
          // It used to be the whole fleet, so the cards described a set the reader could not see:
          // "5 running of 306 in this list" beside an aside listing five, and a project count of
          // every project in the history. Two regions of one screen counting two different sets is
          // the defect this page has now hit twice — the second time was the cards holding still
          // while the heatmap emptied.
          //
          // The date range is deliberately not among the dimensions `filterFleet` applies: a live
          // session is happening now, and "last 7 days" would hide one that started eight days ago
          // and is still working. The note above the cards says exactly that, so the one filter
          // that does not move them is named rather than left to be discovered.
          rows={overviewRows}
          loading={loading}
          unsupported={unsupported}
          heatmap={derived.heatmapData}
          heatmapByHarness={derived.heatmapByHarness}
          baseline={fleet.baseline}
          sessionPresets={sessionPresets}
          onSelectPreset={selectPreset}
          {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
        />
      </div>
      </>
    )
  }

  /**
   * `splitRef` measures the room the pane is clamped against (`panelWidth`), so it belongs on the
   * element the pane is actually laid out in — which is now this one, in every layout.
   *
   * THE ROW LAYOUT ALSO HOSTS THE RAIL NOW, and the rail must sit beside the chat WHETHER OR NOT a
   * rail panel is currently open — `split` alone (`artShell === 'split'`) used to be the right test
   * for "row vs column" because the content box was NEVER genuinely empty while `split` failed (the
   * pre-rail fallback always rendered Contents there). Post-rail that is no longer true: a freshly
   * opened session opens nothing by default, `artShell` reads `'none'`, and `split` alone would
   * collapse the whole row — carrying the rail down into a COLUMN below the chat instead of beside
   * it (measured live: the rail landed flush left at x=288, 422px tall, stacked under the chat).
   * `railDesktop` is the wider test: any desktop viewport with a session selected keeps the row,
   * regardless of what the content box itself currently has to show.
   */
  const railDesktop = !isMobile && selected !== undefined

  /**
   * OWNER-APPROVED VISUAL, mockup option "C" (2026-09-26): the central pane — the region below
   * that holds the open session's conversation/terminal, and the fleet overview when nothing is
   * selected — reads as a card fitted into the surrounding frame. DESKTOP ONLY (`!isMobile`): a
   * phone's screens already cover the viewport edge to edge, and insetting them would just clip
   * the composer against the rounded corner for no visual gain.
   *
   * Four numbers, held in one place rather than scattered across the wrapper below and the three
   * frame dividers it replaces (`TopBar.tsx`'s `noBottomBorder`, `SideNav`'s own `borderRight`,
   * `PanelRail.tsx`'s `borderLeft`):
   *   - `border` — the existing `--border` token; no new colour.
   *   - `radius` — all four corners.
   *   - `gap` — the space cleared on every side, which is what makes those three frame borders
   *     (header above, aside left, rail right) redundant against the panel's OWN border and lets
   *     them be dropped rather than sandwiched.
   */
  const CENTRAL_PANE = { border: PANEL_BORDER, radius: PANEL_RADIUS, gap: 5 } as const
  // THE OUTER FRAME GAP is `OUTER_GAP` from `lib/panelLayout.ts` — it moved there once the dashboard
  // pages joined the same board, so both workspaces read one figure.
  /** The T-junction's own hit-zone square — `junctionHitRect`'s formula (`gap + extra`) applied to
   *  the CURRENT inner gap, so a future `PANEL_GAP` change resizes the junction's target along with
   *  the seam it sits on instead of leaving it sized for the old gap. */
  const JUNCTION_SIZE = junctionHitRect({ x: 0, y: 0 }, PANEL_GAP, 4).width
  /**
   * FLOATING-PANELS DESIGN (`sdd/brief.md`) — `SessionPanel` now draws its OWN two panels (the
   * conversation, then a gap, then the bottom band) with their own borders/radius/overflow-hidden,
   * because the bottom band moved from being docked INSIDE the conversation's card to being its own
   * panel below it. So this wrapper must NOT also draw a border around the pair — that would be a
   * panel drawn around two panels, exactly the nesting the brief forbids. It still draws the border
   * for every OTHER `centre` (nothing selected → `FleetOverview`; the dedicated terminal route),
   * which are genuinely a single region and still want the old inset-card treatment.
   */
  const centreOwnsItsPanels = panel !== null && !dedicatedTerminal

  return (
    <>
    {splitRoute && selected ? (
      <SplitPaneHeader
        pane={pane}
        lang={pt ? 'pt' : 'en'}
        session={selected}
        {...(rowIndex.get(selected.id) ? { row: rowIndex.get(selected.id)! } : {})}
        meta={selectedMeta}
        currency={currency}
        brlRate={brlRate}
        costBasis={ctx.costBasis}
        planFactor={sessionPlanFactor(ctx.planBasis.basis, selected.harness)}
        {...(sessionMetrics ? { onOpenFull: () => openArtifacts('metrics', undefined, pane) } : {})}
        onOpenLive={ref => openArtifacts('live', ref, pane)}
        onOpenTask={ref => navigate(`/tasks/${encodeURIComponent(ref)}`)}
        onLinked={refresh}
        act={act}
        onGone={closeThisPane}
        onOpened={goToReopened}
        onClosePane={closeThisPane}
        view={sessionView}
        onViewChange={setSessionView}
      />
    ) : null}
    {/* IDLE SESSIONS (Task 6) — the offer itself is `IdleReviewCard`, mounted inside `SessionsAside`
        (both its desktop and mobile-list instances), never here — see that card's own header. This
        page still owns the REVIEW MODAL below, and the ONE known gap stated for the old banner still
        holds for it: the mobile DEDICATED TERMINAL (`if (isMobile) return dedicated` above) returns
        before this point and never shows it — a deliberate, documented limitation rather than a
        restructuring of that early return. */}
    <div
      ref={splitRef}
      // `position: relative` ON EVERY BRANCH (fix, narrow-overlay pass, 2026-09-22) — it is the one
      // position value that does NOT become a containing block for a `position: fixed` descendant
      // (so the phone's full-screen pane still resolves against the viewport) and it is what the
      // narrow-desktop `overlay` shell's `position: absolute` (`artOuter`, below) is supposed to
      // resolve against. It used to sit ONLY in the second branch, which is taken exclusively on
      // MOBILE (`split || railDesktop` is false only when `isMobile` — see `railDesktop`'s own
      // comment) — so on DESKTOP, where `railDesktop` is true the instant a session is selected, the
      // overlay's `position: absolute` had no positioned ancestor to resolve against at all and
      // escaped all the way to `<body>`, landing its `top: 0` at the very top of the DOCUMENT rather
      // than at the top of THIS row (which sits below the fixed session header). Verified live at
      // 1000px: `PanelFixedControls`' full-screen/minimize buttons rendered at `top: 10`, correctly
      // positioned relative to body, but painted OVER by the app's own `position: fixed; z-index:
      // 300` header — present in the DOM, entirely invisible and unclickable. The fix costs nothing
      // on the branches that do not need it: `split`'s own box never uses `position: absolute`, and
      // `relative` on a flex container changes no layout of its children.
      style={{
        position: 'relative',
        ...(split || railDesktop
          ? { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }
          : { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }),
        // OUTER FRAME GAPS (`sdd/brief.md`, task 2) — the RIGHT edge (rail to window edge) and the
        // BOTTOM edge (every panel's own bottom, plus the rail's) are both spent HERE, uniformly,
        // for every child of this row: the centre column, the right gap, the artifacts aside and
        // the rail. The LEFT edge is the aside's own concern (`App.tsx`'s `SideNav`, `mode ===
        // 'sessions'` padding) — this row starts exactly where that padding ends, so adding a
        // paddingLeft here too would double the gap between the sessions list and the conversation.
        ...(isMobile ? {} : { paddingRight: OUTER_GAP, paddingBottom: OUTER_GAP }),
      }}
    >
      {/* `display: flex` is the load-bearing part, not `flex: 1`. This file has recorded the same
          bug three times: `flex: 1` on a child means nothing until its PARENT is a flex container,
          and a block child ignores its parent's height and grows to its content — which is how the
          composer once ended up 40.305px down the page on an iPhone 12. */}
      <div style={{
        display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0,
        // `relative` so the floating-window layer below (`FloatingPanelLayer`, `inset: 0`) covers
        // exactly the session area and nothing beside it — the rail and the aside are siblings.
        position: 'relative',
        // Desktop-only inset card (see `CENTRAL_PANE`, above). `margin`, never `padding`: this div
        // is a flex ITEM inside `splitRef`'s row (or the sole item in its column, in the fleet-
        // overview case), so the flex algorithm sizes it INCLUDING the margin — the pane simply
        // ends up 5px smaller on every side within the space it was already given, rather than the
        // margin being added on top of a size already computed and overflowing the fixed-height
        // column this workspace is built on (see the file's own note on the sessions workspace
        // never growing a page-level scrollbar). `overflow: hidden` clips children to the curve —
        // checked: the narrow-desktop `overlay` aside (`artOuter`) and every `position: fixed`
        // element in this file (the mention toast, the preset modals, `leaveGuard`) are SIBLINGS of
        // this div under `splitRef`, never descendants, so neither is clipped by it; the in-panel
        // popovers that are descendants (the composer's `/` and `@` pickers, the bubble's
        // right-click menu, the "more" menu) all open within their own nested containers, inset
        // from this box's edges, and stay inside it under normal use.
        //
        // ONLY `marginTop` SURVIVES HERE UNCONDITIONALLY. TOP ALIGNMENT (owner, 2026-09-27): this
        // used to be `CENTRAL_PANE.gap` (5px) — close enough to flush that the panel read as touching
        // the header, while the left list (`App.tsx`'s `SideNav`) has real room above it from its own
        // mark/mode-switch row. It is now `OUTER_GAP` (6px), the SAME figure every outer edge already
        // uses, so no panel in this workspace sits closer to a frame edge than any other.
        // `marginLeft`/`marginRight`/`marginBottom` are ZERO when this div owns its own two panels
        // (`centreOwnsItsPanels`): each of those three edges already has its own gap drawn by
        // something else — the LEFT one by the sessions-list panel's own resize gap, the RIGHT one
        // by the vertical `.ag-panel-gap` sibling below, the BOTTOM one by `splitRef`'s own
        // `paddingBottom` above — and adding a SECOND margin on top of any of them doubles the visual
        // gap (measured live, before this: 11px on the right instead of 6, back when both were 6px).
        // The plain `FleetOverview`/dedicated-terminal case has no such neighbour gaps of its own, so
        // it takes the same top-only gap as `SessionPanel`'s own panels (no side margin).
        ...(isMobile ? {} : centreOwnsItsPanels
          ? { marginTop: OUTER_GAP, marginLeft: 0, marginRight: 0, marginBottom: 0 }
          : {
            // Same placement as the panels `SessionPanel` draws for itself: only the top gap under
            // the header. A margin on the LEFT added itself to the left list's 10px gap (a 15px gap
            // with the grip's dots hugging the list — owner report); the sides are already the gaps.
            marginTop: OUTER_GAP, marginLeft: 0, marginRight: 0, marginBottom: 0,
            border: CENTRAL_PANE.border, borderRadius: CENTRAL_PANE.radius, overflow: 'hidden',
          }),
      }}>
        {centre}
        {/* PINNED PANELS FLOAT HERE (`lib/floatingPanels.ts`) — a layer over the session area, so
            a window can never be dragged outside it. Desktop only; always mounted with a session
            selected so the area is measured before the first pin is pressed. */}
        {!isMobile && selected && (
          <FloatingPanelLayer
            windows={floatingShown}
            render={floatingBody}
            title={floatingTitle}
            nameInGrip={id => id === 'studio'}
            onRaise={raisePanel}
            onPlace={placePanel}
            onArea={area => setFloatingArea(area, pane)}
          />
        )}
      </div>
      {/* THE RIGHT GAP IS THE HANDLE (`sdd/brief.md`) — no painted border of its own any more (that
          was the doubled divider next to the aside's own left border, screenshot `68381135`): the
          panel's border plus this gap's three dots are now the ONLY line between the centre column
          and the artifacts aside. Drag math UNCHANGED (`dragArt`/`shownArtWidth`, above) — only the
          visual and the hit area moved onto the shared `.ag-panel-gap` grip. */}
        {split && asideIn ? <div
          role="separator"
          aria-orientation="vertical"
          aria-label={pt ? 'Redimensionar painel lateral' : 'Resize the artifacts aside'}
          tabIndex={0}
          className="ag-panel-gap"
          // A stable id — the bottom-right T-junction (below) replays a synthetic `mousedown` on
          // this exact element (`PanelGap.tsx`'s `armGap`) to arm its own window-level drag
          // listener, reusing `dragArt`/`shownArtWidth`'s own clamp/persistence verbatim.
          id={paneDomId('ag-gap-aside-right', pane)}
          onMouseDown={e => {
            // From the width on screen, not the remembered one: a clamped panel would otherwise
            // jump to its stored width the moment the handle is touched.
            dragArt.current = { x: e.clientX, w: shownArtWidth }
            setArtDragging(true)
            document.body.style.userSelect = 'none'
          }}
          style={{ width: PANEL_GAP, flexShrink: 0, cursor: 'col-resize', background: 'transparent' }}
        ><PanelGapDots orientation="vertical" /></div> : null}
      {/* THE T-JUNCTIONS THEMSELVES — see the effect above this component's `return` for the
          measuring and `PanelGap.tsx`'s `PanelJunction`/`armGap` for what a press on one actually
          does. `position: fixed`, so rendering them here (rather than at each individual gap, which
          is what they sit BETWEEN) is only a matter of convenience — this is the one place both
          `bandGapY` and the two asides' own live edges are already in scope. */}
      {bandGapY !== null && junctionIds.includes('bottom-right') && rightAsideEdgeNow !== null && (
        <PanelJunction
          key="bottom-right"
          label={pt ? 'Redimensionar altura da barra e largura do painel' : 'Resize band height and panel width'}
          size={JUNCTION_SIZE}
          left={rightAsideEdgeNow - PANEL_GAP / 2}
          top={bandGapY}
          onDown={onJunctionDown(paneDomId('ag-gap-band-height', pane), paneDomId('ag-gap-aside-right', pane))}
        />
      )}
      {pane === 'main' && bandGapY !== null && junctionIds.includes('bottom-left') && (
        <PanelJunction
          key="bottom-left"
          label={pt ? 'Redimensionar altura da barra e largura da lista' : 'Resize band height and list width'}
          size={JUNCTION_SIZE}
          left={leftAsideEdge - PANEL_GAP / 2}
          top={bandGapY}
          onDown={onJunctionDown(paneDomId('ag-gap-band-height', pane), 'ag-gap-aside-left')}
        />
      )}
      {/* THE ONE PANE. See the block comment at the top of this section. */}
      {artShell === 'none' ? null : (
        <div style={artOuter} ref={rightAsideRef}>
          <div style={artInner}>{rightSlotContent}</div>
        </div>
      )}
      {/* THE RAIL (spec §2) — a SIBLING of the pane above, never inside its `artShell === 'none'`
          branch: "the rail exists even when every panel is at the bottom" (design §2), so a
          session with nothing open on the right still shows it, with its own config area (a later
          pass) to drop things back onto. Desktop only — mobile has no rail at all (spec §8), and
          the mobile switcher (`rightSwitcherMobile`) already covers the same ground there. */}
      {!isMobile && selected && (
        <PanelRail
          panels={gatedRailPanels}
          hidden={gatedHiddenPanels}
          active={slotLayout.right}
          rightOpen={slotLayout.rightOpen}
          activity={railActivity}
          hardwareCritical={hardwareCritical}
          railWidth={rawSlotLayout.railWidth}
          onResizeWidth={setRailWidth}
          lang={pt ? 'pt' : 'en'}
          {...(selected.harness ? { harness: selected.harness } : {})}
          onOpen={openSlotPanel}
          // `panelMinimizeAction` decides WHAT minimize means for THIS panel in the rail slot — see
          // `PanelRail`'s own `onMinimize` doc comment for the bug this replaced: `rightOpen` alone
          // only ever gates the Studio (`collapse-right-park`); every other panel needs the genuine
          // close (`close-right`) `rightSlotBar`'s own minimize button already performs, or the rail
          // icon's "minimize" flips a flag nothing reads and the panel stays fully visible.
          onMinimize={id => (
            panelMinimizeAction(id, 'rail') === 'collapse-right-park'
              ? setRightOpen(false)
              : closeSlotPanel(id)
          )}
          onMove={id => moveSlotPanel(id, 'bottom')}
          onHide={hideSlotPanel}
          onReveal={revealSlotPanel}
          onDrop={dropSlotPanel}
        />
      )}
      {/* THE STUDIO'S OWN PERSISTENT HOST — a SIBLING of the pane above, never nested inside its
          `artShell === 'none'` branch: the Studio can be shown in the BOTTOM band while the right
          pane is fully closed, and nesting it there would unmount it the moment that pane closed.
          Mounted only once the reader has actually opened it (`isPanelShown`), and only while the
          gate is open — the same two conditions `ArtifactsAside`'s own Studio mount used to read
          before this feature moved the Studio out of it.

          MOUNTED THROUGH `mountStudioHostPanel` (module-level, above), not a hand-written
          `cond && (<StudioHost .../>)`: a move (right↔bottom) changes `target` below without
          changing WHETHER this is shown, and `mountPanel` (`lib/panelSlots.ts`) inside that function
          is what makes "no `key=` of its own, exactly one call site" a fact about a function every
          caller shares rather than a rule this page has to keep re-observing. `sessionsPage.lint.
          test.ts`'s own I4 block pins this call SITE's literal (a `key` at ANY field position fails
          it — fix wave 3 restored the whole-literal scan a prior fix wave had narrowed to an
          occurrence count), `panelSlots.mountPanel.test.ts` pins `mountPanel` itself, and
          `studioHostMount.test.ts` (I4) calls `mountStudioHostPanel` DIRECTLY and inspects the real
          `React.ReactElement` it returns. **None of those three is what makes a stray `key` on the
          object literal below impossible to compile** — a source scan and a call through the real
          function both stay green for a `key` reached only via an intermediate typed variable, which
          neither one ever executes or reads. `StudioHostMountParams.key: never` (its own doc comment)
          is the one guarantee that closes that: it fails `tsc` for the literal below AND for that
          routed shape, pinned in `studioHostMountParams.types.test.ts`. */}
      {selected && mountStudioHostPanel({
        shown: editorEnabled === true && (isPanelShown(slotLayout, 'studio') || studioFloating),
        sessionId: selected.id,
        lang: pt ? 'pt' : 'en',
        autosave: editorAutosave === true,
        turns: artifactTurns,
        // `Studio.tsx`'s own bar is a bare close control now (W1-A): `onExit` closes the panel
        // outright, the closest reading of "leave" the slots model has — displacing it never asks,
        // closing it does.
        onExit: () => closeSlotPanel('studio'),
        target: studioTarget,
        harness: selected.harness as HarnessId,
        composerMounted: sessionView === 'chat',
        onMention: onStudioMention,
        // TRUE full screen — see `studioFullscreen`'s own header above. OFFERED IN EITHER SLOT as
        // of 2026-09-19 (`fullscreenModeFor`'s `'overlay'` mode): `SessionsPage`'s own
        // `rightSlotContent` wrapper and `SessionPanel.tsx`'s `StudioBand` both read the SAME flag
        // to draw the actual viewport-covering box, whichever of the two currently holds it.
        // A floating Studio has no full screen of its own: the window IS its size control.
        fullscreen: studioFloating ? false : studioFullscreen,
        onToggleFullscreen: studioFloating ? undefined : () => setStudioFullscreen(f => !f),
        // WHERE IT IS, AND HOW TO MOVE IT — the Studio's own ONE menu (`studioGearEntries`) reads
        // these to offer exactly the move the CURRENT slot allows, and nothing about a different
        // panel (owner, 2026-09-19). `rightIsStudio`/`bottomIsStudio` are already mutually
        // exclusive wherever `shown` is true, the same fact `studioTarget` above rests on.
        slot: rightIsStudio || studioFloating ? 'right' : 'bottom',
        // THE REAL PLACEMENT (rail-loose-ends, item 4) — `studioPlacement`, never `rightIsStudio`,
        // which a phone's viewport fold can leave reading `true` long after the real placement has
        // already become `'bottom'`. `onMove` is driven by the SAME fact for the SAME reason: with
        // `rightIsStudio` a second mobile press (bottom -> rail) silently did nothing, because the
        // fold kept asking to move it to `'bottom'`, where it already was.
        placement: studioPlacement,
        onMove: () => moveSlotPanel('studio', studioPlacement === 'bottom' ? 'rail' : 'bottom'),
        // THE ALWAYS-VISIBLE MINIMIZE ICON — right-slot only; at the bottom `StudioBand`'s own
        // collapse chevron already is this control (`panelMenu.ts`'s own `panelMinimizeAction`).
        // A FLOATING Studio minimizes into the bottom band's strip (owner, 2026-09-29), keeping its
        // window's place and size for the click that restores it.
        onMinimizeRight: studioFloating ? () => minimizeFloatingPanel('studio')
          : rightIsStudio ? () => setRightOpen(false) : undefined,
        // PIN = FLOAT (`lib/floatingPanels.ts`) — pressed on the docked Studio it floats it, pressed
        // on the floating window it docks it back. Nothing floats on a phone.
        // AT THE BOTTOM the pin leads the band's own tab row (`StudioBand`), so the toolbar has none.
        pinned: isMobile || (!rightIsStudio && !studioFloating) ? undefined
          : studioFloating
            ? { active: true, onToggle: () => dockBack('studio') }
            : { active: false, onToggle: () => floatPanel('studio') },
      })}
      {/* Mobile-only chrome, and a slot that is always here so it can never shift the pane. */}
      {isMobile ? filtersSheet : null}
      {/* §6's "Adicionado à mensagem" — see `onStudioMention` above. `position: fixed` rather than
          relying on an ancestor's own positioning, since this page's several return branches do not
          all share one — the same reason `role="status"` is used everywhere else a sentence appears
          and disappears on its own (`Studio.tsx`'s `StudioToast`). */}
      {mentionNotice && (
        <div
          role="status"
          style={{
            position: 'fixed', left: '50%', bottom: isMobile ? 78 : 14, transform: 'translateX(-50%)',
            zIndex: 60, padding: '7px 14px', borderRadius: 10,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            boxShadow: 'var(--ag-shadow-pop)', fontSize: 12.5, color: 'var(--text-primary)',
          }}
        >
          {MENTION_ADDED_TOAST[pt ? 'pt' : 'en']}
        </div>
      )}
      {/* The preset launch shelf's own overlays — `position: fixed`, like `mentionNotice` above, so
          they render correctly regardless of which of this page's several layout branches is
          active. See `selectPreset`/`confirmPresetLaunch` for the two paths. */}
      {launchingPreset && (
        <PresetLaunchConfirm
          lang={pt ? 'pt' : 'en'}
          preset={launchingPreset}
          busy={presetLaunchBusy}
          error={presetLaunchError}
          forceable={presetLaunchForceable}
          onCancel={() => { if (!presetLaunchBusy) { setLaunchingPreset(null); setPresetLaunchForceable(false) } }}
          onConfirm={() => void confirmPresetLaunch()}
          onForce={() => void confirmPresetLaunch(true)}
        />
      )}
      {presetPrefill && (
        <NewSessionModal
          lang={pt ? 'pt' : 'en'}
          onClose={() => setPresetPrefill(null)}
          initialPreset={presetPrefill}
          onStarted={(id, started) => {
            setPresetPrefill(null)
            if (id) {
              markSessionPending({ id, ...started })
              navigate(sessionPath(id), { state: { creating: started ?? {} } })
            }
          }}
        />
      )}
      {/* LAST, and always present, so adding it shifted no slot above. The return that holds the
          pane holds the question asked before the pane is dropped — see `leaveGuard`. */}
      {leaveGuard}
    </div>
    {pane === 'main' && idleOpen && (
      <IdleSessionsModal
        lang={pt ? 'pt' : 'en'}
        candidates={idleCandidates}
        rows={fleet.rows}
        underPressure={ramUnderPressure}
        onClose={() => setIdleOpen(false)}
        act={act}
        refresh={refresh}
      />
    )}
    </>
  )
}
