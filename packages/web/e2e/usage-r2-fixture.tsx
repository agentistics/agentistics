// The real account rows, chart panel and rail, fed synthetic conflicting collector readings.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { BillingAccountList, type BillingRowView } from '../src/pages/settings/AccountRow'
import { UsageChartsPanel } from '../src/pages/usage/UsageChartsPanel'
import { AreaRail } from '../src/components/nav/AreaRail'
import { __setPlanLimitsForTest, type PlanReadings } from '../src/lib/planLimits'
import { fmtDateLocalized } from '../src/lib/dateFormat'
import '../src/index.css'

const H = 3_600_000, now = Date.parse('2026-10-27T12:00:00Z')
const readings: PlanReadings[] = ['claude:a', 'claude:b', 'claude:c', 'codex:a'].map((key, i) => {
  const [harness, account] = key.split(':') as ['claude' | 'codex', string]
  return { harness, account, points: Array.from({ length: 28 }, (_, n) => ({ at: now - (28 - n) * H,
    weekPct: 10 + i * 15 + n / 2, fiveHourPct: (n % 5) * (8 + i * 4), fiveReset: now - (28 - n) * H + (5 - n % 5) * H, weekReset: now + 48 * H })) }
})
// Interleaved older reset stream at a very different percentage: must not make vertical bars.
readings[1]!.points.push(...Array.from({ length: 12 }, (_, n) => ({ at: now - (27 - n) * H + 60000,
  weekPct: 80, fiveHourPct: 99, weekReset: now + 72 * H, fiveReset: now + 5 * H })))
const rows: BillingRowView[] = [...readings, { harness: 'gemini' as const, account: 'empty', points: [] }].map((r, i) => ({
  key: `${r.harness}:${r.account}`, harness: r.harness,
  account: { id: r.account, harness: r.harness, key: r.account, label: `account-${i}@example.test`, root: null, available: true },
  title: i === 1 || i === 3 ? 'Principal' : `Conta ${i + 1}`, sub: 'Conta de teste',
  plan: { name: 'Plano de teste', price: null, mode: 'subscription' }, problem: false, limits: null,
}))
globalThis.fetch = (async () => Response.json({ limits: [], readings })) as typeof fetch
__setPlanLimitsForTest([], now, [], [], readings)
function Fixture() {
  const [available, setAvailable] = useState(true)
  return <BrowserRouter>
    <button id="outside">Fora da barra</button>
    <div style={{ position: 'relative', height: 360, display: 'flex' }}><AreaRail pathname="/sessions" lang="pt" /></div>
    <main style={{ padding: 12, minWidth: 0 }}>
      <p data-localized-date>{fmtDateLocalized('2025-11-16T12:00:00Z', 'pt')}</p>
      <BillingAccountList lang="pt" now={now} rows={rows.map(r => ({ ...r, account: { ...r.account!, available } }))}
        pendingIds={new Set()} failedIds={new Set()} selectedKey={null} onToggle={() => setAvailable(v => !v)} onEdit={() => {}} />
      <UsageChartsPanel readings={readings} budgets={[]} sessions={[]} lang="pt" now={now} />
    </main>
  </BrowserRouter>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
