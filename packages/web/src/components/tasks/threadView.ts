/**
 * threadView.ts — the arithmetic behind the task page's cockpit hero and its threads. Pure.
 *
 * Every rule about a thread itself (who receives a reply, what "waiting on you" means, which
 * question is mirrored) lives in `@agentistics/core`'s `taskThreads.ts`; this file only shapes
 * what the page draws from it.
 */
import { planThreadFanout, rowForParticipant, rowRunning, type FleetRowLike, type ThreadParticipant } from '@agentistics/core'

/** The task's sessions that are running right now, from the fleet poll. */
export function liveSessionsOf(
  taskSessions: readonly { id: string; conversationId?: string }[],
  rows: readonly FleetRowLike[],
): FleetRowLike[] {
  const ids = new Set(taskSessions.map(s => s.id))
  const convs = new Set(taskSessions.map(s => s.conversationId).filter((c): c is string => !!c))
  const seen = new Set<string>()
  return rows.filter(r => {
    if (!rowRunning(r) || seen.has(r.id)) return false
    const mine = ids.has(r.id) || (!!r.conversationId && convs.has(r.conversationId))
    if (mine) seen.add(r.id)
    return mine
  })
}

export interface MixSlice { key: string; pct: number }

/**
 * Shares by TOKENS, largest first, each rounded DOWN so the bar never claims more than it has —
 * and a bucket with no token count is left out rather than drawn as 0 (it is "not measured").
 */
export function mixOf(buckets: readonly { key: string; tokens: number | null }[]): MixSlice[] {
  const measured = buckets.filter((b): b is { key: string; tokens: number } => typeof b.tokens === 'number' && b.tokens > 0)
  const total = measured.reduce((s, b) => s + b.tokens, 0)
  if (total === 0) return []
  return measured
    .map(b => ({ key: b.key, pct: Math.floor((b.tokens / total) * 1000) / 10 }))
    .sort((a, b) => b.pct - a.pct || a.key.localeCompare(b.key))
}

/** Whole days between an ISO instant and now, never negative. */
export function daysSince(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000))
}

/** What the explicit send can promise before it is pressed: how many get it now, how many on reopen. */
export function replyReach(
  participants: readonly ThreadParticipant[],
  rows: readonly FleetRowLike[],
  muted: readonly string[] = [],
): { now: number; queued: number; total: number } {
  const plan = planThreadFanout(participants, rows, muted)
  const now = plan.filter(s => s.action === 'send').length
  const queued = plan.filter(s => s.action === 'queue').length
  return { now, queued, total: now + queued }
}

/** A participant's live state word key, or `null` when nothing in the fleet stands for it. */
export function participantState(p: ThreadParticipant, rows: readonly FleetRowLike[]): string | null {
  return rowForParticipant(p, rows)?.state ?? null
}
