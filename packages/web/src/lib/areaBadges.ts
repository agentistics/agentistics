/**
 * areaBadges.ts — PURE: which areas carry a count badge, and how many.
 *
 * A key is present only when its source ANSWERED and the count is above zero. An unanswered source
 * (`undefined`) and a real zero both leave the key absent: a badge is a call to look, and a "0"
 * would say "checked, nothing" about a source that may not have been asked.
 */
import type { AreaId } from './appAreas'

export interface UsageRowLike { paceStatus?: string; status?: string }

export function areaBadges(input: {
  attention?: number
  usageRows?: readonly UsageRowLike[]
  checkinsOverdue?: number
}): Partial<Record<AreaId, number>> {
  const out: Partial<Record<AreaId, number>> = {}
  const set = (id: AreaId, n: number | undefined) => { if (typeof n === 'number' && n > 0) out[id] = n }
  set('sessions', input.attention)
  if (input.usageRows) {
    set('usage', input.usageRows.filter(r => r.paceStatus === 'over' || r.status === 'hold').length)
  }
  set('leadership', input.checkinsOverdue)
  return out
}
