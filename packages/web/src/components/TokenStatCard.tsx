import React from 'react'
import { Coins, Info } from 'lucide-react'
import type { Lang, TokenBreakdown } from '@agentistics/core'
import {
  TOKEN_COLORS, TOKEN_PARTS, fmt, fmtFull, tokenHelp, tokenLabel, tokenSharePct,
  totalTokens, totalTokensExplained,
} from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import { PrecisionToggle } from './PrecisionToggle'
import { valueFontSize } from '../lib/statCardSize'

/**
 * The KPI cell for tokens — the TOTAL as the headline, and all four billed counters under it.
 *
 * ## Why one card and not five
 *
 * The surfaces this replaces showed two of the four counters (`input` + `output`) as two separate
 * cards, which is 0,34 % of the volume on a real machine — the number people actually pay for is
 * the cache, and it was not on screen anywhere except the Costs page. Five separate cards would put
 * every counter on screen and wreck the grids: the KPI row is user-reorderable and responsive at
 * 1/2/3/4/5 columns, and going from ten cells to thirteen leaves a ragged last row at every
 * breakpoint. One card that spans the two it replaces keeps the cell count — and therefore the
 * layout — exactly as it was, while carrying five numbers instead of two.
 *
 * A counter is never drawn without its name, and the headline is never drawn without
 * `totalTokensExplained`: these figures reach the billions, and a total with no account of what it
 * contains reads as a fault rather than a measurement. Same rule `TOKEN_KINDS` exists to enforce.
 *
 * ## Zero is a real answer here
 *
 * A counter the harness genuinely never produced (agy records no cache WRITE) reads `0`, not `N/A`
 * — that zero is measured, not missing. Capability gating belongs to `HARNESS_CAPABILITIES` and
 * happens before this card is given a breakdown.
 */
interface Props {
  tokens: TokenBreakdown
  lang: Lang
  /** Localized label for the headline. Defaults to "Tokens". */
  label?: string
  /** One-line context under the headline (e.g. the active scope). */
  sub?: string
  accent?: string
  info?: { source: string; formula?: string; note?: string }
  onInfoClick?: () => void
  fullPrecision?: boolean
  onTogglePrecision?: () => void
}

export function TokenStatCard({
  tokens, lang, label, sub, accent = 'var(--anthropic-orange)',
  info, onInfoClick, fullPrecision, onTogglePrecision,
}: Props) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const total = totalTokens(tokens)
  const n = (v: number) => (fullPrecision ? fmtFull(v) : fmt(v))
  const headline = n(total)

  return (
    <div
      className="ag-stat-card"
      style={{
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
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: accent, opacity: 0.5 }} />

      <div className="ag-stat-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
            {label ?? 'Tokens'}
          </span>
          {info && onInfoClick && (
            <button
              onClick={onInfoClick}
              aria-label={pt ? 'Sobre este número' : 'About this number'}
              style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-tertiary)' }}
            >
              <Info size={12} />
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {onTogglePrecision && !isMobile && total >= 1000 && (
            <PrecisionToggle full={!!fullPrecision} accent={accent} onToggle={onTogglePrecision} lang={lang} />
          )}
          <Coins size={15} style={{ color: accent, flexShrink: 0 }} />
        </div>
      </div>

      {/* The headline carries its explanation as a title: a number this large with no account of
          what it contains is the complaint TOKEN_KINDS exists to answer. */}
      <div
        title={totalTokensExplained(tokens, lang)}
        style={{
          fontSize: valueFontSize(headline),
          fontWeight: 700,
          lineHeight: 1.05,
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {headline}
      </div>

      {/* The four counters. Two columns wherever there is room — the card spans two grid cells on
          anything wider than a phone, so a single column would leave half of it empty. */}
      <div
        className="ag-tok-parts"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: isMobile ? '6px 12px' : '6px 18px',
          marginTop: 'auto',
        }}
      >
        {TOKEN_PARTS.map(part => (
          <div
            key={part}
            title={tokenHelp(part, lang)}
            style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, minWidth: 0 }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 11, color: 'var(--text-secondary)' }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: TOKEN_COLORS[part], flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tokenLabel(part, lang)}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 5, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              <strong style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{n(tokens[part])}</strong>
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{tokenSharePct(tokens[part], total)}</span>
            </span>
          </div>
        ))}
      </div>

      {sub && (
        <div className="ag-stat-sub" style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{sub}</div>
      )}
    </div>
  )
}
