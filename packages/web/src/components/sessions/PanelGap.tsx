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
  orientation, label, value, min, max, sign, onChange, onCommit, step = 16, disabled = false, style,
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
 * PanelJunction — the T-junction's own square hot zone (brief: "a square hot zone ... `cursor:
 * move` drags BOTH boundaries at once"). Renders NOTHING of its own beyond the cursor and the hit
 * area — the two gaps it overlaps already draw their own dots, and a THIRD mark at the exact point
 * they cross would be visual noise rather than a third piece of information.
 *
 * `onDrag` receives the pointer's OWN raw delta since the gesture began; the caller resolves it
 * through `applyJunctionDrag` (`lib/panelLayout.ts`) against each boundary's own start/sign/limits,
 * so this component holds no clamping of its own.
 */
export function PanelJunction({
  label, size, onDrag, onCommit,
}: {
  label: string
  /** The square's own side, in px — see `junctionHitRect` for how the caller sized it. */
  size: number
  onDrag: (dx: number, dy: number) => void
  onCommit?: () => void
}) {
  const dragging = useRef(false)
  const origin = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return
      onDrag(e.clientX - origin.current.x, e.clientY - origin.current.y)
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onCommit?.()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [onDrag, onCommit])

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={-1}
      className="ag-panel-junction"
      onMouseDown={e => {
        e.preventDefault()
        dragging.current = true
        origin.current = { x: e.clientX, y: e.clientY }
        document.body.style.cursor = 'move'
        document.body.style.userSelect = 'none'
      }}
      style={{
        position: 'absolute', width: size, height: size,
        transform: 'translate(-50%, -50%)', cursor: 'move', zIndex: 5,
      }}
    />
  )
}
