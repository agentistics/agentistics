/**
 * PanelGap — the floating-panel workspace's ONE resize-handle-as-a-gap component (see `sdd/brief.md`
 * and `lib/panelLayout.ts`). A gap between two panels is BOTH the only visible divider and the drag
 * handle for the boundary it sits on: three dots at rest, brighter on hover/drag, plus a thin accent
 * line — matching the reference grip (`sdd/b6a3778b-image.png`) and the approved mockup's hover
 * treatment.
 *
 * This component owns the POINTER GESTURE (track the start position, resolve the delta through
 * `applyAxisDrag`, call back) but NEVER a limit — `min`/`max` are handed in by the caller, which
 * reads them from whichever axis-specific module already owns them (`asideWidth.ts`'s
 * `clampAsideWidth`, `artifactLayout.ts`'s panel-width clamp, `shellBand.ts`'s
 * `resolveBandDrag`/`resolveBandHeight`), so no limit is ever re-implemented here. This is what
 * "reuse the existing min/max, clamping, snapping and persistence exactly — only the hit area and
 * the visuals move into the gap" means in code.
 */

import { useCallback, useEffect, useRef } from 'react'
import { applyAxisDrag } from '../../lib/panelLayout'

export const PANEL_GAP_PX = 6

export interface PanelGapProps {
  orientation: 'vertical' | 'horizontal'
  label: string
  /** A stable DOM id — used only so a T-junction (`PanelJunction`, below) can find THIS gap's real
   *  element and replay a synthetic `mousedown` on it at the drag's own start position, arming its
   *  window-level listener exactly as a genuine press would. Optional: a lone gap with no junction
   *  beside it never needs one. */
  id?: string
  /** The size in force right now (width for a vertical gap, height for a horizontal one). */
  value: number
  min: number
  max: number
  /** Which way the POINTER has to move to GROW this axis — `+1` when the panel being resized sits
   *  on the pointer-origin side (a left list's own right edge, or a band growing upward on a
   *  smaller `clientY`), `-1` for the mirror case (a right aside's left edge). */
  sign: 1 | -1
  onChange: (next: number) => void
  /** Fired once on drag end, so the caller persists a single value rather than on every move. */
  onCommit?: (next: number) => void
  /** The keyboard step (`ArrowLeft`/`ArrowRight` for a vertical gap, `ArrowUp`/`ArrowDown` for a
   *  horizontal one) — same convention `AsideResizer` already uses. */
  step?: number
  /** Absent when this gap has nothing to move right now — the caller may simply not render it, but
   *  some callers keep the element mounted (for layout stability) and gate the gesture instead. */
  disabled?: boolean
  /**
   * Extra styles merged onto the root, AFTER the defaults — used by callers that place this
   * component inside an absolutely-positioned overlay of their own (the left/right aside gaps,
   * which must sit OUTSIDE their panel's `overflow: hidden` clip) and need it to stretch to fill
   * that overlay's box rather than sizing itself as an ordinary flex sibling.
   */
  style?: React.CSSProperties
}

export function PanelGap({
  orientation, label, id, value, min, max, sign, onChange, onCommit, step = 16, disabled = false, style,
}: PanelGapProps) {
  const dragging = useRef(false)
  const start = useRef({ pointer: 0, value })
  const latest = useRef(value)
  latest.current = value

  const resolve = useCallback((clientPos: number) => {
    const delta = clientPos - start.current.pointer
    return applyAxisDrag(start.current.value, delta, sign, min, max)
  }, [sign, min, max])

  useEffect(() => {
    if (disabled) return
    const move = (e: MouseEvent) => {
      if (!dragging.current) return
      const next = resolve(orientation === 'vertical' ? e.clientX : e.clientY)
      latest.current = next
      onChange(next)
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onCommit?.(latest.current)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    // `onChange`/`onCommit` are read fresh each render via closure capture is unnecessary here since
    // this effect re-subscribes whenever any of its own reactive inputs change; kept minimal on
    // purpose (the same shape `AsideResizer` already uses).
  }, [disabled, orientation, resolve, onChange, onCommit])

  const onMouseDown = (e: React.MouseEvent) => {
    if (disabled) return
    e.preventDefault()
    dragging.current = true
    start.current = { pointer: orientation === 'vertical' ? e.clientX : e.clientY, value }
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    // The RAW physical direction — ArrowRight/ArrowDown is a positive delta, exactly as a mouse
    // moving right/down is — and `applyAxisDrag`'s own `sign` resolves it into a grow or a shrink
    // the identical way the pointer drag above does. Never branch on `sign` here separately: doing
    // so would be a second place this axis's direction convention could drift from the drag's own.
    const positiveKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    const negativeKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const delta = e.key === positiveKey ? step : e.key === negativeKey ? -step : 0
    if (delta !== 0) {
      e.preventDefault()
      const next = applyAxisDrag(value, delta, sign, min, max)
      onChange(next)
      onCommit?.(next)
      return
    }
    if (e.key === 'Home') { e.preventDefault(); onChange(min); onCommit?.(min) }
    if (e.key === 'End') { e.preventDefault(); onChange(max); onCommit?.(max) }
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={disabled ? -1 : 0}
      className="ag-panel-gap"
      {...(id ? { id } : {})}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      style={{
        position: 'relative', flexShrink: 0, background: 'transparent',
        ...(orientation === 'vertical'
          ? { width: PANEL_GAP_PX, cursor: disabled ? 'default' : 'col-resize' }
          : { height: PANEL_GAP_PX, cursor: disabled ? 'default' : 'row-resize' }),
        zIndex: 4,
        ...style,
      }}
    >
      <PanelGapDots orientation={orientation} />
    </div>
  )
}

/**
 * PanelGapDots — the literal three-dot grip (brief: "Three dots centred in every gap: vertical dots
 * (⋮) in vertical gaps, horizontal dots (⋯) in the horizontal gap"), plus the mockup's own thin
 * accent line on hover/drag (`.ag-panel-gap` CSS, `index.css`). `pointer-events: none` throughout —
 * this decoration never steals the drag from the gap's own hit area.
 */
export function PanelGapDots({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  return (
    <span
      aria-hidden="true"
      className="ag-panel-gap-dots"
      style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        display: 'flex', flexDirection: orientation === 'vertical' ? 'column' : 'row', gap: 2,
        pointerEvents: 'none',
      }}
    >
      {[0, 1, 2].map(i => <span key={i} className="ag-panel-gap-dot" />)}
    </span>
  )
}

/**
 * armGap — replays a synthetic `mousedown` on a REAL gap's own DOM element, at the exact pointer
 * position a genuine press on it would have used, so that gap's own `window`-level `mousemove`/
 * `mouseup` listeners (`PanelGap`'s own effect, above, and `useBandDrag`'s — `bandControls.tsx`)
 * arm themselves precisely as they would from a direct press. This is how a T-junction drags TWO
 * boundaries — the band's height and an aside's width — from ONE pointer gesture, WITHOUT this
 * module re-implementing either boundary's own clamp, snap-to-full or persistence: the two gaps a
 * junction sits between keep being the ONLY code that ever resizes them, so a junction drag and an
 * ordinary drag on either gap alone can never disagree about what is allowed. The subsequent REAL
 * `mousemove`/`mouseup` events reach both armed listeners the same way any window-level listener
 * receives them — this function only ever needs to fire once, at the junction's own `mousedown`.
 */
export function armGap(id: string, e: { clientX: number; clientY: number }): void {
  const el = document.getElementById(id)
  if (!el) return
  el.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
  }))
}

/**
 * PanelJunction — the T-junction's own square hot zone (brief: "a square hot zone ... `cursor:
 * move` drags BOTH boundaries at once"). Renders NOTHING of its own beyond the cursor and the hit
 * area — the two gaps it overlaps already draw their own dots, and a THIRD mark at the exact point
 * they cross would be visual noise rather than a third piece of information.
 *
 * Positioned with `position: fixed` at the caller's own `left`/`top` (viewport pixels — the
 * crossing point of the two real gaps it sits between, which the caller measures because it is the
 * one place that knows where BOTH of them are; see `SessionsPage.tsx`'s `useJunctionPoint`). This
 * component holds no geometry of its own beyond the square it draws.
 *
 * `onDown` fires ONCE, synchronously, at the very start of the press — the caller's one chance to
 * call `armGap` for each of the two real boundaries this junction crosses (see that function's own
 * header for why arming, not `applyJunctionDrag`, is what actually moves both boundaries). This
 * component tracks nothing else: once armed, the two real gaps' own listeners do the rest.
 */
export function PanelJunction({
  label, size, left, top, onDown,
}: {
  label: string
  /** The square's own side, in px — see `junctionHitRect` for how the caller sized it. */
  size: number
  /** The crossing point, in viewport pixels — see `SessionsPage.tsx`'s own measuring effect. */
  left: number
  top: number
  onDown: (e: { clientX: number; clientY: number }) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={-1}
      className="ag-panel-junction"
      onMouseDown={e => { e.preventDefault(); onDown(e) }}
      style={{
        position: 'fixed', left, top, width: size, height: size,
        transform: 'translate(-50%, -50%)', cursor: 'move',
        // Higher than every stacking context this workspace draws, INCLUDING `App.tsx`'s own
        // `SideNav` (`zIndex: 200`) — the bottom-left junction sits right where that aside's own
        // gap ends, and `position: fixed` establishes its OWN stacking context whose z-index is
        // compared against the SideNav's at whatever ancestor level the two are siblings, not
        // against the gap's own `4` directly. Measured live: at `zIndex: 6` the SideNav's subtree
        // painted OVER this junction and a press there landed on the plain aside gap underneath —
        // the aside moved, the band never armed.
        zIndex: 700,
      }}
    />
  )
}
