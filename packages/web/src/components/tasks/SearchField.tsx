/**
 * SearchField — the search box every task screen draws: a magnifier inside a `field()` input.
 *
 * It was inlined in `AgentaskToolbar`; the Live columns need the same box, and a second hand-rolled copy is
 * how two searches come to look like two products. The toolbar and the Live column both render this.
 */

import type { CSSProperties } from 'react'
import { Search } from 'lucide-react'
import { field } from './board'

export function SearchField({ value, onChange, placeholder, ariaLabel, mobile, style, inputProps }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  ariaLabel?: string
  mobile: boolean
  /** The wrapper's own layout (flex basis, width). */
  style?: CSSProperties
  inputProps?: Record<string, string | number | boolean | undefined>
}) {
  return (
    <div style={{ position: 'relative', minWidth: 0, ...style }}>
      <Search size={14} aria-hidden style={{ position: 'absolute', left: 11, top: mobile ? 15 : 9, color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
      <input
        aria-label={ariaLabel ?? placeholder} style={{ ...field(mobile), paddingLeft: 32, ...(mobile ? {} : { height: 32 }) }}
        value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
        {...inputProps}
      />
    </div>
  )
}
