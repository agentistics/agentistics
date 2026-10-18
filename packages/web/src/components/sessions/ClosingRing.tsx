/** The status dot of a session that is being closed: a small ring, turning (still under reduced motion). */
export function ClosingRing({ size = 12, label }: { size?: number; label: string }) {
  return (
    <span role="img" aria-label={label} title={label} data-closing-ring className="ag-closing-ring" style={{
      display: 'inline-block', width: size, height: size, flexShrink: 0, margin: '0 -2px', boxSizing: 'border-box', borderRadius: '50%',
      border: '2px solid color-mix(in srgb, var(--text-secondary) 45%, transparent)', borderTopColor: 'var(--anthropic-orange)', borderRightColor: 'var(--anthropic-orange)',
    }} />
  )
}
