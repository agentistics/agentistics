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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowLeft, Loader2, Minus, PictureInPicture2, Plus, Power, X } from 'lucide-react'
import { isNayCwd, nayPlacementRows, planNayPlacement, type Filters, type SessionMeta } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { sessionRunning } from '@agentistics/tui/control/session-dimensions'
import type { AppContext } from '../../lib/app-context'
import { useFleet, useFleetIndex, type FleetActionId } from '../../lib/fleet'
import { sessionPlanFactor } from '../../lib/costBasis'
import { versionedAsset } from '../../lib/brand'
import {
  clampPanelSize, closeWindow, detachSession, dockSession, minimizeWindow, openSession, parseDockState,
  placeWindow, pruneDock, anchorDock, resizeAnchored, PANEL_DEFAULT, type DockState, type NayWindow, type Size,
} from '../../lib/nayDock'
import { SessionChat, type SessionComposerMetrics } from '../sessions/SessionChat'
import { SessionsAside } from '../nav/SessionsAside'
import { MinimizedMenu } from './MinimizedMenu'
import { NayFab } from './NayFab'
import { getFabLive, subscribeFabLive } from '../../lib/nayFabLive'
import { followSettled, initFollow, landImpulse, renderDock, stepFollow, type DockFollowState, type DockFrame } from '../../lib/nayDockFollow'
import { DockSettings } from './DockSettings'
import { NayNotifyCard } from './NayNotifyCard'
import { setOpenSession } from '../../lib/nayNotifyStore'
import { nayFabVisible, useNayFabShownInSession } from '../../lib/nayFabVisibility'
import { useLocation } from 'react-router-dom'
import { getSessionGroups } from '../../lib/sessionUserGroups'
import { getPinnedIds } from '../../lib/pinnedSessions'
import { loadSharedPrefs } from '../../lib/sharedPref'
import { useNayDefaults, useNayHarnesses } from '../../hooks/useNayDefaults'
import { launchSummary, normalizeChoice, type NayLaunchChoice } from '../../lib/nayLaunch'
import { HARNESS_LABELS } from '../../lib/harness'
import { NayLaunchFields } from './NayLaunchFields'
import { naySections, NAY_SECTION_ORDER, NAY_SECTION_TEXT, naySectionOf, type NaySectionId } from '../../lib/nayList'
import { clampFabPos, defaultFabPos, FAB_SIZE, parseNayFabPrefs, DEFAULT_NAY_FAB_PREFS, type NayFabPrefs } from '../../lib/nayFab'

type Lang = 'pt' | 'en'
type Tab = 'nay' | 'sessions'

const ORANGE = 'var(--anthropic-orange)'
const ORANGE_DIM = 'var(--anthropic-orange-dim)'
const SIZE_KEY = 'agentistics-nay-dock-size'
const WINDOWS_KEY = 'agentistics-nay-dock-windows'
const TAB_KEY = 'agentistics-nay-dock-tab'
/** The chat button's place and look — per browser, never the shared preferences file. */
const FAB_KEY = 'agentistics-nay-fab'
/** How long a just-started session may be missing from the fleet before we stop saying it is coming. */
const ARRIVAL_BUDGET_MS = 20_000

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
    open: false, panelSession: null, ...readStored(WINDOWS_KEY, parseDockState, { windows: [] }),
  }))
  const [tab, setTab] = useState<Tab>(() => readStored<Tab>(TAB_KEY, v => (v === 'sessions' ? 'sessions' : 'nay'), 'nay'))
  const [size, setSize] = useState<Size>(() => clampPanelSize(readStored(SIZE_KEY, v => {
    const o = v as Partial<Size>
    return typeof o?.w === 'number' && typeof o?.h === 'number' ? { w: o.w, h: o.h } : PANEL_DEFAULT
  }, PANEL_DEFAULT), viewport()))
  const [starting, setStarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Sessions just started here, and when — so the panel says "starting" rather than "not found". */
  const [arriving, setArriving] = useState<Record<string, number>>({})

  useEffect(() => { writeStored(WINDOWS_KEY, { windows: dock.windows }) }, [dock.windows])
  const { pathname } = useLocation()
  const inSession = pathname.startsWith('/sessions/')
  // The session on screen, for the notifications: a card about it is never shown, and opening one
  // is what "not opened for a while" is measured from.
  useEffect(() => {
    const id = inSession ? decodeURIComponent(pathname.slice('/sessions/'.length).split('/')[0] ?? '') : ''
    setOpenSession(id || null)
  }, [pathname, inSession])
  const shownInSession = useNayFabShownInSession()
  const fabVisible = nayFabVisible({ isMobile, inSession, shownInSession })
  const [fabPrefs, setFabPrefs] = useState<NayFabPrefs>(() => readStored(FAB_KEY, parseNayFabPrefs, DEFAULT_NAY_FAB_PREFS))
  useEffect(() => { writeStored(FAB_KEY, fabPrefs) }, [fabPrefs])
  useEffect(() => { writeStored(TAB_KEY, tab) }, [tab])
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

  const tabButton = (id: Tab, label: string) => (
    <button
      key={id}
      role="tab"
      aria-selected={tab === id}
      onClick={() => { setTab(id); setDock(d => ({ ...d, panelSession: null })) }}
      style={{
        padding: isMobile ? '0 14px' : '6px 12px', minHeight: isMobile ? 44 : undefined,
        border: 'none', borderBottom: `2px solid ${tab === id && !panelSession ? ORANGE : 'transparent'}`,
        background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
        fontWeight: tab === id && !panelSession ? 700 : 500,
        color: tab === id && !panelSession ? ORANGE : 'var(--text-secondary)',
      }}
    >
      {label}
    </button>
  )

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
  const follow = useRef<{ st: DockFollowState | null; raf: number; last: number; landed: number; frame: DockFrame | null }>({ st: null, raf: 0, last: 0, landed: 0, frame: null })
  const followOn = dock.open && !isMobile
  const writeFrame = useCallback((fr: DockFrame | null) => {
    const el = panelRef.current
    if (!el || !fr) return
    el.style.left = `${fr.left}px`; el.style.top = `${fr.top}px`
    el.style.width = `${fr.w}px`; el.style.height = `${fr.h}px`
    el.style.transformOrigin = fr.origin; el.style.transform = fr.transform
    el.style.opacity = String(fr.opacity)
    echoRefs.current.forEach((e, i) => {
      if (!e) return
      const ec = fr.echoes[i]
      e.style.opacity = ec ? String(ec.opacity) : '0'
      if (ec) { e.style.left = `${ec.left}px`; e.style.top = `${ec.top}px`; e.style.width = `${fr.w}px`; e.style.height = `${fr.h}px` }
    })
  }, [])
  useLayoutEffect(() => { if (followOn) writeFrame(follow.current.frame) })
  useEffect(() => {
    const f = follow.current
    if (!followOn) { f.st = null; f.frame = null; return }
    const reduced = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })()
    const btnNow = () => {
      const l = getFabLive()
      const vp = viewport()
      const p = l ? { x: l.x, y: l.y } : clampFabPos(fabPrefs.pos ?? defaultFabPos(vp), vp)
      return { rect: { x: p.x, y: p.y, w: FAB_SIZE, h: FAB_SIZE }, speed: l?.speed ?? 0, l }
    }
    const b0 = btnNow()
    if (!f.st) { f.st = initFollow(b0.rect, size, viewport()); f.landed = b0.l?.landed ?? 0 }
    const frame = (now: number) => {
      const st = f.st
      if (!st) { f.raf = 0; return }
      const dt = Math.min(0.05, (now - f.last) / 1000); f.last = now
      const b = btnNow()
      if (b.l && b.l.landed !== f.landed) { f.landed = b.l.landed; landImpulse(st, fabPrefs.style, reduced, b.l.landSpeed) }
      for (let i = 0; i < 4; i++) stepFollow(st, b.rect, size, viewport(), fabPrefs.style, reduced, dt / 4)
      f.frame = renderDock(st, b.rect, viewport(), fabPrefs.style, reduced, b.speed)
      writeFrame(f.frame)
      f.raf = followSettled(st) && b.speed < 1 ? 0 : requestAnimationFrame(frame)
    }
    const kick = () => { if (!f.raf) { f.last = performance.now(); f.raf = requestAnimationFrame(frame) } }
    kick()
    const off = subscribeFabLive(kick)
    window.addEventListener('resize', kick)
    return () => { off(); window.removeEventListener('resize', kick); if (f.raf) cancelAnimationFrame(f.raf); f.raf = 0 }
  }, [followOn, size, fabPrefs.style, fabPrefs.pos, writeFrame])
  const echoStyle = followOn && (fabPrefs.style === 'trail' || fabPrefs.style === 'comet')

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
            zIndex: 400, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
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
          <div role="tablist" style={{ display: 'flex', flex: 1 }}>
            {tabButton('nay', 'Nay')}
            {tabButton('sessions', pt ? 'Sessões' : 'Sessions')}
          </div>
        </>)}
        <DockSettings
          pt={pt} isMobile={isMobile} prefs={fabPrefs} onPrefs={setFabPrefs} chat={ctx}
          onLeave={() => setDock(d => ({ ...d, open: false }))}
        />
        <IconButton label={pt ? 'Fechar' : 'Close'} onClick={() => setDock(d => ({ ...d, open: false }))} isMobile={isMobile}>
          <X size={15} />
        </IconButton>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {panelSession
          ? renderSession(panelSession, next => setDock(d => ({ ...d, panelSession: next })))
          : tab === 'nay'
            ? (
              <NayList
                lang={lang} isMobile={isMobile} sections={sections} windows={dock.windows}
                starting={starting} notice={notice} unsupported={unsupported}
                onStart={() => { void startNay() }} onOpen={open} onEnd={endSession}
                launchLine={launch ? summaryOf(launch) : null}
                pickerOpen={pickerOpen} onTogglePicker={() => setPickerOpen(o => !o)}
                picker={launch && harnesses ? (
                  <NayLaunchFields layout={isMobile ? 'stack' : 'compact'} pt={pt} harnesses={harnesses}
                    value={launch} onChange={setChoice} />
                ) : null}
              />
            )
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
      <NayNotifyCard lang={lang} isMobile={isMobile} rows={fleet.rows} finishedTasks={fleet.finishedTasks} act={act} />
      {/* The trail/comet outline echoes behind the following dock — drawn by the follow loop. */}
      {echoStyle && [0, 1].map(i => (
        <div key={i} aria-hidden ref={el => { echoRefs.current[i] = el }} style={{
          position: 'fixed', zIndex: 399, pointerEvents: 'none', opacity: 0,
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

function NayList({ lang, isMobile, sections, windows, starting, notice, unsupported, onStart, onOpen, onEnd, launchLine, pickerOpen, onTogglePicker, picker }: {
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
  /** "Claude Code · Opus 4.8 · high": what the next conversation will start with. */
  launchLine: string | null
  pickerOpen: boolean
  onTogglePicker: () => void
  picker: ReactNode
}) {
  const pt = lang === 'pt'
  const [confirming, setConfirming] = useState<string | null>(null)
  const [ending, setEnding] = useState<string | null>(null)
  const empty = NAY_SECTION_ORDER.every(id => sections[id].length === 0)
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
              const running = naySectionOf(s.state) !== 'ended'
              const isEnding = ending === s.id
              return (
                // The row and its End control are SIBLINGS: a button nested in a button is one
                // control to a screen reader and two to a pointer.
                <div key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, minHeight: isMobile ? 48 : 40, padding: '0 8px 0 0',
                    borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
                    opacity: section === 'ended' ? 0.75 : 1,
                  }}
                >
                  <button type="button" onClick={() => onOpen(s.id)} style={{
                    flex: 1, minWidth: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 6px 10px',
                    border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', borderRadius: 9,
                  }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: text.color }} />
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: text.color }}>
                      {text.state[pt ? 'pt' : 'en']}
                      {inWindow && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: ORANGE }}>
                          · <PictureInPicture2 size={10} />{pt ? 'em janela' : 'in a window'}
                        </span>
                      )}
                    </span>
                  </span>
                  </button>
                  {running && (confirming === s.id ? (
                    <EndConfirm pt={pt} isMobile={isMobile}
                      onYes={() => {
                        setConfirming(null); setEnding(s.id)
                        void onEnd(s.id).finally(() => setEnding(e => (e === s.id ? null : e)))
                      }}
                      onNo={() => setConfirming(null)} />
                  ) : (
                    <button type="button" disabled={isEnding}
                      onClick={() => setConfirming(s.id)}
                      aria-label={pt ? `Encerrar ${s.title}` : `End ${s.title}`}
                      title={pt ? 'Encerrar esta conversa' : 'End this conversation'}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0,
                        minWidth: isMobile ? 44 : 0, minHeight: isMobile ? 36 : 26, padding: '2px 8px', borderRadius: 6,
                        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
                        fontFamily: 'inherit', fontSize: 11.5, cursor: isEnding ? 'default' : 'pointer',
                      }}>
                      {isEnding ? <Loader2 size={12} style={{ animation: 'ag-working-spin 1s linear infinite' }} /> : <Power size={12} />}
                      {!isMobile && (pt ? 'Encerrar' : 'End')}
                    </button>
                  ))}
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

function NayWindowFrame({ win, lang, title, onFocus, onMove, onDock, onMinimize, onClose, children }: {
  win: NayWindow
  lang: Lang
  title: string
  onFocus: () => void
  onMove: (next: Partial<Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>) => void
  onDock: () => void
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
        position: 'fixed', left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 410 + win.z,
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
