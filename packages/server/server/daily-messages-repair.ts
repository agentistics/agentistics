/**
 * PURE — brings a STORED record's `daily[day].messages` back in line with its lifetime counters.
 *
 * Until 2026-11-27 the Claude parser counted every user-role LINE as a message on its day — tool
 * results and harness-injected entries included — while `user_message_count` counted only the
 * person's turns. Measured on a real store: Σ daily.messages = 993.374 against 647.475 lifetime
 * (153 %). The parser is fixed (`jsonl.ts`, session cache shape v9), and a transcript still on disk
 * is simply re-read. But most stored records outlive their transcript (Claude Code deletes it after
 * 30 days, the consolidate store keeps the metrics), so they can never be re-read — and they would
 * keep inflating every date-filtered "Messages" card forever.
 *
 * The rule, and why it is safe to run on every read:
 *   - the new parser's per-day count is a SUBSET of the lifetime one (Σ ≤ lifetime — equal unless a
 *     line had no usable timestamp), and the old one a SUPERSET (Σ ≥ lifetime, strictly greater as
 *     soon as one tool ran). So `Σ > lifetime` identifies an old record exactly; anything else is
 *     returned untouched, which also makes the repair idempotent.
 *   - an old record is APPORTIONED: each day keeps its share of the inflated total, scaled to the
 *     lifetime figure with cumulative rounding, so the days add up EXACTLY to the lifetime. The
 *     total is exact; the per-day split is an estimate (which day the dropped tool results fell on
 *     is not recorded anywhere), the same treatment `countsByDay` gives tool calls.
 * Tokens and hours are never touched — they were always measured per line correctly.
 */
import type { SessionMeta } from '@agentistics/core'

export function repairDailyMessages(s: SessionMeta): SessionMeta {
  const daily = s.daily
  if (!daily) return s
  const life = (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
  const keys = Object.keys(daily).sort()
  const counts = keys.map(k => daily[k]?.messages || 0)
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= life) return s
  const next: NonNullable<SessionMeta['daily']> = {}
  let seen = 0
  let given = 0
  keys.forEach((k, i) => {
    seen += counts[i]!
    const upTo = Math.round((seen * life) / total)
    next[k] = { ...daily[k]!, messages: upTo - given }
    given = upTo
  })
  return { ...s, daily: next }
}
