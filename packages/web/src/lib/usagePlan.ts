import type { PlanBudget, PlanPace } from '@agentistics/core'

export type UsageBudgetRow = PlanBudget & PlanPace & { account?: string; accountLabel?: string }
export interface PlanSessionsRow {
  account: string
  harness: string
  label: string
  parallel: number | null
  pauseUntil: number | null
  reason: string
}

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** One decision for the overview sentence and each account's pace pill. */
export function usagePaceState(row: UsageBudgetRow): 'hold' | 'over' | 'on' {
  if (row.status === 'hold') return 'hold'
  return row.paceStatus === 'over' || row.status === 'tight' ? 'over' : 'on'
}

/** The Uso › Agora status sentence. Null when there is nothing to summarise. */
export function usageHeadline(rows: readonly UsageBudgetRow[], now: number, lang: 'pt' | 'en'): string | null {
  if (!rows.length) return null
  const over = rows.filter(r => usagePaceState(r) !== 'on')
  const pauses = over.map(r => r.pauseUntil).filter((p): p is number => p !== undefined && p > now)
  const latest = pauses.length ? Math.max(...pauses) : undefined
  if (!over.length) return lang === 'pt' ? `Todos os ${rows.length} planos no ritmo.` : `All ${rows.length} plans on pace.`
  const head = lang === 'pt' ? `${over.length} de ${rows.length} planos acima do ritmo.` : `${over.length} of ${rows.length} plans over pace.`
  if (latest === undefined) return head
  return head + (lang === 'pt' ? ` Não abra sessões novas até ${hhmm(latest)}.` : ` Do not open new sessions until ${hhmm(latest)}.`)
}

/**
 * Parallel sessions at the sustainable rate, per account. Without measured burn and live
 * sessions capacity is unknown. The requested duration does not hide pauses beyond that window.
 */
export function planSessions(rows: readonly UsageBudgetRow[], _hours: number, _now: number): PlanSessionsRow[] {
  return rows.map(r => {
    const base = {
      account: r.account ?? r.harness, harness: r.harness,
      label: r.accountLabel ?? r.account ?? r.harness, pauseUntil: r.pauseUntil ?? null,
    }
    if (r.status === 'hold') return { ...base, parallel: 0, reason: 'hold' }
    const live = r.liveSessions.length
    if (!live || !(r.burnPctPerHour > 0)) return { ...base, parallel: null, reason: 'unmeasured' }
    const perSession = r.burnPctPerHour / live
    // Avoid dropping an exact whole session through floating-point division (1.2 / 0.4).
    const capacity = r.sustainablePctPerHour / perSession
    return { ...base, parallel: Math.max(0, Math.floor(capacity + Number.EPSILON * Math.max(1, capacity))), reason: 'pace' }
  })
}
