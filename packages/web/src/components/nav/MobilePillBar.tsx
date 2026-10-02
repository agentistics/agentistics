import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { followOffset, isDrag, restOffset, slotAt } from '../../lib/bottomNavDrag'
import { MOBILE_PILL_BAR_Z } from '../../lib/zLayers'

/**
 * THE MOBILE BOTTOM BAR — a floating pill in our dark tone, slightly see-through, with an
 * indicator that sits behind the current item.
 *
 * Two ways to move: TAP an item (the ordinary click), or press anywhere on the bar and DRAG — the
 * indicator follows the finger, the item under it lights up as it is crossed, and letting go
 * activates that item. The arithmetic is `lib/bottomNavDrag.ts` (pure, tested).
 *
 * The pill is dark in BOTH themes on purpose: it is a floating control over the page, and the
 * owner asked for our dark tone rather than a surface that follows the theme. Its colours are
 * therefore literal here and not the theme tokens, which would turn its text dark on light.
 * No backdrop blur — "no liquid glass" was the other half of that request.
 */

export interface PillItem {
  key: string
  label: string
  icon: LucideIcon
  onActivate: () => void
}

/** Gap between the indicator and the edges of its slot. */
const INSET = 4
const ORANGE = 'var(--anthropic-orange)'
const IDLE = 'rgba(255, 255, 255, 0.62)'
const SPRING = 'cubic-bezier(0.34, 1.36, 0.64, 1)'

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function MobilePillBar({ items, activeIndex, ariaLabel }: {
  items: PillItem[]
  /** -1 when the current page is none of the items: the indicator is then not drawn at all. */
  activeIndex: number
  ariaLabel: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  /** The finger's x in the track's own coordinates while dragging; null at rest. */
  const [dragX, setDragX] = useState<number | null>(null)
  const press = useRef<{ id: number; x0: number; dragging: boolean; lastSlot: number } | null>(null)
  const suppressClick = useRef(false)
  const reduced = useRef(false)

  useEffect(() => { reduced.current = prefersReducedMotion() }, [])

  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = () => setWidth(el.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const count = items.length
  const localX = (clientX: number) => clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)
  const hoverSlot = dragX !== null ? slotAt(dragX, width, count) : -1
  const litIndex = hoverSlot >= 0 ? hoverSlot : activeIndex
  const showIndicator = width > 0 && (dragX !== null || activeIndex >= 0)
  const left = dragX !== null
    ? followOffset(dragX, width, count, INSET)
    : restOffset(Math.max(0, activeIndex), width, count, INSET)
  const slotW = count > 0 ? width / count : 0

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    press.current = { id: e.pointerId, x0: e.clientX, dragging: false, lastSlot: -1 }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    if (!p.dragging) {
      if (!isDrag(e.clientX - p.x0)) return
      p.dragging = true
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* already released */ }
    }
    const x = localX(e.clientX)
    const slot = slotAt(x, width, count)
    if (slot !== p.lastSlot) {
      // A tick as each item is crossed, where the platform has one (Android); iOS ignores it.
      if (p.lastSlot !== -1) { try { navigator.vibrate?.(6) } catch { /* not allowed */ } }
      p.lastSlot = slot
    }
    setDragX(x)
  }
  const endPress = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    press.current = null
    if (!p.dragging) return
    setDragX(null)
    // The browser still fires a click after a drag ends; it must not activate a second item.
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 350)
    if (commit) items[slotAt(localX(e.clientX), width, count)]?.onActivate()
  }

  return (
    <nav
      className="mobile-bottom-nav"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        zIndex: MOBILE_PILL_BAR_Z,
        borderRadius: 999,
        background: 'rgba(17, 17, 24, 0.84)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
        padding: INSET,
        // The bar owns horizontal movement on it: without this a drag scrolls or zooms the page.
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        // Height and bottom come from .mobile-bottom-nav (the pill plus the home-indicator inset).
      }}
    >
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={e => endPress(e, true)}
        onPointerCancel={e => endPress(e, false)}
        onClickCapture={e => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false } }}
        style={{ position: 'relative', display: 'flex', height: '100%' }}
      >
        {showIndicator && (
          <div
            aria-hidden
            style={{
              position: 'absolute', top: 0, bottom: 0, left: 0,
              width: Math.max(0, slotW - INSET * 2),
              borderRadius: 999,
              background: 'rgba(5, 5, 9, 0.9)',
              border: '1px solid rgba(255, 255, 255, 0.07)',
              transform: `translateX(${left}px) scale(${dragX !== null ? 1.06 : 1})`,
              transition: reduced.current
                ? 'none'
                : dragX !== null
                  ? 'transform 90ms linear'
                  : `transform 380ms ${SPRING}`,
              pointerEvents: 'none',
            }}
          />
        )}
        {items.map((item, i) => {
          const Icon = item.icon
          const lit = i === litIndex
          const crossing = dragX !== null && i === hoverSlot
          return (
            <button
              key={item.key}
              type="button"
              onClick={item.onActivate}
              aria-current={i === activeIndex ? 'page' : undefined}
              style={{
                position: 'relative', flex: 1, minWidth: 0, minHeight: 44,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 3, padding: '0 2px', border: 'none', background: 'transparent',
                color: lit ? ORANGE : IDLE, fontFamily: 'inherit', cursor: 'pointer',
                fontSize: 10.5, fontWeight: lit ? 700 : 500,
                transition: reduced.current ? 'none' : 'color 0.18s',
              }}
            >
              <span style={{
                display: 'inline-flex',
                transform: crossing ? 'translateY(-2px) scale(1.14)' : 'none',
                transition: reduced.current ? 'none' : `transform 220ms ${SPRING}`,
              }}>
                <Icon size={20} strokeWidth={lit ? 2.1 : 1.8} />
              </span>
              <span style={{ width: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
