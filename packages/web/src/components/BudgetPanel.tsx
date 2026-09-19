import React, { useMemo, useState } from 'react'
import { Target, TrendingUp, AlertTriangle, CheckCircle2, Pencil, Check, X } from 'lucide-react'
import { parseISO } from 'date-fns'
import type { StatsCache, Lang, HarnessId } from '@agentistics/core'
import { getModelPrice, fmtCost } from '@agentistics/core'
import { NAtag } from './NAtag'

interface Props {
  statsCache: StatsCache
  budgetUSD: number | null
  onBudgetChange: (v: number | null) => void
  currency: 'USD' | 'BRL'
  brlRate: number
  /**
   * What the registered plans commit to this month, when there are any.
   *
   * The panel does NOT convert its tracking to plan basis, on purpose: it forecasts VARIABLE
   * spend from the pace so far, and a subscription has no pace — it is a fixed number known on
   * day one. Converting would leave a forecast that only ever predicts itself. What the plan
   * basis genuinely adds here is a second, fixed line the budget can be read against, which is
   * what this prop is.
   */
  monthlyCommitmentUSD?: number | null
  /** The commitment is prorated because a plan started or ended mid-month. */
  commitmentPartial?: boolean
  lang: Lang
  /**
   * The active harness filter (undefined = unified / all-harness view).
   * BudgetPanel reads Claude's stats-cache which is Claude-only data.
   * When a non-claude harness is active we show N/A instead of surfacing
   * Claude's spend as if it were the selected harness's spend.
   */
  harness?: HarnessId
}


/**
 * Current-month spend using global modelUsage proportions, same method as useDerivedStats.
 *
 * The cache-write portion is TTL-aware WHEN `g` (`statsCache.modelUsage[modelId]`) states the
 * split — `g` is `ModelUsage`-shaped, so it CAN carry `cacheCreation1hInputTokens`/
 * `cacheCreation5mInputTokens` (see that field's own doc). Apportioned by the SAME `tokens/gTotal`
 * share every other counter here already uses, so a 1h/5m split found this way stays consistent
 * with how the day's input/output/cacheRead shares are derived.
 *
 * In practice this stays the "genuinely cannot know" fallback today: `statsCache.modelUsage` is
 * Claude's own `stats-cache.json` aggregate (recent days added by this server's
 * `supplementStatsCache`, which also has no TTL granularity to accumulate — see `data.ts`), and
 * neither source has ever written the two split fields onto it. So `has1hSplit` is false for every
 * real row today and this prices the whole apportioned cache-write volume at the 5-minute rate,
 * exactly as before this field existed — the conservative reading, not a guess, same as `calcCost`
 * falls back to for a record with no breakdown. The branch exists so a future aggregate-level split
 * (the natural follow-up the round-2 review names) is priced correctly the day it lands, without
 * anyone having to remember this function.
 */
export function computeMonthCost(statsCache: StatsCache, monthStart: Date, now: Date): number {
  const globalModelUsage = statsCache.modelUsage ?? {}
  let total = 0
  for (const day of statsCache.dailyModelTokens ?? []) {
    const date = parseISO(day.date)
    if (date < monthStart) continue
    if (date > now) continue
    for (const [modelId, tokens] of Object.entries(day.tokensByModel)) {
      const g = globalModelUsage[modelId]
      const gTotal = g
        ? (g.inputTokens + g.outputTokens + g.cacheReadInputTokens + g.cacheCreationInputTokens)
        : 0
      if (gTotal > 0 && g) {
        const price = getModelPrice(modelId)
        total += (tokens * g.inputTokens / gTotal / 1_000_000) * price.input
        total += (tokens * g.outputTokens / gTotal / 1_000_000) * price.output
        total += (tokens * g.cacheReadInputTokens / gTotal / 1_000_000) * price.cacheRead
        const has1hSplit = g.cacheCreation1hInputTokens !== undefined
          && g.cacheCreation5mInputTokens !== undefined
        if (has1hSplit) {
          total += (tokens * (g.cacheCreation1hInputTokens ?? 0) / gTotal / 1_000_000) * price.cacheWrite1h
          total += (tokens * (g.cacheCreation5mInputTokens ?? 0) / gTotal / 1_000_000) * price.cacheWrite
        } else {
          total += (tokens * g.cacheCreationInputTokens / gTotal / 1_000_000) * price.cacheWrite
        }
      } else {
        // Fallback: 70% input / 30% output at Sonnet rates
        total += (tokens * 0.7 / 1_000_000) * 3 + (tokens * 0.3 / 1_000_000) * 15
      }
    }
  }
  return total
}

export function BudgetPanel({ statsCache, budgetUSD, onBudgetChange, currency, brlRate, monthlyCommitmentUSD = null, commitmentPartial = false, lang, harness }: Props) {
  const pt = lang === 'pt'
  const [editing, setEditing] = useState(false)
  const displayBudget = budgetUSD !== null
    ? (currency === 'BRL' ? budgetUSD * brlRate : budgetUSD)
    : null
  const [draft, setDraft] = useState(displayBudget !== null ? String(Math.round(displayBudget * 100) / 100) : '')

  const { monthSpend, forecast, daysElapsed, daysInMonth, monthLabel } = useMemo(() => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const dInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const dElapsed = now.getDate()
    const spend = computeMonthCost(statsCache, monthStart, now)
    const fc = dElapsed > 0 ? (spend / dElapsed) * dInMonth : 0
    const formatter = new Intl.DateTimeFormat(pt ? 'pt-BR' : 'en-US', { month: 'long', year: 'numeric' })
    return {
      monthSpend: spend,
      forecast: fc,
      daysElapsed: dElapsed,
      daysInMonth: dInMonth,
      monthLabel: formatter.format(now),
    }
  }, [statsCache, pt])

  // BudgetPanel reads the Claude stats-cache (Claude-only aggregate data).
  // Showing it for a non-claude harness would mislead the user into thinking
  // they're seeing that harness's spend. Show N/A for any non-claude harness.
  if (harness && harness !== 'claude') {
    return <NAtag harness={harness} label="Budget & forecast" />
  }

  function save() {
    const v = parseFloat(draft.replace(',', '.'))
    if (!isNaN(v) && v > 0) {
      // Convert to USD if user typed in BRL
      const usd = currency === 'BRL' && brlRate > 0 ? v / brlRate : v
      onBudgetChange(usd)
    } else if (draft.trim() === '') {
      onBudgetChange(null)
    }
    setEditing(false)
  }

  function cancel() {
    setDraft(displayBudget !== null ? String(Math.round(displayBudget * 100) / 100) : '')
    setEditing(false)
  }

  const hasBudget = budgetUSD !== null && budgetUSD > 0
  const spendPct = hasBudget ? Math.min(1, monthSpend / budgetUSD!) : 0
  const forecastPct = hasBudget ? forecast / budgetUSD! : 0
  const overForecast = hasBudget && forecast > budgetUSD!
  const overSpend = hasBudget && monthSpend > budgetUSD!

  const statusColor = overSpend
    ? '#ef4444'
    : overForecast
      ? '#f59e0b'
      : hasBudget
        ? 'var(--accent-green, #22c55e)'
        : 'var(--text-tertiary)'

  const statusIcon = overSpend
    ? <AlertTriangle size={13} />
    : overForecast
      ? <AlertTriangle size={13} />
      : hasBudget
        ? <CheckCircle2 size={13} />
        : <Target size={13} />

  const statusLabel = overSpend
    ? (pt ? 'Orçamento estourado' : 'Over budget')
    : overForecast
      ? (pt ? 'Projeção passa do limite' : 'Forecast over budget')
      : hasBudget
        ? (pt ? 'Dentro do orçamento' : 'On track')
        : (pt ? 'Sem orçamento definido' : 'No budget set')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
          <span>{monthLabel}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{pt
            ? `dia ${daysElapsed} de ${daysInMonth}`
            : `day ${daysElapsed} of ${daysInMonth}`}</span>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          color: statusColor,
          fontSize: 11, fontWeight: 600,
        }}>
          {statusIcon}
          {statusLabel}
        </div>
      </div>

      {/* Numbers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
        <Stat
          label={pt ? 'Gasto no mês' : 'Month spend'}
          value={fmtCost(monthSpend, currency, brlRate)}
          sub={pt ? `até ${daysElapsed}º dia` : `through day ${daysElapsed}`}
          accent="var(--anthropic-orange)"
        />
        <Stat
          label={pt ? 'Projeção do mês' : 'Month forecast'}
          value={fmtCost(forecast, currency, brlRate)}
          sub={pt ? 'extrapolação linear' : 'linear projection'}
          accent={overForecast ? '#f59e0b' : 'var(--accent-blue, #3b82f6)'}
        />
        {/* The fixed line beside the variable ones. It is NOT a conversion of the two above —
            those forecast usage from a pace, and a subscription has no pace. This is what you owe
            whatever the pace turns out to be. */}
        {monthlyCommitmentUSD !== null && monthlyCommitmentUSD > 0 && (
          <Stat
            label={pt ? 'Compromisso do mês' : 'Month commitment'}
            value={fmtCost(monthlyCommitmentUSD, currency, brlRate)}
            sub={commitmentPartial
              ? (pt ? 'proporcional — plano mudou no mês' : 'prorated — plan changed mid-month')
              : (pt ? 'assinaturas cadastradas' : 'registered subscriptions')}
            accent="var(--accent-green, #22c55e)"
          />
        )}
        <div style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {pt ? 'Orçamento mensal' : 'Monthly budget'}
            </span>
            {!editing && (
              <button
                onClick={() => { setDraft(displayBudget !== null ? String(Math.round(displayBudget * 100) / 100) : ''); setEditing(true) }}
                title={pt ? 'Editar' : 'Edit'}
                style={{
                  width: 20, height: 20, padding: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'transparent', border: 'none',
                  color: 'var(--text-tertiary)', cursor: 'pointer', borderRadius: 4,
                }}
              >
                <Pencil size={10} />
              </button>
            )}
          </div>
          {editing ? (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600 }}>
                {currency === 'BRL' ? 'R$' : '$'}
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') save()
                  if (e.key === 'Escape') cancel()
                }}
                placeholder={pt ? 'ex: 50' : 'e.g. 50'}
                style={{
                  flex: 1, minWidth: 0,
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '4px 7px',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                  outline: 'none',
                }}
              />
              <button
                onClick={save}
                title={pt ? 'Salvar' : 'Save'}
                style={{ width: 22, height: 22, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--accent-green, #22c55e)', cursor: 'pointer', borderRadius: 4 }}
              >
                <Check size={12} />
              </button>
              <button
                onClick={cancel}
                title={pt ? 'Cancelar' : 'Cancel'}
                style={{ width: 22, height: 22, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', borderRadius: 4 }}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 18, fontWeight: 700, color: hasBudget ? 'var(--text-primary)' : 'var(--text-tertiary)', lineHeight: 1.1 }}>
              {hasBudget ? fmtCost(budgetUSD!, currency, brlRate) : (pt ? '— definir' : '— set one')}
            </div>
          )}
          {!editing && hasBudget && (
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
              {pt ? 'clique no lápis para editar' : 'click pencil to edit'}
            </div>
          )}
        </div>
      </div>

      {/* Dual-bar progress */}
      {hasBudget && (
        <div style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
              {pt ? 'Progresso' : 'Progress'}
            </span>
            <span style={{ color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(spendPct * 100)}% {pt ? 'gasto' : 'spent'}
              {' · '}
              <span style={{ color: overForecast ? '#f59e0b' : 'var(--text-tertiary)' }}>
                {Math.round(forecastPct * 100)}% {pt ? 'projeção' : 'forecast'}
              </span>
            </span>
          </div>

          {/* Bar */}
          <div style={{ position: 'relative', height: 10, background: 'var(--bg-card)', borderRadius: 5, overflow: 'hidden' }}>
            {/* Forecast (lighter, behind) */}
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${Math.min(100, forecastPct * 100)}%`,
              background: overForecast ? 'rgba(245,158,11,0.35)' : 'rgba(59,130,246,0.25)',
              borderRadius: 5,
              transition: 'width 0.5s ease',
            }} />
            {/* Actual spend (solid, on top) */}
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${spendPct * 100}%`,
              background: overSpend
                ? 'linear-gradient(90deg, #ef4444, #f97316)'
                : 'linear-gradient(90deg, var(--anthropic-orange), rgba(217,119,6,0.7))',
              borderRadius: 5,
              transition: 'width 0.5s ease',
            }} />
            {/* Budget marker at 100% */}
            <div style={{
              position: 'absolute',
              left: '100%',
              top: -2, bottom: -2,
              width: 2,
              background: 'var(--text-tertiary)',
              opacity: 0.6,
              transform: 'translateX(-2px)',
            }} />
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--text-tertiary)' }}>
            <LegendDot color="var(--anthropic-orange)" label={pt ? 'Gasto real' : 'Actual'} />
            <LegendDot
              color={overForecast ? '#f59e0b' : 'var(--accent-blue, #3b82f6)'}
              label={pt ? 'Projeção fim do mês' : 'End-of-month forecast'}
            />
            <LegendDot color="var(--text-tertiary)" label={pt ? 'Limite' : 'Budget'} />
          </div>
        </div>
      )}

      {/* Advice row */}
      <div style={{
        display: 'flex',
        gap: 6,
        fontSize: 11,
        color: 'var(--text-secondary)',
        lineHeight: 1.5,
      }}>
        <TrendingUp size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--text-tertiary)' }} />
        {hasBudget ? (
          overSpend ? (
            <span>
              {pt
                ? `Orçamento estourado em ${fmtCost(monthSpend - budgetUSD!, currency, brlRate)}. Veja o painel de cache acima — melhorar o hit rate é o jeito mais rápido de cortar custo.`
                : `Budget exceeded by ${fmtCost(monthSpend - budgetUSD!, currency, brlRate)}. Check the cache panel above — improving hit rate is the fastest way to cut cost.`}
            </span>
          ) : overForecast ? (
            <span>
              {pt
                ? `No ritmo atual, você vai passar do limite em ${fmtCost(forecast - budgetUSD!, currency, brlRate)}.`
                : `At current pace, you'll overshoot the budget by ${fmtCost(forecast - budgetUSD!, currency, brlRate)}.`}
            </span>
          ) : (
            <span>
              {pt
                ? `Sobra ${fmtCost(budgetUSD! - forecast, currency, brlRate)} até o fim do mês segundo a projeção.`
                : `Projected ${fmtCost(budgetUSD! - forecast, currency, brlRate)} of headroom by month end.`}
            </span>
          )
        ) : (
          <span>
            {pt
              ? 'Defina um orçamento mensal para ver a projeção e alertas visuais quando estiver saindo do trilho.'
              : 'Set a monthly budget to see the forecast and visual alerts when you\'re drifting off track.'}
          </span>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 10,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent, lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{sub}</div>
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  )
}
