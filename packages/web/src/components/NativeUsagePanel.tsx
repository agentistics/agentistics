import React from 'react'
import { fmt, fmtCost, formatModel, getModelColor } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import type { NativeUsage } from '../lib/nativeUsage'

// The same column treatment as `ModelBreakdown`, so the two tables read as one family. The cost
// column is the PROJECTION's figure (provider-stated, or the table price of a known model) — this
// panel never prices a call itself, which is why it does not reuse ModelBreakdown's `calcCost`.
const COL: React.CSSProperties = { fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }
const GRID = 'minmax(140px,1fr) 110px 56px 80px 96px'
const GRID_MOBILE = 'minmax(110px,1fr) 56px 88px'

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', 'openai-compatible': 'OpenAI-compatible', google: 'Google',
}

export function NativeUsagePanel({ usage, currency = 'USD', brlRate = 1, lang = 'en' }: {
  usage: NativeUsage | null
  currency?: 'USD' | 'BRL'
  brlRate?: number
  lang?: 'en' | 'pt'
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const money = (v: number | null, partial: boolean) =>
    v === null ? (pt ? 'sem preço' : 'unpriced') : `${partial ? '≥ ' : ''}${fmtCost(v, currency, brlRate)}`

  if (usage === null) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5, padding: '6px 4px' }}>
        {pt
          ? 'Nenhuma chamada nativa ainda. As chamadas do harness nativo (agentop code, agentop provider try) aparecem aqui.'
          : 'No native calls yet. Calls made by the native harness (agentop code, agentop provider try) will appear here.'}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
        {pt
          ? 'Chamadas feitas pelo harness nativo (agentop code, agentop provider try), lidas do journal. Todo o período.'
          : 'Calls made by the native harness (agentop code, agentop provider try), read from the journal. All time.'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? GRID_MOBILE : GRID, gap: 8, padding: '0 4px' }}>
        <span style={COL}>{pt ? 'Modelo' : 'Model'}</span>
        {!isMobile && <span style={COL}>{pt ? 'Provedor' : 'Provider'}</span>}
        <span style={{ ...COL, textAlign: 'right' }}>{pt ? 'Chamadas' : 'Calls'}</span>
        {!isMobile && <span style={{ ...COL, textAlign: 'right' }}>Tokens</span>}
        <span style={{ ...COL, textAlign: 'right' }}>{pt ? 'Custo' : 'Cost'}</span>
      </div>
      {usage.rows.map(r => (
        <div key={`${r.model}|${r.provider ?? ''}`} style={{ display: 'grid', gridTemplateColumns: isMobile ? GRID_MOBILE : GRID, gap: 8, alignItems: 'center', padding: '8px 4px', borderTop: '1px solid var(--border)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: getModelColor(r.model) }} />
            <span style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.model}>{formatModel(r.model)}</span>
          </span>
          {!isMobile && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r.provider ? (PROVIDER_LABEL[r.provider] ?? r.provider) : '—'}</span>}
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.calls)}</span>
          {!isMobile && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
              title={`in ${fmt(r.input ?? 0)} · out ${fmt(r.output ?? 0)} · cache read ${fmt(r.cacheRead ?? 0)} · cache write ${fmt(r.cacheWrite ?? 0)}`}>
              {fmt(r.totalTokens)}
            </span>
          )}
          <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.costUSD === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }}>
            {money(r.costUSD, r.costPartial)}
          </span>
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? GRID_MOBILE : GRID, gap: 8, padding: '8px 4px', borderTop: '1px solid var(--border)', fontWeight: 600 }}>
        <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>Total</span>
        {!isMobile && <span />}
        <span style={{ fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(usage.calls)}</span>
        {!isMobile && <span style={{ fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(usage.totalTokens)}</span>}
        <span style={{ fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--anthropic-orange)' }}>{money(usage.costUSD, usage.costPartial)}</span>
      </div>
    </div>
  )
}
