import React from 'react'
import { Info } from 'lucide-react'
import { PrecisionToggle } from './PrecisionToggle'
import { useIsMobile } from '../hooks/useIsMobile'
import { valueFontSize } from '../lib/statCardSize'

/**
 * Headline font size for a KPI value, scaled so the number stays readable as it grows.
 *
 * The size is measured on the NUMBER ONLY — any leading currency prefix is stripped first.
 * Measuring the whole string made the same amount render two steps smaller in English than in
 * Portuguese: "USD 16,611.61" (13 chars) crossed a threshold that "R$84.362,05" (11) did not,
 * purely because "USD " is two characters longer than "R$".
 */
interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  icon: React.ReactNode
  accent?: string
  info?: {
    source: string
    formula?: string
    note?: string
  }
  onInfoClick?: () => void
  /** Native tooltip on the value itself — used where the headline number needs a qualifier that
   *  does not fit the sub-line (e.g. how a session's active time was measured). */
  valueTitle?: string
  /** Size the headline by THIS string instead of the rendered value. For a value that can be
   *  re-rendered in place (USD ⇄ BRL) pass the wider of the two, so the font never jumps. */
  sizeBasis?: string | number
  /** Keep the sub to a single ellipsized line (full text in its tooltip). A sub that wraps makes
   *  this card taller than every other one in the grid row. */
  subNoWrap?: boolean
  action?: React.ReactNode
  fullPrecision?: boolean
  onTogglePrecision?: () => void
  lang?: string
}

export function StatCard({ label, value, sub, icon, accent = 'var(--anthropic-orange)', info, onInfoClick, valueTitle, sizeBasis, subNoWrap, action, fullPrecision, onTogglePrecision, lang }: StatCardProps) {
  const isMobile = useIsMobile()
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: isMobile ? '14px 14px' : '20px 22px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      position: 'relative',
      overflow: 'hidden',
      transition: 'border-color 0.2s, background 0.2s',
      height: '100%',
      boxSizing: 'border-box',
    }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLDivElement
        el.style.borderColor = `${accent}40`
        el.style.background = 'var(--bg-card-hover)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLDivElement
        el.style.borderColor = 'var(--border)'
        el.style.background = 'var(--bg-card)'
      }}
    >
      {/* Top accent line */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: 2,
        background: `linear-gradient(90deg, ${accent}60, ${accent}10, transparent)`,
      }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {action}
          {onTogglePrecision && !isMobile && (
            <PrecisionToggle
              full={fullPrecision ?? false}
              accent={accent}
              onToggle={onTogglePrecision}
              lang={lang}
            />
          )}
          {info && (
            <button
              onClick={onInfoClick}
              style={{
                width: 18, height: 18,
                borderRadius: '50%',
                background: 'transparent',
                border: 'none',
                cursor: onInfoClick ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-tertiary)',
                padding: 0,
                transition: 'color 0.15s',
              }}
            >
              <Info size={13} />
            </button>
          )}
          <span style={{
            width: 32, height: 32,
            borderRadius: 8,
            background: `${accent}18`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: accent,
            flexShrink: 0,
          }}>
            {icon}
          </span>
        </div>
      </div>

      <div>
        <div
          title={valueTitle}
          style={{
            fontSize: valueFontSize(sizeBasis ?? value),
            fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.15,
            wordBreak: 'break-all',
            cursor: valueTitle ? 'help' : undefined,
          }}
        >
          {value}
        </div>
        {sub && (
          // `pre-line` so a sub can be several short labelled lines instead of one run-on
          // sentence — a card that reports two different quantities has to name both.
          // `subNoWrap` opts out: one ellipsized line, full text in the tooltip, so a long sub
          // cannot stretch the whole KPI row (every card in a grid row shares its height).
          <div
            title={subNoWrap ? sub : undefined}
            style={{
              fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4,
              whiteSpace: subNoWrap ? 'nowrap' : 'pre-line',
              ...(subNoWrap ? { overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'help' } : {}),
            }}
          >
            {sub}
          </div>
        )}
      </div>
    </div>
  )
}
