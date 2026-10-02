/**
 * nativeUsage.ts — the model calls the NATIVE runtime made (`agentop code`, `agentop provider try`),
 * read from the journal projections (`GET /api/runtime/metrics`, harness `agentistics`).
 *
 * These calls belong to no harness transcript, so nothing else in the app shows them. The figures
 * come from the projection AS STATED: the cost the provider reported, or the table price of a model
 * the table knows — never a guessed price (an unknown model is "unpriced", see `hasModelPrice`).
 * A machine without projections (the flag off, a central) answers 404/409: no card, not a zero.
 */
import { useEffect, useState } from 'react'

export interface NativeUsageRow {
  model: string
  /** The provider id the call was billed through, or `null` when the call named none. */
  provider: string | null
  calls: number
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  totalTokens: number
  /** `null` when no call in the row could be priced. */
  costUSD: number | null
  /** Some calls in the row were unpriced, so `costUSD` is a floor. */
  costPartial: boolean
}

export interface NativeUsage {
  rows: NativeUsageRow[]
  calls: number
  totalTokens: number
  costUSD: number | null
  costPartial: boolean
}

interface MetricsGroupWire {
  key: { model?: string | null; provider?: string | null }
  metrics: {
    cost?: { usd: number; pricedRows: number; unpricedRows: number; partial: boolean }
    tokens?: { total: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    responses?: { count: number }
  }
}

export const NATIVE_USAGE_URL = '/api/runtime/metrics?harness=agentistics&groupBy=model,provider&metrics=cost,tokens,responses&limit=200'

/** PURE. The projection answer → the rows the card renders, most expensive first, then by calls. */
export function nativeUsageOf(body: { groups?: MetricsGroupWire[] } | null | undefined): NativeUsage | null {
  const groups = body?.groups ?? []
  const rows: NativeUsageRow[] = []
  for (const g of groups) {
    const calls = g.metrics.responses?.count ?? 0
    const t = g.metrics.tokens
    if (calls === 0 && !(t && t.total > 0)) continue
    const c = g.metrics.cost
    const priced = !!c && c.pricedRows > 0
    rows.push({
      model: g.key.model || '?',
      provider: g.key.provider ?? null,
      calls,
      input: t?.input ?? null,
      output: t?.output ?? null,
      cacheRead: t?.cacheRead ?? null,
      cacheWrite: t?.cacheWrite ?? null,
      totalTokens: t?.total ?? 0,
      costUSD: priced ? c!.usd : null,
      costPartial: !!c && (c.partial || (priced && c.unpricedRows > 0)),
    })
  }
  if (rows.length === 0) return null
  rows.sort((a, b) => (b.costUSD ?? -1) - (a.costUSD ?? -1) || b.calls - a.calls || a.model.localeCompare(b.model))
  const anyPriced = rows.some(r => r.costUSD !== null)
  return {
    rows,
    calls: rows.reduce((n, r) => n + r.calls, 0),
    totalTokens: rows.reduce((n, r) => n + r.totalTokens, 0),
    costUSD: anyPriced ? rows.reduce((n, r) => n + (r.costUSD ?? 0), 0) : null,
    costPartial: rows.some(r => r.costPartial || r.costUSD === null),
  }
}

/** The card's data, refreshed once a minute; `null` while there is nothing to show (or no projections). */
export function useNativeUsage(): NativeUsage | null {
  const [state, setState] = useState<NativeUsage | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(NATIVE_USAGE_URL, { cache: 'no-store' })
        if (!res.ok) { if (alive) setState(null); return }
        const next = nativeUsageOf(await res.json())
        if (alive) setState(next)
      } catch { if (alive) setState(null) }
    }
    void load()
    const t = window.setInterval(load, 60_000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])
  return state
}
