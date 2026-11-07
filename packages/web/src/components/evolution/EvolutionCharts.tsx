/**
 * EvolutionCharts — the drawings of "Evolução de entregas": the pipeline funnel with its bottleneck, the average time
 * per stage over the grouping axis, and the three trend charts (lead time, quality, cost). recharts, like the rest of
 * the app, in the app's own colour variables. Every chart is a view of the reply the server computed; none derives a
 * metric. A series with no measured point is not drawn at all and the card says why.
 */
import { AlertTriangle } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Bottleneck, FunnelRow, MetricGroup, MetricsReply, TimeBucket } from '@agentistics/core'
import { NONE_KEY } from '@agentistics/core'
import { STAGE_LABEL } from '../tasks/liveDeliveryModel'
import { TEXT, pick } from './evolutionText'
import { STAGE_ORDER, fmtDur, fmtPct } from './evolutionModel'

const H = 3_600_000
const AXIS = { fontSize: 10, fill: 'var(--text-secondary)' }
const TIP = { background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12 }
const stageColor = (s: TimeBucket): string => STAGE_LABEL[s].color
const stageName = (s: TimeBucket, pt: boolean): string => (pt ? STAGE_LABEL[s].pt : STAGE_LABEL[s].en)

/** The label a group wears on the axis: its short form, or the no-value bucket's words. */
export const groupShort = (g: MetricGroup, pt: boolean): string => (g.key === NONE_KEY ? pick(TEXT.noValue, pt) : g.short)
export const groupLabel = (g: MetricGroup, pt: boolean): string => (g.key === NONE_KEY ? pick(TEXT.noValue, pt) : g.label)

function Legendish({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
      {items.map(i => <span key={i.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: i.color, display: 'inline-block' }} />{i.name}</span>)}
    </div>
  )
}

export function Funnel({ rows, blockedAny, blockedMs, bottleneck, pt }: { rows: FunnelRow[]; blockedAny: number; blockedMs: number; bottleneck: Bottleneck | null; pt: boolean }) {
  const top = Math.max(1, ...rows.map(r => r.reached))
  return (
    <div data-evo-funnel>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 1.1fr) 2fr 34px 58px', gap: '4px 8px', alignItems: 'center', fontSize: 12 }}>
        <span /><span />
        <span style={{ textAlign: 'right', fontSize: 10.5, color: 'var(--text-tertiary)' }}>{pick(TEXT.deliveries, pt)}</span>
        <span style={{ textAlign: 'right', fontSize: 10.5, color: 'var(--text-tertiary)' }}>{pick(TEXT.median, pt)}</span>
        {rows.map(r => {
          const isBn = bottleneck?.stage === r.stage
          return (
            <div key={r.stage} data-evo-funnel-stage={r.stage} style={{ display: 'contents' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, color: 'var(--text-primary)' }}>
                <i style={{ width: 8, height: 8, borderRadius: 4, background: stageColor(r.stage), flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stageName(r.stage, pt)}</span>
                {isBn && <em style={{ fontStyle: 'normal', fontSize: 9.5, fontWeight: 700, color: 'var(--accent-amber)', border: '1px solid var(--accent-amber)', borderRadius: 4, padding: '0 4px' }}>{pick(TEXT.bottleneckTag, pt)}</em>}
              </span>
              <span style={{ height: 8, background: 'var(--bg-elevated)', borderRadius: 4, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${(r.reached / top) * 100}%`, background: stageColor(r.stage), borderRadius: 4 }} />
              </span>
              <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }} title={pick(TEXT.hereNow(r.now), pt)}>{r.reached}</span>
              <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtDur(r.medianMs, pt)}</span>
            </div>
          )
        })}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)' }}>
          <i style={{ width: 8, height: 8, borderRadius: 4, background: stageColor('blocked'), flexShrink: 0 }} />{pick(TEXT.blockedParallel, pt)}
        </span>
        <span style={{ height: 8, background: 'var(--bg-elevated)', borderRadius: 4, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${(blockedAny / top) * 100}%`, background: stageColor('blocked'), borderRadius: 4 }} />
        </span>
        <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{blockedAny}</span>
        <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{blockedAny ? fmtDur(blockedMs / blockedAny, pt) : '—'}</span>
      </div>
    </div>
  )
}

export function BottleneckCall({ b, pt }: { b: Bottleneck | null; pt: boolean }) {
  if (!b) return <p data-evo-bottleneck="none" style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{pick(TEXT.noBottleneck, pt)}</p>
  const worst = b.byAuthor[0], best = b.byAuthor[b.byAuthor.length - 1]
  const name = (m: string) => (m === NONE_KEY ? pick(TEXT.unknownModel, pt) : m)
  const max = Math.max(1, ...b.byAuthor.map(a => a.avgMs))
  return (
    <div data-evo-bottleneck={b.stage} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--accent-amber)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        <AlertTriangle size={13} aria-hidden /> {pick(TEXT.bottleneck, pt)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
        <i style={{ width: 10, height: 10, borderRadius: 5, background: stageColor(b.stage) }} />{stageName(b.stage, pt)}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
        {Math.round(b.share * 100)}%<small style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 6 }}>{pick(TEXT.ofTotalTime, pt)}</small>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {pick(TEXT.bottleneckSentence(fmtDur(b.avgMs, pt), stageName(b.stage, pt).toLowerCase()), pt)}
        {worst && best && worst.model !== best.model && ` ${pick(TEXT.bottleneckByAuthor(name(worst.model), fmtDur(worst.avgMs, pt), name(best.model), fmtDur(best.avgMs, pt)), pt)}`}
      </p>
      {b.byAuthor.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {b.byAuthor.slice(0, 5).map(a => (
            <div key={a.model} style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 1fr) 2fr 52px', gap: 8, alignItems: 'center', fontSize: 11.5 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }} title={name(a.model)}>{name(a.model)}</span>
              <span style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${(a.avgMs / max) * 100}%`, background: stageColor(b.stage) }} /></span>
              <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtDur(a.avgMs, pt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Average time per stage for each bucket of the grouping axis, stacked. Hours on the axis, the exact words in the tip. */
export function StageStack({ groups, pt, height }: { groups: MetricGroup[]; pt: boolean; height: number }) {
  const data = groups.map(g => ({ label: groupShort(g, pt), full: groupLabel(g, pt), n: g.metrics.published, ...Object.fromEntries(STAGE_ORDER.map(s => [s, g.metrics.stageAvgMs[s] / H])) }))
  if (!groups.some(g => g.metrics.published > 0)) return <Nothing text={pick(TEXT.noPublishedChart, pt)} />
  return (
    <div role="img" aria-label={pick(TEXT.stageChart, pt)} data-evo-chart="stages">
      <Legendish items={STAGE_ORDER.map(s => ({ name: stageName(s, pt), color: stageColor(s) }))} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ right: 8, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} interval="preserveStartEnd" />
          <YAxis width={40} tick={AXIS} tickFormatter={v => fmtDur(Number(v) * H, pt)} />
          <Tooltip contentStyle={TIP} labelFormatter={(_, p) => { const d = p?.[0]?.payload as { full?: string; n?: number } | undefined; return `${d?.full ?? ''} · ${pick(TEXT.publishedN(d?.n ?? 0), pt)}` }}
            formatter={(v, name) => [fmtDur(Number(v) * H, pt), name]} />
          {STAGE_ORDER.map(s => <Bar key={s} dataKey={s} name={stageName(s, pt)} stackId="t" fill={stageColor(s)} isAnimationActive={false} maxBarSize={28} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function Nothing({ text }: { text: string }) {
  return <div data-evo-chart-empty style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{text}</div>
}

interface Series { key: string; name: string; color: string; dash?: boolean; pick: (g: MetricGroup) => number | null }

function Trend({ id, groups, series, fmt, pt, height, width = 40, emptyText }: {
  id: string; groups: MetricGroup[]; series: Series[]; fmt: (v: number) => string; pt: boolean; height: number; width?: number; emptyText: string
}) {
  const live = series.filter(s => groups.some(g => s.pick(g) !== null))
  if (live.length === 0) return <Nothing text={emptyText} />
  const data = groups.map(g => ({ label: groupShort(g, pt), full: groupLabel(g, pt), n: g.metrics.published, ...Object.fromEntries(live.map(s => [s.key, s.pick(g)])) }))
  return (
    <div role="img" aria-label={id} data-evo-chart={id}>
      <Legendish items={live.map(s => ({ name: s.name, color: s.color }))} />
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ right: 8, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} interval="preserveStartEnd" />
          <YAxis width={width} tick={AXIS} tickFormatter={v => fmt(Number(v))} />
          <Tooltip contentStyle={TIP} labelFormatter={(_, p) => { const d = p?.[0]?.payload as { full?: string; n?: number } | undefined; return `${d?.full ?? ''} · ${pick(TEXT.publishedN(d?.n ?? 0), pt)}` }}
            formatter={(v, name) => [fmt(Number(v)), name]} />
          {live.map(s => <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash ? '4 3' : undefined} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function LeadTrend({ reply, pt, height }: { reply: MetricsReply; pt: boolean; height: number }) {
  return <Trend id="lead" groups={reply.groups} pt={pt} height={height} fmt={v => fmtDur(v, pt)} width={48} emptyText={pick(TEXT.noPublishedChart, pt)}
    series={[{ key: 'p50', name: 'p50', color: '#f5a623', pick: g => g.metrics.leadP50Ms }, { key: 'p90', name: 'p90', color: '#fbbf77', dash: true, pick: g => g.metrics.leadP90Ms }]} />
}

export function QualityTrend({ reply, pt, height }: { reply: MetricsReply; pt: boolean; height: number }) {
  return <Trend id="quality" groups={reply.groups} pt={pt} height={height} fmt={v => fmtPct(v, pt)} emptyText={pick(TEXT.noQaChart, pt)}
    series={[
      { key: 'rej', name: pick(TEXT.rejectedQa, pt), color: '#ff5f5f', pick: g => g.metrics.qaRejectionRate },
      { key: 'eta', name: pick(TEXT.etaWithin, pt), color: '#b78bff', dash: true, pick: g => g.metrics.etaRate },
    ]} />
}

export function CostTrend({ reply, pt, height, cost }: { reply: MetricsReply; pt: boolean; height: number; cost: (usd: number) => string }) {
  return <Trend id="cost" groups={reply.groups} pt={pt} height={height} fmt={cost} width={58} emptyText={pick(TEXT.noCostChart, pt)}
    series={[{ key: 'cost', name: pick(TEXT.costPerDelivery, pt), color: '#818cf8', pick: g => g.metrics.costPerPublishedUSD }]} />
}
