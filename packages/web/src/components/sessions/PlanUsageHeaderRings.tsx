import { usePlanLimits, currentUsedPct, windowShortLabel, windowLabel, resetPhrase } from '../../lib/planLimits'
import { requestNayTab } from '../../lib/nayDockRequests'
import { PlanUsageRing, LimitLevelIcon } from '../PlanLimitMeter'
import { HarnessMark } from './HarnessMark'
import { HARNESS_LABELS } from '../../lib/harness'

export function PlanUsageHeaderRings({ lang }: { lang: 'pt' | 'en' }) {
  const { limits, registered, now } = usePlanLimits()
  if (limits === null) return null
  const known = new Set(limits.map(l => l.harness))
  const rows = [...limits.map(l => ({ l, plan: l.plan ?? l.sourcePlan, harness: l.harness })), ...registered.filter(r => !known.has(r.harness)).map(r => ({ l: null, plan: r.plan, harness: r.harness }))]
  if (!rows.length) return null
  const label = rows.map(row => {
    if (!row.l) return `${HARNESS_LABELS[row.harness]} — ${lang === 'pt' ? 'aguardando leitura' : 'waiting for the first reading'}`
    const w = row.l.windows.reduce((a, b) => currentUsedPct(a, now) >= currentUsedPct(b, now) ? a : b)
    return `${HARNESS_LABELS[row.l.harness]}: ${windowLabel(w.kind, lang)} ${Math.round(currentUsedPct(w, now))}%, ${resetPhrase(w, now, lang)}`
  }).join('; ')
  return <div aria-label={label} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
    {rows.slice(0, 2).map(row => {
      const harness = row.l?.harness ?? row.harness
      const worst = row.l?.windows.reduce((a, b) => currentUsedPct(a, now) >= currentUsedPct(b, now) ? a : b)
      const pct = worst ? currentUsedPct(worst, now) : null
      return <button key={harness} aria-label={label} onClick={() => requestNayTab('limits')} style={{ width: 46, height: 52, padding: 0, border: 0, background: 'transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, position: 'relative', cursor: 'pointer' }}>
        <PlanUsageRing pct={pct} size={30}><HarnessMark harness={harness} size={13} /></PlanUsageRing>
        <span style={{ fontSize: 11, lineHeight: 1, color: 'var(--text-secondary)' }}>{worst ? windowShortLabel(worst.kind, lang) : '—'}</span>
        {pct !== null && pct >= 75 && <span style={{ position: 'absolute', top: 2, right: 2 }}><LimitLevelIcon pct={pct} size={13} /></span>}
      </button>
    })}
    {rows.length > 2 && <button aria-label={`+${rows.length - 2}`} onClick={() => requestNayTab('limits')} style={{ width: 30, height: 44, border: 0, background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700 }}>+{rows.length - 2}</button>}
  </div>
}
