/**
 * FloatingPanelLayer — the windows a pinned panel becomes (`lib/floatingPanels.ts`).
 *
 * An absolutely positioned layer over the SESSION AREA (the centre region of the Sessions
 * workspace). It takes no pointer events of its own, so the conversation under it works wherever
 * no window sits; each window takes them back. The layer is its own stacking context, so a
 * window's `z` (1, 2, 3 …, as the store assigns it) orders the windows among themselves and never
 * competes with a modal or a full-screen panel elsewhere on the page.
 *
 * GEOMETRY IS NEVER DECIDED HERE — every rect goes through `restoreRect` (drawing), `moveRect`
 * (dragging) and `resizeRect` (resizing), which clamp to the area this layer MEASURES of itself.
 * A drag is kept locally while the pointer is down and written to the store once, on release, so a
 * drag costs one store write (and one server PUT) rather than one per pointer event.
 *
 * DRAGGED BY ITS HEADER. Every window carries a slim GRIP BAR on top (its panel's name and a grip),
 * which is always draggable — some panels fill their own header with controls edge to edge (the
 * Studio's toolbar), and a window you cannot grab is a window you cannot move. The panel's own
 * header row under it is draggable too wherever it is not interactive (`DRAG_ZONE`): a button in
 * the header is still a button. The cursor says so as the pointer crosses the zone.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GripHorizontal } from 'lucide-react'
import {
  moveRect, resizeRect, restoreRect, RESIZE_EDGES, stackOrder,
  type FloatingSet, type Rect, type ResizeEdge, type Size,
} from '../../lib/floatingPanels'
import type { PanelId } from '../../lib/panelSlots'

/** The grip bar every window carries on top (see the render). */
export const GRIP_BAR_H = 20
/** How tall the grab zone at the top of a window is — the grip bar plus a panel header row. */
export const DRAG_ZONE = GRIP_BAR_H + 38

/** Anything a press in the header must still reach as itself. */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"], .monaco-editor'

function inDragZone(win: HTMLElement, target: EventTarget | null, clientY: number): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(INTERACTIVE)) return false
  return clientY - win.getBoundingClientRect().top <= DRAG_ZONE
}

type Gesture =
  | { kind: 'move'; id: PanelId; start: Rect; x: number; y: number }
  | { kind: 'resize'; id: PanelId; edge: ResizeEdge; start: Rect; x: number; y: number }

const EDGE_CURSOR: Record<ResizeEdge, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}

/** Where each grip sits on the window's frame. Edges are thin strips; corners a larger square so
 *  they are easy to grab. They straddle the border, half outside. */
function gripStyle(edge: ResizeEdge): CSSProperties {
  const T = 6
  const C = 14
  const base: CSSProperties = { position: 'absolute', cursor: EDGE_CURSOR[edge], zIndex: 2, touchAction: 'none' }
  switch (edge) {
    case 'n': return { ...base, top: -T / 2, left: C / 2, right: C / 2, height: T }
    case 's': return { ...base, bottom: -T / 2, left: C / 2, right: C / 2, height: T }
    case 'e': return { ...base, right: -T / 2, top: C / 2, bottom: C / 2, width: T }
    case 'w': return { ...base, left: -T / 2, top: C / 2, bottom: C / 2, width: T }
    case 'ne': return { ...base, right: -C / 2, top: -C / 2, width: C, height: C }
    case 'nw': return { ...base, left: -C / 2, top: -C / 2, width: C, height: C }
    case 'se': return { ...base, right: -C / 2, bottom: -C / 2, width: C, height: C }
    case 'sw': return { ...base, left: -C / 2, bottom: -C / 2, width: C, height: C }
  }
}

export interface FloatingPanelLayerProps {
  windows: FloatingSet
  /** The panel's content — its own header included. */
  render: (id: PanelId) => ReactNode
  /** Accessible name for the window. */
  title: (id: PanelId) => string
  onRaise: (id: PanelId) => void
  onPlace: (id: PanelId, rect: Rect) => void
  /** Reports the area this layer measured, so a newly floated window can be sized for it. */
  onArea?: (area: Size) => void
}

export function FloatingPanelLayer({ windows, render, title, onRaise, onPlace, onArea }: FloatingPanelLayerProps) {
  const [area, setArea] = useState<Size>({ w: 0, h: 0 })
  const [live, setLive] = useState<{ id: PanelId; rect: Rect } | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const liveRef = useRef(live)
  liveRef.current = live
  const areaRef = useRef(area)
  areaRef.current = area

  const observer = useRef<ResizeObserver | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      const next = { w: Math.round(r.width), h: Math.round(r.height) }
      setArea(prev => (prev.w === next.w && prev.h === next.h ? prev : next))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    observer.current = ro
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  useEffect(() => { if (area.w > 0 && area.h > 0) onArea?.(area) }, [area, onArea])

  const end = useCallback(() => {
    const g = gesture.current
    gesture.current = null
    document.body.style.userSelect = ''
    const cur = liveRef.current
    setLive(null)
    if (g && cur && cur.id === g.id) onPlace(g.id, cur.rect)
  }, [onPlace])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = gesture.current
      if (!g) return
      const dx = e.clientX - g.x
      const dy = e.clientY - g.y
      const rect = g.kind === 'move'
        ? moveRect(g.start, dx, dy, areaRef.current)
        : resizeRect(g.start, g.edge, dx, dy, areaRef.current)
      liveRef.current = { id: g.id, rect }
      setLive(liveRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
    }
  }, [end])

  const begin = (g: Gesture) => {
    gesture.current = g
    document.body.style.userSelect = 'none'
    setLive({ id: g.id, rect: g.start })
  }

  const ready = area.w > 0 && area.h > 0
  return (
    <div
      ref={measure}
      data-floating-layer
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 30, isolation: 'isolate' }}
    >
      {ready && stackOrder(windows).map(id => {
        const stored = windows[id]!
        const rect = live && live.id === id ? live.rect : restoreRect(stored, area)
        return (
          <div
            key={id}
            role="dialog"
            aria-label={title(id)}
            data-floating-panel={id}
            onPointerDownCapture={() => onRaise(id)}
            onPointerDown={e => {
              if (e.button !== 0) return
              if (!inDragZone(e.currentTarget, e.target, e.clientY)) return
              e.preventDefault()
              begin({ kind: 'move', id, start: rect, x: e.clientX, y: e.clientY })
            }}
            onPointerMove={e => {
              if (gesture.current) return
              e.currentTarget.style.cursor = inDragZone(e.currentTarget, e.target, e.clientY) ? 'move' : ''
            }}
            style={{
              position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h,
              zIndex: stored.z, pointerEvents: 'auto',
              display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
              background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 14px 36px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.18)',
            }}
          >
            <div style={{
              flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
              overflow: 'hidden', borderRadius: 10,
            }}>
              {/* THE GRIP BAR — every window has one, whatever its panel draws below it. Some
                  panels fill their own header with controls edge to edge (the Studio's toolbar
                  is tabs, a search field and buttons), leaving no neutral pixel to grab; this
                  strip is the handle that always exists. */}
              <div
                data-drag-handle
                title={title(id)}
                onPointerDown={e => {
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  onRaise(id)
                  begin({ kind: 'move', id, start: rect, x: e.clientX, y: e.clientY })
                }}
                style={{
                  flexShrink: 0, height: GRIP_BAR_H, display: 'flex', alignItems: 'center', gap: 6,
                  padding: '0 10px', cursor: 'move', touchAction: 'none', userSelect: 'none',
                  borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated, var(--bg-surface))',
                  color: 'var(--text-tertiary)', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3,
                }}
              >
                <GripHorizontal size={13} style={{ flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {title(id)}
                </span>
              </div>
              {render(id)}
            </div>
            {RESIZE_EDGES.map(edge => (
              <div
                key={edge}
                data-resize={edge}
                aria-hidden
                onPointerDown={e => {
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  onRaise(id)
                  begin({ kind: 'resize', id, edge, start: rect, x: e.clientX, y: e.clientY })
                }}
                style={gripStyle(edge)}
              />
            ))}
          </div>
        )
      })}
      {/* While a window is being dragged, a shield over the whole area keeps a terminal canvas or
          an editor under the pointer from taking the events the drag needs. */}
      {live && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: gesture.current?.kind === 'resize' ? EDGE_CURSOR[gesture.current.edge] : 'move', zIndex: 100000 }} />}
    </div>
  )
}
