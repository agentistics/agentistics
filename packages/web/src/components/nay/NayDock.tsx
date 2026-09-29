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

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowLeft, Loader2, Minus, PictureInPicture2, Plus, X } from 'lucide-react'
import { isNayCwd, type Filters, type SessionMeta } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { sessionRunning } from '@agentistics/tui/control/session-dimensions'
import type { AppContext } from '../../lib/app-context'
import { useFleet, useFleetIndex, type FleetActionId } from '../../lib/fleet'
import { sessionPlanFactor } from '../../lib/costBasis'
import { versionedAsset } from '../../lib/brand'
import {
  clampPanelSize, closeWindow, detachSession, dockSession, minimizeWindow, openSession, parseDockState,
  placeWindow, pruneDock, resizePanel, PANEL_DEFAULT, PANEL_MARGIN, type DockState, type NayWindow, type Size,
} from '../../lib/nayDock'
import { SessionChat, type SessionComposerMetrics } from '../sessions/SessionChat'
import { SessionsAside } from '../nav/SessionsAside'
import { MinimizedMenu } from './MinimizedMenu'

type Lang = 'pt' | 'en'
type Tab = 'nay' | 'sessions'

const ORANGE = 'var(--anthropic-orange)'
const ORANGE_DIM = 'var(--anthropic-orange-dim)'
const SIZE_KEY = 'agentistics-nay-dock-size'
const WINDOWS_KEY = 'agentistics-nay-dock-windows'
const TAB_KEY = 'agentistics-nay-dock-tab'
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
  ctx: Pick<AppContext, 'data' | 'currency' | 'brlRate' | 'costBasis' | 'planBasis'>
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

  const naySessions = useMemo(
    () => fleet.rows.filter(r => isNayCwd(r.cwd) && sessionRunning(r)),
    [fleet.rows],
  )

  const open = useCallback((id: string) => setDock(d => openSession(d, id)), [])

  const startNay = useCallback(async () => {
    setStarting(true)
    setNotice(null)
    try {
      const res = await fetch(`/api/fleet/nay?lang=${lang}`, { method: 'POST' })
      const out = await res.json().catch(() => null) as { ok?: boolean; message?: string; id?: string } | null
      if (out?.ok && out.id) {
        setArriving(a => ({ ...a, [out.id!]: Date.now() }))
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
  }, [lang, pt, open])

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
  const resizeFrom = (edges: { left: boolean; top: boolean }) => (e: ReactPointerEvent) => {
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, size }
    const move = (ev: PointerEvent) => setSize(resizePanel(start.size, ev.clientX - start.x, ev.clientY - start.y, edges, viewport()))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const panelSession = dock.panelSession
  const panelTitle = panelSession ? (findSession(panelSession)?.title ?? 'Nay') : 'Nay'

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

  const panel = dock.open && (
    <div
      role="dialog"
      aria-label="Nay"
      style={isMobile
        ? { position: 'fixed', inset: 0, zIndex: 400, background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column' }
        : {
            position: 'fixed', right: PANEL_MARGIN.right, bottom: PANEL_MARGIN.bottom, width: size.w, height: size.h,
            zIndex: 400, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
    >
      {!isMobile && (<>
        {/* Resize handles: the panel grows up and to the left from its bottom-right anchor. */}
        <div onPointerDown={resizeFrom({ left: false, top: true })} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'}
          style={{ position: 'absolute', top: 0, left: 10, right: 0, height: 6, cursor: 'ns-resize', zIndex: 2 }} />
        <div onPointerDown={resizeFrom({ left: true, top: false })} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'}
          style={{ position: 'absolute', top: 10, left: 0, bottom: 0, width: 6, cursor: 'ew-resize', zIndex: 2 }} />
        <div onPointerDown={resizeFrom({ left: true, top: true })} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'}
          style={{ position: 'absolute', top: 0, left: 0, width: 12, height: 12, cursor: 'nwse-resize', zIndex: 3 }} />
      </>)}

      <header style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {panelSession ? (<>
          <IconButton label={pt ? 'Voltar' : 'Back'} onClick={() => setDock(d => ({ ...d, panelSession: null }))} isMobile={isMobile}>
            <ArrowLeft size={15} />
          </IconButton>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {panelTitle}
          </span>
          {!isMobile && (
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
                lang={lang} isMobile={isMobile} sessions={naySessions} windows={dock.windows}
                starting={starting} notice={notice} unsupported={unsupported}
                onStart={() => { void startNay() }} onOpen={open}
              />
            )
            : (
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
      {!(isMobile && dock.open) && (
        <MinimizedMenu
          pt={pt}
          items={minimized.map(w => ({ id: w.id, row: findSession(w.id) }))}
          onRestore={id => setDock(d => openSession(d, id))}
          onClose={id => setDock(d => closeWindow(d, id))}
          anchorStyle={{ position: 'fixed', right: 24, bottom: isMobile ? 'calc(12px + var(--mobile-nav-h, 0px))' : 24, zIndex: 300 }}
          renderButton={({ onClickCapture, onKeyDown }) => (
        <button
          onClickCapture={onClickCapture}
          onKeyDown={onKeyDown}
          onClick={() => setDock(d => ({ ...d, open: !d.open }))}
          aria-label={pt ? 'Abrir o chat da Nay' : 'Open the Nay chat'}
          aria-expanded={dock.open}
          title="Nay"
          style={{
            width: 56, height: 56, borderRadius: 16, border: `1.5px solid ${ORANGE}`,
            background: dock.open ? ORANGE : 'var(--bg-surface)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          }}
        >
          {dock.open
            ? <X size={20} color="var(--bg-surface)" />
            : <img src={versionedAsset('/minimalistLogo.png')} alt="" style={{ width: 30, height: 30, borderRadius: 8 }} />}
        </button>
          )}
        />
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

/** A control whose action must be unmistakable: an icon AND a word, orange-outlined. */
function LabelButton({ icon, label, title, onClick }: { icon: ReactNode; label: string; title: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={title} style={{
      display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, padding: '4px 9px', borderRadius: 7,
      border: `1px solid ${ORANGE}`, background: ORANGE_DIM, color: ORANGE, cursor: 'pointer',
      fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
    }}>
      {icon}{label}
    </button>
  )
}

function NayList({ lang, isMobile, sessions, windows, starting, notice, unsupported, onStart, onOpen }: {
  lang: Lang
  isMobile: boolean
  sessions: ControlSession[]
  windows: readonly NayWindow[]
  starting: boolean
  notice: string | null
  unsupported: boolean
  onStart: () => void
  onOpen: (id: string) => void
}) {
  const pt = lang === 'pt'
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        onClick={onStart}
        disabled={starting || unsupported}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: isMobile ? 44 : 36,
          borderRadius: 9, border: `1px solid ${ORANGE}`, background: ORANGE_DIM, color: ORANGE,
          fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: starting || unsupported ? 'default' : 'pointer',
          opacity: unsupported ? 0.5 : 1,
        }}
      >
        {starting ? <Loader2 size={14} style={{ animation: 'ag-working-spin 1s linear infinite' }} /> : <Plus size={14} />}
        {pt ? 'Nova conversa com a Nay' : 'New conversation with Nay'}
      </button>
      {unsupported && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>
          {pt ? 'Esta máquina não consegue iniciar sessões.' : 'This machine cannot start sessions.'}
        </p>
      )}
      {notice && <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--accent-orange, var(--text-secondary))' }}>{notice}</p>}

      {sessions.length === 0 ? (
        <p style={{ margin: '8px 2px 0', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {pt
            ? 'Nenhuma conversa da Nay aberta. Elas também aparecem na lista de sessões, no grupo "Nay".'
            : 'No Nay conversation is open. They also appear in the sessions list, under the "Nay" group.'}
        </p>
      ) : sessions.map(s => {
        const inWindow = windows.some(w => w.id === s.id)
        return (
          <button
            key={s.id}
            onClick={() => onOpen(s.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, minHeight: isMobile ? 44 : 38, padding: '6px 10px',
              borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-elevated)', cursor: 'pointer',
              fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: s.state === 'working' ? ORANGE : 'var(--text-tertiary)' }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
            {inWindow && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: ORANGE, flexShrink: 0 }}>
                <PictureInPicture2 size={11} />{pt ? 'em janela' : 'in a window'}
              </span>
            )}
          </button>
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
