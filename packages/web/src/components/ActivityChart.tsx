import React, { useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
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
