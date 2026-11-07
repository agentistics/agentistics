/**
 * EvolutionKpis — the summary cards at the top of "Evolução de entregas". Each card is one measured figure, its change
 * against the window just before (when the period allows one), and a sparkline of the same metric over the chart axis.
 * A figure nobody could measure reads "—" with the reason underneath; it is never drawn as 0.
 */
import { Ban, CheckCircle2, Clock, Coins, RotateCcw, Target, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Metrics, MetricsReply } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { TEXT, pick } from './evolutionText'
import { deltaOf, fmtDur, fmtNum, fmtPct, type Delta } from './evolutionModel'

/** A polyline of the values; a missing value breaks the line instead of joining across the gap. */
export function Spark({ values, color }: { values: (number | null)[]; color: string }) {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (real.length < 2) return <div style={{ height: 22 }} aria-hidden />
  const min = Math.min(...real), max = Math.max(...real), span = max - min || 1
  const w = 100, h = 22, step = values.length > 1 ? w / (values.length - 1) : w
  const segs: string[] = []
  let cur: string[] = []
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return // a sparkline is a glance: it joins across a gap (the charts below do not)
    cur.push(`${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
  })
  if (cur.length) segs.push(cur.join(' '))
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={h} aria-hidden style={{ display: 'block' }}>
      {segs.map((p, i) => <polyline key={i} points={p} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
    </svg>
  )
}

function DeltaTag({ d, pt, hasPrior }: { d: Delta | null; pt: boolean; hasPrior: boolean }) {
  // An open period has no window before it: say nothing rather than repeat "no comparison" on every card.
  if (!hasPrior) return null
  if (!d) return <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{pick(TEXT.noCompare, pt)}</span>
  const color = d.tone === 'good' ? 'var(--accent-green)' : d.tone === 'bad' ? 'var(--accent-red)' : 'var(--text-tertiary)'
  const Icon = d.tone === 'flat' ? Minus : d.pct < 0 ? TrendingDown : TrendingUp
  const text = d.tone === 'flat' ? pick(TEXT.stable, pt) : `${d.pct > 0 ? '+' : '−'}${Math.round(Math.abs(d.pct) * 100)}%`
  return (
    <span data-evo-delta={d.tone} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color }}>
      <Icon size={11} aria-hidden /> {text} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{pick(TEXT.vsPrior, pt)}</span>
    </span>
  )
}

function Kpi({ id, icon, name, value, unit, note, delta, spark, color, pt, hasPrior }: {
  id: string; icon: ReactNode; name: string; value: string; unit?: string; note?: string; delta: Delta | null; spark: (number | null)[]; color: string; pt: boolean; hasPrior: boolean
}) {
  return (
    <div data-evo-kpi={id} style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, boxSizing: 'border-box',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }}>
        <span style={{ display: 'inline-flex', color }}>{icon}</span>{name}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>{value}</span>
        {unit && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{unit}</span>}
      </div>
      <div style={{ minHeight: hasPrior ? 16 : 0 }}><DeltaTag d={delta} pt={pt} hasPrior={hasPrior} /></div>
      {note && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{note}</div>}
      <Spark values={spark} color={color} />
    </div>
  )
}

export function EvolutionKpis({ reply, pt, cost }: { reply: MetricsReply; pt: boolean; cost: (usd: number) => string }) {
  const isMobile = useIsMobile()
  const s: Metrics = reply.summary, p = reply.prior
  const series = (of: (m: Metrics) => number | null) => reply.groups.map(g => of(g.metrics))
  const costValue = s.costPerPublishedUSD
  return (
    <div data-evo-kpis style={{ display: 'grid', gap: 10, gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(6, minmax(0, 1fr))' }}>
      <Kpi hasPrior={p !== null} id="lead" pt={pt} icon={<Clock size={13} />} color="#f5a623" name={pick(TEXT.kpiLead, pt)}
        value={fmtDur(s.leadP50Ms, pt)} unit={s.leadP90Ms !== null ? `p90 ${fmtDur(s.leadP90Ms, pt)}` : undefined}
        delta={p ? deltaOf(s.leadP50Ms, p.leadP50Ms, true) : null} spark={series(m => m.leadP50Ms)}
        {...(s.published === 0 ? { note: pick(TEXT.noPublished, pt) } : {})} />
      <Kpi hasPrior={p !== null} id="published" pt={pt} icon={<CheckCircle2 size={13} />} color="#26b573" name={pick(TEXT.kpiPublished, pt)}
        value={fmtNum(s.published, pt)} unit={pick(TEXT.ofRequested(s.n), pt)}
        delta={p ? deltaOf(s.published, p.published, false) : null} spark={series(m => m.published)} />
      <Kpi hasPrior={p !== null} id="qa" pt={pt} icon={<RotateCcw size={13} />} color="#4c9aff" name={pick(TEXT.kpiQa, pt)}
        value={fmtPct(s.qaRejectionRate, pt)} unit={s.qaN ? `${s.qaRejected} / ${s.qaN}` : undefined}
        delta={p ? deltaOf(s.qaRejectionRate, p.qaRejectionRate, true) : null} spark={series(m => m.qaRejectionRate)}
        {...(s.qaN === 0 ? { note: pick(TEXT.noQaYet, pt) } : {})} />
      <Kpi hasPrior={p !== null} id="eta" pt={pt} icon={<Target size={13} />} color="#b78bff" name={pick(TEXT.kpiEta, pt)}
        value={fmtPct(s.etaRate, pt)} unit={s.etaN ? `±25% · ${s.etaN}` : undefined}
        delta={p ? deltaOf(s.etaRate, p.etaRate, false) : null} spark={series(m => m.etaRate)}
        {...(s.etaN === 0 ? { note: pick(TEXT.noEtaStored, pt) } : s.noEta > 0 ? { note: pick(TEXT.noEtaCount(s.noEta), pt) } : {})} />
      <Kpi hasPrior={p !== null} id="cost" pt={pt} icon={<Coins size={13} />} color="#818cf8" name={pick(TEXT.kpiCost, pt)}
        value={costValue === null ? '—' : cost(costValue)} unit={costValue === null ? undefined : pick(TEXT.perPublished, pt)}
        delta={p ? deltaOf(costValue, p.costPerPublishedUSD, true) : null} spark={series(m => m.costPerPublishedUSD)}
        {...(costValue === null ? { note: pick(TEXT.noCost, pt) } : {})} />
      <Kpi hasPrior={p !== null} id="blocks" pt={pt} icon={<Ban size={13} />} color="#c2410c" name={pick(TEXT.kpiBlocks, pt)}
        value={fmtNum(s.blockedAny, pt)} unit={`${s.blockedNow} ${pick(TEXT.now, pt)} · ${fmtDur(s.blockMs, pt)}`}
        delta={p ? deltaOf(s.blockMs, p.blockMs, true) : null} spark={series(m => m.blockMs)} />
    </div>
  )
}
