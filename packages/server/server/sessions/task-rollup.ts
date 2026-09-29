/**
 * task-rollup.ts — what an attempt cost, in how many rounds, across how many sessions. Pure.
 *
 * Reads `SessionMeta` (from `loadConsolidated()`), never `Conversation`: the latter is a projection
 * built by `toConversation` for the fleet row and carries neither `user_message_count` nor
 * `active_minutes`, which are two of the three metrics this feature exists for.
 *
 * Three rules, each an existing rule of this codebase applied to a new dimension:
 *
 *  1. A metric the harness cannot produce is `null`, never `0` — the HARNESS_CAPABILITIES rule.
 *     An attempt with no sessions left has not cost zero; it is unmeasurable, and those are
 *     different sentences.
 *  2. Cost PROVENANCE is counted per session and never merged in silence. A measured figure (the
 *     harness's own) and an estimate (`calcCost`) are different claims about the world.
 *  3. Copilot's credits are their OWN field and are never dollars. An attempt that mixes them with
 *     a token-derived cost reports `mixedCurrency`, and the caller renders two columns rather than
 *     one sum.
 */

import type { SessionMeta } from '@agentistics/core'
import { sessionTokenTotal } from '@agentistics/core'
import type { LinkProvenance } from './task-model'

export interface SessionCredits {
  nanoAiu: number
  premiumRequests: number
}

/** One session of an attempt, already resolved against the store by the caller. */
export interface RollupSession {
  rowId: string
  provenance: LinkProvenance
  /** Null when the row has no conversation link. It still counts as a session used. */
  meta: SessionMeta | null
  /** Dollars, when this harness produces them at all. */
  costUSD: number | null
  /** True when the figure came from the harness itself rather than from `calcCost`. */
  costMeasured?: boolean
  /** Copilot only. Never converted, never summed with `costUSD`. */
  credits?: SessionCredits
}

export interface AttemptRollup {
  /** Every session filed under the attempt, linked or not. */
  sessionsUsed: number
  /** How many of those had a conversation link, and so contributed numbers. */
  sessionsLinked: number
  provenance: Record<LinkProvenance, number>
  /** Null when no linked session reported a turn count. */
  rounds: number | null
  activeMinutes: number | null
  tokens: number | null
  costUSD: number | null
  /**
   * `costUSD` split by the HARNESS that spent it — `null` exactly when `costUSD` is. A plan basis
   * is per harness (`planAllocation(...).byHarness`), so a row priced with the cross-harness factor
   * rescales an Antigravity-only delivery by what the CLAUDE subscription is worth. The split is
   * what lets the browser price each slice at its own harness's factor. A cost with no meta to name
   * its harness is keyed `''`, which no plan covers.
   */
  costByHarness: Record<string, number> | null
  costMeasuredSessions: number
  costEstimatedSessions: number
  credits: SessionCredits | null
  /** True when this attempt holds both a dollar figure and a credit figure. */
  mixedCurrency: boolean
}

/**
 * The sum, or `null` when nothing usable was reported.
 *
 * Absent is not zero. A harness that records no tokens must not read as a free session, and an
 * attempt whose rows are all unlinked must not read as one that cost nothing.
 */
function sumOrNull(values: readonly (number | null | undefined)[]): number | null {
  const real = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return real.length === 0 ? null : real.reduce((a, b) => a + b, 0)
}

export function rollupAttempt(o: { sessions: readonly RollupSession[] }): AttemptRollup {
  const provenance: Record<LinkProvenance, number> = { assigned: 0, observed: 0, none: 0 }
  for (const s of o.sessions) provenance[s.provenance] += 1

  const linked = o.sessions.filter(s => s.meta !== null)

  const tokens = sumOrNull(linked.map(s => {
    const m = s.meta!
    const has = m.input_tokens !== undefined || m.output_tokens !== undefined
      || m.cache_read_input_tokens !== undefined || m.cache_creation_input_tokens !== undefined
    // `sessionTokenTotal` reads absent counters as 0, which is right for a session that recorded
    // some of them and wrong for one that recorded none — so the question of whether this harness
    // reports tokens at all is asked FIRST, and answered with null.
    return has ? sessionTokenTotal(m) : null
  }))

  const costUSD = sumOrNull(o.sessions.map(s => s.costUSD))
  let costByHarness: Record<string, number> | null = null
  if (costUSD !== null) {
    costByHarness = {}
    for (const s of o.sessions) {
      if (typeof s.costUSD !== 'number' || !Number.isFinite(s.costUSD)) continue
      const h = s.meta ? (s.meta.harness ?? 'claude') : ''
      costByHarness[h] = (costByHarness[h] ?? 0) + s.costUSD
    }
  }

  const creditRows = o.sessions.filter(s => s.credits !== undefined)
  const credits = creditRows.length === 0 ? null : {
    nanoAiu: creditRows.reduce((a, s) => a + s.credits!.nanoAiu, 0),
    premiumRequests: creditRows.reduce((a, s) => a + s.credits!.premiumRequests, 0),
  }

  return {
    sessionsUsed: o.sessions.length,
    sessionsLinked: linked.length,
    provenance,
    rounds: sumOrNull(linked.map(s => s.meta!.user_message_count)),
    activeMinutes: sumOrNull(linked.map(s => s.meta!.active_minutes)),
    tokens,
    costUSD,
    costByHarness,
    costMeasuredSessions: o.sessions.filter(s => s.costMeasured === true).length,
    costEstimatedSessions: o.sessions.filter(s => s.costUSD !== null && s.costMeasured !== true).length,
    credits,
    mixedCurrency: costUSD !== null && credits !== null,
  }
}
