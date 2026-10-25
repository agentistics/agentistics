import type { CSSProperties } from 'react'

/** Shared geometry for counts in workspace/aside tabs and the list's overflow trigger. */
export const COUNT_BADGE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box', borderRadius: 8,
  fontSize: 10, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
}

/**
 * A solid count that calls for attention (area badges in the tree, the rail and the phone's bar).
 * Dark ink on the accent, never white: white on the orange is ~3:1 (#D97706) and ~2.8:1 (#f97316),
 * dark ink is ≥ 6:1 in both themes. Never combine with `ag-attn-count`, which animates the TEXT
 * colour towards the accent — on this ground that made the number disappear (QA r3).
 */
export const SOLID_COUNT: CSSProperties = { background: 'var(--anthropic-orange)', color: '#0a0a0f' }
