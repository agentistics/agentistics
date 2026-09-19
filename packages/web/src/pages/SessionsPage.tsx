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

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactElement, type ReactNode,
} from 'react'
import { useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import {
  ChevronLeft, Cpu, FileText, FolderTree, MessagesSquare, Plus, TerminalSquare,
  X as XIcon,
} from 'lucide-react'
import { StudioHost, type StudioHostProps } from '../components/sessions/StudioHost'
import { ResizeGrip } from '../components/ResizeGrip'
import {
  isPanelShown, mountPanel, resolveForGates, resolveForViewport, rightSlotShowing, usePanelSlots,
  type PanelGates,
} from '../lib/panelSlots'
import { MENTION_ADDED_TOAST } from '../lib/mentionInsert'
import type { HarnessId, SessionPreset } from '@agentistics/core'
import { getCentralMachine } from '../lib/centralMachinePick'
import type { AppContext } from '../lib/app-context'
import { useFleet, useFleetIndex, type FleetActionId } from '../lib/fleet'
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
import { SessionTitleFlag } from '../components/sessions/SessionTitleFlag'
import { MagnifierButton } from '../components/a11y/MagnifierButton'
import { HideLensesButton } from '../components/a11y/HideLensesButton'
import { ArtifactsAside } from '../components/sessions/ArtifactsAside'
import { HardwarePanel } from '../components/sessions/HardwarePanel'
import { UnsavedChangesGuard } from '../components/sessions/UnsavedChangesGuard'
import {
  artifactsPanelMax, ASIDE_ANIM_MS, ASIDE_EASE, edgeHint, PANEL_MIN_WIDTH, panelWidth,
  resolveArtifactLayout, type ArtifactLayout,
} from '../lib/artifactLayout'
import {
  closeArtifacts, openArtifacts, setArtifactCount, useArtifacts,
} from '../lib/artifactsStore'
import { studioMenuRow } from '../lib/studioMenuRow'
import { restingLeftEdge, setRightAsideEdge } from '../lib/rightAsideEdge'
import type { SessionDrilldownProps } from '../components/SessionDrilldown'
import type { Artifact } from '../lib/sessionArtifacts'
import { liveEvents, type LiveTurn } from '../lib/artifactTabs'
import { FiltersBar } from '../components/FiltersBar'
import { SessionPanel, type SessionView } from '../components/sessions/SessionPanel'
import { SessionsAside } from '../components/nav/SessionsAside'
import { SessionActions } from '../components/sessions/SessionActions'
import { filterFleet } from '../lib/fleetFilter'
import { FiltersSheet } from '../components/sessions/FiltersSheet'
import {
  arrivalFor, reopenedSessionRoute, sessionPath, stillArriving, type SessionArrival,
} from '../lib/sessionRoute'
import { dedicatedTerminalPath, paneForTarget, readTerminalPane } from '../lib/terminalSurface'
import { ShellBand } from '../components/sessions/ShellBand'
import { targetLabel } from '../lib/terminalTarget'
import { TerminalRegion } from '../components/RecentSessions'
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
  /** TRUE full screen for the Studio's bottom band — see `SessionsPage`'s own `studioFullscreen`. */
  fullscreen?: boolean
  /** Absent (not merely a no-op) while the Studio is not bottom-docked — see the call site's own
   *  comment on why the control is offered only where there is somewhere to go. */
  onToggleFullscreen?: () => void
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
  })
}

export default function SessionsPage() {
  const ctx = useOutletContext<AppContext>()
  const {
    lang, isCentral, theme, filters, setFilters, activeOnly, setActiveOnly,
    availableProjects, sessionCountByProject, models, availableHarnesses, derived,
    data, currency, brlRate, sessionPresets,
  } = ctx
  const pt = lang === 'pt'
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
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
  const [presetPrefill, setPresetPrefill] = useState<NonNullable<
    Parameters<typeof NewSessionModal>[0]['initialPreset']
  > | null>(null)

  function selectPreset(preset: SessionPreset) {
    if (preset.cwd) {
      setLaunchingPreset(preset)
      setPresetLaunchError(null)
    } else {
      setPresetPrefill({
        harness: preset.harness, prompt: preset.promptTemplate,
        ...(preset.model ? { model: preset.model } : {}),
        ...(preset.effort ? { effort: preset.effort } : {}),
        label: preset.label,
      })
    }
  }

  async function confirmPresetLaunch() {
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
        }),
      })
      const json = await res.json() as { ok: boolean; message: string; id?: string }
      if (!json.ok) {
        setPresetLaunchError(json.message)
        setPresetLaunchBusy(false)
        return
      }
      const started = launchingPreset
      setLaunchingPreset(null)
      setPresetLaunchBusy(false)
      if (json.id) {
        navigate(sessionPath(json.id), { state: { creating: { harness: started.harness, label: started.label } } })
      }
    } catch {
      setPresetLaunchError(pt ? 'Erro de rede ao falar com esta máquina.' : 'Network error talking to this machine.')
      setPresetLaunchBusy(false)
    }
  }

  // Never on a central: it aggregates many machines and hosts none of their sessions, so the only
  // fleet it could read is its own box's, drawn under someone else's rows.
  const { fleet, loading, unsupported: pollUnsupported, stale, act, refresh } = useFleet(pt ? 'pt' : 'en')
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
  const dedicatedTerminal = useLocation().pathname.endsWith('/terminal')
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
  const relayed = getCentralMachine() !== null

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
    navigate(r.path, r.options)
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
  const creatingState = (useLocation().state as { creating?: { harness?: string; label?: string } } | null)?.creating
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
  const sessionView: SessionView = viewParams.get('view') === 'terminal' ? 'terminal' : 'chat'
  const setSessionView = (v: SessionView) => setViewParams(prev => {
    const next = new URLSearchParams(prev)
    if (v === 'chat') next.delete('view')
    else next.set('view', v)
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
    if (!selected) { setOnDisk(new Map()); setOutsideNote(undefined); return }
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
  }, [selected?.id, pt])

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
    const up = () => {
      if (!dragArt.current) return
      dragArt.current = null
      setArtDragging(false)
      document.body.style.userSelect = ''
      try { localStorage.setItem('agentistics:artifacts-w', String(artWidth)) } catch { /* private mode */ }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [artWidth])
  const art = useArtifacts()
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
  const { layout: rawSlotLayout, openPanel: openSlotPanel, closePanel: closeSlotPanel } = usePanelSlots()
  const panelGates: PanelGates = { editorEnabled, shellEnabled, relayed }
  const slotLayout = resolveForGates(resolveForViewport(rawSlotLayout, isMobile), panelGates)
  const rightIsStudio = slotLayout.right === 'studio'
  const rightIsCli = slotLayout.right === 'cli'
  const rightIsShell = slotLayout.right === 'shell'
  const rightIsHardware = slotLayout.right === 'hardware'
  const bottomIsStudio = slotLayout.bottom === 'studio'
  const [rightSlotEl, setRightSlotEl] = useState<HTMLDivElement | null>(null)
  const [bottomStudioEl, setBottomStudioEl] = useState<HTMLDivElement | null>(null)
  /** `null` PARKS the Studio — mounted, hidden, taking no space — which is also what a COLLAPSED
   *  bottom band holding it means: collapsing must not be a way to lose a buffer. */
  const studioTarget: HTMLElement | null = rightIsStudio
    ? rightSlotEl
    : bottomIsStudio && slotLayout.bottomOpen ? bottomStudioEl : null
  /**
   * TRUE FULL SCREEN for the Studio's BOTTOM band — the whole viewport, not merely "fills the
   * centre column" (`SessionPanel`'s own `heightPrefs.full`, untouched by this). Held HERE, not
   * inside `StudioBand` itself, because `Studio.tsx`'s own gear menu (the deliberate, non-drag way
   * to ask for the same thing, and the one place its own exit control lives) is a SIBLING mount
   * reached through `StudioHost`'s portal below — the two can only ever agree on which state is
   * current if something above both of them owns the one flag.
   *
   * RESET the moment the Studio is no longer bottom-docked (moved to the right, closed, displaced)
   * — a lingering `true` would silently reopen full screen the next time the band merely expands,
   * from a plain "Expandir" press nobody asked to mean that.
   */
  const [studioFullscreen, setStudioFullscreen] = useState(false)
  useEffect(() => {
    if (!bottomIsStudio) setStudioFullscreen(false)
  }, [bottomIsStudio])
  const onArtifacts = useCallback((a: { artifacts: Artifact[]; loading: boolean; unavailable?: string; older?: string; unlisted: boolean; turns: readonly LiveTurn[] }) => {
    setArtifacts(a.artifacts)
    setArtifactTurns(a.turns)
    setArtifactsLoading(a.loading)
    setArtifactsUnavailable(a.unavailable)
    setArtifactsOlder(a.older)
    setArtifactsUnlisted(a.unlisted)
    if (selected) setArtifactCount(selected.id, a.artifacts.length)
  }, [selected])

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

  const artLayout = resolveArtifactLayout({
    // The RIGHT SLOT is open whenever Contents wants it OR panelSlots has put the Studio, Claude
    // Code, the Shell or Hardware there — opening any of them from a switcher must show the box
    // even though none of them touch `art.open`; see `StudioHost.tsx` and `lib/panelSlots.ts`.
    // Missing one of these here is exactly the shape of bug this comment already warns about for
    // the Studio: the switcher can pick the panel and the box never opens to show it — measured
    // live for `hardware` (design item 3): the header tab lit, `rightSlotContent` correctly chose
    // the `HardwarePanel` branch, and the aside stayed at ZERO width because nothing here had told
    // `resolveArtifactLayout` this was a reason to open it at all.
    open: (art.open || rightIsStudio || rightIsCli || rightIsShell || rightIsHardware) && selected !== undefined,
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
    open: art.open,
    events: liveEvents(artifactTurns),
    isMobile,
  })
  const HINT_VERB: Record<string, string> = {
    wrote: pt ? 'escrevendo' : 'writing',
    read: pt ? 'lendo' : 'reading',
    ran: pt ? 'rodando' : 'running',
    thought: pt ? 'pensando' : 'thinking',
    delegated: pt ? 'delegando' : 'delegating',
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
      title={`${HINT_VERB[hint.kind]} · ${hint.text}`}
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
        border: 'none', borderBottom: '1px solid var(--border-subtle)',
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
      {/* The THING, not a count: a path or a command says whether this is worth watching. */}
      <span style={{
        minWidth: 0, flex: 1, color: 'var(--text-tertiary)', fontSize: 11,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
      }}>{hint.text}</span>
      <span style={{ flexShrink: 0, color: 'var(--anthropic-orange)', fontSize: 11 }}>
        {pt ? 'acompanhar →' : 'follow →'}
      </span>
    </button>
  )

  const artifactsPane = selected === undefined ? null : (
    <ArtifactsAside
      sessionId={selected.id}
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
      tabRequest={art.tabRequest}
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
      onClose={closeArtifacts}
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
  const rightActivePanel: 'studio' | 'cli' | 'shell' | 'hardware' | null = rightIsStudio
    ? 'studio' : rightIsCli ? 'cli' : rightIsShell ? 'shell' : rightIsHardware ? 'hardware' : null
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
  const rightSwitcherMobile = (isMobile && selected) ? (
    <div role="tablist" aria-label={pt ? 'O que mostrar' : 'What to show'} style={{
      display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, flexWrap: 'wrap',
      padding: '4px 6px', borderBottom: '1px solid var(--border)',
    }}>
      {(
        [
          { id: 'contents' as const, label: pt ? 'Conteúdo' : 'Contents', icon: <FileText key="c" size={12} />, on: rightSlotShowing(slotLayout, art.open) === 'contents', shown: true },
          { id: 'studio' as const, label: 'Studio', icon: <FolderTree key="s" size={12} />, on: rightIsStudio, shown: editorEnabled === true },
          { id: 'hardware' as const, label: pt ? 'Hardware' : 'Hardware', icon: <Cpu key="hw" size={12} />, on: rightIsHardware, shown: hardwareOffered },
        ]
      ).filter(entry => entry.shown).map(({ id, label, icon, on }) => (
        <button
          key={id}
          role="tab"
          aria-selected={on}
          onClick={() => {
            // `openArtifacts()` itself displaces a right-slot panel, asking first when it is the
            // Studio and dirty (`lib/artifactsStore.ts`) — a separate `closeSlotPanel` here would
            // ask a second, redundant question and could open Contents before the first is answered.
            if (id === 'contents') openArtifacts()
            else openSlotPanel(id, 'right')
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            minHeight: 44, padding: '0 14px',
            borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 11.5, fontWeight: on ? 700 : 500,
            background: on ? 'var(--bg-elevated)' : 'transparent',
            color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
          }}
        >{icon}{label}</button>
      ))}
      <span style={{ flex: 1 }} />
      {/* CLOSE — a phone has no fixed header to close this from any other way (item 2's merged
          tab group is desktop-only), so this stays the one door out here. Closing the Studio asks
          first when dirty, through the very `hidePanel` `closeSlotPanel` already calls. */}
      {rightActivePanel && (
        <button className="ag-tap-icon"
          onClick={() => closeSlotPanel(rightActivePanel)}
          title={pt ? 'Fechar' : 'Close'}
          aria-label={pt ? 'Fechar' : 'Close'}
          style={rightSlotIconBtn}
        ><XIcon size={13} /></button>
      )}
    </div>
  ) : null

  /**
   * DESKTOP HAS NO TOOLBAR HERE ANY MORE (owner feedback, 2026-09-17: "there must be exactly ONE
   * panel switcher on desktop … no tab row inside the right aside"). This used to be a "Move to the
   * bottom" button (`rightSlotToolbar`) that called `moveSlotPanel` directly — a SECOND, DISCONNECTED
   * control that could move a panel in `panelSlots.ts` without ShellBand ever learning the stream it
   * should now be showing (`ShellBand`'s own `target` is a separate local preference,
   * `chooseTarget`-driven — see that component's own header), which is exactly how pressing it read
   * as "this just closes the right aside": the store moved the panel correctly, but the docked band
   * kept showing whatever it last had a `target` for, or nothing.
   *
   * The move gesture now lives in the ONE panel bar's own overflow menu — computed once by
   * `SessionPanel.tsx` (`moveDownEntries`, where the docked band's own `chooseTarget` is in scope to
   * call) and rendered by whichever band is docked (`ShellBand`/`StudioBand`/`PanelBarBand`), so a
   * move can never again land in the store without the screen that has to display it hearing about
   * it. CLOSING a right-slot panel needs no replacement here: it was already reachable by clicking
   * the same (lit) entry in that one bar (`onPanelBarPick`), never through this toolbar.
   */
  const rightSlotHeader = isMobile ? rightSwitcherMobile : null

  /** What the right box actually shows: the Studio's own target (StudioHost re-parents its carrier
   *  into it) while `panelSlots` says so; `cli`/`shell` render their own `TerminalRegion`/`ShellBand`
   *  with `placement="aside"` (design §1.5) — ordinary mounts, no persistent carrier needed since
   *  neither holds a buffer that must survive the move; `hardware` its own `HardwarePanel` (design
   *  item 3, sharing its content with the modal); `ArtifactsAside` otherwise. */
  const rightSlotContent = rightIsStudio ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      <div ref={setRightSlotEl} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }} />
    </div>
  ) : rightIsCli && selected ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      <div style={{ flex: 1, minHeight: 0, padding: 10, display: 'flex', flexDirection: 'column' }}>
        <TerminalRegion
          placement="aside"
          id={selected.id}
          theme={theme === 'light' ? 'light' : 'dark'}
          lang={pt ? 'pt' : 'en'}
          fill
          {...(rowIndex.get(selected.id) ? { row: rowIndex.get(selected.id)! } : {})}
          act={act}
        />
      </div>
    </div>
  ) : rightIsShell && selected ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      <div style={{ flex: 1, minHeight: 0, padding: 10, display: 'flex', flexDirection: 'column' }}>
        <ShellBand
          key={`aside-${selected.id}`}
          placement="aside"
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
      <HardwarePanel lang={pt ? 'pt' : 'en'} onClose={() => closeSlotPanel('hardware')} />
    </div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {rightSlotHeader}
      {artifactsPane}
    </div>
  )

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
      sessionKeys={[sessionId, selected?.id, selected?.conversationId]
        .filter((k): k is string => typeof k === 'string' && k !== '')}
    />
  )

  const panel = selected === undefined ? null : (
    <SessionPanel
      session={selected}
      {...(rowIndex.get(selected.id) ? { row: rowIndex.get(selected.id)! } : {})}
      lang={pt ? 'pt' : 'en'}
      theme={theme === 'light' ? 'light' : 'dark'}
      act={act}
      onGone={() => navigate('/sessions')}
      // Follow a reopen to the row it created. Without it the panel keeps an id the fleet no longer
      // carries — see `SessionPanel`'s own `onOpened`.
      onOpened={goToReopened}
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
      onTaskLinked={refresh}
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
    artifactsPane === null || !asideAlive || !panel || (isMobile && (creating || finishing))
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
  useEffect(() => {
    const el = rightAsideRef.current
    if (isMobile || artShell === 'none' || artShell === 'fullscreen' || !el) {
      setRightAsideEdge(null)
      return
    }
    const report = () => {
      const rect = el.getBoundingClientRect()
      setRightAsideEdge(restingLeftEdge(rect.left, getComputedStyle(el).transform))
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
  }, [isMobile, artShell, splitRoom, asideIn])
  useEffect(() => () => setRightAsideEdge(null), [])

  // ---------------------------------------------------------------------------
  // The DEDICATED terminal — one screen, one pane, both layouts. Before the mobile branch because
  // it is the SAME screen at 390px and at 1440px: a terminal that fills what it is given needs no
  // second version, and the key strip it gets on a phone is decided by `keyStripShown`.
  // ---------------------------------------------------------------------------
  if (dedicatedTerminal && selected) {
    const back = () => navigate(sessionPath(selected.id))
    return (
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
          {/* THE TARGET SELECTOR. One screen, two panes, and neither segment may be called
              "Terminal" — that ambiguity is exactly what phase 1 avoided by naming the shell a
              shell. It is a ROUTE and not a state, so a reload and a shared link land on the pane
              you were looking at. Withheld when this machine serves no shell: a segment whose only
              outcome is a refusal is worse than no segment. */}
          {shellEnabled && (
            <div role="tablist" aria-label={pt ? 'Qual terminal' : 'Which terminal'} style={{
              // RIGHT, like the band's. One control, one shape, one SIDE — a control that changes
              // corner between the docked band and this screen is one the reader has to find again.
              display: 'flex', gap: 4, flexShrink: 0, alignSelf: 'flex-end',
              padding: 3, borderRadius: 8, background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
            }}>
              {(['assistant', 'shell'] as const).map(target => {
                const on = dedicatedPane === target
                // ONE VOCABULARY. The band and this screen ask the same question, so they may not
                // word it differently — and the CLI segment is named after the harness on the
                // screen rather than after a concept.
                const label = targetLabel(
                  target === 'assistant' ? 'cli' : 'shell',
                  selected.harness,
                  pt ? 'pt' : 'en',
                )
                return (
                  <button
                    key={target}
                    role="tab"
                    aria-selected={on}
                    onClick={() => navigate(dedicatedTerminalPath(selected.id, target), { replace: true })}
                    style={{
                      // 44px is the MOBILE figure; on a desktop it would turn a segmented control
                      // into a row of buttons.
                      minHeight: isMobile ? 44 : 26, padding: isMobile ? '0 16px' : '0 12px',
                      borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: 12, fontWeight: 650, border: 'none',
                      background: on ? 'var(--bg-surface)' : 'transparent',
                      color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      boxShadow: on ? '0 1px 2px rgba(0,0,0,0.18)' : 'none',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}
          {/* A link to `?pane=shell` on a machine that serves no shell must not quietly draw the
              ASSISTANT's pane under a shell's name. The selector is absent there — a segment whose
              only outcome is a refusal is worse than none — so the sentence is the only thing that
              can say what happened. */}
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
              sessionId={selected.id}
              {...(selected.cwd ? { cwd: selected.cwd } : {})}
              lang={pt ? 'pt' : 'en'}
              theme={theme === 'light' ? 'light' : 'dark'}
              {...(selected.harness ? { harness: selected.harness } : {})}
            />
          ) : (
            <TerminalRegion
              /* DEDICATED: you asked for this screen, so focus is the consent and there is no arm
                 button; on a phone it carries the key strip. */
              placement="dedicated"
              id={selected.id}
              theme={theme === 'light' ? 'light' : 'dark'}
              lang={pt ? 'pt' : 'en'}
              fill
              {...(rowIndex.get(selected.id) ? { row: rowIndex.get(selected.id)! } : {})}
              act={act}
            />
          )}
        </div>
      </div>
    )
  }

  /**
   * What the pane sits beside or under. A VALUE, never a `return`: the moment one of these is
   * returned on its own, the pane it was meant to share a parent with is at a different index.
   */
  let centre: ReactNode
  if (isMobile && (creating || finishing)) {
    // A session that is on its way owns the whole surface — before the panel case, because
    // `finishing` is the one moment BOTH are true, and before the list, which is the metrics screen
    // this replaced. One rule, both layouts: the loader is the same on a phone.
    centre = (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
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
      }}>
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
            {...(!isCentral && selected.conversationBlind === undefined ? {
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
                on: art.open,
                onSelect: () => (art.open ? closeArtifacts() : openArtifacts()),
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
   */
  return (
    <div
      ref={splitRef}
      style={split
        ? { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }
        // `relative` for the overlay to resolve against, and it is the one position value that does
        // NOT become a containing block for a `position: fixed` descendant — so the phone's
        // full-screen pane still resolves against the viewport.
        : { position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      {/* `display: flex` is the load-bearing part, not `flex: 1`. This file has recorded the same
          bug three times: `flex: 1` on a child means nothing until its PARENT is a flex container,
          and a block child ignores its parent's height and grows to its content — which is how the
          composer once ended up 40.305px down the page on an iPhone 12. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        {centre}
      </div>
      {/* The handle. Four pixels of hit area over a one-pixel rule — the rule is what you see, the
          area is what you can grab, and matching them makes a divider people miss. It goes with the
          panel: a grab handle for something that is halfway out of the room resizes nothing.
          `ResizeGrip` (design item 6) paints the small pill that says so without touching the hit
          area itself — `.ag-resize-handle` is what gives it something to key its hover/drag state
          off, in `index.css`. */}
        {split && asideIn ? <div
          className="ag-resize-handle"
          onMouseDown={e => {
            // From the width on screen, not the remembered one: a clamped panel would otherwise
            // jump to its stored width the moment the handle is touched.
            dragArt.current = { x: e.clientX, w: shownArtWidth }
            setArtDragging(true)
            document.body.style.userSelect = 'none'
          }}
          style={{
            width: 4, flexShrink: 0, cursor: 'col-resize', background: 'transparent',
            borderLeft: '1px solid var(--border)',
          }}
        ><ResizeGrip orientation="vertical" /></div> : null}
      {/* THE ONE PANE. See the block comment at the top of this section. */}
      {artShell === 'none' ? null : (
        <div style={artOuter} ref={rightAsideRef}>
          <div style={artInner}>{rightSlotContent}</div>
        </div>
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
        shown: editorEnabled === true && isPanelShown(slotLayout, 'studio'),
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
        // TRUE full screen — see `studioFullscreen`'s own header above. The TOGGLE is offered only
        // while the Studio is actually BOTTOM-DOCKED (`bottomIsStudio`): the right slot has no drag
        // handle and no giant-band gesture to escalate from, the same "offered only where there is
        // somewhere to go" rule `ShellBand`'s own fullscreen control follows for `aside`/`dedicated`.
        fullscreen: studioFullscreen,
        onToggleFullscreen: bottomIsStudio ? () => setStudioFullscreen(f => !f) : undefined,
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
          onCancel={() => { if (!presetLaunchBusy) setLaunchingPreset(null) }}
          onConfirm={() => void confirmPresetLaunch()}
        />
      )}
      {presetPrefill && (
        <NewSessionModal
          lang={pt ? 'pt' : 'en'}
          onClose={() => setPresetPrefill(null)}
          initialPreset={presetPrefill}
          onStarted={(id, started) => {
            setPresetPrefill(null)
            if (id) navigate(sessionPath(id), { state: { creating: started ?? {} } })
          }}
        />
      )}
      {/* LAST, and always present, so adding it shifted no slot above. The return that holds the
          pane holds the question asked before the pane is dropped — see `leaveGuard`. */}
      {leaveGuard}
    </div>
  )
}
