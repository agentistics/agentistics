/**
 * NayDock — the floating chat, rebuilt around REAL sessions.
 *
 * A Nay conversation is an ordinary managed `claude` session running in Nay's own directory
 * (`isNayCwd`), so this component draws it with the very `SessionChat` the sessions workspace
 * draws. The composer is that component's: attachments, the metrics chip, the microphone, auto
 * mode and everything else come with it, and nothing here re-implements any of them. See
 * docs/superpowers/specs/2026-09-29-nay-as-sessions-design.md.
 *
 * Shape: one fixed button (it is ALWAYS the chat button, whatever is detached) opens a panel with
 * two tabs.
 * - **Nay** lists the running Nay sessions and starts new ones.
 * - **Sessões** is the same `SessionsAside` the sidebar mounts, opening what you pick in the panel.
 *
 * A session can be detached into a window of its own. Picking one opens it WHERE IT IS (`openSession`
 * in `lib/nayDock.ts`), so the same session is never on screen twice.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowLeft, Loader2, Minus, MoreVertical, PictureInPicture2, Plus, Power, SquareArrowOutUpRight, X } from 'lucide-react'
import { isNayCwd, nayPlacementRows, planNayPlacement, sessionIdentityKey, type Filters, type SessionMeta } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { sessionRunning } from '@agentistics/tui/control/session-dimensions'
import type { AppContext } from '../../lib/app-context'
import { useFleet, useFleetIndex, type FleetActionId } from '../../lib/fleet'
import { sessionPlanFactor } from '../../lib/costBasis'
import { versionedAsset } from '../../lib/brand'
import { sessionCardStyle } from '../../lib/sessionCardStyle'
import { readAsideGroupPrefs, subscribeAsideGroupPrefs } from '../../lib/sessionsAsidePrefs'
import { SessionFacts } from '../sessions/SessionFacts'
import { TabStrip } from '../sessions/formBits'
import { SessionRowMenu } from '../sessions/SessionRowMenu'
import { SessionFiling } from '../tasks/SessionFiling'
import { boardCopy } from '../tasks/copy'
import { detachSession as unfileSession } from '../../lib/tasks'
import { RenameSessionDialog } from '../sessions/RenameSessionDialog'
import { NOTIFY_TOGGLE, notifyMenuExtras, useMutedKeys } from '../../lib/notifyMenu'
import { toggleSessionMuted } from '../../lib/mutedSessions'
import { LINK_TASK, NAY_COPY_ID, NAY_GO_TO, UNLINK_TASK, nayRowMenuEntries, type RowVerb } from '../../lib/rowMenu'
import {
  clampPanelSize, closeWindow, detachSession, dockSession, minimizeWindow, openSession, parseDockState,
  placeWindow, pruneDock, anchorDock, resizeAnchored, PANEL_DEFAULT, dockZIndex, windowZIndex, type DockState, type NayWindow, type Size,
} from '../../lib/nayDock'
import { SessionChat, type SessionComposerMetrics } from '../sessions/SessionChat'
import { SessionsAside } from '../nav/SessionsAside'
import { MinimizedMenu } from './MinimizedMenu'
import { NayFab } from './NayFab'
import { getFabLive, subscribeFabLive } from '../../lib/nayFabLive'
import { followSettled, forceRest, shouldWake, frameStyle, initFollow, landImpulse, nextQuiet, renderDock, REST_AFTER_FRAMES, stepFollow, type DockFollowState, type DockFrame } from '../../lib/nayDockFollow'
import { DockSettings, DockSettingsScreen } from './DockSettings'
import { NayNotifyCard } from './NayNotifyCard'
import { setOpenSession, setVisibleSessions } from '../../lib/nayNotifyStore'
import { nayFabVisible, useNayFabShownInSession } from '../../lib/nayFabVisibility'
import { useLocation, useNavigate } from 'react-router-dom'
import { sessionPath } from '../../lib/sessionRoute'
import { getSessionGroups } from '../../lib/sessionUserGroups'
import { getPinnedIds } from '../../lib/pinnedSessions'
import { loadSharedPrefs } from '../../lib/sharedPref'
import { useNayDefaults, useNayHarnesses } from '../../hooks/useNayDefaults'
import { launchSummary, normalizeChoice, type NayLaunchChoice } from '../../lib/nayLaunch'
import { HARNESS_LABELS } from '../../lib/harness'
import { NayLaunchFields } from './NayLaunchFields'
import { naySections, NAY_SECTION_ORDER, NAY_SECTION_TEXT, naySectionOf, type NaySectionId } from '../../lib/nayList'
import { cardStyleOf, clampFabPos, defaultFabPos, dockStyleOf, FAB_SIZE } from '../../lib/nayFab'
import { setNayFabPrefs, useNayFabPrefs } from '../../lib/nayFabPrefsStore'
import { createPersonalDoc, createSharedPref } from '../../lib/sharedPref'

type Lang = 'pt' | 'en'
type Tab = 'nay' | 'sessions'
const DOCK_TABS: readonly Tab[] = ['nay', 'sessions']

const ORANGE = 'var(--anthropic-orange)'
const ORANGE_DIM = 'var(--anthropic-orange-dim)'
const SIZE_KEY = 'agentistics-nay-dock-size'
const WINDOWS_KEY = 'agentistics-nay-dock-windows'
const TAB_KEY = 'agentistics-nay-dock-tab'
/** How long a just-started session may be missing from the fleet before we stop saying it is coming. */
const ARRIVAL_BUDGET_MS = 20_000

/**
 * The open windows and the active tab are CHOICES and live server-side (`/api/user-prefs`), so the
 * dock reads the same on every device; the panel SIZE depends on the screen and stays per browser.
 */
const windowsStore = createPersonalDoc(WINDOWS_KEY, 'nayDockWindows')
const tabStore = createSharedPref<Tab>({
  key: TAB_KEY, prefKey: 'nayDockTab', fallback: 'nay', adoptLocalWhenAbsent: true,
  parse: v => (v === 'sessions' || v === 'nay' ? v : null),
})

/** Every storage touch is guarded: a private window makes the accessor itself throw. */
function readStored<T>(key: string, parse: (v: unknown) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : parse(JSON.parse(raw))
  } catch { return fallback }
}
function writeStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* a convenience, never required */ }
}

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight })

export interface NayDockProps {
  lang: Lang
  isMobile: boolean
  ctx: Pick<AppContext, 'data' | 'currency' | 'brlRate' | 'costBasis' | 'planBasis'
    | 'chatModel' | 'setChatModel' | 'chatSoundEnabled' | 'setChatSoundEnabled' | 'chatSoundId' | 'setChatSoundId'>
  /** The sidebar's own session filters, so the "Sessões" tab lists what the sidebar lists. */
  filters: Filters
  activeOnly: boolean
}

export function NayDock({ lang, isMobile, ctx, filters, activeOnly }: NayDockProps) {
  const pt = lang === 'pt'
  const { fleet, loading, unsupported, stale, act } = useFleet(lang)
  const rowIndex = useFleetIndex(fleet.sessions)

  const [dock, setDock] = useState<DockState>(() => ({
    open: false, panelSession: null, ...parseDockState(windowsStore.get()),
  }))
  const [tab, setTab] = useState<Tab>(() => tabStore.get())
  // Follow the server's copy when it lands after mount, or arrives from another device.
  useEffect(() => windowsStore.subscribe(() => {
    const { windows } = parseDockState(windowsStore.get())
    setDock(d => (JSON.stringify(d.windows) === JSON.stringify(windows) ? d : { ...d, windows }))
  }), [])
  useEffect(() => tabStore.subscribe(() => setTab(tabStore.get())), [])
  const [size, setSize] = useState<Size>(() => clampPanelSize(readStored(SIZE_KEY, v => {
    const o = v as Partial<Size>
    return typeof o?.w === 'number' && typeof o?.h === 'number' ? { w: o.w, h: o.h } : PANEL_DEFAULT
  }, PANEL_DEFAULT), viewport()))
  const [starting, setStarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Sessions just started here, and when — so the panel says "starting" rather than "not found". */
  const [arriving, setArriving] = useState<Record<string, number>>({})

  useEffect(() => { windowsStore.set({ windows: dock.windows }) }, [dock.windows])
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // "Go to session": the workspace route for it, leaving the dock and every window exactly as they are.
  const goToSession = useCallback((id: string) => navigate(sessionPath(id)), [navigate])
  const inSession = pathname.startsWith('/sessions/')
  // The session on screen, for the notifications: a card about it is never shown, and opening one
  // is what "not opened for a while" is measured from.
  useEffect(() => {
    const id = inSession ? decodeURIComponent(pathname.slice('/sessions/'.length).split('/')[0] ?? '') : ''
    setOpenSession(id || null)
  }, [pathname, inSession])
  const shownInSession = useNayFabShownInSession()
  const fabVisible = nayFabVisible({ isMobile, inSession, shownInSession })
  // The button's place and its three motion choices live in a shared store: Settings → Chat edits
  // them too, and two copies of one setting disagree the moment either changes.
  const fabPrefs = useNayFabPrefs()
  /** Sessions still waiting on the person — the Nay button's badge and the top of the Nay tab. */
  /** The chat window's settings screen replaces the conversation while it is open (owner, 2026-09-30). */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  // Opening a session (a notification's Reply, a row) or closing the window leaves the settings screen.
  useEffect(() => { setSettingsOpen(false) }, [dock.panelSession, dock.open])
  const setFabPrefs = setNayFabPrefs
  const dockStyle = dockStyleOf(fabPrefs)
  useEffect(() => { tabStore.set(tab) }, [tab])
  useEffect(() => { writeStored(SIZE_KEY, size) }, [size])
  useEffect(() => {
    const onResize = () => setSize(s => clampPanelSize(s, viewport()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const findSession = useCallback((id: string): ControlSession | undefined =>
    fleet.rows.find(r => r.id === id || r.conversationId === id), [fleet.rows])

  // A session that no longer exists leaves no empty frame behind — but only once the fleet has
  // answered, and never for one that is still on its way.
  useEffect(() => {
    if (loading) return
    const now = Date.now()
    setDock(d => pruneDock(d, id => !!findSession(id) || (arriving[id] !== undefined && now - arriving[id]! < ARRIVAL_BUDGET_MS)))
  }, [loading, findSession, arriving])

  const sections = useMemo(() => naySections(fleet.rows), [fleet.rows])

  /*
   * THE SERVER FILES NAY CONVERSATIONS; THIS TAB ONLY RE-READS WHAT IT WROTE.
   *
   * On every fleet read the server moves each Nay conversation into "Nay › Ativas" or
   * "Nay › Inativas" (`reconcileNayFolders`). The browser's copy of the groups is only re-read when
   * the tab regains focus, so a conversation started or ended here went on showing in the wrong
   * place — and the next drag in the aside wrote that stale copy back over the server's filing. So
   * when the local copy disagrees with where the fleet says a Nay conversation belongs, re-read it,
   * at most once every few seconds. Never a write: the folder ids are minted on the server, and a
   * browser creating its own would leave two "Nay" trees.
   */
  const lastSync = useRef(0)
  useEffect(() => {
    const rows = nayPlacementRows(fleet.rows, sessionRunning)
    if (rows.length === 0) return
    if (!planNayPlacement(getSessionGroups(), getPinnedIds(), rows).changed) return
    const now = Date.now()
    if (now - lastSync.current < 4000) return
    lastSync.current = now
    void loadSharedPrefs()
  }, [fleet.rows])

  /** End a Nay conversation: kill its session; the server then files it under "Nay › Inativas". */
  const endSession = useCallback(async (id: string): Promise<boolean> => {
    const out = await act({ id, action: 'kill' })
    if (!out.ok) { setNotice(out.message); return false }
    setNotice(null)
    return true
  }, [act])

  const open = useCallback((id: string) => setDock(d => openSession(d, id)), [])
  const [confirmEnd, setConfirmEnd] = useState(false)
  useEffect(() => { setConfirmEnd(false) }, [dock.panelSession])

  // What "Nova conversa" starts with: the Settings -> Chat defaults, until somebody changes them in
  // the picker — then that choice, for this page. One tap when nothing changes.
  const harnesses = useNayHarnesses(lang, dock.open)
  const defaults = useNayDefaults()
  const [choice, setChoice] = useState<NayLaunchChoice | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const launch = harnesses ? normalizeChoice(choice ?? defaults ?? {}, harnesses) : null
  const harnessLabel = (id: string) => (HARNESS_LABELS as Record<string, string>)[id] ?? harnesses?.find(h => h.id === id)?.label ?? id
  const summaryOf = (run: { harness: string; model?: string | undefined; effort?: string | undefined }) =>
    launchSummary(run, harnessLabel(run.harness), harnesses?.find(h => h.id === run.harness), pt)

  const startNay = useCallback(async () => {
    setStarting(true)
    setNotice(null)
    try {
      // The choice travels only once the harnesses have loaded; before that the server applies the
      // same Settings defaults itself, so an early tap starts exactly what the picker would show.
      const res = await fetch(`/api/fleet/nay?lang=${lang}`, {
        method: 'POST',
        ...(launch ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(launch) } : {}),
      })
      const out = await res.json().catch(() => null) as { ok?: boolean; message?: string; id?: string } | null
      if (out?.ok && out.id) {
        setArriving(a => ({ ...a, [out.id!]: Date.now() }))
        // The server has just filed it under "Nay › Ativas"; pick that up now rather than on focus.
        void loadSharedPrefs()
        open(out.id)
      } else {
        setNotice(out?.message === 'chat_disabled'
          ? (pt ? 'O chat está desligado em Configurações → Chat.' : 'The chat is turned off in Settings → Chat.')
          : (out?.message ?? (pt ? 'Não foi possível iniciar a Nay.' : 'Could not start Nay.')))
      }
    } catch {
      setNotice(pt ? 'Não foi possível falar com o servidor.' : 'Could not reach the server.')
    } finally {
      setStarting(false)
    }
  }, [lang, pt, open, launch])

  const actFleet = useCallback(
    (req: { id: string; action: FleetActionId; text?: string; choice?: number; occurrence?: number }) => act(req),
    [act],
  )

  const metricsFor = useCallback((s: ControlSession): SessionComposerMetrics => {
    const meta: SessionMeta | undefined = s.conversationId !== undefined
      ? ctx.data?.sessions?.find(x => x.session_id === s.conversationId)
      : undefined
    return {
      meta,
      currency: ctx.currency,
      brlRate: ctx.brlRate,
      costBasis: ctx.costBasis,
      planFactor: sessionPlanFactor(ctx.planBasis.basis, s.harness),
    }
  }, [ctx])

  /** One session's chat, or the sentence that says why it is not there. */
  const renderSession = (id: string, onReopened: (next: string) => void): ReactNode => {
    const s = findSession(id)
    if (!s) {
      const since = arriving[id]
      const coming = since !== undefined && Date.now() - since < ARRIVAL_BUDGET_MS
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-tertiary)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>
          {coming && <Loader2 size={14} style={{ animation: 'ag-working-spin 1s linear infinite' }} />}
          {coming
            ? (pt ? 'Iniciando a sessão…' : 'Starting the session…')
            : (pt ? 'Esta sessão não está mais na frota desta máquina.' : 'This session is no longer in this machine\'s fleet.')}
        </div>
      )
    }
    const row = rowIndex.get(s.id)
    return (
      // INNER PADDING, so the conversation and the composer do not run into the window's edges
      // (owner, 2026-09-29), and the surface the composer's blurred ground fades INTO: this panel is
      // `--bg-surface`, not the page's `--bg-base` the ground assumes by default.
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        padding: isMobile ? '4px 6px 0' : '8px 10px 0',
        ['--ag-composer-ground' as string]: 'var(--bg-surface)',
      } as CSSProperties}>
        {/* What this conversation runs on, in one line: "Claude Code · Opus 4.8 · high". */}
        <div title={pt ? 'Assistente · modelo · esforço desta conversa' : 'This conversation\'s assistant · model · effort'} style={{
          flexShrink: 0, alignSelf: 'flex-start', margin: '0 2px 6px', padding: '2px 8px', borderRadius: 999,
          border: '1px solid var(--border)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: '100%',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {summaryOf({ harness: s.harness, model: s.model, effort: s.effort })}
        </div>
        <SessionChat
          key={s.id}
          session={s} {...(row ? { row } : {})} lang={lang} act={actFleet}
          metrics={metricsFor(s)}
          onReopened={onReopened}
        />
      </div>
    )
  }

  // ------------------------------------------------------------------------------------------
  // The docked panel's resize handles (desktop only).
  // ------------------------------------------------------------------------------------------
  const resizeFrom = (handle: { x?: 'left' | 'right'; y?: 'up' | 'down' }) => (e: ReactPointerEvent) => {
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, size }
    const move = (ev: PointerEvent) => setSize(resizeAnchored(start.size, ev.clientX - start.x, ev.clientY - start.y, handle, viewport()))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const panelSession = dock.panelSession
  const panelRow = panelSession ? findSession(panelSession) : undefined
  const panelTitle = panelRow?.title ?? 'Nay'


  // THE PANEL OPENS BESIDE THE BUTTON, wherever it was dragged (desktop). The button's place is the
  // same stored position `NayFab` draws from, clamped the same way, so the two cannot disagree about
  // where the button is. A phone keeps its full-screen sheet.
  const vpNow = viewport()
  const fabAt = clampFabPos(fabPrefs.pos ?? defaultFabPos(vpNow), vpNow)
  const place = anchorDock({ x: fabAt.x, y: fabAt.y, w: FAB_SIZE, h: FAB_SIZE }, size, vpNow)
  const edgeX = place.grow.x === 'left' ? { left: 0 } : { right: 0 }
  const edgeY = place.grow.y === 'up' ? { top: 0 } : { bottom: 0 }
  const cornerCursor = (place.grow.x === 'left') === (place.grow.y === 'up') ? 'nwse-resize' : 'nesw-resize'

  /*
   * THE DOCK FOLLOWS THE BUTTON (desktop). While the button moves, the open dock follows its LIVE
   * position with the motion of the button's own drag style — jelly, elastic trail, shock or comet,
   * the four the owner approved — instead of teleporting to its new place when the drag ends. The
   * physics is the pure `nayDockFollow.ts`; this loop only feeds it the button and writes the frame
   * through refs, running only while something moves. React's own `left/top` (from the stored
   * position) is the resting answer; the last frame is re-applied after every render so a re-render
   * mid-drag cannot snap the dock back for a frame.
   */
  const panelRef = useRef<HTMLDivElement>(null)
  const echoRefs = useRef<(HTMLDivElement | null)[]>([])
  const follow = useRef<{ st: DockFollowState | null; raf: number; last: number; landed: number; frame: DockFrame | null; quiet: number; bx: number; by: number; restX: number; restY: number }>({ st: null, raf: 0, last: 0, landed: 0, frame: null, quiet: 0, bx: NaN, by: NaN, restX: NaN, restY: NaN })
  const followOn = dock.open && !isMobile
  /*
   * THE FRAME IS A TRANSFORM, NEVER A LAYOUT WRITE. Moving the dock by `left`/`top` every frame made
   * the browser re-lay-out the whole panel (a full SessionChat) sixty times a second, which is the
   * stutter the owner saw after #821. React keeps the RESTING place in `left`/`top`; the loop only
   * writes a `translate3d` offset from it (composited, no layout), and touches width, height and
   * opacity only when they actually change. `base` is React's current resting place, refreshed on
   * every render, so the offset is always measured from what the element really has.
   */
  const base = useRef({ left: 0, top: 0 })
  const written = useRef({ w: -1, h: -1, o: -1 })
  const writeFrame = useCallback((fr: DockFrame | null, moving: boolean) => {
    const el = panelRef.current
    if (!el || !fr) return
    const w = written.current
    // In motion a composited translate; AT REST no transform and no will-change (see `frameStyle`).
    const fs = frameStyle(fr, base.current, moving)
    el.style.transformOrigin = fr.origin
    el.style.transform = fs.transform
    el.style.willChange = fs.willChange
    if (fs.left !== undefined) el.style.left = `${fs.left}px`
    if (fs.top !== undefined) el.style.top = `${fs.top}px`
    if (fr.w !== w.w) { el.style.width = `${fr.w}px`; w.w = fr.w }
    if (fr.h !== w.h) { el.style.height = `${fr.h}px`; w.h = fr.h }
    if (fr.opacity !== w.o) { el.style.opacity = String(fr.opacity); w.o = fr.opacity }
    echoRefs.current.forEach((e, i) => {
      if (!e) return
      const ec = fr.echoes[i]
      e.style.opacity = ec ? String(ec.opacity) : '0'
      if (ec) {
        e.style.transform = `translate3d(${ec.left}px, ${ec.top}px, 0)`
        if (e.style.width !== `${fr.w}px`) { e.style.width = `${fr.w}px`; e.style.height = `${fr.h}px` }
      }
    })
  }, [])
  base.current = { left: place.left, top: place.top }
  useLayoutEffect(() => { if (followOn) { written.current = { w: -1, h: -1, o: -1 }; writeFrame(follow.current.frame, follow.current.raf !== 0) } })
  useEffect(() => {
    const f = follow.current
    if (!followOn) { f.st = null; f.frame = null; return }
    const reduced = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })()
    // Measured ONCE, and again only on a resize: nothing inside the frame loop reads the layout.
    let vp = viewport()
    const btnNow = () => {
      const l = getFabLive()
      const p = l ? { x: l.x, y: l.y } : clampFabPos(fabPrefs.pos ?? defaultFabPos(vp), vp)
      return { rect: { x: p.x, y: p.y, w: FAB_SIZE, h: FAB_SIZE }, speed: l?.speed ?? 0, l }
    }
    const b0 = btnNow()
    if (!f.st) { f.st = initFollow(b0.rect, size, vp); f.landed = b0.l?.landed ?? 0 }
    const frame = (now: number) => {
      const st = f.st
      if (!st) { f.raf = 0; return }
      const dt = Math.min(0.05, (now - f.last) / 1000); f.last = now
      const b = btnNow()
      if (b.l && b.l.landed !== f.landed) { f.landed = b.l.landed; landImpulse(st, dockStyle, reduced, b.l.landSpeed) }
      for (let i = 0; i < 4; i++) stepFollow(st, b.rect, size, vp, dockStyle, reduced, dt / 4)
      // The rest guarantee (see `REST_AFTER_FRAMES`): a quiet button puts the dock at rest even if
      // the spring never meets its own threshold.
      f.quiet = nextQuiet(f.quiet, Number.isNaN(f.bx) ? Infinity : Math.hypot(b.rect.x - f.bx, b.rect.y - f.by), b.speed)
      f.bx = b.rect.x; f.by = b.rect.y
      const forced = f.quiet >= REST_AFTER_FRAMES
      if (forced) forceRest(st)
      f.frame = renderDock(st, b.rect, vp, dockStyle, reduced, forced ? 0 : b.speed)
      const rest = forced || (followSettled(st) && b.speed < 1)
      if (rest) { f.quiet = 0; f.restX = b.rect.x; f.restY = b.rect.y }
      writeFrame(f.frame, !rest)
      f.raf = rest ? 0 : requestAnimationFrame(frame)
    }
    const kick = () => {
      if (f.raf) return
      // A button still where the dock came to rest (a sub-pixel republish) is not a reason to leave
      // rest: starting the loop would put the transform back on for REST_AFTER_FRAMES, every time.
      const b = btnNow()
      if (!shouldWake(f.restX, f.restY, b.rect, b.speed)) return
      f.last = performance.now(); f.quiet = 0; f.bx = NaN; f.raf = requestAnimationFrame(frame)
    }
    f.restX = NaN
    kick()
    const off = subscribeFabLive(kick)
    const onResize = () => { vp = viewport(); f.restX = NaN; kick() }
    window.addEventListener('resize', onResize)
    return () => { off(); window.removeEventListener('resize', onResize); if (f.raf) cancelAnimationFrame(f.raf); f.raf = 0 }
  }, [followOn, size, dockStyle, fabPrefs.pos, writeFrame])
  const echoStyle = followOn && (dockStyle === 'trail' || dockStyle === 'comet')

  // Above every detached window, or one overlapping the dock takes its clicks (see `dockZIndex`).
  const dockZ = dockZIndex(dock.windows.filter(w => !w.minimized))
  // What the person can see: every detached window that is not minimized, plus the session the open
  // dock shows. No card is raised about those (see `setVisibleSessions`).
  const visibleKey = [
    ...(isMobile ? [] : dock.windows.filter(w => !w.minimized).map(w => w.id)),
    ...(dock.open && panelSession ? [panelSession] : []),
  ].join('\n')
  useEffect(() => { setVisibleSessions(visibleKey ? visibleKey.split('\n') : []) }, [visibleKey])
  const panel = dock.open && (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Nay"
      style={isMobile
        // The phone sheet covers the whole screen, so it must keep its content out of the status bar
        // and the home indicator itself: nothing above it pads for the notch. Without this the header
        // (tabs, gear, close) sat under the iOS status bar, invisible and untappable.
        ? {
            position: 'fixed', inset: 0, zIndex: 400, background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column',
            paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)',
          }
        : {
            position: 'fixed', left: place.left, top: place.top, width: place.w, height: place.h,
            zIndex: dockZ, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
    >
      {!isMobile && (<>
        {/* Resize handles, on the edges facing AWAY from the button: the panel grows away from it. */}
        <div onPointerDown={resizeFrom({ y: place.grow.y })} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'}
          style={{ position: 'absolute', ...edgeY, left: 10, right: 10, height: 6, cursor: 'ns-resize', zIndex: 2 }} />
        <div onPointerDown={resizeFrom({ x: place.grow.x })} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'}
          style={{ position: 'absolute', ...edgeX, top: 10, bottom: 10, width: 6, cursor: 'ew-resize', zIndex: 2 }} />
        <div onPointerDown={resizeFrom({ x: place.grow.x, y: place.grow.y })} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'}
          style={{ position: 'absolute', ...edgeX, ...edgeY, width: 12, height: 12, cursor: cornerCursor, zIndex: 3 }} />
      </>)}

      <header style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {panelSession ? (<>
          <IconButton label={pt ? 'Voltar' : 'Back'} onClick={() => setDock(d => ({ ...d, panelSession: null }))} isMobile={isMobile}>
            <ArrowLeft size={15} />
          </IconButton>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {panelTitle}
          </span>
          {panelRow && isNayCwd(panelRow.cwd) && sessionRunning(panelRow) && (
            confirmEnd ? (
              <EndConfirm pt={pt} isMobile={isMobile}
                onYes={() => { void endSession(panelRow.id).then(ok => { if (ok) setDock(d => ({ ...d, panelSession: null })) }); setConfirmEnd(false) }}
                onNo={() => setConfirmEnd(false)} />
            ) : (
              <LabelButton icon={<Power size={14} />} label={isMobile ? (pt ? 'Encerrar' : 'End') : (pt ? 'Encerrar conversa' : 'End conversation')} danger
                title={pt ? 'Encerrar esta conversa e arquivá-la em Nay › Inativas' : 'End this conversation and file it under Nay › Inativas'}
                onClick={() => setConfirmEnd(true)} />
            )
          )}
          {!isMobile && !confirmEnd && (
            <LabelButton icon={<PictureInPicture2 size={14} />} label={pt ? 'Desacoplar' : 'Undock'}
              title={pt ? 'Abrir esta sessão numa janela própria' : 'Open this session in its own window'}
              onClick={() => setDock(d => detachSession(d, panelSession, viewport()))} />
          )}
        </>) : (<>
          <img src={versionedAsset('/minimalistLogo.png')} alt="" style={{ width: 20, height: 20, borderRadius: 6, marginLeft: 4 }} />
          {/* The site's shared tab strip (`TabStrip`), not a dock-only underline copy. */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <TabStrip<Tab>
              tabs={DOCK_TABS}
              value={tab}
              onPick={id => { setTab(id); setDock(d => ({ ...d, panelSession: null })) }}
              label={id => (id === 'nay' ? 'Nay' : (pt ? 'Sessões' : 'Sessions'))}
              flush
              ariaLabel={pt ? 'Painel da Nay' : 'Nay panel'}
              {...(isMobile ? { tap: 44 } : {})}
            />
          </div>
        </>)}
        <DockSettings pt={pt} isMobile={isMobile} open={settingsOpen} onToggle={() => setSettingsOpen(o => !o)} />
        <IconButton label={pt ? 'Fechar' : 'Close'} onClick={() => setDock(d => ({ ...d, open: false }))} isMobile={isMobile}>
          <X size={15} />
        </IconButton>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {settingsOpen ? (
          <DockSettingsScreen
            pt={pt} isMobile={isMobile} chat={ctx}
            onLeave={() => setDock(d => ({ ...d, open: false }))}
            onBack={closeSettings}
          />
        ) : panelSession
          ? renderSession(panelSession, next => setDock(d => ({ ...d, panelSession: next })))
          : tab === 'nay'
            ? (<>
              <NayList
                lang={lang} isMobile={isMobile} sections={sections} windows={dock.windows}
                starting={starting} notice={notice} unsupported={unsupported}
                onStart={() => { void startNay() }} onOpen={open} onEnd={endSession}
                onAct={act} onGoTo={goToSession} onNotice={setNotice} rowsById={rowIndex}
                launchLine={launch ? summaryOf(launch) : null}
                pickerOpen={pickerOpen} onTogglePicker={() => setPickerOpen(o => !o)}
                picker={launch && harnesses ? (
                  <NayLaunchFields layout={isMobile ? 'stack' : 'compact'} pt={pt} harnesses={harnesses}
                    value={launch} onChange={setChoice} />
                ) : null}
              />
            </>)
            : (
              // Inner gutter, so the aside's cards and search do not run into the panel's edges.
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: isMobile ? '6px 10px' : '8px 12px' }}>
                <SessionsAside
                  lang={lang}
                  rows={fleet.rows}
                  finishedTasks={fleet.finishedTasks}
                  loading={loading}
                  unsupported={unsupported}
                  {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
                  filters={filters}
                  activeOnly={activeOnly}
                  stale={stale}
                  rowsById={rowIndex}
                  act={req => act({ ...req, action: req.action as FleetActionId })}
                  onOpenRow={row => open(row.id)}
                  onCreated={id => { setArriving(a => ({ ...a, [id]: Date.now() })); open(id) }}
                  {...(panelSession ? { selectedId: panelSession } : {})}
                  onGoToSession={goToSession}
                />
              </div>
            )}
      </div>
    </div>
  )

  const visibleWindows = isMobile ? [] : dock.windows.filter(w => !w.minimized)
  const minimized = isMobile ? [] : dock.windows.filter(w => w.minimized)

  return (
    <>
      {/* The session notifications the button SPEAKS. Mounted whether or not the button itself is
          on screen: on a phone inside a session the button can be hidden, and the card then opens
          from the corner it would have occupied. */}
      <NayNotifyCard lang={lang} isMobile={isMobile} rows={fleet.rows} finishedTasks={fleet.finishedTasks} act={act} fabStyle={cardStyleOf(fabPrefs)} onReply={open} zIndex={dockZ + 1} />
      {/* The trail/comet outline echoes behind the following dock — drawn by the follow loop. */}
      {echoStyle && [0, 1].map(i => (
        <div key={i} aria-hidden ref={el => { echoRefs.current[i] = el }} style={{
          position: 'fixed', left: 0, top: 0, zIndex: dockZ - 1, pointerEvents: 'none', opacity: 0, willChange: 'transform, opacity',
          border: '1px solid var(--anthropic-orange)', borderRadius: 10,
        }} />
      ))}
      {panel}

      {visibleWindows.map(w => (
        <NayWindowFrame
          key={w.id}
          win={w}
          lang={lang}
          title={findSession(w.id)?.title ?? 'Nay'}
          onFocus={() => setDock(d => openSession(d, w.id))}
          onMove={next => setDock(d => placeWindow(d, w.id, next, viewport()))}
          onDock={() => setDock(d => dockSession(d, w.id))}
          onGoTo={() => goToSession(w.id)}
          onMinimize={() => setDock(d => minimizeWindow(d, w.id))}
          onClose={() => setDock(d => closeWindow(d, w.id))}
        >
          {renderSession(w.id, next => setDock(d => ({
            ...d, windows: d.windows.map(x => (x.id === w.id ? { ...x, id: next } : x)),
          })))}
        </NayWindowFrame>
      ))}

      {/* THE chat button — always this one, whatever is detached. */}
      {!(isMobile && dock.open) && fabVisible && (
        <NayFab prefs={fabPrefs} onPrefs={setFabPrefs} isMobile={isMobile} routeKey={inSession ? 'session' : 'app'}>
          {fab => (
            <MinimizedMenu
              pt={pt}
              items={minimized.map(w => ({ id: w.id, row: findSession(w.id) }))}
              onRestore={id => setDock(d => openSession(d, id))}
              onClose={id => setDock(d => closeWindow(d, id))}
              anchorStyle={{ position: 'relative', width: '100%', height: '100%' }}
              suppressed={fab.dragging}
              renderButton={({ onClickCapture, onKeyDown }) => (
                <button
                  ref={fab.bodyRef}
                  onPointerDown={fab.onPointerDown}
                  onPointerMove={fab.onPointerMove}
                  onPointerUp={fab.onPointerUp}
                  onPointerCancel={fab.onPointerCancel}
                  onClickCapture={e => { fab.onClickCapture(e); if (!e.isPropagationStopped()) onClickCapture(e) }}
                  onKeyDown={onKeyDown}
                  onClick={() => setDock(d => ({ ...d, open: !d.open }))}
                  data-nay-fab
                  aria-label={pt ? 'Abrir o chat da Nay' : 'Open the Nay chat'}
                  aria-expanded={dock.open}
                  title={pt ? 'Nay — arraste para mover' : 'Nay — drag to move'}
                  style={{
                    width: 56, height: 56, borderRadius: 16, border: `1.5px solid ${ORANGE}`,
                    background: dock.open ? ORANGE : 'var(--bg-surface)', cursor: fab.dragging ? 'grabbing' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                    touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', padding: 0, willChange: 'transform',
                    position: 'relative',
                  }}
                >
                  {dock.open
                    ? <X size={20} color="var(--bg-surface)" />
                    : <img src={versionedAsset('/minimalistLogo.png')} alt="" draggable={false} style={{ width: 30, height: 30, borderRadius: 8, pointerEvents: 'none' }} />}
                </button>
              )}
            />
          )}
        </NayFab>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------

/** A small icon control. On a phone its 44px target is PROJECTED (`.ag-tap-icon`), never painted. */
function IconButton({ label, onClick, isMobile, children }: { label: string; onClick: () => void; isMobile: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={isMobile ? 'ag-tap-icon' : undefined} style={{
      width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', borderRadius: 7, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
    }}>{children}</button>
  )
}

/** A control whose action must be unmistakable: an icon AND a word, orange-outlined (red to end). */
function LabelButton({ icon, label, title, onClick, danger }: { icon: ReactNode; label: string; title: string; onClick: () => void; danger?: boolean }) {
  const tone = danger ? 'var(--accent-red, #ef4444)' : ORANGE
  return (
    <button onClick={onClick} title={title} style={{
      display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, padding: '4px 9px', borderRadius: 7,
      border: `1px solid ${tone}`, background: danger ? 'rgba(239, 68, 68, 0.1)' : ORANGE_DIM, color: tone, cursor: 'pointer',
      fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {icon}{label}
    </button>
  )
}

/**
 * The inline "end it?" question. Ending a conversation stops its session, so it ASKS — inline, in
 * the place the button was, never through `window.confirm` (which blocks the page and reads as a
 * browser error).
 */
function EndConfirm({ pt, isMobile, onYes, onNo }: { pt: boolean; isMobile: boolean; onYes: () => void; onNo: () => void }) {
  const btn = (label: string, onClick: () => void, danger: boolean) => (
    <button type="button" onClick={onClick} style={{
      minHeight: isMobile ? 36 : 26, padding: '2px 9px', borderRadius: 6, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
      border: `1px solid ${danger ? 'var(--accent-red, #ef4444)' : 'var(--border)'}`,
      background: danger ? 'var(--accent-red, #ef4444)' : 'transparent', color: danger ? '#fff' : 'var(--text-secondary)',
    }}>{label}</button>
  )
  return (
    <span role="group" aria-label={pt ? 'Encerrar esta conversa?' : 'End this conversation?'}
      style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{pt ? 'Encerrar?' : 'End it?'}</span>
      {btn(pt ? 'Encerrar' : 'End', onYes, true)}
      {btn(pt ? 'Não' : 'No', onNo, false)}
    </span>
  )
}

function NayList({ lang, isMobile, sections, windows, starting, notice, unsupported, onStart, onOpen, onEnd, onAct, onGoTo, onNotice, rowsById, launchLine, pickerOpen, onTogglePicker, picker }: {
  lang: Lang
  isMobile: boolean
  sections: Record<NaySectionId, ControlSession[]>
  windows: readonly NayWindow[]
  starting: boolean
  notice: string | null
  unsupported: boolean
  onStart: () => void
  onOpen: (id: string) => void
  onEnd: (id: string) => Promise<boolean>
  /** The fleet's own verbs (`rename`, `resume`) — the same `act` the Sessions workspace calls. */
  onAct: (req: { id: string; action: FleetActionId; text?: string }) => Promise<{ ok: boolean; message: string; id?: string }>
  /** Open the session in the Sessions workspace. */
  onGoTo: (id: string) => void
  onNotice: (message: string | null) => void
  /** The fleet rows by id, for each row's server-resolved verbs. */
  rowsById: ReadonlyMap<string, { verbs: RowVerb[] }>
  /** "Claude Code · Opus 4.8 · high": what the next conversation will start with. */
  launchLine: string | null
  pickerOpen: boolean
  onTogglePicker: () => void
  picker: ReactNode
}) {
  const pt = lang === 'pt'
  const mutedKeys = useMutedKeys()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [ending, setEnding] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [filing, setFiling] = useState<string | null>(null)
  const all = NAY_SECTION_ORDER.flatMap(id => sections[id])
  const menuRow = menu ? all.find(r => r.id === menu.id) : undefined
  const pickMenu = (action: string) => {
    if (!menuRow) return
    const id = menuRow.id
    if (action === 'kill') { setConfirming(id); return }
    if (action === 'rename') { setRenaming({ id, title: menuRow.title }); return }
    if (action === NAY_GO_TO) { onGoTo(id); return }
    if (action === NOTIFY_TOGGLE) { toggleSessionMuted(sessionIdentityKey(menuRow)); setMenu(null); return }
    if (action === LINK_TASK) { setFiling(id); return }
    if (action === UNLINK_TASK) {
      void unfileSession(id, id).then(() => onNotice(boardCopy(lang).unfiled))
      return
    }
    if (action === NAY_COPY_ID) {
      const conv = menuRow.conversationId
      if (conv) void navigator.clipboard?.writeText(conv).then(
        () => onNotice(pt ? 'Id da conversa copiado.' : 'Conversation id copied.'),
        () => onNotice(pt ? 'Não foi possível copiar.' : 'Could not copy.'),
      )
      return
    }
    void onAct({ id, action: action as FleetActionId }).then(out => {
      onNotice(out.ok && action !== 'resume' ? null : out.message)
      // A reopen mints a new id; open THAT one, or the row it came from vanishes on the next poll.
      if (out.ok && action === 'resume' && out.id) onOpen(out.id)
    })
  }
  const empty = NAY_SECTION_ORDER.every(id => sections[id].length === 0)
  // The person's own card-colour choice from the Sessions aside, so a Nay row reads like that list's.
  const cardColor = useSyncExternalStore(subscribeAsideGroupPrefs, () => readAsideGroupPrefs().cardColor)
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        onClick={onStart}
        disabled={starting || unsupported}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: isMobile ? 44 : 36, flexShrink: 0,
          borderRadius: 9, border: `1px solid ${ORANGE}`, background: ORANGE_DIM, color: ORANGE,
          fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: starting || unsupported ? 'default' : 'pointer',
          opacity: unsupported ? 0.5 : 1,
        }}
      >
        {starting ? <Loader2 size={14} style={{ animation: 'ag-working-spin 1s linear infinite' }} /> : <Plus size={14} />}
        {pt ? 'Nova conversa com a Nay' : 'New conversation with Nay'}
      </button>
      {launchLine && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0 }}>
          <span style={{ flexShrink: 0 }}>{pt ? 'Com' : 'With'}</span>
          <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{launchLine}</span>
          <button type="button" onClick={onTogglePicker} aria-expanded={pickerOpen} style={{
            flexShrink: 0, border: 'none', background: 'transparent', padding: isMobile ? '10px 4px' : '2px 4px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11.5, color: ORANGE, textDecoration: 'underline', textUnderlineOffset: 3,
          }}>{pickerOpen ? (pt ? 'Pronto' : 'Done') : (pt ? 'Alterar' : 'Change')}</button>
        </div>
      )}
      {pickerOpen && picker && <div style={{ flexShrink: 0 }}>{picker}</div>}
      {unsupported && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>
          {pt ? 'Esta máquina não consegue iniciar sessões.' : 'This machine cannot start sessions.'}
        </p>
      )}
      {notice && <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--accent-orange, var(--text-secondary))' }}>{notice}</p>}

      {empty && (
        <p style={{ margin: '8px 2px 0', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {pt
            ? 'Nenhuma conversa da Nay ainda. Elas também aparecem na lista de sessões, na pasta "Nay".'
            : 'No Nay conversation yet. They also appear in the sessions list, in the "Nay" folder.'}
        </p>
      )}
      {NAY_SECTION_ORDER.map(section => {
        const rows = sections[section]
        if (rows.length === 0) return null
        const text = NAY_SECTION_TEXT[section]
        return (
          <section key={section} aria-label={text.heading[pt ? 'pt' : 'en']} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <h3 style={{ margin: '2px 2px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
              {text.heading[pt ? 'pt' : 'en']}
              <span style={{ fontWeight: 500 }}>{rows.length}</span>
            </h3>
            {rows.map(s => {
              const inWindow = windows.some(w => w.id === s.id)
              const isEnding = ending === s.id
              const card = sessionCardStyle(s.state, cardColor, false)
              return (
                // The row and its End control are SIBLINGS: a button nested in a button is one
                // control to a screen reader and two to a pointer.
                <div key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, minHeight: isMobile ? 48 : 40, padding: '0 8px 0 0',
                    borderRadius: 9, background: card.background, boxShadow: card.edge,
                  }}
                >
                  {/* The Sessions workspace's own row vocabulary (`SessionFacts` + `sessionCardStyle`),
                      not a third style: title, then state · harness · model · effort. The title
                      already carries the time the conversation started. */}
                  <button type="button" onClick={() => onOpen(s.id)}
                    title={s.model ? `${s.title}\n${s.model}` : s.title}
                    style={{
                      flex: 1, minWidth: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0 7px 14px',
                      border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', borderRadius: 9,
                      color: 'var(--text-secondary)',
                    }}>
                    <SessionFacts session={s} lang={pt ? 'pt' : 'en'} withEffort
                      {...(card.stateTextColor ? { metaColor: card.stateTextColor } : {})} />
                    {inWindow && (
                      <span title={pt ? 'Aberta numa janela' : 'Open in a window'}
                        style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 10.5, color: ORANGE }}>
                        <PictureInPicture2 size={11} />{!isMobile && (pt ? 'em janela' : 'in a window')}
                      </span>
                    )}
                  </button>
                  {confirming === s.id ? (
                    <EndConfirm pt={pt} isMobile={isMobile}
                      onYes={() => {
                        setConfirming(null); setEnding(s.id)
                        void onEnd(s.id).finally(() => setEnding(e => (e === s.id ? null : e)))
                      }}
                      onNo={() => setConfirming(null)} />
                  ) : isEnding ? (
                    <Loader2 size={14} style={{ flexShrink: 0, color: 'var(--text-tertiary)', animation: 'ag-working-spin 1s linear infinite' }} />
                  ) : (
                    <button type="button"
                      onClick={e => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setMenu({ id: s.id, x: r.right - 210, y: r.bottom + 4 })
                      }}
                      aria-label={pt ? `Opções de ${s.title}` : `Options for ${s.title}`}
                      aria-haspopup="menu"
                      title={pt ? 'Opções' : 'Options'}
                      // A 26px icon that projects its 44px touch box (`.ag-tap-icon`) instead of painting it.
                      className="ag-tap-icon"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        width: 26, height: 26, borderRadius: 6,
                        border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
                      }}>
                      <MoreVertical size={14} />
                    </button>
                  )}
                </div>
              )
            })}
          </section>
        )
      })}
      {menu && menuRow && (
        <SessionRowMenu
          x={Math.max(4, menu.x)} y={menu.y}
          entries={[
            ...nayRowMenuEntries(rowsById.get(menuRow.id)?.verbs ?? [], {
              running: naySectionOf(menuRow.state) !== 'ended', conversationId: menuRow.conversationId, pt,
              task: menuRow.task,
            }),
            ...notifyMenuExtras(menuRow, mutedKeys, pt),
          ]}
          onPick={pickMenu}
          onClose={() => setMenu(null)}
        />
      )}
      {filing && (() => {
        const r = all.find(x => x.id === filing)
        return (
          <SessionFiling
            session={{ id: filing, title: r?.title ?? filing, ...(r?.harness ? { harness: r.harness } : {}), ...(r?.task ? { task: r.task } : {}) }}
            lang={lang}
            onChanged={() => onNotice(boardCopy(lang).filed)}
            onClose={() => setFiling(null)}
          />
        )
      })()}
      {renaming && (
        <RenameSessionDialog
          lang={pt ? 'pt' : 'en'}
          title={renaming.title}
          onCancel={() => setRenaming(null)}
          onSubmit={text => onAct({ id: renaming.id, action: 'rename', text }).then(out => {
            onNotice(out.ok ? null : out.message)
            setRenaming(null)
          })}
        />
      )}
    </div>
  )
}

function NayWindowFrame({ win, lang, title, onFocus, onMove, onDock, onGoTo, onMinimize, onClose, children }: {
  win: NayWindow
  lang: Lang
  title: string
  onFocus: () => void
  onMove: (next: Partial<Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>) => void
  onDock: () => void
  /** Open this session in the Sessions workspace; the window stays as it is. */
  onGoTo: () => void
  onMinimize: () => void
  onClose: () => void
  children: ReactNode
}) {
  const pt = lang === 'pt'
  const dragRef = useRef<{ x: number; y: number; wx: number; wy: number } | null>(null)

  const startDrag = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    onFocus()
    dragRef.current = { x: e.clientX, y: e.clientY, wx: win.x, wy: win.y }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (d) onMove({ x: d.wx + ev.clientX - d.x, y: d.wy + ev.clientY - d.y })
    }
    const up = () => { dragRef.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, w: win.w, h: win.h }
    const move = (ev: PointerEvent) => onMove({ w: start.w + ev.clientX - start.x, h: start.h + ev.clientY - start.y })
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      onPointerDownCapture={onFocus}
      style={{
        position: 'fixed', left: win.x, top: win.y, width: win.w, height: win.h, zIndex: windowZIndex(win),
        // THE SAME DISCREET FRAME the terminal's floating windows wear (`FloatingPanelLayer`) — a
        // hairline border, a 10px radius and their shadow. It was a loud orange outline, which read
        // as an alert rather than as a window (owner, 2026-09-29). Their drag bar is NOT borrowed:
        // this window's own header row below is where it is dragged from.
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
        boxShadow: '0 14px 36px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.18)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <header onPointerDown={startDrag} style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'move', userSelect: 'none',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated, var(--bg-surface))', flexShrink: 0,
      }}>
        <PictureInPicture2 size={13} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <LabelButton icon={<ArrowDownToLine size={13} />} label={pt ? 'Acoplar' : 'Dock'}
          title={pt ? 'Voltar esta sessão para o painel do chat' : 'Put this session back in the chat panel'} onClick={onDock} />
        <LabelButton icon={<SquareArrowOutUpRight size={13} />} label={pt ? 'Ir para a sessão' : 'Go to session'}
          title={pt ? 'Abrir esta sessão na tela de Sessões' : 'Open this session in the Sessions workspace'} onClick={onGoTo} />
        <IconButton label={pt ? 'Minimizar' : 'Minimize'} onClick={onMinimize} isMobile={false}><Minus size={14} /></IconButton>
        <IconButton label={pt ? 'Fechar a janela' : 'Close the window'} onClick={onClose} isMobile={false}><X size={14} /></IconButton>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
      <div onPointerDown={startResize} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'} style={{
        position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize',
        background: 'linear-gradient(135deg, transparent 50%, var(--border) 50%)',
      }} />
    </div>
  )
}
