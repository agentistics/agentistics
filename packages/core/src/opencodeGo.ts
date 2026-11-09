/**
 * opencodeGo.ts — PURE: OpenCode Go's plans, per-model dollar limits, and what a stream of priced
 * responses has used of them.
 *
 * Source: https://opencode.ai/docs/go/ ("Usage limits"), read 2026-11-06 — never invented. Limits are
 * MONTHLY DOLLAR amounts PER MODEL; the 5-hour window is 20 % of a model's monthly limit, the week
 * 50 %, the month 100 %. A response reports what it counted as `opencode.allowance`; what this machine
 * can read instead is the `cost` OpenCode stamps on every assistant message, which on a measured Go
 * session equals tokens x the docs' list price to the last digit (glm-5.3-flash: 29.994 in + 54 out
 * -> 0,0045261). So the figures here are an ESTIMATE of the allowance: they cover the responses this
 * machine saw, and the windows are rolling because the docs do not say where a period is anchored.
 * Go Plus / Go Teams cannot be told from Go by any local file, so the tier is the person's to set.
 */

import type { PlanLimits } from './planLimits'

export type OpencodePlanId = 'go' | 'go-plus' | 'go-teams' | 'zen' | 'none'

export interface OpencodePlan {
  id: OpencodePlanId
  label: string
  /** US$ per month; per member for Teams. `null`: pay-as-you-go credit has no fixed price. */
  priceUsd: number | null
  perMember?: true
}

export const OPENCODE_GO_VERIFIED = { verifiedAt: '2026-11-06', source: 'https://opencode.ai/docs/go/' } as const

export const OPENCODE_PLANS: readonly OpencodePlan[] = [
  { id: 'go', label: 'OpenCode Go', priceUsd: 10 },
  { id: 'go-plus', label: 'OpenCode Go Plus', priceUsd: 40 },
  { id: 'go-teams', label: 'OpenCode Go Teams', priceUsd: 20, perMember: true },
  { id: 'zen', label: 'OpenCode Zen', priceUsd: null },
  { id: 'none', label: 'OpenCode', priceUsd: 0 },
]

export const opencodePlan = (id: OpencodePlanId): OpencodePlan => OPENCODE_PLANS.find(p => p.id === id) ?? OPENCODE_PLANS[4]!

/** Window shares of a model's monthly limit. */
export const GO_WINDOW_SHARE = { '5h': 0.2, week: 0.5, month: 1 } as const
export type GoWindowKind = keyof typeof GO_WINDOW_SHARE
export const GO_WINDOW_MS: Record<GoWindowKind, number> = {
  '5h': 5 * 3_600_000,
  week: 7 * 24 * 3_600_000,
  month: 30 * 24 * 3_600_000,
}

/** model id (as `opencode models` prints it, after `opencode-go/`) -> monthly limit in US$ for [Go, Go Plus, Go Teams]. */
export const GO_MONTHLY_LIMITS: Readonly<Record<string, readonly [number, number, number]>> = {
  'glm-5.3-flash': [60, 180, 65],
  'glm-5.3': [15, 120, 20],
  'glm-5.2': [60, 180, 65],
  'kimi-k3.1-pro': [15, 60, 20],
  'kimi-k3': [15, 60, 20],
  'kimi-k2.7-code': [60, 180, 65],
  'longcat-2.0': [60, 240, 65],
  'step-5-preview': [15, 60, 20],
  'mimo-v2.6-flash': [60, 120, 65],
  'mimo-v2.6-pro': [15, 60, 20],
  'mimo-v2.5': [60, 120, 65],
  'mimo-v2.5-pro': [15, 60, 20],
  'minimax-m3.1-flash': [20, 80, 25],
  'minimax-m3': [60, 180, 65],
  'muse-spark-1.3-contributor': [60, 120, 65],
  'muse-spark-1.2-contributor': [60, 120, 65],
  'qwen3.8-max': [15, 60, 20],
  'qwen3.8-flash': [30, 90, 35],
  'qwen3.7-plus': [60, 180, 65],
  'deepseek-v4.1-flash': [100, 200, 105],
  'deepseek-v4-pro': [15, 60, 20],
  'hy4': [60, 240, 65],
  'hy4-preview': [30, 120, 35],
  'hy3': [60, 240, 65],
  'grok-4.7': [15, 60, 20],
  'gpt-6-luna': [15, 60, 20],
  'gpt-5.6-luna': [15, 60, 20],
  'claude-haiku-5-5': [15, 60, 20],
  'gemini-4-argon': [30, 120, 35],
}

const TIER_INDEX: Partial<Record<OpencodePlanId, 0 | 1 | 2>> = { go: 0, 'go-plus': 1, 'go-teams': 2 }

/** A model's monthly limit under a plan, or `null` when the plan has none or the docs do not list the model (free ones are unlimited). */
export function goMonthlyLimit(modelId: string, plan: OpencodePlanId): number | null {
  const i = TIER_INDEX[plan]
  const row = GO_MONTHLY_LIMITS[modelId]
  return i === undefined || !row ? null : row[i]!
}

/** Models whose provider says prompts are used for training (the owner never uses them on private code). */
export const goTrainsOnData = (modelId: string): boolean => modelId.startsWith('muse-spark')

export interface GoCostRow { model: string; costUsd: number; at: number }

export interface GoWindowUse {
  kind: GoWindowKind
  usedUsd: number
  limitUsd: number
  /** `used / limit`, unclamped (a model can be over its allowance). */
  fraction: number
  /** Epoch ms at which the oldest counted response leaves the window (rolling), or a full window from `now` when nothing is counted. */
  resetsAt: number
}

export interface GoModelUse {
  model: string
  windows: GoWindowUse[]
  /** The window closest to its limit. */
  binding: GoWindowUse
  trainsOnData: boolean
}

export interface GoUsage {
  plan: OpencodePlanId
  models: GoModelUse[]
  /** The model nearest to a limit, per window kind — what an account-level ring shows. */
  tightest: Record<GoWindowKind, GoModelUse | null>
  /** Models seen with a cost but no listed limit (free, or newer than the table): said, never counted as zero use. */
  unlisted: string[]
}

/** Rolling-window usage per model. Rows from before the month window are ignored. */
export function goUsage(rows: readonly GoCostRow[], plan: OpencodePlanId, now: number): GoUsage {
  const byModel = new Map<string, GoCostRow[]>()
  for (const r of rows) {
    if (!Number.isFinite(r.costUsd) || r.costUsd < 0 || r.at > now) continue
    const list = byModel.get(r.model)
    if (list) list.push(r); else byModel.set(r.model, [r])
  }
  const models: GoModelUse[] = []
  const unlisted: string[] = []
  for (const [model, list] of byModel) {
    const monthly = goMonthlyLimit(model, plan)
    if (monthly === null) { unlisted.push(model); continue }
    const windows = (Object.keys(GO_WINDOW_SHARE) as GoWindowKind[]).map((kind): GoWindowUse => {
      const since = now - GO_WINDOW_MS[kind]
      let usedUsd = 0
      let oldest = Infinity
      for (const r of list) if (r.at > since) { usedUsd += r.costUsd; if (r.at < oldest) oldest = r.at }
      const limitUsd = monthly * GO_WINDOW_SHARE[kind]
      return { kind, usedUsd, limitUsd, fraction: usedUsd / limitUsd, resetsAt: (Number.isFinite(oldest) ? oldest : now) + GO_WINDOW_MS[kind] }
    })
    const binding = windows.reduce((a, b) => (b.fraction > a.fraction ? b : a))
    models.push({ model, windows, binding, trainsOnData: goTrainsOnData(model) })
  }
  models.sort((a, b) => b.binding.fraction - a.binding.fraction || a.model.localeCompare(b.model))
  const tightest = { '5h': null, week: null, month: null } as GoUsage['tightest']
  for (const kind of Object.keys(tightest) as GoWindowKind[]) {
    for (const m of models) {
      const w = m.windows.find(x => x.kind === kind)!
      const cur = tightest[kind]
      if (!cur || w.fraction > cur.windows.find(x => x.kind === kind)!.fraction) tightest[kind] = m
    }
  }
  return { plan, models, tightest, unlisted: unlisted.sort() }
}

/**
 * Local priced responses do not reveal the provider's quota or window anchor. Keep the plan visible,
 * with no measured windows and no routing capacity. Dollar estimates remain in the usage endpoint.
 */
export function goPlanLimits(u: GoUsage, now: number, account = 'default'): PlanLimits | null {
  if (!['go', 'go-plus', 'go-teams'].includes(u.plan)) return null
  return { harness: 'opencode', account, sourcePlan: opencodePlan(u.plan).label, windows: [], updatedAt: now, source: 'opencode-cost-estimate',
    unmeasuredReason: 'Go quota and reset unknown: local response costs do not measure provider availability.' }
}
