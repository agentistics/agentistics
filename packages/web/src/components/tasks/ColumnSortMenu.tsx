/**
 * ColumnSortMenu — the kanban column's TITLE, as the control that orders that column.
 *
 * A table column has one thing to sort by, so its title can be the button. A kanban column holds the
 * same kind of card top to bottom and the choice is WHICH property to order them by, so the title
 * opens a small menu of the keys the board offers (`BOARD_SORTS`, the very list the board's own
 * picker shows), each cycling ascending → descending → back to hand order exactly like a table
 * header. The arrow shows on the key in force, and a column that has been given an order of its own
 * says so on its title ("Cost ↓") — an order you cannot see once the menu is shut is the same defect
 * as a filter you forgot you set.
 *
 * It decides nothing about the ordering: `columnSort.ts` owns what a pick means and `taskSort.ts`
 * owns how a spec sorts. This file draws the trigger and the panel, and keeps the panel out of the
 * way the way `BoardArrange`'s panels do — fixed, in a portal, closing on scroll, so no ancestor's
 * overflow can clip it and it never drifts away from the title it belongs to.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowDownUp, ArrowUp } from 'lucide-react'
import type { SortKey, SortSpec } from '@agentistics/core'
import { scrollIsOutside } from '../../lib/popoverScroll'
import { microLabel, surface } from './board'

export function ColumnSortMenu({ title, color, sort, overridden, options, onPick, onClear, tooltip, followLabel, isMobile }: {
  /** The status word the header prints — already in the reader's language. */
  title: string
  color: string
  /** The order the column is drawn in NOW (its own, else the board's). */
  sort: SortSpec
  /** Has THIS column been given an order of its own? */
  overridden: boolean
  options: Array<{ key: SortKey; label: string }>
  onPick: (key: SortKey) => void
  /** Give the column back to the board's order. */
  onClear: () => void
  tooltip: string
  /** "Default order" — the row that drops the column's own order. */
  followLabel: string
  isMobile: boolean
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  // The panel is portaled into `document.body`, so a capture-phase `window` scroll listener also
  // fires when the panel's OWN option list scrolls — closing on that made options past the fold
  // unreachable. Only a scroll outside the panel closes it.
  useEffect(() => {
    if (!at) return
    const close = () => setAt(null)
    const onScroll = (e: Event) => {
      if (scrollIsOutside(panel.current, e.target)) close()
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', esc)
    }
  }, [at])

  const active = options.find(o => o.key === sort.key)
  return (
    <>
      <button
        type="button"
        onClick={e => {
          if (at) { setAt(null); return }
          const r = e.currentTarget.getBoundingClientRect()
          // Clamped on BOTH axes: a column title low on a short phone would otherwise hang the
          // panel's foot off the screen with no way to scroll to it (it is fixed, not in flow).
          setAt({
            left: Math.max(8, Math.min(r.left, window.innerWidth - 228)),
            top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 348)),
          })
        }}
        title={tooltip}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', fontFamily: 'inherit', minWidth: 0,
          minHeight: isMobile ? 44 : undefined,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color }}>{title}</span>
        {overridden && active
          ? (
            <span style={{
              ...microLabel, textTransform: 'none', letterSpacing: 0, fontSize: 10.5,
              color: 'var(--anthropic-orange)', display: 'inline-flex', alignItems: 'center', gap: 2,
            }}>
              {active.label}
              {sort.dir === 'asc' ? <ArrowUp size={10} aria-hidden /> : <ArrowDown size={10} aria-hidden />}
            </span>
          )
          : <ArrowDownUp size={11} color="var(--text-tertiary)" aria-hidden />}
      </button>
      {at && createPortal(
        <>
          <div onClick={() => setAt(null)} style={{ position: 'fixed', inset: 0, zIndex: 1199 }} />
          <div
            ref={panel}
            role="menu"
            style={{
              position: 'fixed', left: at.left, top: at.top, width: 220, zIndex: 1200,
              ...surface, background: 'var(--bg-elevated)', padding: 6, display: 'grid', gap: 2,
              boxShadow: 'var(--shadow-elevated)', maxHeight: 'min(340px, 70vh)', overflowY: 'auto',
            }}
          >
            <div style={{ ...microLabel, padding: '2px 8px 4px' }}>{tooltip}</div>
            {options.map(o => {
              const on = sort.key === o.key
              return (
                <button
                  key={o.key}
                  type="button"
                  role="menuitem"
                  onClick={() => onPick(o.key)}
                  style={{
                    display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', width: '100%',
                    padding: '6px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                    fontFamily: 'inherit',
                    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
                    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                    minHeight: isMobile ? 44 : 28,
                  }}
                >
                  <span style={{ flex: 1 }}>{o.label}</span>
                  {on && o.key !== 'manual' && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                </button>
              )
            })}
            {overridden && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { onClear(); setAt(null) }}
                style={{
                  textAlign: 'left', padding: '6px 8px', borderRadius: 5, cursor: 'pointer',
                  fontSize: 12, fontFamily: 'inherit', border: '1px solid transparent',
                  background: 'transparent', color: 'var(--text-tertiary)',
                  minHeight: isMobile ? 44 : 28, borderTop: '1px solid var(--border)',
                }}
              >{followLabel}</button>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
