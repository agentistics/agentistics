/**
 * today.ts — PURE. What today has cost, for the status bar.
 *
 * **Today is the spend INCURRED today, by event time** (the leader's A4.5 decision): each session's
 * own per-day usage (`daily`) for today's UTC date, priced through `cutSessionUsage`, which is the
 * rule the dashboard's Costs applies to a day range and the rule the projections file responses by.
 * A session with no `daily` (written by an older build, or a harness that records none) keeps the
 * old rule, its whole figure on its start day, because a record that cannot be split did not do
 * nothing. Below, the reasons for UTC.
 *
 * **The day key is UTC**, and the choice is deliberate. Two day rules
 * exist in this repo: the UTC slice (`tagSessionDay`, and the dashboard's own date presets, which
 * bound their ranges with `utcStartOfDay`) and a local-clock one used for the session-gap streak. A
 * status bar sitting beside a dashboard MUST agree with the dashboard, and at UTC-3 the two rules
 * disagree for three hours every night — which is exactly when someone would notice the two
 * surfaces contradicting each other and stop believing both.
 *
 * **Summed per session, and only for today.** `stats-cache.json` is Claude-only and holds the deep
 * history that no longer exists as session files; for TODAY the sessions are all still there, for
 * every harness, so the per-session sum is both complete and cross-harness. Reaching for the cache
 * here would report Claude's day under a label that says "today" without saying "Claude".
 *
 * **Tokens means all four counters** — `sessionTokenTotal` sums input, output, cache read and cache
 * write. On real data the conversational pair alone is under 1% of the volume, so a two-term sum is
 * not slightly low, it is off by roughly 300x while the cost beside it disagrees by 10x.
 */

import { cutSessionUsage, sessionCostUSD, sessionTokenTotal, type SessionMeta } from '@agentistics/core'

export interface TodayTotals {
  costUSD: number
  tokens: number
  sessions: number
}

/** The UTC day key for an instant. Exported so the caller does not restate the rule. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function todayTotals(sessions: readonly SessionMeta[], now: Date): TodayTotals {
  const key = dayKey(now)
  let costUSD = 0
  let tokens = 0
  let count = 0
  for (const s of sessions) {
    let day: SessionMeta
    if (s.daily) {
      const d = s.daily[key]
      if (!d) continue
      day = cutSessionUsage(s, {
        input_tokens: d.input_tokens || 0,
        output_tokens: d.output_tokens || 0,
        cache_read_input_tokens: d.cache_read_input_tokens || 0,
        cache_creation_input_tokens: d.cache_creation_input_tokens || 0,
      })
    } else {
      if ((s.start_time ?? '').slice(0, 10) !== key) continue
      day = s
    }
    count += 1
    tokens += sessionTokenTotal(day)
    costUSD += sessionCostUSD(day) ?? 0
  }
  return { costUSD, tokens, sessions: count }
}

/**
 * A token count for a status bar: `1.2M`, `51.7k`, `812`.
 *
 * Rounds DOWN, like every other gauge in this product, so nothing reads as a round number it has
 * not reached.
 */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`
  if (n >= 1_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}k`
  return String(Math.floor(n))
}
