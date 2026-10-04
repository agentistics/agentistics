/**
 * pricing-provenance.ts — WHERE each `MODEL_PRICING` row's rates were read, and WHEN (ST-02).
 *
 * The table's own comments already said it; this is the same fact as data, so a settings screen can
 * print "official · 2026-09-25" beside a price instead of asking anyone to trust a bare number. A
 * row whose date was never recorded says so (`verifiedAt: null`) rather than borrowing a neighbour's.
 * `pricing-provenance.test.ts` holds every table row to an entry here, so a new row cannot ship
 * without saying where it came from.
 */
import { isLocalModelId } from './local-models'
import { pricingKey } from './types'

export interface PriceProvenance {
  /** The page the rates were read from (no scheme). */
  source: string
  /** `YYYY-MM-DD` the rates were checked; `null` = never recorded for this row. */
  verifiedAt: string | null
}

const ANTHROPIC = 'platform.claude.com/docs/en/about-claude/pricing'
const GOOGLE = 'ai.google.dev/gemini-api/docs/pricing'
const OPENAI = 'developers.openai.com/api/docs/pricing'

/** One entry per `MODEL_PRICING` key, transcribed from the comments beside each row. */
export const PRICE_PROVENANCE: Record<string, PriceProvenance> = {
  'claude-fable-5': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  'claude-mythos-5': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  'claude-opus-5': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  'claude-opus-5-5': { source: ANTHROPIC, verifiedAt: '2026-09-25' },
  'claude-opus-4-8': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  'claude-opus-4-7': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  'claude-sonnet-5': { source: ANTHROPIC, verifiedAt: '2026-09-25' },
  'claude-opus-4-6': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  'claude-sonnet-4-6': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  'claude-haiku-4-5-20251001': { source: ANTHROPIC, verifiedAt: '2026-07-27' },
  // Legacy rows: the same page, but no check date was ever written beside them.
  'claude-opus-4-5-20251101': { source: ANTHROPIC, verifiedAt: null },
  'claude-opus-4-1-20250805': { source: ANTHROPIC, verifiedAt: null },
  'claude-opus-4-20250514': { source: ANTHROPIC, verifiedAt: null },
  'claude-sonnet-4-5-20250929': { source: ANTHROPIC, verifiedAt: null },
  'claude-sonnet-4-20250514': { source: ANTHROPIC, verifiedAt: null },
  'claude-haiku-3-5-20241022': { source: ANTHROPIC, verifiedAt: null },
  'claude-3-haiku-20240307': { source: ANTHROPIC, verifiedAt: null },
  'gemini-3.6-flash': { source: GOOGLE, verifiedAt: '2026-07-27' },
  'gemini-3.5-flash-lite': { source: GOOGLE, verifiedAt: '2026-07-27' },
  'gemini-3.5-flash': { source: GOOGLE, verifiedAt: '2026-06-22' },
  'gemini-3.1-flash-lite': { source: GOOGLE, verifiedAt: '2026-07-27' },
  'gemini-3.1-pro': { source: GOOGLE, verifiedAt: '2026-06-22' },
  'gemini-3-flash-preview': { source: GOOGLE, verifiedAt: '2026-06-22' },
  'gemini-3-flash': { source: GOOGLE, verifiedAt: '2026-06-22' },
  'gemini-2.5-flash': { source: GOOGLE, verifiedAt: '2026-06-22' },
  'gpt-5.6-sol': { source: OPENAI, verifiedAt: '2026-07-27' },
  'gpt-5.6-terra': { source: OPENAI, verifiedAt: '2026-07-27' },
  'gpt-5.6-luna': { source: OPENAI, verifiedAt: '2026-07-27' },
  'gpt-5.5': { source: OPENAI, verifiedAt: '2026-07-27' },
  'gpt-5.4-mini': { source: OPENAI, verifiedAt: '2026-07-27' },
  'gpt-5.4': { source: OPENAI, verifiedAt: '2026-07-27' },
  'gpt-5-mini': { source: OPENAI, verifiedAt: '2026-06-20' },
  'gpt-5': { source: OPENAI, verifiedAt: '2026-06-20' },
}

/**
 * Where `modelId`'s price comes from: its table row's provenance, `local` for a model that runs on
 * this machine (it costs nothing — no page to cite), or `null` when no source can price it (the
 * caller prints N/A, never the fallback rate `getModelPrice` would guess).
 */
export function priceProvenance(modelId: string): PriceProvenance | 'local' | null {
  if (isLocalModelId(modelId)) return 'local'
  const key = pricingKey(modelId)
  return key ? (PRICE_PROVENANCE[key] ?? null) : null
}
