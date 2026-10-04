import React, { useMemo } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { GitCompare } from 'lucide-react'
import type { AppContext } from '../lib/app-context'
import type { SurfaceHarnessId, Lang, TokenBreakdown } from '@agentistics/core'
import { EMPTY_TOKENS, TOKEN_PARTS, UNPRICED_MODEL_LABEL, UNPRICED_TOTAL_MARKER, fmt, fmtCost, formatModel, isUnpricedModel, t, tokenLabel, tokenSharePct, totalTokens } from '@agentistics/core'
import { HARNESS_LABELS, HARNESS_COLORS, capable } from '../lib/harness'
import { computeFilteredHarnessSummaries } from '../hooks/useData'
import { fmtDateLocalized } from '../lib/dateFormat'
import { CompareByFilter } from './compare/CompareByFilter'
import { MetricNote } from '../components/MetricNote'

interface HarnessAgg {
  harness: SurfaceHarnessId
  sessions: number
  messages: number
  inputTokens: number
  outputTokens: number
  /** All four billed counters — what the "Tokens" row compares. See `tokens.ts` in the core. */
  tokens: TokenBreakdown
  costUSD: number
  /** Tokens no price covers (PRICE.UNKNOWN) — see `HarnessSummary.unpricedTokens`. */
  unpricedTokens: number
  lastActive: string | null
}

/** "unknown" — the cell for a figure that exists but cannot be priced. Distinct from N/A (cannot be measured). */
function UnknownCell({ lang }: { lang: Lang }) {
  return (
    <span data-unpriced style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
      {UNPRICED_MODEL_LABEL[lang === 'pt' ? 'pt' : 'en']}
    </span>
  )
}

function NACell({ lang }: { lang: Lang }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 5,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--text-tertiary)',
      letterSpacing: '0.03em',
    }}>
      {t('compare.na', lang)}
    </span>
  )
}

function MetricBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div style={{ height: 4, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden', marginTop: 6 }}>
      <div style={{
        height: '100%',
        width: `${pct}%`,
        background: color,
        borderRadius: 2,
        transition: 'width 0.4s ease-out',
        opacity: 0.75,
      }} />
    </div>
  )
}

interface MetricRowProps {
  label: string
  /** `unknown`: a figure that exists and cannot be priced (drawn as "unknown", never as 0 or N/A);
   *  `note`: a qualifier under the value (e.g. "+ unpriced usage" on a cost that is a floor). */
  values: { harness: SurfaceHarnessId; value: number | null; unknown?: boolean; note?: string }[]
  format: (v: number) => string
  colors: Record<SurfaceHarnessId, string>
  lang: Lang
}

function MetricRow({ label, values, format: formatFn, colors, lang }: MetricRowProps) {
  const maxVal = Math.max(...values.map(v => v.value ?? 0))
  return (
    <tr>
      <td style={{
        padding: '12px 16px 12px 0',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        borderBottom: '1px solid var(--border)',
        verticalAlign: 'top',
      }}>
        {label}
      </td>
      {values.map(({ harness, value, unknown, note }) => (
        <td key={harness} style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          verticalAlign: 'top',
        }}>
          {unknown ? (
            <UnknownCell lang={lang} />
          ) : value === null ? (
            <NACell lang={lang} />
          ) : (
            <>
              <div style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--text-primary)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {formatFn(value)}
              </div>
              {note && <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>{note}</div>}
              <MetricBar value={value} max={maxVal} color={colors[harness]} />
            </>
          )}
        </td>
      ))}
    </tr>
  )
}

function MiniBarChart({ values, color, peakIndex: peak, height = 40 }: {
  values: number[]
  color: string
  peakIndex: number | null
  height?: number
}) {
  const max = Math.max(...values, 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height }}>
      {values.map((v, i) => {
        const pct = Math.round((v / max) * 100)
        const isPeak = i === peak
        return (
          <div
            key={i}
            title={`${v}`}
            style={{
              flex: 1,
              height: `${Math.max(pct, v > 0 ? 4 : 0)}%`,
              background: isPeak ? color : `${color}55`,
              borderRadius: '2px 2px 0 0',
              minWidth: 2,
              transition: 'height 0.3s ease-out',
            }}
          />
        )
      })}
    </div>
  )
}

const SPARK_BUCKETS = 60

/** Map a harness's active-day list onto a fixed number of buckets across a
 *  SHARED [minMs, maxMs] time axis, summing sessions per bucket. This lets every
 *  harness's sparkline share the same timeline, so a harness with only one or two
 *  active days renders as isolated thin bars instead of one giant block. */
function bucketize(
  daily: { date: string; sessions: number }[],
  minMs: number,
  maxMs: number,
  n: number,
): number[] {
  const buckets = new Array<number>(n).fill(0)
  if (daily.length === 0 || maxMs <= minMs) {
    // Degenerate range (no data, or all activity on a single day): drop each
    // active day into the first bucket so it's still represented.
    for (const d of daily) buckets[0] = (buckets[0] ?? 0) + d.sessions
    return buckets
  }
  const span = maxMs - minMs
  for (const d of daily) {
    const t = new Date(d.date).getTime()
    if (Number.isNaN(t)) continue
    let idx = Math.floor(((t - minMs) / span) * n)
    if (idx < 0) idx = 0
    if (idx >= n) idx = n - 1
    buckets[idx] = (buckets[idx] ?? 0) + d.sessions
  }
  return buckets
}

function SparklineChart({ buckets, color, height = 32, noDataLabel }: {
  buckets: number[]
  color: string
  height?: number
  noDataLabel: string
}) {
  const total = buckets.reduce((a, b) => a + b, 0)
  if (total === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{noDataLabel}</span>
      </div>
    )
  }
  const max = Math.max(...buckets, 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height, overflow: 'hidden' }}>
      {buckets.map((v, i) => {
        const pct = (v / max) * 100
        return (
          <div
            key={i}
            title={`${v} sessions`}
            style={{
              flex: 1,
              height: `${v > 0 ? Math.max(pct, 8) : 0}%`,
              background: `${color}99`,
              borderRadius: '1px 1px 0 0',
              minWidth: 1,
            }}
          />
        )
      })}
    </div>
  )
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '20px 22px',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

/**
 * The compare page, in two modes.
 *
 *   'harness' — the original: every harness side by side under ONE filter. Untouched.
 *   'filter'  — two independent filter sets and a curated A / B / Δ table.
 *
 * One page rather than two nav entries, because "compare harnesses" is one case of "compare two
 * scopes" and two similar items in a menu is a choice nobody wants to make. Only the HARNESS mode
 * stays gated on having more than one harness; the page itself is always reachable.
 */
export default function ComparePage() {
  const ctx = useOutletContext<AppContext>()
  const [searchParams, setSearchParams] = useSearchParams()
  const mode: 'harness' | 'filter' = searchParams.get('mode') === 'filter' ? 'filter' : 'harness'
  const setMode = (m: 'harness' | 'filter') => setSearchParams(m === 'filter' ? { mode: 'filter' } : {})
  // A FRAGMENT, not a wrapper div. Every page here renders into a `<main>` that is a flex column
  // with a 20px gap, so a page's top-level children ARE the spaced items. Wrapping them made the
  // whole page one item and every section inside it lost its spacing — the sections collapsed
  // into each other and the page read as broken.
  return (
    <>
      <CompareModeSelector mode={mode} onChange={setMode} lang={ctx.lang} multiHarness={(ctx.data.harnesses?.length ?? 0) > 1} />
      {mode === 'filter' ? <CompareByFilter ctx={ctx} /> : <CompareByHarness />}
    </>
  )
}

function CompareModeSelector({ mode, onChange, lang, multiHarness }: {
  mode: 'harness' | 'filter'
  onChange: (m: 'harness' | 'filter') => void
  lang: 'pt' | 'en'
  multiHarness: boolean
}) {
  const pt = lang === 'pt'
  const options: { id: 'harness' | 'filter'; label: string; disabled?: boolean }[] = [
    { id: 'harness', label: pt ? 'Por harness' : 'By harness', disabled: !multiHarness },
    { id: 'filter', label: pt ? 'Por filtro' : 'By filter' },
  ]
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', alignSelf: 'flex-start' }}>
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => !o.disabled && onChange(o.id)}
          disabled={o.disabled}
          title={o.disabled ? (pt ? 'Só há um harness com dados' : 'Only one harness has data') : undefined}
          style={{
            padding: '8px 16px', border: 'none', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            background: mode === o.id ? 'var(--anthropic-orange-dim)' : 'transparent',
            color: o.disabled ? 'var(--text-tertiary)' : mode === o.id ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
            opacity: o.disabled ? 0.5 : 1,
            cursor: o.disabled ? 'default' : 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** The original page body, extracted verbatim. */
function CompareByHarness() {
  const { data, currency, brlRate, lang, filters } = useOutletContext<AppContext>()

  // Compare respects the active filters (users, harnesses, date, projects, models): the
  // columns shown AND every metric reflect exactly the filtered slice — same behavior as the
  // main dashboard. With NO filter active it keeps the statsCache-canonical Claude totals so
  // the default view matches the dashboard's all-time KPIs. Shared with the PDF Export page's
  // Compare section via computeFilteredHarnessSummaries so both always agree.
  const { activeHarnesses, summaries, lastActive } = useMemo(
    () => computeFilteredHarnessSummaries(data, filters),
    [data, filters],
  )

  // Localized short day-of-week labels (Sunday-first to match getDay()).
  const dowLabels = useMemo(() => [
    t('compare.dow.sun', lang),
    t('compare.dow.mon', lang),
    t('compare.dow.tue', lang),
    t('compare.dow.wed', lang),
    t('compare.dow.thu', lang),
    t('compare.dow.fri', lang),
    t('compare.dow.sat', lang),
  ], [lang])

  const aggs = useMemo<HarnessAgg[]>(() => {
    return activeHarnesses.map(harness => {
      const s = summaries[harness]
        ?? { sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, tokens: EMPTY_TOKENS, costUSD: 0, unpricedTokens: 0 }
      return {
        harness,
        sessions: s.sessions,
        messages: s.messages,
        inputTokens: capable(harness, 'tokens') ? s.inputTokens : 0,
        outputTokens: capable(harness, 'tokens') ? s.outputTokens : 0,
        tokens: capable(harness, 'tokens') ? s.tokens : EMPTY_TOKENS,
        costUSD: capable(harness, 'cost') ? s.costUSD : 0,
        unpricedTokens: capable(harness, 'cost') ? s.unpricedTokens : 0,
        lastActive: lastActive[harness] ?? null,
      }
    })
  }, [activeHarnesses, summaries, lastActive])

  const colors = HARNESS_COLORS

  // Shared time axis for the "Activity over time" sparklines, spanning the
  // earliest→latest active day across ALL harnesses so they are comparable.
  const { minMs, maxMs } = useMemo(() => {
    let mn = Infinity, mx = -Infinity
    for (const h of activeHarnesses) {
      for (const d of summaries[h]?.dailyActivity ?? []) {
        const t = new Date(d.date).getTime()
        if (Number.isNaN(t)) continue
        if (t < mn) mn = t
        if (t > mx) mx = t
      }
    }
    return { minMs: mn === Infinity ? 0 : mn, maxMs: mx === -Infinity ? 0 : mx }
  }, [activeHarnesses, summaries])

  const tokensValues = aggs.map(a => ({
    harness: a.harness,
    value: capable(a.harness, 'tokens') ? totalTokens(a.tokens) : null,
  }))
  // PRICE.UNKNOWN: a harness whose every token is unpriced has NO cost ("unknown", never R$0,00), and one
  // with some unpriced usage shows a cost that is a floor and says so.
  const unpricedLabel = UNPRICED_TOTAL_MARKER[lang === 'pt' ? 'pt' : 'en']
  const costValues = aggs.map(a => {
    const capableCost = capable(a.harness, 'cost')
    const allUnpriced = capableCost && a.unpricedTokens > 0 && a.unpricedTokens >= totalTokens(a.tokens)
    return {
      harness: a.harness,
      value: capableCost && !allUnpriced ? a.costUSD : null,
      ...(allUnpriced ? { unknown: true } : {}),
      ...(capableCost && !allUnpriced && a.unpricedTokens > 0 ? { note: unpricedLabel } : {}),
    }
  })
  const sessionValues = aggs.map(a => ({ harness: a.harness, value: a.sessions }))
  const messageValues = aggs.map(a => ({ harness: a.harness, value: a.messages }))

  // Cost per 1M tokens (blended) — null where not applicable. Used to highlight the cheapest.
  const costPerMValues = aggs.map(a => ({
    harness: a.harness,
    value: capable(a.harness, 'cost') && capable(a.harness, 'tokens')
      ? (summaries[a.harness]?.costPerMTokens ?? null)
      : null,
  }))
  const cheapestHarness = useMemo<SurfaceHarnessId | null>(() => {
    let best: SurfaceHarnessId | null = null
    let bestVal = Infinity
    for (const { harness, value } of costPerMValues) {
      if (value !== null && value > 0 && value < bestVal) {
        bestVal = value
        best = harness
      }
    }
    return best
  }, [costPerMValues])

  const fmtTokens = (v: number) => fmt(v)
  const fmtCostFn = (v: number) => fmtCost(v, currency, brlRate)
  const fmtCount = (v: number) => v.toLocaleString()
  const modelLabel = (model: string) =>
    model === 'unknown' ? t('compare.unknownModel', lang) : formatModel(model)

  return (
    <>
      {/* Page header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
          <span style={{ color: 'var(--anthropic-orange)' }}><GitCompare size={16} /></span>
          {t('compare.title', lang)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {t('compare.subtitle', lang)}
        </div>
      </div>

      {/* Legend / harness header cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
      }}>
        {aggs.map(a => (
          <div key={a.harness} style={{
            background: 'var(--bg-card)',
            border: `1px solid ${colors[a.harness]}40`,
            borderRadius: 'var(--radius-lg)',
            padding: '16px 18px',
            borderTop: `3px solid ${colors[a.harness]}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: colors[a.harness],
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: colors[a.harness] }}>
                {HARNESS_LABELS[a.harness]}
              </span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
              {a.sessions.toLocaleString()}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {t('compare.sessionsLower', lang)}
            </div>
            {a.lastActive && (
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 8 }}>
                {t('compare.lastActive', lang)}: {fmtDateLocalized(a.lastActive, lang)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Comparison table */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px 22px',
        overflowX: 'auto',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${120 + aggs.length * 130}px` }}>
          <thead>
            <tr>
              <th style={{
                padding: '0 16px 14px 0',
                textAlign: 'left',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                borderBottom: '1px solid var(--border)',
              }}>
                {t('compare.metric', lang)}
              </th>
              {aggs.map(a => (
                <th key={a.harness} style={{
                  padding: '0 16px 14px',
                  textAlign: 'left',
                  fontSize: 11,
                  fontWeight: 700,
                  color: colors[a.harness],
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  borderBottom: `2px solid ${colors[a.harness]}`,
                  whiteSpace: 'nowrap',
                }}>
                  {HARNESS_LABELS[a.harness]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <MetricRow label={t('compare.sessions', lang)} values={sessionValues} format={fmtCount} colors={colors} lang={lang} />
            <MetricRow label={t('compare.messages', lang)} values={messageValues} format={fmtCount} colors={colors} lang={lang} />
            <MetricRow label={t('compare.totalTokens', lang)} values={tokensValues} format={fmtTokens} colors={colors} lang={lang} />
            {/* All FOUR counters, one row each. This was input and output alone — the pair that
                comes to 0,34 % of the volume on a real machine — so the table could show one
                harness's total dwarfing another's without showing the cache that explains it.
                Rows cost height, never width, so a comparison of six harnesses is unaffected.
                Labels come from `tokenLabel`, the same vocabulary every other surface prints. */}
            {TOKEN_PARTS.map(part => (
              <MetricRow
                key={part}
                label={tokenLabel(part, lang === 'pt' ? 'pt' : 'en')}
                values={aggs.map(a => ({
                  harness: a.harness,
                  value: capable(a.harness, 'tokens') ? a.tokens[part] : null,
                }))}
                format={fmtTokens}
                colors={colors}
                lang={lang}
              />
            ))}
            <MetricRow label={t('compare.cost', lang)} values={costValues} format={fmtCostFn} colors={colors} lang={lang} />
          </tbody>
        </table>
      </div>

      {/* The four rows under the total now ARE the total, so the note says how they are priced
          rather than apologising for the two that were missing. */}
      <MetricNote>
        {lang === 'pt'
          ? 'A linha de tokens totais soma os quatro contadores abaixo dela. São quatro preços diferentes: leitura de cache custa cerca de um décimo da entrada nova, e a saída é o token mais caro que existe — por isso dois harnesses com o mesmo total podem custar muito diferente.'
          : 'The total-tokens row adds the four counters under it. They are four different prices: a cache read costs about a tenth of fresh input, and output is the most expensive token there is — which is why two harnesses with the same total can cost very differently.'}
      </MetricNote>

      {/* Cost per 1M tokens (blended) — highlights the cheapest harness */}
      <SectionCard title={t('compare.costPerMTokens', lang)}>
        <MetricNote style={{ marginTop: 0, marginBottom: 12 }}>
          {lang === 'pt'
            ? 'Custo dividido por TODOS os tokens cobrados, cache incluído. Dividir só pela conversa daria um valor dezenas de vezes maior que o cobrado, e ordenaria os assistentes por quanto cada um usa cache em vez de por quanto custa.'
            : 'Cost divided by ALL billed tokens, cache included. Dividing by the conversation alone would report a figure tens of times higher than what is charged, and would rank assistants by how much each one caches rather than by what it costs.'}
        </MetricNote>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
        }}>
          {costPerMValues.map(({ harness, value }) => {
            const isCheapest = harness === cheapestHarness && value !== null
            const unknownRate = value === null && capable(harness, 'cost') && (summaries[harness]?.unpricedTokens ?? 0) > 0
            return (
              <div key={harness} style={{
                background: 'var(--bg-elevated)',
                border: isCheapest ? `1px solid ${colors[harness]}` : '1px solid var(--border)',
                borderRadius: 'var(--radius-md, 8px)',
                padding: '14px 16px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors[harness], marginBottom: 8 }}>
                  {HARNESS_LABELS[harness]}
                </div>
                {unknownRate ? (
                  <UnknownCell lang={lang} />
                ) : value === null ? (
                  <NACell lang={lang} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtCost(value, currency, brlRate)}
                    </span>
                    {isCheapest && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: colors[harness],
                        background: `${colors[harness]}22`,
                        borderRadius: 4,
                        padding: '2px 6px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}>
                        {t('compare.cheapest', lang)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* Cost by model — per harness, listing each model's tokens + cost */}
      <SectionCard title={t('compare.costByModel', lang)}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
        }}>
          {aggs.map(a => {
            const s = summaries[a.harness]
            const showModels = capable(a.harness, 'cost') && capable(a.harness, 'model')
            const models = showModels ? (s?.models ?? []) : []
            return (
              <div key={a.harness}>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors[a.harness], marginBottom: 8 }}>
                  {HARNESS_LABELS[a.harness]}
                </div>
                {!showModels ? (
                  <NACell lang={lang} />
                ) : models.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('compare.noData', lang)}</span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {models.map(m => {
                      // Every billed counter: a rate per million computed over the non-cached 4 %
                      // of the volume reads tens of times higher than what is actually charged.
                      const totalTok = totalTokens(m.tokens)
                      const unpricedModel = isUnpricedModel(m.model)
                      const perM = totalTok > 0 && !unpricedModel ? m.costUSD / (totalTok / 1e6) : null
                      return (
                        <div key={m.model} style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                          paddingBottom: 8,
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                              {modelLabel(m.model)}
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                              {unpricedModel ? UNPRICED_MODEL_LABEL[lang === 'pt' ? 'pt' : 'en'] : fmtCost(m.costUSD, currency, brlRate)}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                              {fmt(totalTok)} {t('compare.totalTokens', lang).toLowerCase()}
                            </span>
                            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                              {perM !== null ? `${fmtCost(perM, currency, brlRate)} / 1M` : '—'}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* Per-harness activity bar */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px 22px',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
          {t('compare.sessionShare', lang)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {aggs.map(a => {
            const totalSessions = aggs.reduce((s, x) => s + x.sessions, 0)
            const pct = totalSessions > 0 ? Math.round((a.sessions / totalSessions) * 100) : 0
            // A harness with real sessions must never read `0%`. Found in the browser: Codex CLI
            // and Kimi Code, one session each against 352, both rendered as `0%` beside a bar with
            // visible width — the label contradicting the chart next to it. The bar keeps the raw
            // `pct` (a 0-width bar is the honest picture of a rounding error); only the LABEL is
            // corrected, because a label is read as a claim.
            const pctLabel = tokenSharePct(a.sessions, totalSessions)
            return (
              <div key={a.harness}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: colors[a.harness],
                    }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {HARNESS_LABELS[a.harness]}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {a.sessions.toLocaleString()} {t('compare.sessionsLower', lang)}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: colors[a.harness], minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {pctLabel}
                    </span>
                  </div>
                </div>
                <div style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: colors[a.harness],
                    borderRadius: 3,
                    transition: 'width 0.4s ease-out',
                  }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Section 1: Usage by hour of day */}
      <SectionCard title={t('compare.usageByHourOfDay', lang)}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 16,
        }}>
          {aggs.map(a => {
            const s = summaries[a.harness]
            const totalMsgs = s?.hourCounts.reduce((acc, v) => acc + v, 0) ?? 0
            return (
              <div key={a.harness}>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors[a.harness], marginBottom: 8 }}>
                  {HARNESS_LABELS[a.harness]}
                </div>
                {totalMsgs === 0 ? (
                  <div style={{ height: 40, display: 'flex', alignItems: 'center' }}>
                    <NACell lang={lang} />
                  </div>
                ) : (
                  <>
                    <MiniBarChart
                      values={s?.hourCounts ?? Array(24).fill(0)}
                      color={colors[a.harness]}
                      peakIndex={s?.peakHour ?? null}
                      height={40}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>0h</span>
                      <span style={{ fontSize: 10, color: colors[a.harness], fontWeight: 600 }}>
                        {s?.peakHour !== null && s?.peakHour !== undefined
                          ? `${t('compare.peak', lang)} ${String(s.peakHour).padStart(2, '0')}:00`
                          : ''}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>23h</span>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* Section 2: Busiest day of week */}
      <SectionCard title={t('compare.busiestDayOfWeek', lang)}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 16,
        }}>
          {aggs.map(a => {
            const s = summaries[a.harness]
            const hasData = s && s.dowCounts.some(v => v > 0)
            return (
              <div key={a.harness}>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors[a.harness], marginBottom: 8 }}>
                  {HARNESS_LABELS[a.harness]}
                </div>
                {!hasData ? (
                  <div style={{ height: 40, display: 'flex', alignItems: 'center' }}>
                    <NACell lang={lang} />
                  </div>
                ) : (
                  <>
                    <MiniBarChart
                      values={s.dowCounts}
                      color={colors[a.harness]}
                      peakIndex={s.peakDow}
                      height={40}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      {dowLabels.map((label, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 9,
                            color: i === s.peakDow ? colors[a.harness] : 'var(--text-tertiary)',
                            fontWeight: i === s.peakDow ? 700 : 400,
                            flex: 1,
                            textAlign: 'center',
                          }}
                        >
                          {label.slice(0, 1)}
                        </span>
                      ))}
                    </div>
                    {s.peakDow !== null && (
                      <div style={{ fontSize: 11, color: colors[a.harness], fontWeight: 600, marginTop: 6 }}>
                        {t('compare.peak', lang)}: {dowLabels[s.peakDow]}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* Section 3: Activity over time */}
      <SectionCard title={t('compare.activityOverTime', lang)}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 16,
        }}>
          {aggs.map(a => {
            const s = summaries[a.harness]
            return (
              <div key={a.harness}>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors[a.harness], marginBottom: 8 }}>
                  {HARNESS_LABELS[a.harness]}
                </div>
                <SparklineChart
                  buckets={bucketize(s?.dailyActivity ?? [], minMs, maxMs, SPARK_BUCKETS)}
                  color={colors[a.harness]}
                  height={40}
                  noDataLabel={t('compare.noData', lang)}
                />
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  {s && s.dailyActivity.length > 0
                    ? `${fmtDateLocalized(s.dailyActivity[0]!.date, lang)} – ${fmtDateLocalized(s.dailyActivity[s.dailyActivity.length - 1]!.date, lang)}`
                    : t('compare.noData', lang)}
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* Section 4: Peaks (token day + session cost) */}
      <SectionCard title={t('compare.peaks', lang)}>
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${120 + aggs.length * 130}px` }}>
          <thead>
            <tr>
              <th style={{
                padding: '0 16px 10px 0',
                textAlign: 'left',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                borderBottom: '1px solid var(--border)',
              }}>
                {t('compare.metric', lang)}
              </th>
              {aggs.map(a => (
                <th key={a.harness} style={{
                  padding: '0 16px 10px',
                  textAlign: 'left',
                  fontSize: 11,
                  fontWeight: 700,
                  color: colors[a.harness],
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  borderBottom: `2px solid ${colors[a.harness]}`,
                  whiteSpace: 'nowrap',
                }}>
                  {HARNESS_LABELS[a.harness]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{
                padding: '12px 16px 12px 0',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
                borderBottom: '1px solid var(--border)',
              }}>
                {t('compare.peakTokenDay', lang)}
              </td>
              {aggs.map(a => {
                const s = summaries[a.harness]
                const ptd = capable(a.harness, 'tokens') ? s?.peakTokenDay : null
                return (
                  <td key={a.harness} style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    {!capable(a.harness, 'tokens') ? (
                      <NACell lang={lang} />
                    ) : ptd ? (
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(ptd.tokens)}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                          {fmtDateLocalized(ptd.date, lang)}
                        </div>
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
                    )}
                  </td>
                )
              })}
            </tr>
            <tr>
              <td style={{
                padding: '12px 16px 12px 0',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}>
                {t('compare.peakSessionCost', lang)}
              </td>
              {aggs.map(a => {
                const s = summaries[a.harness]
                const psc = capable(a.harness, 'cost') ? s?.peakSessionCost : null
                return (
                  <td key={a.harness} style={{ padding: '12px 16px' }}>
                    {!capable(a.harness, 'cost') ? (
                      <NACell lang={lang} />
                    ) : psc !== null && psc !== undefined ? (
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtCost(psc, currency, brlRate)}
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
                    )}
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
        </div>
      </SectionCard>
    </>
  )
}
