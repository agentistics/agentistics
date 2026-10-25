import type { PlanBudget, PlanPace } from '@agentistics/core'
import { fmtWhen } from './planLimits'

export type UsageBudgetRow = PlanBudget & PlanPace & { account?: string; accountLabel?: string }
export interface PlanSessionsRow {
  account: string
  harness: string
  label: string
  parallel: number | null
  pauseUntil: number | null
  reason: string
}

/** One decision for the overview sentence and each account's pace pill. */
export function usagePaceState(row: Partial<Pick<UsageBudgetRow, 'status' | 'paceStatus'>>): 'hold' | 'over' | 'on' | 'under' {
  if (row.status === 'hold') return 'hold'
  return row.paceStatus === 'over' || row.status === 'tight' ? 'over' : row.paceStatus ?? 'on'
}

/** Shared by Agora and planning, including accounts with measured capacity but no live session. */
export function hasMeasuredPace(row: UsageBudgetRow): boolean {
  return row.freeSlotsMeasured && Number.isFinite(row.burnPctPerHour) && row.burnPctPerHour > 0
}

/** The Uso › Agora status sentence. Null when there is nothing to summarise. */
export function usageHeadline(rows: readonly UsageBudgetRow[], now: number, lang: 'pt' | 'en'): string | null {
  if (!rows.length) return null
  const over = rows.filter(r => ['hold', 'over'].includes(usagePaceState(r)))
  const pauses = over.map(r => r.pauseUntil).filter((p): p is number => p !== undefined && p > now)
  const latest = pauses.length ? Math.max(...pauses) : undefined
  if (!over.length) return lang === 'pt' ? `Todos os ${rows.length} planos no ritmo.` : `All ${rows.length} plans on pace.`
  const head = lang === 'pt' ? `${over.length} de ${rows.length} planos acima do ritmo.` : `${over.length} of ${rows.length} plans over pace.`
  if (latest === undefined) return head
  return head + (lang === 'pt' ? ` Não abra sessões novas até ${fmtWhen(latest, now, lang)}.` : ` Do not open new sessions until ${fmtWhen(latest, now, lang)}.`)
}

/**
 * Parallel sessions at the sustainable rate, per account. Without measured capacity
 * the recommendation is unknown. The requested duration does not hide pauses beyond that window.
 */
export function planSessions(rows: readonly UsageBudgetRow[], _hours: number, _now: number): PlanSessionsRow[] {
  return rows.map(r => {
    const base = {
      account: r.account ?? r.harness, harness: r.harness,
      label: r.accountLabel ?? r.account ?? r.harness, pauseUntil: r.pauseUntil ?? null,
    }
    if (r.status === 'hold') return { ...base, parallel: 0, reason: 'hold' }
    if (!hasMeasuredPace(r)) return { ...base, parallel: null, reason: 'unmeasured' }
    // The server owns cadence, including hold/over-pace and spawnability overrides.
    return { ...base, parallel: r.suggestedParallel, reason: 'pace' }
  })
}
