import React from 'react'
import { X } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useEscapeOwner } from '../lib/overlayStack'
import { ConfirmModal } from '../pages/settings/primitives'
import {
  drawerAfterFrame, drawerAfterTransition, drawerFrame, drawerMounted, drawerPhaseFor,
  prefersReducedMotion, swipeClosePx, swipeCloses, swipeIsHorizontal,
  DRAWER_CLOSE_MS, type DrawerPhase, type DrawerSide,
} from '../lib/drawerMotion'

/**
 * THE APP'S ONE SIDE PANEL. Moved here from `pages/settings/` when the phone's session screen
 * became its second kind of user — a component in a settings folder reads as settings-only, and
 * the next screen to need a drawer would have written its own.
 *
 * It SLIDES IN AND OUT (`lib/drawerMotion.ts`): mounted off-screen, moved on the next frame, and
 * unmounted only after the closing transition has ended, so it never pops out. The backdrop fades
 * with it, and `prefers-reduced-motion` keeps the fade and drops the travel.
 *
 * `side` is the one thing that differs between its users. `'right'` (default) is the settings
 * editor: a titled form with a close button and an optional pinned footer. `'left'` is the
 * session's own panel on a phone: the CALLER draws its header (`title` is a node there — the way
 * back and the inbox, not a heading), there is no X (the backdrop, Esc, the system back and a
 * swipe towards the edge all close it), and the panel follows a finger swiping it shut.
 */
export function Drawer({ open, title, onClose, children, footer, dirty = false, lang = 'en', side = 'right' }: {
  open: boolean
  /** A heading for `'right'`; the caller's own header row for `'left'`. */
  title: React.ReactNode
  onClose: () => void; children: React.ReactNode
  /** Optional action bar pinned to the bottom of the panel — for a drawer-wide save button. */
  footer?: React.ReactNode
  /** When true, closing (backdrop / X / Escape) or leaving the tab asks to confirm first, so
   *  unsaved edits are never silently discarded. Drawers compute this from their form state. */
  dirty?: boolean
  lang?: 'pt' | 'en'
  side?: DrawerSide
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const left = side === 'left'
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)
  const [phase, setPhase] = React.useState<DrawerPhase>(open ? 'entering' : 'closed')
  const [dragPx, setDragPx] = React.useState(0)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const touch = React.useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null)
  const reducedMotion = React.useMemo(prefersReducedMotion, [])

  React.useEffect(() => { setPhase(p => drawerPhaseFor(p, open)) }, [open])

  // `entering` → `open` on the frame AFTER mounting, so the browser has painted the off-screen
  // position and the transition has somewhere to start from.
  React.useEffect(() => {
    if (phase !== 'entering') return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setPhase(drawerAfterFrame)) })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [phase])

  // The closing transition's end unmounts — with a timer behind it, because `transitionend` never
  // fires on a tab in the background, and an invisible panel left mounted would take every tap.
  React.useEffect(() => {
    if (phase !== 'leaving') return
    const t = setTimeout(() => setPhase(drawerAfterTransition), DRAWER_CLOSE_MS + 80)
    return () => clearTimeout(t)
  }, [phase])

  React.useEffect(() => { if (phase === 'open') panelRef.current?.focus({ preventScroll: true }) }, [phase])
  React.useEffect(() => { if (!open) setDragPx(0) }, [open])

  const attemptClose = React.useCallback(() => {
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }, [dirty, onClose])

  useEscapeOwner(open, attemptClose)

  React.useEffect(() => {
    if (!open || !dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [open, dirty])

  if (!drawerMounted(phase)) return null

  const width = panelRef.current?.offsetWidth ?? 0
  const frame = drawerFrame({ phase, side, reducedMotion, dragPx, width })

  // SWIPE TO CLOSE, `'left'` only: the settings editor holds sliders and wide tables that a
  // sideways touch must keep. Decided after the first few pixels — a vertical move is a scroll of
  // the panel's own content and never moves the panel.
  const swipe = left && open ? {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (t) touch.current = { x: t.clientX, y: t.clientY, horizontal: null }
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = touch.current; const t = e.touches[0]
      if (!s || !t) return
      const dx = t.clientX - s.x; const dy = t.clientY - s.y
      if (s.horizontal === null) s.horizontal = swipeIsHorizontal(dx, dy)
      if (s.horizontal) setDragPx(swipeClosePx(dx, side))
    },
    onTouchEnd: () => {
      const closes = swipeCloses(dragPx, width)
      touch.current = null
      if (closes) onClose()
      else setDragPx(0)
    },
    onTouchCancel: () => { touch.current = null; setDragPx(0) },
  } : {}

  return (
    <>
    <div
      onClick={attemptClose}
      data-drawer-phase={phase}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
        justifyContent: left ? 'flex-start' : 'flex-end',
        paddingTop: isMobile && !left ? 'var(--safe-top)' : 0,
        // Its own layer, so the backdrop can fade without fading the panel it holds.
        isolation: 'isolate',
      }}
    >
      <div aria-hidden style={{
        position: 'absolute', inset: 0, zIndex: -1,
        background: left ? 'var(--ag-scrim, rgba(0,0,0,0.55))' : 'rgba(0,0,0,0.5)',
        opacity: frame.backdropOpacity, transition: frame.transition,
      }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onTransitionEnd={e => { if (e.target === e.currentTarget) setPhase(drawerAfterTransition) }}
        {...swipe}
        style={{
          width: left
            ? 'min(86%, 360px)'
            : (isMobile ? '100%' : 'min(680px, calc(94vw / var(--ui-zoom, 1)))'),
          height: '100%',
          background: left ? 'var(--bg-surface)' : 'var(--bg-card)',
          ...(left
            ? { borderRadius: '0 22px 22px 0', boxShadow: 'var(--ag-shadow-menu)', paddingTop: 'var(--safe-top)' }
            : { borderLeft: isMobile ? 'none' : '1px solid var(--border)', boxShadow: '-12px 0 40px rgba(0,0,0,0.35)' }),
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden', outline: 'none',
          transform: frame.transform, opacity: frame.panelOpacity, transition: frame.transition,
          willChange: 'transform, opacity', touchAction: left ? 'pan-y' : undefined,
        }}
      >
        {left ? (
          <div style={{ flexShrink: 0, zIndex: 1 }}>{title}</div>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 18px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg-card)', zIndex: 1, flexShrink: 0,
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
            <button
              onClick={attemptClose}
              style={{
                border: 'none', background: 'transparent', color: 'var(--text-tertiary)',
                cursor: 'pointer', display: 'inline-flex', padding: 4,
              }}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div style={{
          padding: left ? '4px 12px 16px' : 18, display: 'flex', flexDirection: 'column', gap: left ? 8 : 12,
          flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
        }}>
          {children}
        </div>
        {footer && (
          <div style={{
            zIndex: 1, flexShrink: 0,
            padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)',
            display: 'flex', gap: 8, justifyContent: 'flex-end',
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
    <ConfirmModal
      open={confirmDiscard}
      title={pt ? 'Descartar alterações?' : 'Discard changes?'}
      message={pt
        ? 'Você tem alterações não salvas. Se sair agora, elas serão perdidas.'
        : 'You have unsaved changes. If you leave now, they will be lost.'}
      confirmLabel={pt ? 'Descartar' : 'Discard'}
      cancelLabel={pt ? 'Continuar editando' : 'Keep editing'}
      onConfirm={() => { setConfirmDiscard(false); onClose() }}
      onCancel={() => setConfirmDiscard(false)}
    />
    </>
  )
}

export default Drawer
