/**
 * The client half of the projection query API (`GET /api/runtime/metrics`, P3 / A4) that every
 * SURFACE shares — the MCP (A4.4) and the TUI (A4.6) today. Minimal structural types (a surface does
 * not depend on the server package), every page of a query, and the per-dimension rollup the
 * surfaces' figures are built from.
 *
 * The query is INJECTED: HTTP in a surface, the server's in-process query in the parity check. A
 * refusal (404 `projections_disabled`, 409 central, 503 no reader) throws `ProjectionUnavailable`,
 * and the surface falls back to its legacy path.
 */

export interface MetricsGroupLike {
  key: Record<string, string | null>
  metrics: {
    cost?: { usd: number; unpricedRows: number; partial: boolean }
    tokens?: { total: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    sessions?: { count: number }
    messages?: { value: number }
  }
}
export interface MetricsPageLike {
  groups: MetricsGroupLike[]
  page: { nextCursor: string | null }
  basis?: { freshness?: { lag: number; fresh: boolean; rebuilding: boolean }; costBasis?: unknown }
}
export type MetricsAnswer =
  | { ok: true; body: MetricsPageLike }
  | { ok: false; status: number; error: string }
export type MetricsQueryFn = (params: URLSearchParams) => Promise<MetricsAnswer>

export class ProjectionUnavailable extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`projections unavailable (${status} ${code})`)
  }
}

/** Every page of one query: the API pages by key, at most 1000 groups a page. */
const MAX_PAGES = 200

/** Query parameters; an array is one filter with several values, sent as REPEATED parameters (the
 *  only spelling `project` accepts, since a path may hold a comma). */
export type MetricsParams = Record<string, string | readonly string[]>

export function metricsSearchParams(params: MetricsParams): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') p.append(k, v)
    else for (const one of v) p.append(k, one)
  }
  return p
}

export async function allMetricGroups(q: MetricsQueryFn, params: MetricsParams): Promise<{ groups: MetricsGroupLike[]; basis: MetricsPageLike['basis'] }> {
  const groups: MetricsGroupLike[] = []
  let cursor: string | null = null
  let basis: MetricsPageLike['basis']
  for (let i = 0; i < MAX_PAGES; i++) {
    const p = metricsSearchParams({ ...params, limit: '1000' })
    if (cursor) p.set('cursor', cursor)
    const a = await q(p)
    if (!a.ok) throw new ProjectionUnavailable(a.status, a.error)
    groups.push(...a.body.groups)
    basis = a.body.basis
    cursor = a.body.page.nextCursor
    if (!cursor) return { groups, basis }
  }
  throw new Error(`metrics query did not finish in ${MAX_PAGES} pages`)
}

export interface Tok { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
export interface Rollup {
  key: string | null
  sessions: number
  personTurns: number | null
  main: Tok
  mainCost: number
  allTokens: number
  allCost: number
  costPartial: boolean
  lastActive: string | null
}

const tok = (t: MetricsGroupLike['metrics']['tokens']): Tok => ({
  input: t?.input ?? 0, output: t?.output ?? 0, cacheRead: t?.cacheRead ?? 0, cacheWrite: t?.cacheWrite ?? 0, total: t?.total ?? 0,
})

export function harnessScope(harness?: string): Record<string, string> {
  return harness && harness !== 'all' ? { harness } : {}
}

/** Per-`dim` rollup (or one total row with `dim` null): three queries — everything, main agent only, and by day. */
export async function projectedRollup(q: MetricsQueryFn, dim: string | null, harness?: string): Promise<Map<string | null, Rollup>> {
  const by = (extra: string[]) => [...(dim ? [dim] : []), ...extra].join(',')
  const base = harnessScope(harness)
  const [all, main, days] = await Promise.all([
    allMetricGroups(q, { ...base, ...(dim ? { groupBy: by([]) } : {}), metrics: 'sessions,messages,tokens,cost' }),
    allMetricGroups(q, { ...base, ...(dim ? { groupBy: by([]) } : {}), subagent: 'false', metrics: 'tokens,cost' }),
    allMetricGroups(q, { ...base, groupBy: by(['day']), metrics: 'sessions' }),
  ])
  const keyOf = (g: MetricsGroupLike) => (dim ? g.key[dim] ?? null : null)
  const out = new Map<string | null, Rollup>()
  const row = (k: string | null): Rollup => {
    let r = out.get(k)
    if (!r) {
      r = { key: k, sessions: 0, personTurns: null, main: tok(undefined), mainCost: 0, allTokens: 0, allCost: 0, costPartial: false, lastActive: null }
      out.set(k, r)
    }
    return r
  }
  for (const g of all.groups) {
    const r = row(keyOf(g))
    r.sessions = g.metrics.sessions?.count ?? 0
    r.personTurns = g.metrics.messages ? g.metrics.messages.value : null
    r.allTokens = g.metrics.tokens?.total ?? 0
    r.allCost = g.metrics.cost?.usd ?? 0
    r.costPartial ||= g.metrics.cost?.partial ?? false
  }
  for (const g of main.groups) {
    const r = row(keyOf(g))
    r.main = tok(g.metrics.tokens)
    r.mainCost = g.metrics.cost?.usd ?? 0
    r.costPartial ||= g.metrics.cost?.partial ?? false
  }
  for (const g of days.groups) {
    const d = g.key.day
    if (!d) continue
    const r = row(keyOf(g))
    if (!r.lastActive || d > r.lastActive) r.lastActive = d
  }
  return out
}


/** The surfaces' HTTP query: `${apiBase}/api/runtime/metrics?…`, the refusal's code read off its body. */
export function httpMetricsQuery(apiBase: string, fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): MetricsQueryFn {
  return async params => {
    const res = await fetchFn(`${apiBase}/api/runtime/metrics?${params}`)
    const body = await res.json().catch(() => ({})) as { error?: unknown }
    return res.ok
      ? { ok: true, body: body as unknown as MetricsPageLike }
      : { ok: false, status: res.status, error: String(body?.error ?? res.status) }
  }
}
