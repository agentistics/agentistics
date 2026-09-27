/**
 * providers.ts — which company bills a given model id.
 *
 * A harness is not a provider. Codex and Copilot both run OpenAI models; Antigravity runs Google's
 * AND Anthropic's; Kimi Code routes to whoever it likes. Pricing is per MODEL, so grouping a price
 * table by harness would put the same row under three headings with three different totals.
 *
 * ── ADDING A HARNESS ─────────────────────────────────────────────────────────────────────────
 * Nothing here needs to change if the harness reports model ids from a provider already listed
 * below — which is the common case, since new harnesses tend to route to existing model families.
 * Add an entry ONLY when a harness introduces a genuinely new vendor, and when you do:
 *   1. add the provider here with the id prefixes it bills under and its pricing page URL;
 *   2. add that vendor's models to MODEL_PRICING (types.ts) with verified rates and a dated
 *      source comment — never guess a rate, a wrong price is worse than a missing one;
 *   3. make sure the adapter reports the BARE model id (strip any `provider/` prefix, as the Kimi
 *      adapter does) so both this matcher and the pricing table can key on it.
 * `resolveProvider` falls back to 'other' rather than throwing, so a missed entry degrades to an
 * ungrouped row instead of breaking the page.
 */

/**
 * `'openai-compatible'` is in the union but has NO entry in `PROVIDERS` below, on purpose (B5a, D1).
 * It is a PROTOCOL — the OpenAI Chat Completions wire shape, spoken by OpenAI itself, OpenRouter,
 * DeepSeek, LiteLLM, 9router and Ollama — not a company that bills a model id. The native runtime
 * needs it as a `ProviderId` because a `ProviderClient`, a journaled `model.*` event and a stored
 * credential all name the protocol their request was made over. Pricing needs the opposite: the
 * vendor that bills the MODEL, whichever door the request went through. So `resolveProvider` never
 * returns it (a model id carries no protocol), and a model served over this protocol is grouped by
 * its own prefix like every other.
 */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'moonshot' | 'openai-compatible' | 'other'

export interface ProviderInfo {
  id: ProviderId
  label: string
  /** Lowercase prefixes of model ids this provider bills. Longest match wins. */
  prefixes: string[]
  /** The vendor's own pricing page — shown as the citation next to the table. */
  pricingUrl?: string
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    prefixes: ['claude-', 'anthropic.', 'anthropic/'],
    pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    prefixes: ['gpt-', 'o1', 'o3', 'o4', 'openai/', 'chatgpt-', 'codex-'],
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
  },
  {
    id: 'google',
    label: 'Google',
    prefixes: ['gemini-', 'gemma-', 'google/', 'vertex_ai/'],
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI',
    prefixes: ['kimi-', 'kimi', 'moonshot'],
    pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat',
  },
]

const OTHER: ProviderInfo = { id: 'other', label: 'Other', prefixes: [] }

/** The provider that bills a model id. Never throws: an unrecognised id groups under "Other". */
export function resolveProvider(modelId: string): ProviderInfo {
  const id = modelId.toLowerCase()
  let best: ProviderInfo | null = null
  let bestLen = 0
  for (const p of PROVIDERS) {
    for (const prefix of p.prefixes) {
      if (id.startsWith(prefix) && prefix.length > bestLen) { best = p; bestLen = prefix.length }
    }
  }
  return best ?? OTHER
}

/** Provider order for display, with "Other" always last so unknowns never lead the page. */
export function providerOrder(): ProviderInfo[] {
  return [...PROVIDERS, OTHER]
}
