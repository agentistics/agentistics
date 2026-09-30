/**
 * NayNotifyCard.tsx — the session notification the floating Nay button SPEAKS.
 *
 * Our own notification in place of the operating system's (owner, 2026-09-29): it comes out of the
 * button — "ei, olha essa sessão" — and carries what a person needs to decide without leaving the
 * page: the session's name, its assistant and model, how long it has been waiting and when its last
 * message came. Its actions:
 *  - REPLY — opens the session in the Nay dock's floating window, the full `SessionChat` composer
 *    (attachments, mic, auto mode, history, send-now), never a second, smaller text field;
 *  - GO to the session — its full page;
 *  - APPROVE — only on an approval card, and never blindly: it lists the options the server READ OFF
 *    the session's screen (`dialogOptions`) and sends the one tapped, by number. When the options
 *    cannot be read, it says so and sends nothing (`approveBlind`/`chooseBlind`/`dialogBlind`);
 *  - SNOOZE — 15 min, 1 h, or a time typed by hand (`parseSnooze`); the card comes back when it runs
 *    out, if what it said is still true;
 *  - END — only on a "not opened for a while" card, through `NayEndSession`;
 *  - DISMISS.
 *
 * One card at a time, the newest; a count says how many more are waiting behind it. The rules are
 * `nayNotify.ts`, the memory `nayNotifyStore.ts`, the motion `nayNotifyAnim.ts`.
 *
 * THE CARD FOLLOWS THE BUTTON the way the open dock does (owner, 2026-09-30): the same pure physics
 * (`nayDockFollow.ts`) fed the same live position (`nayFabLive.ts`), so it takes the button's drag
 * style, changes sides with the same hysteresis, never covers the button, stays on screen, and
 * rides along without lag under reduced motion. With no button on screen it stands still where
 * `cardPlacement` put it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { HarnessId } from '@agentistics/core'
import type { FleetState } from '../../lib/fleet'
import { versionedAsset } from '../../lib/brand'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import {
  cardPlacement, cardWidth, formatSpan, formatWaiting, parseSnooze, snoozeError, SNOOZE_PRESETS, type CardPlacement, type NayAlert,
} from '../../lib/nayNotify'
import { followSettled, initFollow, landImpulse, NO_FADE, renderDock, restingTransform, stepFollow, type DockFollowState, type DockFrame } from '../../lib/nayDockFollow'
import type { AnchorRect, Size } from '../../lib/nayDock'
import { getFabLive, subscribeFabLive } from '../../lib/nayFabLive'
import { FAB_SIZE, type NayFabStyle } from '../../lib/nayFab'
import { dismissAlert, snoozeAlert, useNayAlerts, useNayShock } from '../../lib/nayNotifyStore'
import { playEnter, playExit, playShock, prefersReducedMotion } from '../../lib/nayNotifyAnim'
import { getNotificationSettings, subscribeNotificationSettings, type NotificationSettings } from '../../lib/sessionNotifications'
import { NayEndSession } from './NayEndSession'

type Drawer = null | 'approve' | 'snooze' | 'snooze-custom' | 'end'

export interface NayNotifyCardProps {
  lang: 'pt' | 'en'
  isMobile: boolean
  rows: readonly ControlSession[]
  finishedTasks: readonly string[]
  act: FleetState['act']
  /** The button's drag style — the card follows it with the matching motion, like the dock. */
  fabStyle: NayFabStyle
  /** Open this session in the Nay dock's floating window (what "Responder" does). */
  onReply: (sessionId: string) => void
  /** Above the dock and every detached window: a card behind a window is a card nobody sees. */
  zIndex: number
}

interface ButtonNow { rect: AnchorRect; speed: number; landed: number; landSpeed: number }

/** Where the button is RIGHT NOW: its live, per-frame position while it moves; null when not on screen. */
function buttonNow(): ButtonNow | null {
  const r = fabEl()?.getBoundingClientRect()
  if (!r || r.width === 0) return null
  const l = getFabLive()
  return l
    ? { rect: { x: l.x, y: l.y, w: FAB_SIZE, h: FAB_SIZE }, speed: l.speed, landed: l.landed, landSpeed: l.landSpeed }
    : { rect: { x: r.left, y: r.top, w: r.width, h: r.height }, speed: 0, landed: 0, landSpeed: 0 }
}

/** The button's live position alone, for the frame loop: no DOM read, so no layout forced per frame. */
function liveButton(): ButtonNow | null {
  const l = getFabLive()
  return l ? { rect: { x: l.x, y: l.y, w: FAB_SIZE, h: FAB_SIZE }, speed: l.speed, landed: l.landed, landSpeed: l.landSpeed } : null
}

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight })

/** The follow engine's frame, read as the placement the entrances and the tail are drawn from. */
function frameToPlacement(fr: DockFrame, st: DockFollowState, btn: AnchorRect): CardPlacement & { tail: boolean } {
  const originX = btn.x + btn.w / 2 - fr.left
  const originY = btn.y + btn.h / 2 - fr.top
  const vertical = st.key[0] === 'v'
  return {
    left: fr.left, top: fr.top, originX, originY,
    tailSide: st.place.grow.y === 'up' ? 'bottom' : 'top',
    tailX: Math.max(18, Math.min(fr.w - 34, originX - 8)),
    tail: vertical,
  }
}

/** The live notification settings — a fresh object per read, so held in state and re-read on change. */
function useSettings(): NotificationSettings {
  const [s, set] = useState(getNotificationSettings)
  useEffect(() => subscribeNotificationSettings(() => set(getNotificationSettings())), [])
  useEffect(() => {
    const on = () => set(getNotificationSettings())
    window.addEventListener('agentistics:notification-settings-changed', on)
    return () => window.removeEventListener('agentistics:notification-settings-changed', on)
  }, [])
  return s
}

function fabEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-nay-fab]')
}

function bottomInset(isMobile: boolean): number {
  if (!isMobile) return 0
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-nav-h'))
  return Number.isFinite(v) ? v : 0
}

const SAY: Record<NayAlert['kind'], { pt: string; en: string }> = {
  turn: { pt: 'Ei, a sessão respondeu.', en: 'Hey, the session replied.' },
  approval: { pt: 'Ei, olha essa sessão: ela pediu permissão.', en: 'Hey, look at this session: it is asking for permission.' },
  stale: { pt: 'Ei, essa sessão está parada faz tempo.', en: 'Hey, this session has been waiting a while.' },
}

const STATE_CHIP: Record<NayAlert['kind'], { pt: string; en: string; fg: string; bg: string }> = {
  turn: { pt: 'precisa de você', en: 'needs you', fg: 'var(--anthropic-orange-light)', bg: 'var(--anthropic-orange-dim)' },
  approval: { pt: 'pede aprovação', en: 'needs approval', fg: 'var(--accent-red)', bg: 'var(--accent-red-dim)' },
  stale: { pt: 'sem abrir', en: 'not opened', fg: 'var(--text-secondary)', bg: 'var(--border)' },
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The last thing the session said, for a two-line preview. Absent = nothing is drawn. */
function lastSaid(row: ControlSession | undefined, kind: NayAlert['kind']): string | null {
  if (!row) return null
  if (kind === 'approval' && row.approvalLines?.length) return row.approvalLines.filter(l => l.trim()).slice(0, 3).join(' ')
  const turn = [...(row.chatTurns ?? [])].reverse().find(t => t.role === 'assistant' && !t.pending && t.text.trim())
  return turn ? turn.text.trim().slice(0, 240) : null
}

export function NayNotifyCard({ lang, isMobile, rows, finishedTasks, act, fabStyle, onReply, zIndex }: NayNotifyCardProps) {
  const pt = lang === 'pt'
  const alerts = useNayAlerts()
  const alert = alerts.length > 0 ? alerts[alerts.length - 1]! : null
  const settings = useSettings()
  const shock = useNayShock()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const cardRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [snoozeText, setSnoozeText] = useState('')
  const [snoozeErr, setSnoozeErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [, tick] = useState(0)
  /** The pointer is over the card or it holds the keyboard: somebody is using it, so it stays. */
  const [engaged, setEngaged] = useState(false)
  const tailRef = useRef<HTMLSpanElement>(null)
  /** Where React-free placement put the card; the follow loop only ever moves it by `translate` from here. */
  const cardBase = useRef({ left: 0, top: 0 })
  const written = useRef({ w: -1, h: -1, o: -1 })
  const follow = useRef<{ st: DockFollowState | null; want: Size | null; raf: number; last: number; landed: number; frame: DockFrame | null }>(
    { st: null, want: null, raf: 0, last: 0, landed: 0, frame: null })
  const kickRef = useRef<() => void>(() => {})

  const row = alert ? rows.find(r => r.id === alert.sessionId) : undefined
  const reduced = prefersReducedMotion()

  // "A session replied": the button shocks — but NOT on the Sessions page, where the reply is
  // already on screen and a jumping button beside it is noise.
  const lastShock = useRef(shock)
  useEffect(() => {
    if (shock === lastShock.current) return
    lastShock.current = shock
    if (pathname.startsWith('/sessions')) return
    const el = fabEl()
    if (el) playShock(el, prefersReducedMotion())
  }, [shock, pathname])

  // The wait is live: re-rendered every 30 s while a card is up.
  useEffect(() => {
    if (!alert) return
    const t = window.setInterval(() => tick(n => n + 1), 30_000)
    return () => window.clearInterval(t)
  }, [alert])

  // IT LEAVES BY ITSELF after the chosen time (5 s by default), unless somebody is using it.
  useEffect(() => {
    const sec = settings.autoDismissSec
    if (!alert || drawer || engaged || !(sec > 0)) return
    const key = alert.key
    const t = window.setTimeout(() => void close(() => dismissAlert(key)), sec * 1000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert?.key, drawer, engaged, settings.autoDismissSec])

  // A new card resets its own controls.
  useEffect(() => { setDrawer(null); setSnoozeText(''); setSnoozeErr(null); setNotice(null); setLeaving(false) }, [alert?.key])

  /** The balloon's tail, drawn by ref: it moves every frame and must not re-render React for it. */
  const writeTail = (t: { side: 'top' | 'bottom'; x: number } | null) => {
    const el = tailRef.current
    if (!el) return
    if (!t) { el.style.display = 'none'; return }
    el.style.display = 'block'
    el.style.left = `${Math.round(t.x)}px`
    if (t.side === 'bottom') { el.style.top = ''; el.style.bottom = '-9px'; el.style.borderTop = 'none'; el.style.borderLeft = 'none'; el.style.borderBottom = ''; el.style.borderRight = '' }
    else { el.style.bottom = ''; el.style.top = '-9px'; el.style.borderBottom = 'none'; el.style.borderRight = 'none'; el.style.borderTop = ''; el.style.borderLeft = '' }
  }

  /** Anchor the card at a resting place: the one layout write, made when a card opens or is re-placed. */
  const setBase = (left: number, top: number) => {
    const card = cardRef.current
    if (!card) return
    cardBase.current = { left, top }
    card.style.left = `${left}px`; card.style.top = `${top}px`
    card.style.translate = ''
  }

  /**
   * Put the card where the follow engine says. A COMPOSITED write only: `translate` from the
   * resting place (the entrances animate `transform`, which `translate` composes with instead of
   * fighting), width / max-height / opacity only when they change, and no layout read at all.
   */
  const writeFrame = (fr: DockFrame, st: DockFollowState, btn: AnchorRect) => {
    const card = cardRef.current
    if (!card) return
    const p = frameToPlacement(fr, st, btn), b = cardBase.current, w = written.current
    const dx = fr.left - b.left, dy = fr.top - b.top
    card.style.translate = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 ? '' : `${dx}px ${dy}px`
    // Only while it moves: `will-change` left on makes the card the containing block of the folder
    // Select's fixed popover (see `frameStyle` in nayDockFollow.ts).
    card.style.willChange = card.style.translate ? 'translate, transform' : ''
    card.style.transformOrigin = `${p.originX}px ${p.originY}px`
    card.style.transform = restingTransform(fr.transform)
    if (fr.w !== w.w) { card.style.width = `${fr.w}px`; w.w = fr.w }
    if (fr.h !== w.h) { card.style.maxHeight = `${fr.h}px`; w.h = fr.h }
    if (fr.opacity !== w.o) { card.style.opacity = String(fr.opacity); w.o = fr.opacity }
    writeTail(p.tail ? { side: p.tailSide, x: p.tailX } : null)
  }

  /** Place the card now: on the follow engine when the button is on screen, statically otherwise. */
  const placeNow = (): CardPlacement | null => {
    const card = cardRef.current
    if (!card) return null
    const f = follow.current
    const want: Size = { w: card.offsetWidth, h: card.scrollHeight }
    const b = buttonNow()
    const reduced = prefersReducedMotion()
    if (b) {
      const vp = viewport()
      if (!f.st) { f.st = initFollow(b.rect, want, vp); f.landed = b.landed }
      f.want = want
      stepFollow(f.st, b.rect, want, vp, fabStyle, true, 0, NO_FADE)
      f.frame = renderDock(f.st, b.rect, vp, fabStyle, reduced, 0, NO_FADE)
      written.current = { w: -1, h: -1, o: -1 }
      setBase(f.frame.left, f.frame.top)
      writeFrame(f.frame, f.st, b.rect)
      return frameToPlacement(f.frame, f.st, b.rect)
    }
    f.st = null
    const p = cardPlacement({
      fab: null, vpW: window.innerWidth, vpH: window.innerHeight,
      cardW: card.offsetWidth, cardH: card.offsetHeight, bottomInset: bottomInset(isMobile),
    })
    setBase(p.left, p.top)
    card.style.transformOrigin = `${p.originX}px ${p.originY}px`
    writeTail({ side: p.tailSide, x: p.tailX })
    return p
  }

  // Stacked above the dock and every detached window (the owner found it hidden behind one).
  useLayoutEffect(() => { if (cardRef.current) cardRef.current.style.zIndex = String(zIndex) })

  // Placed and animated once per card, before paint.
  useLayoutEffect(() => {
    if (!alert) return
    follow.current.st = null
    const p = placeNow()
    if (!p || !cardRef.current) return
    cancelRef.current?.()
    cancelRef.current = playEnter(settings.nayAnimation, cardRef.current, fabEl(), p, prefersReducedMotion())
    return () => { cancelRef.current?.(); cancelRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert?.key])

  // A drawer opening changes the card's height: the follow target grows with it.
  useLayoutEffect(() => {
    if (!alert) return
    const card = cardRef.current, f = follow.current
    if (card && f.st) { f.want = { w: card.offsetWidth, h: card.scrollHeight }; kickRef.current() } else placeNow()
  }, [drawer, notice, busy]) // eslint-disable-line react-hooks/exhaustive-deps

  // THE FOLLOW LOOP — the dock's own, run only while something moves.
  useEffect(() => {
    if (!alert) return
    const f = follow.current
    const reduced = prefersReducedMotion()
    // Measured once, and again on a resize — the loop itself reads no layout.
    let vp = viewport()
    const frame = (now: number) => {
      const st = f.st, b = liveButton()
      if (!st || !b || !f.want) { f.raf = 0; return }
      const dt = Math.min(0.05, (now - f.last) / 1000); f.last = now
      if (b.landed !== f.landed) { f.landed = b.landed; landImpulse(st, fabStyle, reduced, b.landSpeed) }
      for (let i = 0; i < 4; i++) stepFollow(st, b.rect, f.want, vp, fabStyle, reduced, dt / 4, NO_FADE)
      f.frame = renderDock(st, b.rect, vp, fabStyle, reduced, b.speed, NO_FADE)
      writeFrame(f.frame, st, b.rect)
      if (followSettled(st) && b.speed < 1) {
        // At rest the card is RE-ANCHORED where it stopped and carries no translate or transform:
        // either would make it the containing block of the folder `Select`'s fixed popover.
        setBase(f.frame.left, f.frame.top)
        writeFrame(f.frame, st, b.rect)
        f.raf = 0
      } else f.raf = requestAnimationFrame(frame)
    }
    const kick = () => {
      if (!f.st) { placeNow(); return }
      if (!f.raf) { f.last = performance.now(); f.raf = requestAnimationFrame(frame) }
    }
    kickRef.current = kick
    const off = subscribeFabLive(kick)
    const onResize = () => { vp = viewport(); kick() }
    window.addEventListener('resize', onResize)
    return () => { off(); window.removeEventListener('resize', onResize); if (f.raf) cancelAnimationFrame(f.raf); f.raf = 0 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert?.key, fabStyle])

  if (!alert) return null

  const close = async (after: () => void) => {
    if (leaving) return
    setLeaving(true)
    if (cardRef.current) await playExit(cardRef.current, fabEl(), reduced)
    after()
  }

  const say = SAY[alert.kind][lang]
  const chip = STATE_CHIP[alert.kind]
  const harnessLabel = alert.harness ? (HARNESS_LABELS[alert.harness as HarnessId] ?? alert.harness) : null
  const harnessColor = alert.harness ? (HARNESS_COLORS[alert.harness as HarnessId] ?? 'var(--text-tertiary)') : null
  const preview = lastSaid(row, alert.kind)
  const width = cardWidth(typeof window === 'undefined' ? 390 : window.innerWidth, isMobile)
  const tap = isMobile ? 44 : 32

  const btn: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: tap,
    padding: isMobile ? '8px 12px' : '5px 10px', borderRadius: 8, border: '1px solid var(--border)',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5,
    fontWeight: 500, cursor: 'pointer',
  }
  const primary: CSSProperties = { ...btn, background: 'var(--anthropic-orange)', borderColor: 'var(--anthropic-orange)', color: '#fff' }
  const hint: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }
  const field: CSSProperties = {
    fontFamily: 'inherit', fontSize: isMobile ? 16 : 13, padding: '7px 9px', borderRadius: 8, minWidth: 0,
    border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)',
  }

  const finish = (message: string) => void close(() => { dismissAlert(alert.key); if (message) setNotice(null) })

  const pick = async (n: number) => {
    setBusy(true)
    const out = await act({ id: alert.sessionId, action: 'approve', choice: n })
    setBusy(false)
    if (out.ok) finish('')
    else setNotice(out.message)
  }

  const doSnooze = (ms: number) => void close(() => snoozeAlert(alert.key, ms))

  const approveBody = () => {
    const blind = row?.approveBlind ?? row?.chooseBlind ?? row?.dialogBlind
    const options = row?.dialogOptions ?? []
    if (!row || row.state !== 'waiting-approval') {
      return <span style={hint}>{pt ? 'A sessão não está mais esperando uma aprovação.' : 'The session is no longer waiting for an approval.'}</span>
    }
    if (blind || options.length === 0) {
      return (
        <>
          <span style={hint}>{blind ?? (pt ? 'Não consegui ler as opções desta tela, então nada será enviado daqui. Abra a sessão para responder.' : 'The options on this screen could not be read, so nothing is sent from here. Open the session to answer.')}</span>
          <button type="button" style={btn} onClick={() => void close(() => { dismissAlert(alert.key); navigate(`/sessions/${encodeURIComponent(alert.sessionId)}`) })}>
            {pt ? 'Ir para a sessão' : 'Go to the session'}
          </button>
        </>
      )
    }
    return (
      <>
        <span style={hint}>{pt ? 'Opções lidas da tela da sessão. Nada é enviado até você tocar em uma.' : 'Options read off the session\'s screen. Nothing is sent until you tap one.'}</span>
        {options.map(o => (
          <button key={o.number} type="button" disabled={busy || o.freeText}
            title={o.freeText ? (pt ? 'Esta opção pede texto: abra a sessão para escrever' : 'This option takes text: open the session to type it') : undefined}
            onClick={() => void pick(o.number)}
            style={{ ...btn, justifyContent: 'flex-start', textAlign: 'left', width: '100%', opacity: o.freeText ? 0.55 : 1 }}>
            <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--anthropic-orange-light)', minWidth: 16 }}>{o.number}.</span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{o.label}</span>
          </button>
        ))}
      </>
    )
  }

  const showTail = settings.nayAnimation === 'balloon' && !reduced
  const tailStyle: CSSProperties = {
    position: 'absolute', display: 'none', width: 16, height: 16, background: 'var(--bg-card, var(--bg-surface))',
    transform: 'rotate(45deg)', border: '1px solid var(--border)',
  }

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={pt ? `Notificação: ${alert.name}` : `Notification: ${alert.name}`}
      aria-live="polite"
      onPointerEnter={() => setEngaged(true)}
      onPointerLeave={() => setEngaged(false)}
      onFocus={() => setEngaged(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEngaged(false) }}
      style={{
        // left / top / transform-origin / max-height are written by the placement and the follow
        // loop, never by React: a re-render mid-drag must not snap the card back for a frame.
        position: 'fixed', zIndex: 305, width, maxWidth: 'calc(100vw - 24px)',
        background: 'var(--bg-card, var(--bg-surface))', border: '1px solid var(--border)', borderRadius: 14,
        boxShadow: '0 14px 36px rgba(0,0,0,0.34), 0 2px 6px rgba(0,0,0,0.18), inset 0 0 0 1px var(--anthropic-orange-dim)',
        fontSize: 13, color: 'var(--text-primary)', overflowY: 'auto', overscrollBehavior: 'contain',
      }}
    >
      {showTail && <span aria-hidden ref={tailRef} style={tailStyle} />}
      <div style={{ position: 'relative', display: 'grid', gap: 10, padding: 12 }}>
        <div data-rise style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src={versionedAsset('/minimalistLogo.png')} alt="" style={{ width: 20, height: 20, borderRadius: 6 }} />
          <span style={{ fontWeight: 650, fontSize: 12.5 }}>Nay</span>
          {alerts.length > 1 && (
            <span title={pt ? 'Mais notificações esperando' : 'More notifications waiting'} style={{
              fontSize: 10.5, fontWeight: 600, padding: '2px 6px', borderRadius: 9,
              background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)',
            }}>+{alerts.length - 1}</span>
          )}
          <button type="button" aria-label={pt ? 'Dispensar' : 'Dismiss'} onClick={() => void close(() => dismissAlert(alert.key))}
            style={{ marginLeft: 'auto', width: tap, height: tap, border: 'none', borderRadius: 7, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
            <X size={15} />
          </button>
        </div>

        <div data-rise data-say style={{ fontSize: 13.5, fontWeight: 500 }}>{say}</div>

        <div data-rise style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '9px 10px', display: 'grid', gap: 6, background: 'var(--bg-surface)' }}>
          <div title={alert.name} style={{ fontWeight: 650, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alert.name}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {harnessLabel && (
              <span style={chipStyle}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: harnessColor ?? undefined }} />{harnessLabel}
              </span>
            )}
            {alert.model && <span style={chipStyle}>{alert.model}</span>}
            <span style={{ ...chipStyle, border: 'none', background: chip.bg, color: chip.fg }}>{chip[lang]}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
            <span>{pt ? 'Esperando' : 'Waiting'}</span>
            <b style={numStyle}>{formatWaiting(alert.sinceMs, Date.now(), alert.sinceKnown, lang)}</b>
            <span>{pt ? 'Última mensagem' : 'Last message'}</span>
            <b style={numStyle}>{alert.sinceKnown ? hhmm(alert.sinceMs) : (pt ? 'antes de abrir a página' : 'before this page opened')}</b>
          </div>
          {preview && (
            <div style={{
              fontSize: 12.5, color: 'var(--text-secondary)', borderLeft: '2px solid var(--anthropic-orange-dim)', paddingLeft: 8,
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere',
            }}>{preview}</div>
          )}
        </div>

        {alert.demo && (
          <span data-rise style={hint}>{pt ? 'Exemplo das configurações: não há sessão por trás, então só adiar e dispensar funcionam.' : 'A settings example: there is no session behind it, so only snooze and dismiss work.'}</span>
        )}
        <div data-rise style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {!alert.demo && (
            <button type="button" style={btn} onClick={() => void close(() => { dismissAlert(alert.key); onReply(alert.sessionId) })}>
              {pt ? 'Responder' : 'Reply'}
            </button>
          )}
          {!alert.demo && (
            <button type="button" style={btn} onClick={() => void close(() => { dismissAlert(alert.key); navigate(`/sessions/${encodeURIComponent(alert.sessionId)}`) })}>
              {pt ? 'Ir para a sessão' : 'Go to session'}
            </button>
          )}
          {alert.kind === 'approval' && !alert.demo && (
            <button type="button" style={primary} onClick={() => setDrawer(d => (d === 'approve' ? null : 'approve'))}>{pt ? 'Aprovar…' : 'Approve…'}</button>
          )}
          <button type="button" style={{ ...btn, background: 'transparent' }} onClick={() => setDrawer(d => (d === 'snooze' || d === 'snooze-custom' ? null : 'snooze'))}>
            {pt ? 'Adiar' : 'Snooze'}
          </button>
          {alert.kind === 'stale' && row && (
            <button type="button" style={{ ...btn, background: 'transparent', color: 'var(--accent-red)' }} onClick={() => setDrawer(d => (d === 'end' ? null : 'end'))}>
              {pt ? 'Encerrar' : 'End'}
            </button>
          )}
        </div>

        {notice && <span role="alert" style={{ ...hint, color: 'var(--accent-red)' }}>{notice}</span>}

        {drawer && (
          <div style={{ display: 'grid', gap: 7, borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
            {drawer === 'approve' && approveBody()}
            {drawer === 'snooze' && (
              <>
                <span style={hint}>{pt ? 'Lembrar de novo em' : 'Remind me again in'}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {SNOOZE_PRESETS.map(p => (
                    <button key={p.ms} type="button" style={btn} onClick={() => doSnooze(p.ms)}>{p.label[lang]}</button>
                  ))}
                  <button type="button" style={btn} onClick={() => setDrawer('snooze-custom')}>{pt ? 'Inserir tempo' : 'Enter a time'}</button>
                </div>
              </>
            )}
            {drawer === 'snooze-custom' && (
              <form style={{ display: 'grid', gap: 6 }} onSubmit={e => {
                e.preventDefault()
                const r = parseSnooze(snoozeText)
                if (!r.ok) { setSnoozeErr(snoozeError(r.reason, lang)); return }
                doSnooze(r.ms)
              }}>
                <label htmlFor="nay-snooze" style={hint}>{pt ? 'Minutos ou horas: 30m, 2h, 1h30' : 'Minutes or hours: 30m, 2h, 1h30'}</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input id="nay-snooze" autoFocus value={snoozeText} placeholder="30m" inputMode="text"
                    aria-invalid={snoozeErr ? true : undefined}
                    onChange={e => { setSnoozeText(e.target.value); setSnoozeErr(null) }} style={{ ...field, flex: 1 }} />
                  <button type="submit" style={primary}>{pt ? 'Adiar' : 'Snooze'}</button>
                </div>
                {snoozeErr
                  ? <span role="alert" style={{ ...hint, color: 'var(--accent-red)' }}>{snoozeErr}</span>
                  : (() => { const r = parseSnooze(snoozeText); return r.ok ? <span style={hint}>{pt ? `Volta em ${formatSpan(r.ms)}.` : `Back in ${formatSpan(r.ms)}.`}</span> : null })()}
              </form>
            )}
            {drawer === 'end' && row && (
              <NayEndSession
                row={row} rows={rows} finishedTasks={finishedTasks} lang={lang} isMobile={isMobile} act={act}
                onBack={() => setDrawer(null)}
                onDone={(message, ended) => { if (ended) finish(message); else setNotice(message) }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, lineHeight: 1, padding: '4px 7px', borderRadius: 6,
  border: '1px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
}
const numStyle: CSSProperties = { fontWeight: 500, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }
