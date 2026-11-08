/**
 * liveHistoryModel — PURE. The Histórico column: pieces published more than 24 h ago, grouped by the day
 * they were published, newest first. The server already bounds the list (30 days, 150 pieces); the groups
 * are bounded again here so the column stays a glance, not an archive.
 */

import type { LiveCard } from './liveDeliveryModel'

export const HISTORY_MAX_GROUPS = 10

export interface HistoryGroup { day: string; label: string; cards: LiveCard[] }

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

/** "hoje" / "ontem" / "05/11" — the heading of one day. */
export function dayLabel(ms: number, nowMs: number, pt: boolean): string {
  const diff = Math.round((new Date(dayKey(nowMs)).getTime() - new Date(dayKey(ms)).getTime()) / 86_400_000)
  if (diff <= 0) return pt ? 'hoje' : 'today'
  if (diff === 1) return pt ? 'ontem' : 'yesterday'
  const d = new Date(ms)
  return pt ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

export function groupHistory(cards: readonly LiveCard[], nowMs: number, pt: boolean): HistoryGroup[] {
  const sorted = [...cards].filter(c => c.d.deliveredAtMs !== null).sort((a, b) => b.d.deliveredAtMs! - a.d.deliveredAtMs!)
  const groups: HistoryGroup[] = []
  for (const c of sorted) {
    const day = dayKey(c.d.deliveredAtMs!)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.cards.push(c)
    else groups.push({ day, label: dayLabel(c.d.deliveredAtMs!, nowMs, pt), cards: [c] })
  }
  return groups.slice(0, HISTORY_MAX_GROUPS)
}
