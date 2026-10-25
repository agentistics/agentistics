/**
 * areaBadges.ts — PURE: which areas carry a count badge, and how many.
 *
 * A key is present only when its source ANSWERED and the count is above zero. An unanswered source
 * (`undefined`) and a real zero both leave the key absent: a badge is a call to look, and a "0"
 * would say "checked, nothing" about a source that may not have been asked.
 */
import type { AreaId } from './appAreas'
import { usagePaceState, type UsageBudgetRow } from './usagePlan'

export type UsageRowLike = Partial<Pick<UsageBudgetRow, 'status' | 'paceStatus'>>

export function areaBadges(input: {
  attention?: number
  usageRows?: readonly UsageRowLike[]
  checkinsOverdue?: number
}): Partial<Record<AreaId, number>> {
  const out: Partial<Record<AreaId, number>> = {}
  const set = (id: AreaId, n: number | undefined) => { if (typeof n === 'number' && n > 0) out[id] = n }
  set('sessions', Math.max(0, input.attention ?? 0) + Math.max(0, input.checkinsOverdue ?? 0))
  if (input.usageRows) {
    // The SAME rule as the Uso › Agora sentence ("N de M planos acima do ritmo"): one reading of over pace.
    set('usage', input.usageRows.filter(r => ['hold', 'over'].includes(usagePaceState(r))).length)
  }
  return out
}
