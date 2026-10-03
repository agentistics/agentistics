/**
 * ColResizeHandle — the draggable border on a column header.
 *
 * Pointer events with capture, so the drag survives leaving the 6px strip and works for mouse,
 * touch and pen alike. The width is reported LIVE through `onChange` (the caller keeps it in local
 * state) and committed once on release through `onCommit`, so one drag is one saved write rather
 * than a PUT per pixel. Double-click asks the caller to fit the content. On a phone the strip is
 * wider (touch target) and sits inside the header, so the page never scrolls sideways for it.
 */
import { useRef } from 'react'
import { dragWidth } from './columnWidths'

export function ColResizeHandle({ width, onChange, onCommit, onFit, title, mobile }: {
  /** The column's current width — read at the start of a drag. */
  width: number
  onChange: (w: number) => void
  onCommit: (w: number) => void
  onFit: () => void
  title: string
  mobile: boolean
}) {
  const start = useRef<{ x: number; w: number; last: number } | null>(null)
  const rtl = typeof document !== 'undefined' && document.dir === 'rtl'
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      title={title}
      data-col-resize
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => { e.stopPropagation(); onFit() }}
      onPointerDown={e => {
        e.preventDefault(); e.stopPropagation()
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width, last: width }
      }}
      onPointerMove={e => {
        const s = start.current
        if (!s) return
        const w = dragWidth(s.w, s.x, e.clientX, rtl)
        s.last = w
        onChange(w)
      }}
      onPointerUp={e => {
        const s = start.current
        start.current = null
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* already released */ }
        if (s && s.last !== s.w) onCommit(s.last)
      }}
      onPointerCancel={() => { start.current = null }}
      style={{
        position: 'absolute', top: 0, bottom: 0, insetInlineEnd: 0, width: mobile ? 14 : 8,
        cursor: 'col-resize', touchAction: 'none', userSelect: 'none', zIndex: 2,
        display: 'flex', justifyContent: 'center',
      }}
    >
      <span style={{ width: 1, height: '60%', alignSelf: 'center', background: 'var(--border)' }} />
    </span>
  )
}
