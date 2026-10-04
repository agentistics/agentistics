/**
 * nativeRuns.ts — PURE. H6: a native session's ONE LINE PER RUN and its CONTEXT GAUGE, as the engine
 * serves them (`GET /api/runtime/sessions/:id/runs`, folded from the usage ledger the board's cost
 * comes from). Structural: the web never imports the engine. Untrusted input never throws.
 */
import { fmt, fmtCost } from '@agentistics/core'

export interface RunLineView {
  runId: string
  responses: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null
  costUSD: number | null
  costMeasured: boolean
  cacheShare: number | null
  context: { tokens: number; window: number | null; fraction: number | null } | null
  model?: string
  /** B9.1: reasoning tokens over the run, when the provider counted them apart. */
  reasoningTokens?: number
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function parseRuns(body: unknown): RunLineView[] {
  const runs = (body as { runs?: unknown } | null)?.runs
  if (!Array.isArray(runs)) return []
  return runs.filter((r): r is RunLineView =>
    !!r && typeof r === 'object' && typeof (r as RunLineView).runId === 'string' && num((r as RunLineView).responses))
}

const pct = (f: number) => `${Math.floor(f * 100)}%`

/** The line of one run: `12.3K tokens · USD 0.04 (estimated) · cache 87% · context 34% of 200.0K`. */
export function runLineText(r: RunLineView, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  const parts: string[] = []
  // H24: the model the run was priced on — after a switch, the cost per model reads run by run.
  if (r.model) parts.push(r.model)
  parts.push(r.tokens ? `${fmt(r.tokens.total)} tokens` : (pt ? 'tokens não medidos' : 'tokens not measured'))
  parts.push(r.costUSD === null
    ? (pt ? 'sem preço' : 'no price')
    : `${fmtCost(r.costUSD)}${r.costMeasured ? '' : (pt ? ' (estimado)' : ' (estimated)')}`)
  if (num(r.reasoningTokens)) parts.push(pt ? `raciocínio ${fmt(r.reasoningTokens)}` : `reasoning ${fmt(r.reasoningTokens)}`)
  if (r.cacheShare !== null) parts.push(`cache ${pct(r.cacheShare)}`)
  const c = r.context
  if (c) {
    parts.push(c.fraction === null || c.window === null
      ? (pt ? `contexto ${fmt(c.tokens)} (janela desconhecida)` : `context ${fmt(c.tokens)} (window unknown)`)
      : (pt ? `contexto ${pct(c.fraction)} de ${fmt(c.window)}` : `context ${pct(c.fraction)} of ${fmt(c.window)}`))
  }
  return parts.join(' · ')
}

/** The gauge: how full the window was on the LATEST run's last call; `null` when it is not known. */
export function contextGauge(runs: readonly RunLineView[]): { fraction: number; tokens: number; window: number } | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const c = runs[i]!.context
    if (!c) continue
    return c.fraction === null || c.window === null ? null : { fraction: c.fraction, tokens: c.tokens, window: c.window }
  }
  return null
}
