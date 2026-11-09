/**
 * The ONE rule for how a cost figure reads when some or all of its usage has no price (PRICE.UNKNOWN):
 * every token unpriced -> "not recorded" (never a 0), some -> the priced value plus the
 * "+ unpriced usage" marker, none -> the plain value. Every surface that prints a cost goes through here.
 */
import { UNPRICED_TOTAL_MARKER, sessionCostUSD, unpricedTokens } from './types'
import { sessionTokenTotal } from './tokens'

export type CostState = 'priced' | 'partial' | 'unknown'

export const COST_NOT_RECORDED = { pt: 'não registrado', en: 'not recorded' } as const

export function costState(unpriced: number, tokens: number): CostState {
  if (!(unpriced > 0)) return 'priced'
  return unpriced >= tokens ? 'unknown' : 'partial'
}

/** The text of a cost cell. `format` renders the priced figure (currency, locale). */
export function costCellText(usd: number, unpriced: number, tokens: number, lang: 'pt' | 'en', format: (usd: number) => string): string {
  const state = costState(unpriced, tokens)
  if (state === 'unknown') return COST_NOT_RECORDED[lang]
  const v = format(usd)
  return state === 'partial' ? `${v} ${UNPRICED_TOTAL_MARKER[lang]}` : v
}

/** A whole session's cost cell, through the same rule. `usd` overrides the priced figure (plan rescale etc.). */
export function sessionCostCell(
  s: Parameters<typeof unpricedTokens>[0] & Parameters<typeof sessionCostUSD>[0] & Parameters<typeof sessionTokenTotal>[0],
  lang: 'pt' | 'en',
  format: (usd: number) => string,
  usd?: number,
): string {
  return costCellText(usd ?? sessionCostUSD(s) ?? 0, unpricedTokens(s), sessionTokenTotal(s) ?? 0, lang, format)
}
