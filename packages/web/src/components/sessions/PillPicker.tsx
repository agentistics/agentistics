/**
 * PillPicker — the wizard's row of dot-and-label choice buttons, extracted from `EffortPicker` so the
 * effort scale and the permission mode are ONE control with two vocabularies, never two look-alikes.
 *
 * It knows nothing about efforts or modes: a caller hands it items (key, label, dot colour, and
 * optionally the selected tint) and decides what a click means.
 */
import type { CSSProperties } from 'react'

export interface PillItem {
  key: string
  label: string
  /** The dot, and by default the selected border/tint. */
  color: string
  /** Selected border, when it differs from `color`. */
  border?: string
  /** Selected background, when it differs from the default 16% tint of `color`. */
  bg?: string
  title?: string
  className?: string
  /** Extra attributes for tests and styling hooks (e.g. `data-mode`). */
  data?: Record<string, string>
}

export interface PillPickerProps {
  items: readonly PillItem[]
  /** The selected key, or `''` for none. */
  value: string
  onPick: (key: string) => void
  /** `radio` gives the row radio semantics (always one chosen); omitted, the buttons are plain. */
  radioLabel?: string
  minHeight?: number
  style?: CSSProperties
}

export function PillPicker({ items, value, onPick, radioLabel, minHeight, style }: PillPickerProps) {
  return (
    <div role={radioLabel ? 'radiogroup' : undefined} aria-label={radioLabel} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', ...style }}>
      {items.map(item => {
        const on = value === item.key
        const data = Object.fromEntries(Object.entries(item.data ?? {}).map(([k, v]) => [`data-${k}`, v]))
        return (
          <button
            key={item.key}
            type="button"
            role={radioLabel ? 'radio' : undefined}
            aria-checked={radioLabel ? on : undefined}
            title={item.title}
            onClick={() => onPick(item.key)}
            className={on ? item.className : undefined}
            {...data}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 13px', borderRadius: 9, cursor: 'pointer', minHeight,
              border: `1px solid ${on ? (item.border ?? item.color) : 'var(--border-subtle)'}`,
              background: on ? (item.bg ?? `color-mix(in srgb, ${item.color} 16%, transparent)`) : 'var(--bg-elevated)',
              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: on ? 650 : 500,
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 4, background: item.color, flexShrink: 0 }} />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
