import React from 'react'
import { Crown } from 'lucide-react'
import { fmt, fmtCost, type Lang } from '@agentistics/core'
import { formatMultiple } from '../../lib/costBasis'
import type { CompareCell, CompareRow } from '../../lib/compareMetrics'
import { useIsMobile } from '../../hooks/useIsMobile'

/** The colour each side is drawn in, everywhere it appears. Six, because that is the cap on
 *  sides — past it the table stops being readable on any screen. */
export const SIDE_COLOURS = [
  'var(--anthropic-orange)',
  'var(--accent-blue, #3b82f6)',
  'var(--accent-green, #22c55e)',
  'var(--accent-purple, #a855f7)',
  '#eab308',
  '#ec4899',
] as const

export const sideColour = (i: number): string => SIDE_COLOURS[i % SIDE_COLOURS.length]!

export interface TableSide {
  id: string
  label: string
  description?: string
  /** The basis this side asks for. Shown in the header so a mixed table — plan against API, the
   *  core question of this feature — reads as deliberate rather than inconsistent. */
  basis?: 'api' | 'plan'
}

/**
 * N sides of a comparison, as a table on desktop and a stack of cards on a phone.
 *
 * Shared by the compare page and the Home page so a pinned comparison is rendered by exactly the
 * same code that built it — two renderers would eventually disagree about what a delta means.
 *
 * Bars are scaled to the largest value in the ROW, so length is the comparison and the number is
 * the detail. The winner carries a crown rather than leaving the reader to scan for it.
 */
export function ComparisonTable({ rows, sides, currency, brlRate, lang }: {
  rows: CompareRow[]
  sides: TableSide[]
  currency: 'USD' | 'BRL'
  brlRate: number
  lang: Lang
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  if (sides.length === 0 || rows.length === 0) return null

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(row => (
          <div key={row.metric.key} style={{
            border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-card)', padding: '11px 13px',
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              {pt ? row.metric.labelPt : row.metric.labelEn}
              
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {sides.map((s, i) => (
                <div key={s.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11.5, color: sideColour(i), fontWeight: 700 }}>
                      {s.label}
                      {s.basis === 'plan' && <BasisTag pt={pt} />}
                      {row.bestIndex === i && <Crown size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />}
                    </span>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                        {formatValue(row, row.cells[i]?.value ?? null, currency, brlRate, lang)}
                      </span>
                      <DeltaText cell={row.cells[i]} row={row} currency={currency} brlRate={brlRate} lang={lang} />
                    </span>
                  </div>
                  <RowBar row={row} index={i} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    // The container scrolls, never the page body — six sides plus the metric column outgrows a
    // laptop, and a page that scrolls sideways is the layout rule this repo states outright.
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflowX: 'auto' }}>
      <div style={{ minWidth: 200 + sides.length * 150 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: `minmax(160px, 1.2fr) repeat(${sides.length}, minmax(140px, 1fr))`,
          gap: 12, padding: '8px 14px', background: 'var(--bg-hover)',
        }}>
          <span style={HEAD}>{pt ? 'Métrica' : 'Metric'}</span>
          {sides.map((s, i) => (
            <span key={s.id} style={{ ...HEAD, color: sideColour(i) }} title={s.description}>
              {s.label}
              {s.basis === 'plan' && <BasisTag pt={pt} />}
              {i === 0 && (
                <span style={{ color: 'var(--text-tertiary)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
                  {' '}· {pt ? 'base' : 'baseline'}
                </span>
              )}
            </span>
          ))}
        </div>
        {rows.map((row, r) => (
          <div
            key={row.metric.key}
            style={{
              display: 'grid', gridTemplateColumns: `minmax(160px, 1.2fr) repeat(${sides.length}, minmax(140px, 1fr))`,
              gap: 12, padding: '9px 14px', alignItems: 'center',
              borderTop: r === 0 ? 'none' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {pt ? row.metric.labelPt : row.metric.labelEn}
            </div>
            {sides.map((s, i) => (
              <div key={s.id} style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{
                    fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                    color: row.cells[i]?.value === null ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {formatValue(row, row.cells[i]?.value ?? null, currency, brlRate, lang)}
                  </span>
                  {row.bestIndex === i && <Crown size={11} style={{ color: sideColour(i), flexShrink: 0 }} />}
                </div>
                <DeltaText cell={row.cells[i]} row={row} currency={currency} brlRate={brlRate} lang={lang} />
                {/* The one thing that must never be silent: this column asked for the plan basis
                    and could not have it, so the figure beside it is an API one wearing a plan
                    heading unless it says otherwise. */}
                {row.cells[i]?.fellBack && (
                  <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 2, whiteSpace: 'nowrap' }}>
                    {pt ? 'sem plano · em API' : 'no plan · in API'}
                  </div>
                )}
                <RowBar row={row} index={i} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function RowBar({ row, index }: { row: CompareRow; index: number }) {
  const max = Math.max(...row.cells.map(c => c.value ?? 0), 0)
  const v = row.cells[index]?.value ?? null
  const pct = v !== null && max > 0 ? Math.max(2, (v / max) * 100) : 0
  return (
    <div style={{ height: 3, background: 'var(--bg-elevated)', borderRadius: 2, marginTop: 5, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: sideColour(index), opacity: 0.6, borderRadius: 2, transition: 'width 0.35s ease-out' }} />
    </div>
  )
}

function DeltaText({ cell, row, currency, brlRate, lang }: {
  cell: CompareCell | undefined
  row: CompareRow
  currency: 'USD' | 'BRL'
  brlRate: number
  lang: Lang
}) {
  // A ZERO delta renders nothing. "−0 (−0%)" on every identical row was pure noise — two equal
  // numbers side by side already say they are equal.
  if (!cell || cell.delta === null || cell.delta === 0) return null
  const sign = cell.delta > 0 ? '+' : '−'
  const abs = formatValue(row, Math.abs(cell.delta), currency, brlRate, lang)
  const pct = cell.deltaPct === null ? null : `${cell.delta > 0 ? '+' : '−'}${Math.abs(Math.round(cell.deltaPct * 100))}%`
  return (
    <div style={{ fontSize: 10.5, color: TONE_COLOR[cell.tone], marginTop: 1, whiteSpace: 'nowrap' }}>
      {sign}{abs}{pct && <span style={{ opacity: 0.8 }}> ({pct})</span>}
    </div>
  )
}

function BasisTag({ pt }: { pt: boolean }) {
  return (
    <span style={{
      marginLeft: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em',
      color: 'var(--anthropic-orange)', border: '1px solid var(--anthropic-orange)',
      padding: '1px 5px', borderRadius: 8, verticalAlign: 1,
    }}>
      {pt ? 'PLANO' : 'PLAN'}
    </span>
  )
}

export function formatValue(
  row: CompareRow,
  value: number | null,
  currency: 'USD' | 'BRL',
  brlRate: number,
  lang: Lang,
): string {
  if (value === null) return '—'
  switch (row.metric.format) {
    case 'cost':
    case 'rate': return fmtCost(value, currency, brlRate)
    case 'percent': return `${Math.round(value * 100)}%`
    case 'multiple': return formatMultiple(value, lang === 'pt' ? 'pt' : 'en') ?? '—'
    default: return fmt(Math.round(value))
  }
}

const TONE_COLOR: Record<string, string> = {
  good: 'var(--accent-green, #22c55e)',
  bad: '#ef4444',
  flat: 'var(--text-tertiary)',
  na: 'var(--text-tertiary)',
}

const HEAD: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: 0.3,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
