/**
 * StatTile.tsx — the KPI tile: one big figure over an uppercase caption.
 *
 * It existed TWICE, in RepoDetailPage and TagDetailPage, and the two copies had already drifted
 * into different failure modes for the same input: the repo one had no `overflow`, so a long value
 * was painted straight through the card's right edge; the tag one clipped it to an ellipsis. One
 * tile, one behaviour.
 *
 * Compact quantities use container sizing; descriptive values longer than 20 characters use a
 * readable 14px and wrap. A status sentence must never shrink to fit as if it were a number.
 */
import React from 'react'

/** The design size of the figure, and the ceiling `min()` never goes above. */
const BASE_PX = 18
/** Average advance per character, in em, for a bold digit in the UI font — with margin. */
const CHAR_EM = 0.62

export function statValueFontSize(value: string): string {
  const len = Math.max(value.length, 1)
  return `min(${BASE_PX}px, ${(100 / (len * CHAR_EM)).toFixed(2)}cqi)`
}

/**
 * The one column rule for a KPI strip. `150px` and not `120px`: at 120 a 430px phone fits three
 * tiles ~100px wide, which no money figure fits in at any legible size — the strip was three
 * columns of shrunken, wrapped numbers. Two wider tiles read better and, because nothing wraps
 * any more, cost no more height.
 */
export const STAT_TILE_GRID = 'repeat(auto-fit, minmax(150px, 1fr))'

export function StatTile({ label, value, accent, title }: {
  label: string
  value: string
  accent?: boolean
  title?: string
}) {
  const descriptive = value.length > 20
  return (
    <div
      title={title ?? value}
      style={{
        display: 'flex', flexDirection: 'column', gap: 3, padding: '11px 13px', minWidth: 0,
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        containerType: 'inline-size',
      }}
    >
      <span
        className="ag-stat-value"
        style={{
          fontSize: descriptive ? 14 : statValueFontSize(value),
          fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums',
          color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
          whiteSpace: descriptive ? 'normal' : 'nowrap', overflowWrap: 'anywhere',
          overflow: descriptive ? undefined : 'hidden', textOverflow: descriptive ? undefined : 'ellipsis',
        }}
      >{value}</span>
      <span style={{
        fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase',
        letterSpacing: '0.05em', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.4,
      }}>{label}</span>
    </div>
  )
}
