/** Settings → Billing → OpenCode: the plan, its price and the (estimated) use of the Go allowance in dollars. */
import React, { useCallback, useEffect, useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { MetricNote } from '../../components/MetricNote'
import { PlanUsageRing } from '../../components/PlanLimitMeter'
import { OC_PLAN_CHOICES, OC_USAGE_COPY, ocUsageView, type OcUsageReply } from './opencodeGoView'

export default function OpenCodeUsageCard({ lang, refreshKey }: { lang: 'pt' | 'en'; refreshKey: number }) {
  const pt = lang === 'pt', t = OC_USAGE_COPY(pt), mobile = useIsMobile()
  const [data, setData] = useState<OcUsageReply | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/opencode/usage')
      if (res.ok) {
        const body = await res.json() as Partial<OcUsageReply> | null
        if (body && body.plan && typeof body.plan.id === 'string') setData(body as OcUsageReply)
      }
    } catch { /* offline: the card just stays out of the way */ }
  }, [])
  useEffect(() => { void load() }, [load, refreshKey])

  if (!data) return null
  const v = ocUsageView(data, pt)
  const setPlan = async (value: string) => {
    setSaving(true)
    try { await fetch('/api/opencode/plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: value }) }) } catch { /* the reload shows the truth */ }
    await load(); setSaving(false)
  }

  return <div data-opencode-usage style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', padding: '12px 14px' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px' }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{v.title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{v.price} · {v.basis}</div>
    </div>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '10px 0', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
      {t.planLabel}
      <select aria-label={t.planLabel} value={data.plan.chosen ? data.plan.id : 'auto'} disabled={saving} onChange={e => { void setPlan(e.target.value) }}
        style={{ minHeight: mobile ? 44 : 36, fontSize: 16, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
        <option value="auto">{t.planAuto}</option>
        {OC_PLAN_CHOICES.map(id => <option key={id} value={id}>{t.planName(id)}</option>)}
      </select>
      <span style={{ fontWeight: 400 }}>{t.planHint}</span>
    </label>

    {v.rings.length > 0 && <div data-opencode-rings style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, margin: '4px 0 10px' }}>
      {v.rings.map(r => <div key={r.kind} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center', minWidth: 0 }}>
        <PlanUsageRing pct={r.pct} size={mobile ? 52 : 56} stroke={4}>{r.pct === null ? '–' : `${r.pct}%`}</PlanUsageRing>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{r.label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{r.detail}</div>
      </div>)}
    </div>}

    {v.models.length > 0 && <div data-opencode-models>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{t.modelsTitle}</div>
      {v.models.map(m => <div key={m.model} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '0 10px', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
        <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          {m.model}
          {m.trains && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent-red)' }}>{t.trains}</span>}
        </div>
        <div style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{m.pct}% · {t.windowShort(m.binding)}</div>
        <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-secondary)' }}>{m.amount}</div>
      </div>)}
    </div>}

    {v.notes.map(n => <MetricNote key={n}>{n}</MetricNote>)}
    {v.showEstimate && <MetricNote>{t.estimated}</MetricNote>}
  </div>
}
