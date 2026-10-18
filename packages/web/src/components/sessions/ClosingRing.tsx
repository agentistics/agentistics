/** The status dot of a session that is being closed: a small ring, turning (still under reduced motion). */
export function ClosingRing({ size = 8, label }: { size?: number; label: string }) {
  return (
    <span role="img" aria-label={label} title={label} data-closing-ring className="ag-closing-ring" style={{
      display: 'inline-block', width: size, height: size, flexShrink: 0, boxSizing: 'border-box', borderRadius: '50%',
      border: '1.5px solid color-mix(in srgb, var(--anthropic-orange) 28%, transparent)', borderTopColor: 'var(--anthropic-orange)',
    }} />
  )
}
