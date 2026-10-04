/**
 * VaultFabPop.tsx — the vault icon that pops up above the Nay chat button (owner, 2026-10-03).
 *
 * Right-click the button (it never opens the browser's menu), long-press it on touch (450 ms, with a
 * haptic where the device has one), or press Shift+F10 / the context-menu key while it is focused:
 * a vault icon rises from behind it. Activating the icon opens the personal vault as a quick sheet
 * (`QuickVault`, the page's own rows and unlock); a press anywhere else or Escape sinks it back.
 *
 * The rules are `lib/vaultFab.ts` (pure, tested). This wraps the chat button, so it sees the button's
 * events FIRST (capture) and can swallow the click a long-press would otherwise turn into "open the
 * chat". The sheet is PORTALED to `<body>`: the button's anchor carries a transform, and a fixed
 * overlay inside a transformed ancestor would be positioned against the button instead of the screen.
 */

import { Suspense, lazy, useEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Vault } from 'lucide-react'
import {
  VAULT_FAB_INITIAL, VAULT_LONG_PRESS_MS, VAULT_PRESS_SLOP, closeVaultPanel, isContextMenuKey, vaultFabMotion, vaultFabReduce, vaultIconMounted,
  type VaultFabEvent, type VaultFabState,
} from '../../lib/vaultFab'
import { pt_ } from '../../lib/personalText'

const QuickVault = lazy(() => import('../../pages/VaultPage').then(m => ({ default: m.QuickVault })))

const ICON = 44

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

type Action = VaultFabEvent | { type: 'panel-closed' }
const reducer = (s: VaultFabState, a: Action): VaultFabState => (a.type === 'panel-closed' ? closeVaultPanel(s) : vaultFabReduce(s, a))

export function VaultFabPop({ lang, isMobile, suppressed, children }: {
  lang: 'en' | 'pt'
  isMobile: boolean
  /** The button is being dragged: the icon goes, and nothing may summon it. */
  suppressed: boolean
  children: ReactNode
}) {
  const [s, dispatch] = useReducer(reducer, VAULT_FAB_INITIAL)
  const [reduced, setReduced] = useState(prefersReducedMotion)
  const [ripple, setRipple] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const iconRef = useRef<HTMLButtonElement>(null)
  const press = useRef<{ x: number; y: number; timer: number } | null>(null)
  const swallowClick = useRef(false)
  const viaKeyboard = useRef(false)
  const motion = vaultFabMotion(reduced)
  const label = pt_('fabOpen', lang)

  useEffect(() => {
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)') } catch { return }
    const on = () => setReduced(mq!.matches)
    mq.addEventListener?.('change', on)
    return () => mq?.removeEventListener?.('change', on)
  }, [])

  const summon = () => {
    if (suppressed) return
    if (s.phase !== 'shown') setRipple(n => n + 1)
    dispatch({ type: 'summon' })
  }

  // A drag of the button takes the icon away.
  useEffect(() => { if (suppressed) { cancelPress(); dispatch({ type: 'dismiss' }) } }, [suppressed])

  // Outside press / Escape → it sinks back. The press on the button itself is left to summon again.
  useEffect(() => {
    if (s.phase !== 'shown') return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (iconRef.current?.contains(t) || wrapRef.current?.contains(t)) return
      dispatch({ type: 'dismiss' })
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch({ type: 'dismiss' }) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [s.phase])

  // `leaving` ends with the animation; a timer backs `animationend` up (a hidden tab never fires it).
  useEffect(() => {
    if (s.phase !== 'leaving') return
    const t = window.setTimeout(() => dispatch({ type: 'settled' }), motion.leaveMs + 40)
    return () => window.clearTimeout(t)
  }, [s.phase, motion.leaveMs])

  // From the keyboard, focus goes to the icon so Enter opens it at once.
  useEffect(() => {
    if (s.phase === 'shown' && viaKeyboard.current) { viaKeyboard.current = false; iconRef.current?.focus() }
  }, [s.phase])

  useEffect(() => () => cancelPress(), [])

  function cancelPress() { if (press.current) { window.clearTimeout(press.current.timer); press.current = null } }

  const onContextMenu = (e: ReactMouseEvent) => { e.preventDefault(); summon() }
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return
    cancelPress()
    const timer = window.setTimeout(() => {
      press.current = null
      swallowClick.current = true
      try { navigator.vibrate?.(12) } catch { /* not allowed */ }
      summon()
    }, VAULT_LONG_PRESS_MS)
    press.current = { x: e.clientX, y: e.clientY, timer }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > VAULT_PRESS_SLOP) cancelPress()
  }
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    e.preventDefault(); e.stopPropagation()
  }
  const onKeyDownCapture = (e: ReactKeyboardEvent) => {
    if (!isContextMenuKey(e)) return
    e.preventDefault(); e.stopPropagation()
    viaKeyboard.current = true
    summon()
  }

  return (
    <div
      ref={wrapRef}
      data-vault-fab
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onContextMenu={onContextMenu}
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onPointerUpCapture={cancelPress}
      onPointerCancelCapture={cancelPress}
      onClickCapture={onClickCapture}
      onKeyDownCapture={onKeyDownCapture}
    >
      {children}
      {ripple > 0 && motion.ripple && (
        <span key={ripple} aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, pointerEvents: 'none', animation: motion.ripple }} />
      )}
      {vaultIconMounted(s) && (
        <button
          ref={iconRef}
          type="button"
          data-vault-fab-icon
          data-phase={s.phase}
          aria-label={label}
          title={label}
          tabIndex={s.phase === 'shown' ? 0 : -1}
          disabled={s.phase !== 'shown'}
          onClick={e => { e.stopPropagation(); dispatch({ type: 'activate' }) }}
          onContextMenu={e => e.preventDefault()}
          onAnimationEnd={() => { if (s.phase === 'leaving') dispatch({ type: 'settled' }) }}
          style={{
            position: 'absolute', left: '50%', marginLeft: -ICON / 2, bottom: 'calc(100% + 12px)', width: ICON, height: ICON,
            borderRadius: 14, border: '1.5px solid var(--anthropic-orange)', background: 'var(--bg-surface)', color: 'var(--anthropic-orange)',
            display: 'grid', placeItems: 'center', padding: 0, cursor: 'pointer', boxShadow: '0 8px 22px rgba(0,0,0,0.32)',
            animation: s.phase === 'shown' ? motion.enter : motion.leave, transformOrigin: '50% 100%',
            pointerEvents: s.phase === 'shown' ? 'auto' : 'none', zIndex: 1, touchAction: 'manipulation',
          }}
        >
          <Vault size={20} strokeWidth={1.9} />
        </button>
      )}
      {s.panel && typeof document !== 'undefined' && createPortal(
        <Suspense fallback={null}>
          <QuickVault lang={lang} isMobile={isMobile} onClose={() => dispatch({ type: 'panel-closed' })} />
        </Suspense>,
        document.body,
      )}
    </div>
  )
}
