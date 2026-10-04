/**
 * ViewBar — the ONE view control every task screen draws: "Filter · Group · Columns · Sort".
 *
 * The table, the subtask grid and the kanban each used to carry their own row of separate buttons
 * (a filter here, a group picker there, a sort chip that only appeared once it was not the default),
 * each opening its own differently-shaped panel. They are segments of one bar now, with the look of
 * `nav/ModeSwitch` (an elevated trough, the active segment on the surface colour), and every segment
 * opens the EXISTING menu content in the SAME portal panel (`PickerMenu.tsx`'s `PanelMenu`).
 *
 * This file owns only the SHAPE: the trough, the segment style a menu trigger wears, and the sort
 * menu (the one panel the old toolbars had no single control for). What each segment filters, groups
 * or orders stays with the screen that owns that state — nothing here decides anything.
 */

import type { CSSProperties, ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { SortDir } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { microLabel } from './board'
import { PanelMenu } from './PickerMenu'

/** The trough. Wraps on a phone rather than overflowing: four segments are ~320px at 12.5px. */
export function ViewBar({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 2, padding: 3, borderRadius: 10,
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        maxWidth: '100%', boxSizing: 'border-box', flexWrap: 'wrap',
      }}
    >{children}</div>
  )
}

/**
 * What a menu trigger wears to be a segment. `active` = this segment has been moved off its
 * default (a narrowed filter, a non-default order) and reads as the selected one, exactly like the
 * current mode in ModeSwitch.
 */
export const viewSegment = (mobile: boolean, active = false): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  // 44px is the MOBILE number; the desktop bar stays a bar, not a row of buttons.
  minHeight: mobile ? 44 : 28, padding: '0 11px', borderRadius: 8, border: 'none',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, whiteSpace: 'nowrap',
  fontWeight: active ? 700 : 500,
  background: active ? 'var(--bg-surface)' : 'transparent',
  color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
  transition: 'background 0.15s, color 0.15s',
})

/** The narrow-count bubble ModeSwitch draws on a segment (a filter's active dimensions). */
export const segmentBadge: CSSProperties = {
  minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, fontSize: 10, fontWeight: 700,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--anthropic-orange)', color: '#fff', lineHeight: 1,
}

export interface SortOption<K extends string> { key: K; label: string }

/**
 * The "Sort" segment. One panel: the default order, then every sortable key. Pressing the current
 * key flips its direction (the second half of the same gesture, so there is no separate up/down
 * control to find), pressing another starts it ascending, and the first row clears the sort.
 */
export function ViewSortMenu<K extends string>({
  label, title, options, current, onChange, defaultLabel, ascLabel, descLabel, note, width = 230,
}: {
  /** The segment's words. */
  label: string
  title: string
  options: readonly SortOption<K>[]
  current: { key: K; dir: SortDir } | null
  /** `null` = back to the screen's own default order. */
  onChange: (next: { key: K; dir: SortDir } | null) => void
  defaultLabel: string
  ascLabel: string
  descLabel: string
  note?: string
  width?: number
}) {
  const isMobile = useIsMobile()
  const row = (on: boolean): CSSProperties => ({
    display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', width: '100%',
    padding: '6px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
    minHeight: isMobile ? 44 : 28,
  })
  return (
    <PanelMenu
      title={title}
      width={width}
      triggerStyle={viewSegment(isMobile, current !== null)}
      render={close => (
        <>
          <button type="button" onClick={() => { onChange(null); close() }} style={row(current === null)}>
            <span style={{ flex: 1 }}>{defaultLabel}</span>
          </button>
          {options.map(o => {
            const on = current?.key === o.key
            return (
              <button
                key={o.key} type="button"
                onClick={() => onChange(on
                  ? { key: o.key, dir: current!.dir === 'asc' ? 'desc' : 'asc' }
                  : { key: o.key, dir: 'asc' })}
                style={row(on)}
              >
                <span style={{ flex: 1 }}>{o.label}</span>
                {on && (
                  <span aria-label={current!.dir === 'asc' ? ascLabel : descLabel} style={{ display: 'flex' }}>
                    {current!.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  </span>
                )}
              </button>
            )
          })}
          {note && (
            <div style={{ ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 8px', lineHeight: 1.5 }}>
              {note}
            </div>
          )}
        </>
      )}
    >{label}</PanelMenu>
  )
}
