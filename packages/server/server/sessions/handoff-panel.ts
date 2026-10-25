/** UI adapter for the existing math; keep HandoffPanel v1 stable when the engine is replaced. */
import { getModelPrice, hasModelPrice, handoffCut, handoffLevel, normalizeHandoffConfig, type HandoffPanel } from '@agentistics/core'
import { computeHandoffWhy, type HandoffHintRow } from './handoff-hint'
import type { ManagedSession } from './types'
import { DEFAULT_DEADLINE_MS } from './retire-plan'
import { findConversation, type Conversation } from './conversations'

/** Only the exact recorded conversation may supply metrics; never guess by directory. */
export function handoffMetrics(row: HandoffHintRow & { harness?: string; conversationId?: string }, conversations: readonly Conversation[]): HandoffHintRow {
  const linked = row.conversationId ? findConversation(conversations.filter(c => c.harness === row.harness), row.conversationId) : undefined
  return { ...row,
    model: linked?.model ?? row.model,
    costUSD: row.costUSD ?? linked?.costUSD,
    contextTokens: row.contextTokens ?? linked?.contextTokens,
    contextWindow: row.contextWindow ?? linked?.contextWindow,
    calls: row.calls ?? linked?.calls,
    turns: row.turns ?? linked?.turns,
  }
}

export interface HandoffLifecycle {
  session: Pick<ManagedSession, 'handoffRequestedAt' | 'handoffTo' | 'handoffRelayClosing' | 'retire' | 'endedAt'>
  successor?: Pick<ManagedSession, 'id' | 'endedAt'>
  successorGone?: boolean
}
/** Use recorded lifecycle events; elapsed time alone never claims the session is being killed. */
export function handoffProgress({ session: row, successor, successorGone }: HandoffLifecycle, now: number): HandoffPanel['handoff'] {
  const req = row.retire
  const successorId = req?.successorId ?? row.handoffTo
  if (req?.expiredAt || successorGone || successor?.endedAt || (successorId && !successor)) return undefined
  if (req && now >= Date.parse(req.deadlineAt)) return undefined
  const requestedAt = row.handoffRequestedAt ?? req?.requestedAt
  if (successorId && successor) {
    // The panel endpoint has already excluded stopped views. endedAt is recorded BEFORE the
    // kill, so a still-live predecessor with that decision is closing, not back at the warning.
    if (row.handoffRelayClosing || row.endedAt) return { stage: 'closing', successorId, requestedAt, deadlineAt: req?.deadlineAt, progress: .95 }
    if (req?.successorId === successorId) {
      const elapsed = Math.max(0, now - Date.parse(req.requestedAt))
      const duration = Math.max(req.quietForMs, Date.parse(req.deadlineAt) - Date.parse(req.requestedAt), 1)
      return { stage: 'taken-over', successorId, requestedAt: req.requestedAt, deadlineAt: req.deadlineAt, progress: .5 + .4 * Math.min(1, elapsed / duration) }
    }
    return { stage: 'successor-open', successorId, requestedAt, progress: .35 }
  }
  if (!requestedAt || !Number.isFinite(Date.parse(requestedAt)) || now >= Date.parse(requestedAt) + DEFAULT_DEADLINE_MS) return undefined
  return { stage: 'preparing', requestedAt, deadlineAt: new Date(Date.parse(requestedAt) + DEFAULT_DEADLINE_MS).toISOString(), progress: .1 }
}

export interface HandoffQuotaRate { fiveHourPctPerUSD: number | null; weekPctPerUSD: number | null; unavailableReason?: 'no-meter' | 'account-unknown' | 'missing-window' }
export function computeHandoffPanel(row: HandoffHintRow, configIn: unknown, quota: HandoffQuotaRate = { fiveHourPctPerUSD: null, weekPctPerUSD: null }, now = Date.now(), lifecycle?: HandoffLifecycle): HandoffPanel {
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
    ...(lifecycle ? { handoff: handoffProgress(lifecycle, now) } : {}),
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
    quotaEstimated: true, quotaUnavailableReason: quota.unavailableReason, workInFlight: why.workInFlight, handoffPath: row.handoffPath ?? null,
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
    if (!previous || !Number.isFinite(previous.totalUSD) || !Number.isFinite(current.totalUSD)
      || previous.population !== current.population || current.at <= previous.at || current.at - previous.at > 30 * 60_000
      || !a || !b || a.resetsAt !== b.resetsAt || b.usedPct <= a.usedPct || current.totalUSD <= previous.totalUSD) return null
    return (b.usedPct - a.usedPct) / (current.totalUSD - previous.totalUSD)
  }
  return { fiveHourPctPerUSD: rate('fiveHour'), weekPctPerUSD: rate('week') }
}

/** Calibrate on fleet polls, retaining each meter's last useful rate between rounded readings. */
export function createHandoffQuotaSampler() {
  type WindowSample = { baseline: QuotaObservation; last: QuotaObservation; rate: number | null; measuredAt: number }
  const accounts = new Map<string, Partial<Record<'fiveHour' | 'week', WindowSample>>>()
  return {
    forget(key: string) { accounts.delete(key) },
    observe(key: string, current: QuotaObservation): HandoffQuotaRate {
      const samples = accounts.get(key) ?? {}
      const out: HandoffQuotaRate = { fiveHourPctPerUSD: null, weekPctPerUSD: null }
      for (const [window, field] of [['fiveHour', 'fiveHourPctPerUSD'], ['week', 'weekPctPerUSD']] as const) {
        const meter = current[window]
        let sample = samples[window]
        if (!meter || meter.resetsAt <= current.at || !Number.isFinite(meter.usedPct) || !Number.isFinite(current.totalUSD)) {
          delete samples[window]
          continue
        }
        if (!sample || current.population !== sample.last.population || current.at < sample.last.at
          || current.totalUSD < sample.last.totalUSD || meter.resetsAt !== sample.last[window]?.resetsAt
          || meter.usedPct < sample.last[window]!.usedPct || current.at - sample.baseline.at > 30 * 60_000) {
          sample = { baseline: current, last: current, rate: null, measuredAt: current.at }
        } else if (current.at > sample.last.at) {
          // A stationary rounded meter is not a new rate: retain the last measured one.
          if (meter.usedPct > sample.last[window]!.usedPct) {
            const rate = quotaRate(sample.baseline, current)[field]
            if (rate !== null) {
              sample.rate = rate
              sample.measuredAt = current.at
              sample.baseline = current
            }
          }
          sample.last = current
        }
        samples[window] = sample
        out[field] = current.at - sample.measuredAt <= 30 * 60_000 ? sample.rate : null
      }
      if (!accounts.has(key) && accounts.size >= 100) accounts.delete(accounts.keys().next().value!)
      accounts.set(key, samples)
      return out
    },
  }
}
