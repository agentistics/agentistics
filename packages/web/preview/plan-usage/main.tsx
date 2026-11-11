import { createRoot } from 'react-dom/client'
import type { PlanLimits } from '@agentistics/core'
import '../../src/index.css'
import { PlanUsageSummary } from '../../src/components/PlanLimitMeter'

document.documentElement.setAttribute('data-theme', 'dark')
const now = Date.parse('2026-11-11T00:15:00Z')
const limits: PlanLimits[] = Array.from({ length: 9 }, (_, i) => ({
  harness: i < 3 ? 'claude' : 'codex', account: `fixture-${i}`,
  source: 'claude-usage-api', plan: i < 3 ? 'Claude Max 5x' : 'ChatGPT Pro', updatedAt: now,
  windows: [{ kind: '5h', usedPct: [0, 1, 6, 80][i % 4]!, resetsAt: now + 3_600_000 }, { kind: 'week', usedPct: [26, 95, 55][i % 3]!, resetsAt: now + 3 * 86_400_000 }],
}))
const labels = Object.fromEntries(limits.map((l, i) => [`${l.harness}:${l.account}`, ['Navara', 'Principal', 'Vini', 'Work', 'Personal'][i % 5]!]))
const controls = (_harness: PlanLimits['harness'], account?: string) => ({ accountId: account!, on: true, pending: false, onToggle() {}, reloginable: false })
createRoot(document.getElementById('root')!).render(<main style={{ padding: 12, minHeight: '100vh', boxSizing: 'border-box', background: 'var(--bg-base)' }}>
  <div data-plan-usage-popover style={{ display: 'flex', flexDirection: 'column', width: 'min(364px, 100%)', maxHeight: 480, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--ag-shadow-menu)' }}>
    <PlanUsageSummary limits={limits} accountLabels={labels} now={now} lang="pt" agentUse={controls} />
  </div>
</main>)
