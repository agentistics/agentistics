import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { barFollow, barSlotAt, barSlots, isDrag } from '../../lib/bottomNavDrag'
import { SOLID_COUNT } from './countBadge'
import { MOBILE_PILL_BAR_Z } from '../../lib/zLayers'

/**
 * THE MOBILE BOTTOM BAR — three pieces, as the owner drew it: a LEFT pill, a standalone ROUND
 * centre button, a RIGHT pill. The pills' inner ends are concave, curving around the circle with an
 * even gap (a radial mask, so the shape is the same at every width).
 *
 * The active slot wears a large soft pill behind its icon AND label; when the centre button is the
 * active one the circle itself carries the fill. Two ways to move: TAP an item, or press anywhere
 * on the bar and DRAG — the indicator follows the finger inside the pill it is over, the circle
 * lights when the finger is over it, and letting go activates what is under the finger. The
 * arithmetic is `lib/bottomNavDrag.ts` (pure, tested).
 *
 * Surfaces come from the theme tokens, so the bar follows light and dark.
 */

export interface PillItem {
  key: string
  label: string
  icon: LucideIcon
  onActivate: () => void
  ariaLabel?: string
  expanded?: boolean
  hasPopup?: 'dialog'
  badge?: number
}

/** Gap between the indicator and the edges of its slot. */
const INSET = 4
/** The round button, and the even gap kept between it and the pills' concave ends. */
const CIRCLE = 58
/** Width of the spacer the circle sits in; the circle is wider, so it bites into each pill. */
const SPACER = 40
/** Padding inside a pill: small at the outer end, wider where the concave bite is. */
const PAD_OUT = 4
const PAD_IN = 18
const ORANGE = 'var(--anthropic-orange)'
const SPRING = 'cubic-bezier(0.34, 1.36, 0.64, 1)'
const SURFACE = 'var(--bg-card)'
const CIRCLE_SHADOW = '0 2px 8px rgba(0, 0, 0, 0.25)'

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function MobilePillBar({ items, activeIndex, centerIndex, ariaLabel }: {
  /** Left pill items, then the centre button, then the right pill items. */
  items: PillItem[]
  /** Which item is the standalone round button. */
  centerIndex: number
  /** -1 when the current page is none of the items: nothing is then drawn as active. */
  activeIndex: number
  ariaLabel: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(64)
  /** The finger's x in the track's own coordinates while dragging; null at rest. */
  const [dragX, setDragX] = useState<number | null>(null)
  const press = useRef<{ id: number; x0: number; y0: number; dragging: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [reduced, setReduced] = useState(prefersReducedMotion)

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const sync = () => setReduced(media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = () => { const r = el.getBoundingClientRect(); setWidth(r.width); if (r.height > 0) setHeight(r.height) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const leftCount = centerIndex
  const rightCount = items.length - centerIndex - 1
  const slots = barSlots(width, SPACER, leftCount, rightCount, PAD_OUT, PAD_IN)
  const localX = (clientX: number) => clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)
  const hoverSlot = dragX !== null ? barSlotAt(dragX, slots) : -1
  const litIndex = hoverSlot >= 0 ? hoverSlot : activeIndex
  const indicatorSlot = slots[litIndex]
  const showIndicator = width > 0 && !!indicatorSlot && indicatorSlot.kind !== 'centre'
  const indicatorLeft = dragX !== null && hoverSlot >= 0
    ? barFollow(dragX, slots, INSET)
    : (indicatorSlot ? indicatorSlot.left + INSET : 0)
  const withinBar = (y: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    return !!rect && y >= rect.top && y <= rect.bottom
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    press.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dragging: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    if (!p.dragging) {
      if (!isDrag(e.clientX - p.x0) && !isDrag(e.clientY - p.y0)) return
      p.dragging = true
    }
    if (!withinBar(e.clientY)) { setDragX(null); return }
    setDragX(localX(e.clientX))
  }
  const endPress = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    press.current = null
    if (!p.dragging) return
    setDragX(null)
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 350)
    if (commit && withinBar(e.clientY)) items[barSlotAt(localX(e.clientX), slots)]?.onActivate()
  }

  const slotButton = (item: PillItem, i: number) => {
    const Icon = item.icon
    const lit = i === litIndex
    const crossing = dragX !== null && i === hoverSlot
    return (
      <button
        key={item.key}
        type="button"
        onClick={item.onActivate}
        aria-label={item.ariaLabel}
        aria-expanded={item.expanded}
        aria-haspopup={item.hasPopup}
        aria-current={item.expanded === undefined && i === activeIndex ? 'page' : undefined}
        style={{
          position: 'relative', flex: 1, minWidth: 0, minHeight: 44,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 3, padding: '0 2px', border: 'none', background: 'transparent',
          color: lit ? ORANGE : 'var(--text-secondary)', fontFamily: 'inherit', cursor: 'pointer',
          fontSize: 10.5, fontWeight: lit ? 700 : 500,
          transition: reduced ? 'none' : 'color 0.18s',
        }}
      >
        <span style={{
          position: 'relative', display: 'inline-flex',
          transform: crossing && !reduced ? 'translateY(-2px) scale(1.14)' : 'none',
          transition: reduced ? 'none' : `transform 220ms ${SPRING}`,
        }}>
          <Icon size={20} strokeWidth={lit ? 2.1 : 1.8} />
          {item.badge !== undefined && item.badge > 0 && <span data-area-badge style={{
            position: 'absolute', top: -7, left: 'calc(100% - 4px)', minWidth: 18, height: 18, padding: '0 4px',
            borderRadius: 9, ...SOLID_COUNT, fontSize: 11, fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>{item.badge}</span>}
        </span>
        <span style={{ width: '100%', minWidth: 0, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label}
        </span>
      </button>
    )
  }

  const circle = (item: PillItem, i: number) => {
    const Icon = item.icon
    const lit = i === litIndex
    const Badge = item.badge !== undefined && item.badge > 0
    return (
      <div key={item.key} data-bar-centre style={{ position: 'relative', flex: `0 0 ${SPACER}px`, alignSelf: 'stretch' }}>
        <button
          type="button"
          onClick={item.onActivate}
          aria-label={item.ariaLabel ?? item.label}
          aria-current={i === activeIndex ? 'page' : undefined}
          style={{
            position: 'absolute', left: '50%', top: '50%', width: CIRCLE, height: CIRCLE, borderRadius: '50%',
            transform: `translate(-50%, -50%) scale(${lit && dragX !== null && !reduced ? 1.06 : 1})`,
            transition: reduced ? 'none' : `transform 220ms ${SPRING}, border-color 0.18s`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer',
            color: lit ? ORANGE : 'var(--text-secondary)', fontFamily: 'inherit',
            background: lit
              ? 'linear-gradient(var(--anthropic-orange-dim), var(--anthropic-orange-dim)), var(--bg-card)'
              : SURFACE,
            border: `1.5px solid ${lit ? ORANGE : 'var(--border)'}`,
            boxShadow: CIRCLE_SHADOW,
          }}
        >
          <Icon size={26} strokeWidth={lit ? 2.1 : 1.8} />
        </button>
        {/* Above the right pill: that pill is drawn after the circle and used to cover the count. */}
        {Badge && <span data-area-badge style={{
          position: 'absolute', zIndex: 2, top: 'calc(50% - 38px)', left: `calc(50% + ${CIRCLE / 2 - 4}px)`,
          minWidth: 18, height: 18, padding: '0 4px', borderRadius: 9, ...SOLID_COUNT,
          fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>{item.badge}</span>}
      </div>
    )
  }

  /**
   * One pill's outline as a PATH, so the border is the path's own stroke and follows the curve: a
   * rounded outer end, and an inner end that is an arc of the circle centred on the round button,
   * running corner to corner so the gap around the circle is even.
   */
  const pillLayer = (side: 'left' | 'right') => {
    const W = Math.max(0, (width - SPACER) / 2)
    const H = height
    const r = H / 2
    const R = Math.hypot(SPACER / 2, H / 2)
    const d = side === 'left'
      ? `M ${r} 0 H ${W} A ${R} ${R} 0 0 0 ${W} ${H} H ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`
      : `M 0 0 H ${W - r} A ${r} ${r} 0 0 1 ${W - r} ${H} H 0 A ${R} ${R} 0 0 0 0 0 Z`
    return (
      <svg aria-hidden data-bar-pill={side} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', filter: 'drop-shadow(0 6px 10px rgba(0, 0, 0, 0.22))' }}>
        <path d={d} fill={SURFACE} stroke="var(--border)" strokeWidth={1} strokeLinejoin="round" />
      </svg>
    )
  }
  const group = (side: 'left' | 'right', from: number, to: number) => (
    <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
      {pillLayer(side)}
      <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0, padding: side === 'left' ? `0 ${PAD_IN}px 0 ${PAD_OUT}px` : `0 ${PAD_OUT}px 0 ${PAD_IN}px` }}>
        {items.slice(from, to).map((item, k) => slotButton(item, from + k))}
      </div>
    </div>
  )

  return (
    <nav
      className="mobile-bottom-nav"
      aria-label={ariaLabel}
      style={{
        position: 'fixed', left: 12, right: 12, zIndex: MOBILE_PILL_BAR_Z,
        touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
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
        {group('left', 0, centerIndex)}
        {circle(items[centerIndex]!, centerIndex)}
        {group('right', centerIndex + 1, items.length)}
        {showIndicator && indicatorSlot && (
          <div
            aria-hidden
            data-bar-indicator
            style={{
              position: 'absolute', top: INSET, bottom: INSET, left: 0,
              width: Math.max(0, indicatorSlot.width - INSET * 2),
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--anthropic-orange) 16%, transparent)',
              transform: `translateX(${indicatorLeft}px) scale(${dragX !== null && !reduced ? 1.04 : 1})`,
              transition: reduced
                ? 'none'
                : dragX !== null
                  ? 'transform 90ms linear'
                  : `transform 380ms ${SPRING}`,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </nav>
  )
}
