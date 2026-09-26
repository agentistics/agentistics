/**
 * TopBar — the fixed strip along the top of the PAGE, to the right of the aside.
 *
 * The aside now runs the full height of the window and carries its own mark and collapse control
 * (`AsideHeader`), so this strip starts where the aside ends and holds only what the current
 * screen wants in it. It used to span the whole window with a left column standing over the aside,
 * which made the aside stop at the header instead of running to the top.
 *
 * There are deliberately no history arrows. They were tried, they duplicated the browser's own in
 * every context except an installed PWA, and they were removed.
 *
 * The SELECTED SESSION's title, view tabs and actions ride here, in `trailing`. It is deliberately
 * an opaque node rather than session-shaped props: this component knows about a strip and a slot,
 * and nothing about sessions. Absent is the normal case; the strip is then just the band.
 */

export interface TopBarProps {
  height: number
  /** The aside's current width; the strip starts exactly there. */
  asideWidth: number
  /**
   * Whatever the current screen wants in this strip. Absent on most screens, and absent is the
   * normal case — this is a place to put something, not a slot that must be filled.
   */
  trailing?: React.ReactNode
  /**
   * Give `trailing` exactly the box `<main>`'s content has, so a row drawn here can line up with the
   * body under it. The strip starts at the aside's edge, so it already IS that box — this only
   * drops the 9px decorative inset a title wants and a self-centring max-width row must not have.
   */
  trailingFlush?: boolean
}

export function TopBar({ height, asideWidth, trailing, trailingFlush = false }: TopBarProps) {
  return (
    <div
      style={{
        position: 'fixed', top: 0, left: asideWidth, right: 0, height, zIndex: 300,
        display: 'flex', alignItems: 'center', padding: 0, boxSizing: 'border-box',
        background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)',
        // Follows the aside's own fold, on the same curve `<main>`'s left padding uses.
        transition: 'left 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {/* `minWidth: 0` so a long session title truncates instead of pushing the strip wider than the
          window — the one thing a fixed full-width bar must never do. 9px, not 4: the title starts
          on the same vertical line as the content inside the session below it. FLUSH drops even
          that. */}
      {trailing && (
        <div style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
          paddingLeft: trailingFlush ? 0 : 9,
        }}>
          {trailing}
        </div>
      )}
    </div>
  )
}
