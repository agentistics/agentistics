/** Shared owner preferences and the versioned handoff panel wire contract. */
export type HandoffProfile = 'economy' | 'balanced' | 'long' | 'custom'
export interface HandoffConfig {
  profile: HandoffProfile
  customTokens: number
  warnings: { near: boolean; due: boolean; overdue: boolean }
  extraPercent: number
}
export const DEFAULT_HANDOFF_CONFIG: HandoffConfig = {
  profile: 'balanced', customTokens: 250_000,
  warnings: { near: true, due: true, overdue: true }, extraPercent: 10,
}
export function normalizeHandoffConfig(value: unknown): HandoffConfig {
  const v = value && typeof value === 'object' ? value as Partial<HandoffConfig> : {}
  const bounded = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback
  const warning = (key: keyof HandoffConfig['warnings']) => typeof v.warnings?.[key] === 'boolean' ? v.warnings[key] : true
  return {
    profile: ['economy', 'balanced', 'long', 'custom'].includes(v.profile ?? '') ? v.profile! : 'balanced',
    customTokens: bounded(v.customTokens, 250_000, 1_000, 10_000_000),
    warnings: { near: warning('near'), due: warning('due'), overdue: warning('overdue') },
    extraPercent: bounded(v.extraPercent, 10, 0, 100),
  }
}
export function handoffCut(config: HandoffConfig): number {
  return { economy: 150_000, balanced: 250_000, long: 400_000, custom: config.customTokens }[config.profile]
}
export type HandoffLevel = 'normal' | 'near' | 'due' | 'overdue'
export function handoffLevel(tokens: number, cut: number): HandoffLevel {
  return tokens >= cut + 50_000 ? 'overdue' : tokens >= cut ? 'due' : tokens >= cut * .8 ? 'near' : 'normal'
}
export interface HandoffProjection {
  kind: 'continue' | 'extra' | 'handoff'
  contextTokens: number | null
  costUSD: number | null
  fiveHourPct: number | null
  weekPct: number | null
}
/** Unknown measurements remain null; all money is estimated API-equivalent USD. */
export interface HandoffPanel {
  version: 1
  sessionId: string
  updatedAt: number
  config: HandoffConfig
  cutTokens: number
  contextTokens: number | null
  contextWindow: number | null
  level: HandoffLevel
  spentUSD: number | null
  replies: number | null
  nextReplyUSD: number | null
  successorReplyUSD: number | null
  successorBaseTokens: number
  handoffOverheadUSD: number | null
  breakEvenReplies: number | null
  projectionReplies: number
  projections: HandoffProjection[]
  quotaEstimated: boolean
  quotaUnavailableReason?: 'no-meter' | 'account-unknown' | 'missing-window'
  workInFlight: string[]
  handoffPath: string | null
}
