/**
 * SegmentedTabs — the segmented control, as a shape.
 *
 * Extracted from the former `ModeSwitch` (the Painel | Sessões switch, removed by APP.AREAS) so
 * the sessions aside's own Ativas | Grupos | Encerradas tabs are the SAME control rather than a
 * second one that drifts: one track, one raised segment, one badge. Each caller owns what its
 * segments MEAN; this file only draws.
 */

import type React from 'react'
import './SegmentedTabs.css'
import { COUNT_BADGE } from './countBadge'

export interface SegmentedTab<Id extends string> {
  id: Id
  label: string
  /** Absent draws no icon slot (the open aside's tabs are words only). */
  icon?: React.ReactNode
  /** A count drawn after the label (or over the icon when collapsed). Absent or 0 draws nothing. */
  badge?: number
  /** Already-worded label for the badge — it never carries its meaning in colour alone. */
  badgeLabel?: string
  /** `accent` is the solid orange pill (needs a person); `quiet` a neutral count; `alert` the fell tint. */
  badgeTone?: 'accent' | 'quiet' | 'alert'
}

const BADGE: Record<NonNullable<SegmentedTab<string>['badgeTone']>, React.CSSProperties> = {
  accent: { background: 'var(--anthropic-orange)', color: '#fff' },
  quiet: { background: 'transparent', color: 'var(--anthropic-orange)' },
  alert: { background: 'color-mix(in srgb, var(--accent-red) 22%, transparent)', color: 'var(--accent-red)' },
}

export function SegmentedTabs<Id extends string>({ tabs, value, onChange, collapsed = false, ariaLabel, containerName = 'workspace-mode', className, equal = false, badgeOutside = false }: {
  tabs: readonly SegmentedTab<Id>[]
  value: Id
  onChange: (id: Id) => void
  /** Icons only, stacked — the 64px rail. */
  collapsed?: boolean
  ariaLabel: string
  /** The CSS container this control answers to (`SegmentedTabs.css` narrows the segments under it). */
  containerName?: string
  className?: string
  /** Equal-width segments (the aside's three tabs); otherwise each takes its content's width. */
  equal?: boolean
  /** Collapsed only: the count sits on the segment's corner, clear of the icon (the sessions rail). */
  badgeOutside?: boolean
}) {
  return (
    <div
      role="tablist"
      className={className ?? 'ag-mode-switch'}
      aria-label={ariaLabel}
      style={{
        containerType: 'inline-size', containerName,
        display: 'flex', flexDirection: collapsed ? 'column' : 'row',
        gap: 'var(--seg-track-gap, 3px)', padding: 'var(--seg-track-pad, 3px)', borderRadius: 10, minWidth: 0, width: '100%',
        boxSizing: 'border-box',
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
      }}
    >
      {tabs.map(tab => {
        const on = tab.id === value
        const badge = (tab.badge ?? 0) > 0
        return (
          <button
            key={tab.id}
            type="button"
            className={collapsed ? undefined : 'ag-mode-segment'}
            role="tab"
            aria-selected={on}
            aria-label={collapsed ? tab.label : undefined}
            title={collapsed ? tab.label : undefined}
            data-segment={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              flex: equal ? '1 1 0' : '1 1 auto', minWidth: 0, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--mode-gap, 6px)',
              position: 'relative',
              minHeight: collapsed ? 34 : 'var(--mode-min-height, 34px)', padding: collapsed ? '0' : '0 var(--mode-padding, 8px)',
              borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 'var(--mode-font, 12.5px)', fontWeight: on ? 700 : 500, whiteSpace: 'nowrap',
              background: on ? 'var(--bg-surface)' : 'transparent',
              boxShadow: on ? 'var(--ag-shadow-seg)' : 'none',
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {tab.icon && <span style={{ display: collapsed ? 'flex' : 'var(--mode-icon-display, flex)', flexShrink: 0 }}>{tab.icon}</span>}
            {!collapsed && (
              <span style={{ flexShrink: 0 }}>{tab.label}</span>
            )}
            {badge && (
              <span
                aria-label={tab.badgeLabel ?? String(tab.badge)}
                style={{
                  position: collapsed ? 'absolute' : 'static',
                  top: collapsed ? (badgeOutside ? -5 : 2) : undefined, right: collapsed ? (badgeOutside ? -7 : 2) : undefined,
                  flexShrink: 0,
                  ...COUNT_BADGE,
                  ...BADGE[tab.badgeTone ?? 'accent'],
                  // Outside the icon, a quiet count needs a ground of its own or it reads as part of the glyph.
                  ...(collapsed && badgeOutside && tab.badgeTone === 'quiet'
                    ? { background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)' } : {}),
                }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
