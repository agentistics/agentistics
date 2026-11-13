/**
 * Cost of a session = Σ over its turns of calcCost(turn tokens, turn model). Never a share of a
 * model's period sum. A turn whose model has no price row, or whose tokens were not stored, makes
 * the session `costUSD: null` with the reason; it is never priced at a fallback rate and never 0.
 */
import { calcCost, hasModelPrice } from '../types'
import { PRICE_PROVENANCE } from '../pricing-provenance'
import type { Covered, Priced } from './contract'

export interface TurnTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The TTL split of `cacheWrite`. Used only when BOTH halves are stated (calcCost's own rule). */
  cacheWrite1h?: number
  cacheWrite5m?: number
}

export interface SessionTurn {
  model: string
  /** null = the harness did not store tokens for this turn. */
  tokens: TurnTokens | null
}

/** Version of the price table in use: the newest verification date among the priced rows. */
export function priceTableVersion(): string {
  let newest = ''
  for (const p of Object.values(PRICE_PROVENANCE)) if (p.verifiedAt && p.verifiedAt > newest) newest = p.verifiedAt
  return newest ? `MODEL_PRICING@${newest}` : 'MODEL_PRICING@unknown'
}

export function sessionCost(turns: readonly SessionTurn[]): Priced {
  const base = { basis: 'table×tokens' as const, priceTable: priceTableVersion() }
  if (turns.length === 0) return { ...base, costUSD: null, missing: 'tokens' }
  let sum = 0
  let missing: Priced['missing']
  for (const t of turns) {
    if (!hasModelPrice(t.model)) { missing = missing ?? 'price'; continue }
    if (!t.tokens) { missing = missing ?? 'tokens'; continue }
    sum += calcCost(
      {
        inputTokens: t.tokens.input,
        outputTokens: t.tokens.output,
        cacheReadInputTokens: t.tokens.cacheRead,
        cacheCreationInputTokens: t.tokens.cacheWrite,
        ...(t.tokens.cacheWrite1h !== undefined && t.tokens.cacheWrite5m !== undefined
          ? { cacheCreation1hInputTokens: t.tokens.cacheWrite1h, cacheCreation5mInputTokens: t.tokens.cacheWrite5m } : {}),
        webSearchRequests: 0,
        costUSD: 0,
      },
      t.model,
    )
  }
  if (missing) return { ...base, costUSD: null, missing }
  return { ...base, costUSD: sum }
}

/** Sum of priced sessions with its coverage. `value` is null when ANY session is unpriced and `strict`, else the covered sum. */
export function sumCost(items: readonly { id: string; cost: Priced }[], formula = 'Σ session cost (table×tokens)'): Covered<number> {
  const missing = items.filter(i => i.cost.costUSD === null).map(i => i.id)
  const covered = items.length - missing.length
  const value = covered === 0 ? null : items.reduce((s, i) => s + (i.cost.costUSD ?? 0), 0)
  return { value, interval: null, gaps: missing.length ? [{ code: 'no_tokens' as const, count: missing.length }] : [], n: items.length, covered, total: items.length, missing, formula, origin: {
    records: ['session cost records'], formula, n: items.length,
    coverage: `${covered} of ${items.length} sessions priced`,
  } }
}
