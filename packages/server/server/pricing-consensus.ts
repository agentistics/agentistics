import type { PriceEntry } from '@agentistics/core'

/**
 * A vendor page is scraped HTML, written for people, and a redesign can make a reader return
 * numbers that are well-formed and wrong. On 2026-09-25 Anthropic moved Output from the last column
 * to the second, the positional reader priced every cache read at the 1h cache-WRITE rate (20x),
 * and because the official layer overrode the others unconditionally, every cost surface jumped
 * ~16x while the built-in table and the community dataset both still held the right figure.
 *
 * So a scraped row has to AGREE before it wins. It must pass the row invariants, and when some
 * other layer already prices the model, no field may sit more than `MAX_OFFICIAL_DRIFT` away from
 * that figure. A refused row keeps the prior price: a scrape bug costs freshness, never money.
 * A model nobody else prices yet is adopted on the invariants alone — pricing a model on the day it
 * launches is what the scrape is for.
 */

/** Same-id price changes this large are a misread, not a repricing; the next community refresh
 *  carries a genuine one anyway. */
export const MAX_OFFICIAL_DRIFT = 3

type Field = keyof PriceEntry
const FIELDS: Field[] = ['input', 'output', 'cacheRead', 'cacheWrite']

export type OfficialRejection =
  | { id: string; reason: 'invariant' }
  | { id: string; reason: 'drift'; field: Field }

/** Shape any vendor row must have. `output >= input` is deliberately NOT one: some real models
 *  bill output below input, while a cache read above input or a cache write below the read is a
 *  column mix-up on every vendor measured. */
function rowIsSane(p: PriceEntry): boolean {
  if (!FIELDS.every(f => Number.isFinite(p[f]) && p[f] > 0)) return false
  return p.cacheRead <= p.input && p.cacheWrite >= p.cacheRead
}

function driftedField(p: PriceEntry, prior: PriceEntry): Field | null {
  for (const f of FIELDS) {
    const a = p[f], b = prior[f]
    if (b > 0 && (a > b * MAX_OFFICIAL_DRIFT || a < b / MAX_OFFICIAL_DRIFT)) return f
  }
  return null
}

/** `prior` is what the lower layers (built-in + community) already say. */
export function vetOfficialPricing(
  official: Record<string, PriceEntry>,
  prior: Record<string, PriceEntry>,
): { accepted: Record<string, PriceEntry>; rejected: OfficialRejection[] } {
  const accepted: Record<string, PriceEntry> = {}
  const rejected: OfficialRejection[] = []
  for (const [id, price] of Object.entries(official)) {
    if (!rowIsSane(price)) { rejected.push({ id, reason: 'invariant' }); continue }
    const known = prior[id]
    const field = known ? driftedField(price, known) : null
    if (field) { rejected.push({ id, reason: 'drift', field }); continue }
    accepted[id] = price
  }
  return { accepted, rejected }
}
