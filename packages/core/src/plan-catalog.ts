/**
 * plan-catalog.ts — the known subscription plans, offered as a PREFILL for the billing timeline.
 *
 * ── A PRICE HERE IS A SUGGESTION, NEVER AN AUTHORITY ─────────────────────────────────────────
 * Whatever the user types wins, always. This table exists so that registering a plan is two
 * clicks instead of a trip to a pricing page — not so the product can assert what someone pays.
 * It cannot know: prices are regional, they change, annual billing differs from monthly, and a
 * grandfathered subscriber may pay a figure no page has shown for a year.
 *
 * ── THE MODEL_PRICING RULE, ENFORCED BY THE TYPE ─────────────────────────────────────────────
 * CLAUDE.md's rule for `MODEL_PRICING` is "never guess a rate: a wrong price is worse than a
 * missing one, and a missing one is visible". The same applies here and harder, because a wrong
 * monthly price silently scales EVERY cost on the dashboard. So `verifiedAt` and `source` live
 * INSIDE `CatalogPrice` rather than beside it: a price cannot be added without stating when it
 * was checked and where it came from. An unverifiable price is OMITTED — the form's amount field
 * is then blank and required, which costs the user one keystroke and costs the product nothing.
 *
 * Several entries below deliberately carry no price for exactly that reason, each with a note
 * saying what the vendor's page does and does not state. Two cases worth knowing about:
 *   • Claude Max — the pricing page quotes only "From $100 per month" for Max as a whole and does
 *     not break out 5x and 20x. The floor is quoted so the 5x entry carries it; the 20x figure is
 *     not on the page and is therefore absent.
 *   • Google's subscription page is GEOLOCALIZED and served this machine Brazilian real. A
 *     region's price is not the price, so no figure is shipped.
 *
 * ── RE-VERIFYING ─────────────────────────────────────────────────────────────────────────────
 * Bump `verifiedAt` only when the figure has actually been re-checked against `source`. A stale
 * date is information; a fresh date on an unchecked number is a lie the UI will repeat.
 */

import type { HarnessId } from './types'
import type { BillingCurrency, BillingDay, BillingMode } from './billing'

export type PlanProviderId =
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'google'
  | 'cursor'
  | 'windsurf'
  | 'moonshot'
  | 'generic'

/** A price that has been checked. The two provenance fields are required BY CONSTRUCTION. */
export interface CatalogPrice {
  amount: number
  currency: BillingCurrency
  /** `yyyy-MM-dd` the figure was last checked against `source`. */
  verifiedAt: BillingDay
  /** The exact page the figure came from. */
  source: string
}

export interface PlanCatalogEntry {
  /** Stable forever — it is persisted in the user's timeline, so renaming one orphans their
   *  period. Add a new id instead of repurposing an old one. */
  id: string
  provider: PlanProviderId
  label: string
  mode: BillingMode
  /** Which harnesses this plan typically pays for. An ORDERING HINT ONLY, never a filter: people
   *  do route Claude models through a gateway and Copilot through anything, so a picker that hid
   *  the "wrong" plan would simply be wrong. */
  suggestedHarnesses: HarnessId[]
  /** Absent when no figure could be verified. The form then requires the user to type one. */
  monthly?: CatalogPrice
  noteEn?: string
  notePt?: string
}

const CLAUDE_PRICING = 'https://claude.com/pricing'
const COPILOT_PRICING = 'https://github.com/features/copilot/plans'
const CHATGPT_PRICING = 'https://openai.com/chatgpt/pricing/'
const GEMINI_PRICING = 'https://gemini.google/subscriptions/'
const CHECKED = '2026-08-12'

/**
 * `api-payg` and `other` are SENTINELS, not plans, and both are listed last everywhere.
 * `api-payg` is how a user says "I pay per token" — its periods carry no monthly price because
 * their cost is the API estimate itself. `other` is the escape hatch for anything absent here,
 * and requires a label so the timeline never shows a nameless row.
 */
export const SENTINEL_PLAN_IDS = ['api-payg', 'other'] as const

export const PLAN_CATALOG: readonly PlanCatalogEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'anthropic-pro',
    provider: 'anthropic',
    label: 'Claude Pro',
    mode: 'subscription',
    suggestedHarnesses: ['claude'],
    monthly: { amount: 20, currency: 'USD', verifiedAt: CHECKED, source: CLAUDE_PRICING },
    noteEn: 'USD 20/month billed monthly; USD 17/month billed annually.',
    notePt: 'USD 20/mês na cobrança mensal; USD 17/mês na anual.',
  },
  {
    id: 'anthropic-max-5x',
    provider: 'anthropic',
    label: 'Claude Max 5x',
    mode: 'subscription',
    suggestedHarnesses: ['claude'],
    monthly: { amount: 100, currency: 'USD', verifiedAt: CHECKED, source: CLAUDE_PRICING },
    noteEn: 'The pricing page quotes "From $100 per month" for Max; 5x is the entry tier. Confirm against your invoice.',
    notePt: 'A página de preços diz "a partir de $100 por mês" para o Max; 5x é o nível de entrada. Confirme na sua fatura.',
  },
  {
    id: 'anthropic-max-20x',
    provider: 'anthropic',
    label: 'Claude Max 20x',
    mode: 'subscription',
    suggestedHarnesses: ['claude'],
    // No price: the pricing page states only the "From $100" floor for Max and does not break the
    // 20x tier out. Guessing it would scale every cost on the dashboard by a made-up number.
    noteEn: 'The pricing page does not state the 20x price separately — enter the amount from your invoice.',
    notePt: 'A página de preços não informa o valor do 20x separadamente — digite o valor da sua fatura.',
  },
  {
    id: 'anthropic-team',
    provider: 'anthropic',
    label: 'Claude Team',
    mode: 'subscription',
    suggestedHarnesses: ['claude'],
    monthly: { amount: 25, currency: 'USD', verifiedAt: CHECKED, source: CLAUDE_PRICING },
    noteEn: 'Standard seat, billed monthly (USD 20/seat annually). The premium seat is USD 125/month.',
    notePt: 'Assento padrão, cobrança mensal (USD 20/assento na anual). O assento premium é USD 125/mês.',
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'openai-go',
    provider: 'openai',
    label: 'ChatGPT Go',
    mode: 'subscription',
    suggestedHarnesses: ['codex'],
    monthly: { amount: 8, currency: 'USD', verifiedAt: CHECKED, source: CHATGPT_PRICING },
    noteEn: 'US price. Go is priced regionally and differs in other countries.',
    notePt: 'Preço nos EUA. O Go tem preço regional e varia em outros países.',
  },
  {
    id: 'openai-plus',
    provider: 'openai',
    label: 'ChatGPT Plus',
    mode: 'subscription',
    suggestedHarnesses: ['codex'],
    monthly: { amount: 20, currency: 'USD', verifiedAt: CHECKED, source: CHATGPT_PRICING },
  },
  {
    id: 'openai-pro',
    provider: 'openai',
    label: 'ChatGPT Pro',
    mode: 'subscription',
    suggestedHarnesses: ['codex'],
    monthly: { amount: 200, currency: 'USD', verifiedAt: CHECKED, source: CHATGPT_PRICING },
    noteEn: 'Pro has two tiers — a USD 100/month tier with lower allowances and this USD 200/month one.',
    notePt: 'O Pro tem dois níveis — um de USD 100/mês com limites menores e este de USD 200/mês.',
  },
  {
    id: 'openai-business',
    provider: 'openai',
    label: 'ChatGPT Business',
    mode: 'subscription',
    suggestedHarnesses: ['codex'],
    // No price: the business pricing page is not publicly readable.
    noteEn: 'Per-seat price is not published on a public page — enter the amount from your invoice.',
    notePt: 'O valor por assento não está numa página pública — digite o valor da sua fatura.',
  },

  // ── GitHub ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'copilot-pro',
    provider: 'github',
    label: 'GitHub Copilot Pro',
    mode: 'subscription',
    suggestedHarnesses: ['copilot'],
    monthly: { amount: 10, currency: 'USD', verifiedAt: CHECKED, source: COPILOT_PRICING },
  },
  {
    id: 'copilot-pro-plus',
    provider: 'github',
    label: 'GitHub Copilot Pro+',
    mode: 'subscription',
    suggestedHarnesses: ['copilot'],
    monthly: { amount: 39, currency: 'USD', verifiedAt: CHECKED, source: COPILOT_PRICING },
  },
  {
    id: 'copilot-max',
    provider: 'github',
    label: 'GitHub Copilot Max',
    mode: 'subscription',
    suggestedHarnesses: ['copilot'],
    monthly: { amount: 100, currency: 'USD', verifiedAt: CHECKED, source: COPILOT_PRICING },
  },
  {
    id: 'copilot-business',
    provider: 'github',
    label: 'GitHub Copilot Business',
    mode: 'subscription',
    suggestedHarnesses: ['copilot'],
    noteEn: 'The plans page does not state the organization price — enter the amount from your invoice.',
    notePt: 'A página de planos não informa o valor para organizações — digite o valor da sua fatura.',
  },
  {
    id: 'copilot-enterprise',
    provider: 'github',
    label: 'GitHub Copilot Enterprise',
    mode: 'subscription',
    suggestedHarnesses: ['copilot'],
    noteEn: 'The plans page does not state the organization price — enter the amount from your invoice.',
    notePt: 'A página de planos não informa o valor para organizações — digite o valor da sua fatura.',
  },

  // ── Google ─────────────────────────────────────────────────────────────────────────────────
  // No prices: gemini.google/subscriptions is geolocalized and served this machine Brazilian real.
  // A region's price is not the price.
  {
    id: 'google-ai-plus',
    provider: 'google',
    label: 'Google AI Plus',
    mode: 'subscription',
    // @harness-adapters-only: the CLIs this subscription covers — data about the plan, not an enumeration.
    suggestedHarnesses: ['gemini', 'antigravity'],
    noteEn: "Google prices this per region — enter the amount your account is charged.",
    notePt: 'O Google cobra por região — digite o valor cobrado na sua conta.',
  },
  {
    id: 'google-ai-pro',
    provider: 'google',
    label: 'Google AI Pro',
    mode: 'subscription',
    // @harness-adapters-only: the CLIs this subscription covers — data about the plan, not an enumeration.
    suggestedHarnesses: ['gemini', 'antigravity'],
    noteEn: "Google prices this per region — enter the amount your account is charged.",
    notePt: 'O Google cobra por região — digite o valor cobrado na sua conta.',
  },
  {
    id: 'google-ai-ultra',
    provider: 'google',
    label: 'Google AI Ultra',
    mode: 'subscription',
    // @harness-adapters-only: the CLIs this subscription covers — data about the plan, not an enumeration.
    suggestedHarnesses: ['gemini', 'antigravity'],
    noteEn: "Google prices this per region — enter the amount your account is charged.",
    notePt: 'O Google cobra por região — digite o valor cobrado na sua conta.',
  },

  // ── Others ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-pro',
    provider: 'cursor',
    label: 'Cursor Pro',
    mode: 'subscription',
    suggestedHarnesses: [],
    noteEn: 'Not verified against a vendor page — enter the amount from your invoice.',
    notePt: 'Não verificado numa página do fornecedor — digite o valor da sua fatura.',
  },
  {
    id: 'windsurf-pro',
    provider: 'windsurf',
    label: 'Windsurf Pro',
    mode: 'subscription',
    suggestedHarnesses: [],
    noteEn: 'Not verified against a vendor page — enter the amount from your invoice.',
    notePt: 'Não verificado numa página do fornecedor — digite o valor da sua fatura.',
  },
  {
    id: 'kimi-plus',
    provider: 'moonshot',
    label: 'Kimi subscription',
    mode: 'subscription',
    suggestedHarnesses: ['kimi'],
    noteEn: 'Not verified against a vendor page — enter the amount from your invoice.',
    notePt: 'Não verificado numa página do fornecedor — digite o valor da sua fatura.',
  },

  // ── Sentinels, always last ─────────────────────────────────────────────────────────────────
  {
    id: 'api-payg',
    provider: 'generic',
    label: 'API — pay as you go',
    mode: 'api',
    suggestedHarnesses: [],
    noteEn: 'No monthly price: on these days the API estimate IS the bill, so cost is reported as-is.',
    notePt: 'Sem valor mensal: nesses dias a estimativa de API É a fatura, então o custo vai como está.',
  },
  {
    id: 'other',
    provider: 'generic',
    label: 'Other plan',
    mode: 'subscription',
    suggestedHarnesses: [],
    noteEn: 'Name it and enter what you pay per month.',
    notePt: 'Dê um nome e informe quanto você paga por mês.',
  },
]

const BY_ID = new Map(PLAN_CATALOG.map((entry) => [entry.id, entry]))

/** The catalog entry for an id, or `undefined`. Never throws — a timeline holding an id from a
 *  newer build must render as an unknown plan, not crash the page. */
export function findPlan(id: string): PlanCatalogEntry | undefined {
  return BY_ID.get(id)
}

const isSentinel = (id: string): boolean => (SENTINEL_PLAN_IDS as readonly string[]).includes(id)

/**
 * The catalog ordered for one harness: its suggested plans first, then everything else, then the
 * sentinels.
 *
 * It ORDERS and never FILTERS — every entry is always returned. Hiding the "wrong" plans would
 * be a guess about someone's billing dressed up as a simplification, and it is wrong often
 * enough to matter: Antigravity runs Anthropic models, Kimi routes to whoever it likes, and a
 * corporate gateway can put any model behind any subscription.
 */
export function plansForHarness(harness: HarnessId): PlanCatalogEntry[] {
  const rank = (entry: PlanCatalogEntry): number => {
    if (isSentinel(entry.id)) return 2
    return entry.suggestedHarnesses.includes(harness) ? 0 : 1
  }
  return [...PLAN_CATALOG].sort((a, b) => {
    const diff = rank(a) - rank(b)
    if (diff !== 0) return diff
    return PLAN_CATALOG.indexOf(a) - PLAN_CATALOG.indexOf(b)
  })
}
