/**
 * Surface-level parity (P3 / A4.4): the legacy tool output against the projected one, row by row and
 * field by field — the check that must pass on a real store before a surface's default flips.
 *
 * Counts and tokens must be EQUAL; money may differ by `costTolerance` (relative, default 0.1%), or
 * by one cent, whichever is larger. A row present on one side only is a difference too.
 */

export interface FieldDiff { key: string; field: string; legacy: unknown; projected: unknown }
export interface ParityReport {
  surface: string
  rowsLegacy: number
  rowsProjected: number
  matchedRows: number
  onlyLegacy: string[]
  onlyProjected: string[]
  diffs: FieldDiff[]
  equal: boolean
}

export interface ParityOptions { costTolerance?: number }

const isMoney = (field: string) => /cost|usd/i.test(field)

export function sameValue(field: string, a: unknown, b: unknown, opts: ParityOptions = {}): boolean {
  if (typeof a === 'number' && typeof b === 'number' && isMoney(field)) {
    const tol = Math.max(0.01, Math.abs(a) * (opts.costTolerance ?? 0.001))
    return Math.abs(a - b) <= tol
  }
  return a === b
}

export function compareRows(
  surface: string,
  legacy: Record<string, unknown>[],
  projected: Record<string, unknown>[],
  key: string,
  fields: readonly string[],
  opts: ParityOptions = {},
): ParityReport {
  const index = (rows: Record<string, unknown>[]) => new Map(rows.map(r => [String(r[key]), r]))
  const L = index(legacy)
  const P = index(projected)
  const diffs: FieldDiff[] = []
  let matchedRows = 0
  for (const [k, l] of L) {
    const p = P.get(k)
    if (!p) continue
    let rowEqual = true
    for (const f of fields) {
      if (!sameValue(f, l[f], p[f], opts)) { diffs.push({ key: k, field: f, legacy: l[f], projected: p[f] }); rowEqual = false }
    }
    if (rowEqual) matchedRows++
  }
  const onlyLegacy = [...L.keys()].filter(k => !P.has(k))
  const onlyProjected = [...P.keys()].filter(k => !L.has(k))
  return {
    surface, rowsLegacy: L.size, rowsProjected: P.size, matchedRows, onlyLegacy, onlyProjected, diffs,
    equal: diffs.length === 0 && onlyLegacy.length === 0 && onlyProjected.length === 0,
  }
}

export function compareObject(
  surface: string,
  legacy: Record<string, unknown>,
  projected: Record<string, unknown>,
  fields: readonly string[],
  opts: ParityOptions = {},
): ParityReport {
  return compareRows(surface, [{ ...legacy, __k: 'total' }], [{ ...projected, __k: 'total' }], '__k', fields, opts)
}

/** The figures each MCP tool's parity is judged on: every field both paths define with the same meaning. */
export const MCP_PARITY_FIELDS = {
  agentistics_summary: ['totalSessions', 'totalInputTokens', 'totalOutputTokens', 'totalCacheReadTokens', 'totalCacheWriteTokens', 'estimatedCostUSD', 'topModel', 'topProject', 'activeDays'],
  agentistics_harnesses: { key: 'harness', fields: ['sessions', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'estimatedCostUSD'] },
  agentistics_projects: { key: 'path', fields: ['sessions', 'inputTokens', 'outputTokens', 'totalTokens', 'estimatedCostUSD'] },
  agentistics_costs: { key: 'model', fields: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'estimatedCostUSD'] },
  agentistics_repos: { key: 'repo', fields: ['sessions', 'inputTokens', 'outputTokens', 'totalTokens', 'estimatedCostUSD'] },
} as const
