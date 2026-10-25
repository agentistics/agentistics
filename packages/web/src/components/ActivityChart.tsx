import React, { useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, LineChart, Line, Legend,
} from 'recharts'
import { format, parseISO } from 'date-fns'

interface Props {
  data: {
    date: string
    value: number
    sessions: number
    tools: number
  }[]
  height?: number
  theme?: 'dark' | 'light'
  /** Forces a specific metric and hides the metric selector (for catalog variants). */
  forcedMetric?: Metric
  /** Forces overlay mode and hides the metric selector (for catalog variants). */
  forcedOverlay?: boolean
  /** Hides all toggles (metric pills, Overlay All, Axes, Legend). */
  hideControls?: boolean
  /**
   * Overrides the pill/legend/tooltip labels for one or more of the three slots — defaults to
   * "Messages" / "Sessions" / "Tool Calls" when omitted, so every existing caller (the dashboard's
   * own heatmap, `componentCatalog.tsx`'s variants) is unaffected. A caller whose data means
   * something else — the task board's "Sessions started" / "Delivered" / "Created", say — passes
   * its own words rather than mislabeling counts that were never messages or tool calls.
   */
  metricLabels?: Partial<Record<Metric, string>>
}

type Metric = 'value' | 'sessions' | 'tools'

function getMetrics(
  theme?: 'dark' | 'light', labels?: Partial<Record<Metric, string>>,
): { key: Metric; label: string; color: string }[] {
  const messagesColor = theme === 'light' ? '#f97316' : '#D97706'
  return [
    { key: 'value', label: labels?.value ?? 'Messages', color: messagesColor },
    { key: 'sessions', label: labels?.sessions ?? 'Sessions', color: '#6366f1' },
    { key: 'tools', label: labels?.tools ?? 'Tool Calls', color: '#10b981' },
  ]
}

// DATA_METRICS computed per render inside the component

const CustomTooltip = ({ active, payload, label, isOverlay, rawData }: any) => {
  if (!active || !payload?.length) return null
  const raw = rawData?.find((d: any) => d.date === label)
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '10px 14px',
      fontSize: 12,
      boxShadow: 'var(--shadow-elevated)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        {label ? format(parseISO(label), 'MMM d, yyyy') : ''}
      </div>
      {payload.map((p: any) => {
        // In overlay mode show actual values, not normalized %
        const metricKey = p.dataKey.replace('_norm', '') as 'value' | 'sessions' | 'tools'
        const actualValue = isOverlay && raw ? raw[metricKey] : p.value
        return (
          <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', marginTop: 2 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: p.color }} />
            <span>{p.name}: </span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{actualValue}</span>
          </div>
        )
      })}
    </div>
  )
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 8px',
        borderRadius: 4,
        border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
        background: active ? 'var(--bg-elevated)' : 'transparent',
        color: active ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        fontSize: 10,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

export function ActivityChart({
  data, height = 180, theme, forcedMetric, forcedOverlay, hideControls, metricLabels,
}: Props) {
  const [metric, setMetric] = useState<Metric>(forcedMetric ?? 'value')
  const [overlayAll, setOverlayAll] = useState(forcedOverlay ?? false)
  const [showAxes, setShowAxes] = useState(true)
  const [showLegend, setShowLegend] = useState(true)
  const effectiveMetric: Metric = forcedMetric ?? metric
  const isOverlay = forcedOverlay ?? overlayAll
  const isLocked = forcedMetric !== undefined || forcedOverlay !== undefined || hideControls === true
  const METRICS = getMetrics(theme, metricLabels)
  const DATA_METRICS = METRICS as { key: 'value'|'sessions'|'tools'; label: string; color: string }[]

  const maxValues = {
    value: Math.max(...data.map(d => d.value), 1),
    sessions: Math.max(...data.map(d => d.sessions), 1),
    tools: Math.max(...data.map(d => d.tools), 1),
  }

  const chartData = data.map(d => ({
    ...d,
    displayDate: d.date,
    value_norm: Math.round((d.value / maxValues.value) * 100),
    sessions_norm: Math.round((d.sessions / maxValues.sessions) * 100),
    tools_norm: Math.round((d.tools / maxValues.tools) * 100),
  }))

  const activeLegendItems = isOverlay
    ? DATA_METRICS
    : DATA_METRICS.filter(m => m.key === effectiveMetric as string)

  return (
    <div>
      {/* Top bar: metric selector + toggles — hidden in locked/variant mode */}
      {!isLocked && (
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {METRICS.map(m => (
          <button
            key={m.key}
            onClick={() => { setMetric(m.key); setOverlayAll(false) }}
            style={{
              padding: '5px 12px',
              borderRadius: 20,
              border: !overlayAll && metric === m.key ? `1px solid ${m.color}60` : '1px solid var(--border)',
              background: !overlayAll && metric === m.key ? `${m.color}18` : 'transparent',
              color: !overlayAll && metric === m.key ? m.color : 'var(--text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s',
              fontFamily: 'inherit',
              opacity: overlayAll ? 0.5 : 1,
            }}
          >
            {m.label}
          </button>
        ))}
        {/* Overlay All toggle */}
        <button
          onClick={() => setOverlayAll(v => !v)}
          style={{
            padding: '5px 12px',
            borderRadius: 20,
            border: overlayAll ? '1px solid #8b5cf660' : '1px solid var(--border)',
            background: overlayAll ? '#8b5cf618' : 'transparent',
            color: overlayAll ? '#a78bfa' : 'var(--text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s',
            fontFamily: 'inherit',
          }}
        >
          Overlay All
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <ToggleBtn active={showAxes} onClick={() => setShowAxes(v => !v)}>Axes</ToggleBtn>
          <ToggleBtn active={showLegend} onClick={() => setShowLegend(v => !v)}>Legend</ToggleBtn>
        </div>
      </div>
      )}

      {/* Legend */}
      {showLegend && (
        <div style={{ display: 'flex', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
          {activeLegendItems.map(m => (
            <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 20, height: 2, borderRadius: 1, background: m.color }} />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{m.label}</span>
              {isOverlay && (
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                  (max {m.key === 'value' ? maxValues.value : m.key === 'sessions' ? maxValues.sessions : maxValues.tools})
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {data.length === 0 ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
          No data for this period
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={chartData} margin={{ left: -10, right: 4 }}>
            <defs>
              {DATA_METRICS.map(m => (
                <linearGradient key={m.key} id={`grad-${m.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={m.color} stopOpacity={isOverlay ? 0.12 : 0.3} />
                  <stop offset="100%" stopColor={m.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke="var(--border)" strokeDasharray="0" vertical={false} />
            {showAxes ? (
              <XAxis
                dataKey="displayDate"
                tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => {
                  try { return format(parseISO(v), 'MMM d') } catch { return v }
                }}
                interval="preserveStartEnd"
              />
            ) : (
              <XAxis dataKey="displayDate" hide />
            )}
            <YAxis hide />
            <Tooltip content={<CustomTooltip isOverlay={isOverlay} rawData={data} />} />
            {isOverlay
              ? DATA_METRICS.map(m => (
                  <Area
                    key={m.key}
                    type="monotone"
                    dataKey={`${m.key}_norm`}
                    stroke={m.color}
                    strokeWidth={1.5}
                    fill={`url(#grad-${m.key})`}
                    dot={false}
                    activeDot={{ r: 3, fill: m.color, stroke: 'var(--bg-base)', strokeWidth: 2 }}
                    name={m.label}
                  />
                ))
              : (() => {
                  const m = DATA_METRICS.find(x => x.key === (effectiveMetric as string)) ?? DATA_METRICS[0]
                  if (!m) return null
                  return (
                    <Area
                      type="monotone"
                      dataKey={m.key}
                      stroke={m.color}
                      strokeWidth={2}
                      fill={`url(#grad-${m.key})`}
                      dot={false}
                      activeDot={{ r: 4, fill: m.color, stroke: 'var(--bg-base)', strokeWidth: 2 }}
                      name={m.label}
                    />
                  )
                })()
            }
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

/** Evenly spaced, round-ish ticks across [min, max]: few enough to read at 390 px. */
export function timeTicks(min: number, max: number, count: number): number[] {
  if (!(max > min) || count < 2) return [min]
  const span = max - min
  const steps = [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000, 2 * 24 * 3_600_000, 3 * 24 * 3_600_000, 7 * 24 * 3_600_000]
  const step = steps.find(s => span / s <= count - 1) ?? steps[steps.length - 1]!
  // Day-or-longer steps align to the local midnight, the rest to the local hour.
  const align = (t: number) => { const d = new Date(t); if (step >= 24 * 3_600_000) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0); return d.getTime() }
  const ticks: number[] = []
  for (let t = align(min); t <= max; t += step) if (t >= min) ticks.push(t)
  return ticks.length ? ticks : [min, max]
}

/** Percent comparisons share the activity chart's frame, with a fixed scale and no normalization. */
export function ActivityPercentChart({ data, series, lang, height = 220 }: {
  data: { at: number; [key: string]: number | null }[]
  series: { key: string; label: string; color: string; expected?: boolean; connectNulls?: boolean }[]
  lang: 'pt' | 'en'
  height?: number
}) {
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US'
  const dateLabel = (at: number) => new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const min = data.length ? Math.min(...data.map(p => p.at)) : 0
  const max = data.length ? Math.max(...data.map(p => p.at)) : 0
  const short = max - min < 36 * 3_600_000
  const tickLabel = (at: number) => new Date(at).toLocaleString(locale, short ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' })
  const narrow = typeof window !== 'undefined' && window.innerWidth < 520
  const ticks = timeTicks(min, max, narrow ? 4 : 7)
  // The tooltip follows the pointer and leaves with it; on touch, a tap outside the chart closes it.
  const [open, setOpen] = useState(false)
  const box = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return <div ref={box} style={{ minWidth: 0 }} role="img" aria-label={series.map(s => s.label).join(' · ')} onMouseLeave={() => setOpen(false)}>
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ left: 0, right: 12, top: 8 }} onMouseMove={() => setOpen(true)} onClick={() => setOpen(true)}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={tickLabel} tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={v => `${v}%`} width={38} tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }} axisLine={false} tickLine={false} />
        <Tooltip active={open ? undefined : false} labelFormatter={v => dateLabel(Number(v))} formatter={v => v == null ? '—' : `${Number(v).toFixed(1)}%`} contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }} />
        <Legend wrapperStyle={{ fontSize: 11, overflowWrap: 'anywhere' }} />
        {series.map(s => <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeDasharray={s.expected ? '5 4' : undefined} strokeWidth={s.expected ? 1.5 : 2} type="linear" dot={!s.expected && data.length < 3} activeDot={s.expected ? false : { r: 3 }} connectNulls={s.connectNulls ?? false} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer>
  </div>
}
