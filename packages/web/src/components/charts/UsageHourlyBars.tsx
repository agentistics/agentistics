import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { timeTicks } from '../ActivityChart'

export function UsageHourlyBars({ data, series, lang, messages = false, timeRange }: {
  data: { at: number; [key: string]: number }[]
  series: { key: string; label: string; color: string }[]
  lang: 'pt' | 'en'; messages?: boolean; timeRange?: [number, number]
}) {
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US'
  const date = (at: number) => new Date(at).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const min = timeRange?.[0] ?? data[0]?.at ?? 0, max = timeRange?.[1] ?? data.at(-1)?.at ?? 0
  return <div style={{ minWidth: 0 }} role="img" aria-label={lang === 'pt' ? 'Uso por hora' : 'Hourly use'}>
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ right: 12 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="at" type="number" domain={[min, max]} ticks={timeTicks(min, max, 4)} tickFormatter={date} tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
        <YAxis width={42} tickFormatter={v => messages ? String(v) : `${v}%`} tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
        <Tooltip labelFormatter={v => date(Number(v))} formatter={(v, name) => [`${Number(v).toFixed(messages ? 0 : 1)}${messages ? (lang === 'pt' ? ' mensagens' : ' messages') : (lang === 'pt' ? '% do limite usado' : '% of limit used')}`, name]}
          contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }} />
        <Legend wrapperStyle={{ fontSize: 11, overflowWrap: 'anywhere' }} />
        {series.map(s => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} stackId="usage" isAnimationActive={false} maxBarSize={18} />)}
      </BarChart>
    </ResponsiveContainer>
  </div>
}
