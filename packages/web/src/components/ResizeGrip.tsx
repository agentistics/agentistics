/**
 * ResizeGrip — the small pill that marks a draggable edge (design item 6, owner's screenshots: red
 * boxes on the vertical divider between the chat and the right aside, and on the bottom band's top
 * edge — "it is not obvious it can be dragged").
 *
 * ONE component for every resizable edge in the sessions workspace: the vertical divider between the
 * centre column and the right aside (`SessionsPage.tsx`), the bottom band's top edge (`ShellBand.tsx`
 * / `SessionPanel.tsx`'s `StudioBand`), and the Studio's own tree/editor divider (`Studio.tsx`). A
 * second hand-rolled pill at any of those sites is exactly the drift `bandControls.tsx` already
 * exists to close for the band's own buttons.
 *
 * IDLE = subtle grey (`--border-subtle`, already theme-aware in both palettes — see `index.css`'s own
 * dark-mode block); HOVER OR AN ACTIVE DRAG = the accent. That reading is a CSS pseudo-class
 * (`.ag-resize-handle:hover`/`:active`/`:focus-visible`, `index.css`), not JS state: `:active` on a
 * plain element stays applied for as long as the mouse button is held down, even once the pointer
 * drifts off a 4px-wide strip mid-drag, which is exactly the case a hover-only reading would lose.
 *
 * The grip itself is `pointer-events: none` and adds NO size of its own — it paints on top of
 * whichever handle already owns the hit area (unchanged, per the design: "hit area unchanged or
 * larger; never narrower"). The caller supplies `.ag-resize-handle` on that same element so the CSS
 * above has something to key its hover/active state off; this component only needs to know which way
 * to draw the pill.
 */

export function ResizeGrip({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  const THICKNESS = 4
  const LENGTH = 28
  return (
    <span
      aria-hidden="true"
      className="ag-resize-grip"
      style={orientation === 'vertical'
        ? { width: THICKNESS, height: LENGTH, transform: 'translate(-50%, -50%)' }
        : { width: LENGTH, height: THICKNESS, transform: 'translate(-50%, -50%)' }}
    />
  )
}
