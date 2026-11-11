/**
 * SortControl — "sort by" for a list drawn as CARDS.
 *
 * A phone has no column headers to click, and the repository tab collapses to
 * a card per delivery there. This is the same three-state order those tables offer, reached through
 * one select and one direction button — both 44px. The select is the platform's own: on a phone that
 * is the touch-native picker (which is why this control is only ever drawn there), and `field()` gives
 * it the 16px type iOS Safari needs not to zoom the viewport, and the 44px height. The application's
 * `Select` popover is a desktop control — its trigger measured 34px tall on a phone.
 *
 * It owns no ordering: the parent holds the `SortSpec` and the cycle, exactly as for the headers.
 */

import { ArrowDown, ArrowUp } from 'lucide-react'
import type { SortDir } from '@agentistics/core'
import { button, field, microLabel } from './board'

export function SortControl<K extends string>({ label, options, current, onPick, onDir, defaultLabel, ascLabel, descLabel, mobile }: {
  /** "Sort by" — already in the reader's language. */
  label: string
  options: { key: K; label: string }[]
  current: { key: K; dir: SortDir } | null
  /** Choosing a key starts it ascending; choosing the "default order" row clears the sort. */
  onPick: (key: K | null) => void
  onDir: () => void
  defaultLabel: string
  ascLabel: string
  descLabel: string
  mobile: boolean
}) {
  const NONE = '__default__'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ ...microLabel, fontSize: 10.5, flexShrink: 0 }}>{label}</span>
      <select
        aria-label={label}
        value={current?.key ?? NONE}
        onChange={e => onPick(e.target.value === NONE ? null : e.target.value as K)}
        style={{ ...field(mobile), flex: 1, minWidth: 0, width: 'auto' }}
      >
        <option value={NONE}>{defaultLabel}</option>
        {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      {current && (
        <button
          type="button"
          onClick={onDir}
          title={current.dir === 'asc' ? ascLabel : descLabel}
          aria-label={current.dir === 'asc' ? ascLabel : descLabel}
          style={{ ...button(mobile), padding: '0 12px', minWidth: mobile ? 44 : undefined }}
        >
          {current.dir === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
        </button>
      )}
    </div>
  )
}
