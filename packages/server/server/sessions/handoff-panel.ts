/** UI adapter for the existing math; keep HandoffPanel v1 stable when the engine is replaced. */
import { getModelPrice, hasModelPrice, handoffCut, handoffLevel, normalizeHandoffConfig, type HandoffPanel } from '@agentistics/core'
import { computeHandoffWhy, type HandoffHintRow } from './handoff-hint'

export interface HandoffQuotaRate { fiveHourPctPerUSD: number | null; weekPctPerUSD: number | null }
export function computeHandoffPanel(row: HandoffHintRow, configIn: unknown, quota: HandoffQuotaRate = { fiveHourPctPerUSD: null, weekPctPerUSD: null }, now = Date.now()): HandoffPanel {
  const config = normalizeHandoffConfig(configIn)
  const cutTokens = handoffCut(config)
  const why = computeHandoffWhy({ ...row, cutTokens })
  const context = Number.isFinite(row.contextTokens) ? row.contextTokens! : null
  const window = Number.isFinite(row.contextWindow) && row.contextWindow! > 0 ? row.contextWindow! : null
  const price = row.model && hasModelPrice(row.model) ? getModelPrice(row.model).cacheRead / 1_000_000 : null
  const money = (tokens: number | null) => tokens !== null && price !== null ? tokens * price : null
  const n = 20
  const extra = context === null || window === null ? null : context + window * config.extraPercent / 100
  const successor = why.overheadTokens === undefined ? null : why.overheadTokens + n * why.successorBaseTokens
  const cost = (kind: 'continue' | 'extra' | 'handoff', tokens: number | null, current: number | null) => {
    const costUSD = money(tokens)
    return { kind, contextTokens: current, costUSD,
      fiveHourPct: costUSD !== null && quota.fiveHourPctPerUSD !== null ? costUSD * quota.fiveHourPctPerUSD : null,
      weekPct: costUSD !== null && quota.weekPctPerUSD !== null ? costUSD * quota.weekPctPerUSD : null }
  }
  return {
    version: 1, sessionId: row.id, updatedAt: now, config, cutTokens,
    contextTokens: context, contextWindow: window,
    level: context === null ? 'normal' : handoffLevel(context, cutTokens),
    spentUSD: Number.isFinite(row.costUSD) ? row.costUSD! : null,
    replies: Number.isFinite(row.calls) ? row.calls! : null,
    nextReplyUSD: money(context), successorReplyUSD: money(why.successorBaseTokens),
    successorBaseTokens: why.successorBaseTokens,
    handoffOverheadUSD: money(why.overheadTokens ?? null), breakEvenReplies: why.breakEvenTurns ?? null,
    projectionReplies: n,
    projections: [cost('continue', context === null ? null : n * context, context), cost('extra', extra === null ? null : n * extra, extra), cost('handoff', successor, why.successorBaseTokens)],
    quotaEstimated: true, workInFlight: why.workInFlight, handoffPath: row.handoffPath ?? null,
  }
}

export interface QuotaObservation {
  at: number; totalUSD: number; population: string
  fiveHour?: { usedPct: number; resetsAt: number }
  week?: { usedPct: number; resetsAt: number }
}
/** Same account, session population and reset interval only; renewals and missing burn are unknown. */
export function quotaRate(previous: QuotaObservation | undefined, current: QuotaObservation): HandoffQuotaRate {
  const rate = (key: 'fiveHour' | 'week') => {
    const a = previous?.[key], b = current[key]
    if (!previous || previous.population !== current.population || current.at <= previous.at || current.at - previous.at > 30 * 60_000
      || !a || !b || a.resetsAt !== b.resetsAt || b.usedPct <= a.usedPct || current.totalUSD <= previous.totalUSD) return null
    return (b.usedPct - a.usedPct) / (current.totalUSD - previous.totalUSD)
  }
  return { fiveHourPctPerUSD: rate('fiveHour'), weekPctPerUSD: rate('week') }
}
