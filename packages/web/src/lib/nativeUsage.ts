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
import { nativeRuntimeFrom } from './nativeSession'

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

/**
 * PURE. Whether the card is drawn, and with what. The card belongs to the NATIVE RUNTIME being shown
 * here (`nativeRuntimeFrom`: an engine that provides it, and the experimental flag on), not to having
 * calls: shown, with no native call yet it is an empty state instead of vanishing (v2.98.0 hid it, so
 * a fresh install could not tell "nothing yet" from "no such feature"). Not shown — a community build,
 * or the flag off (owner decision 2026-10-03) — there is no card, whatever the journal holds.
 */
export function nativeCard(engine: boolean, usage: NativeUsage | null): { show: boolean; usage: NativeUsage | null } {
  return { show: engine, usage: engine ? usage : null }
}

/** The card's data, refreshed once a minute. */
export function useNativeUsage(): { show: boolean; usage: NativeUsage | null } {
  const [state, setState] = useState<{ engine: boolean; usage: NativeUsage | null }>({ engine: false, usage: null })
  useEffect(() => {
    let alive = true
    const load = async () => {
      let engine = false
      try {
        const e = await fetch('/api/engine', { cache: 'no-store' })
        // The card is a native surface: shown only where the native runtime may be (the experimental flag).
        if (e.ok) engine = nativeRuntimeFrom(await e.json())
      } catch { /* engine unknown: treated as absent */ }
      let usage: NativeUsage | null = null
      try {
        const res = await fetch(NATIVE_USAGE_URL, { cache: 'no-store' })
        if (res.ok) usage = nativeUsageOf(await res.json())
      } catch { /* no projections: no rows */ }
      if (alive) setState({ engine, usage })
    }
    void load()
    const t = window.setInterval(load, 60_000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])
  return nativeCard(state.engine, state.usage)
}
