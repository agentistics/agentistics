import type { CSSProperties } from 'react'

/** Shared geometry for counts in workspace/aside tabs and the list's overflow trigger. */
export const COUNT_BADGE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box', borderRadius: 8,
  fontSize: 10, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
}
