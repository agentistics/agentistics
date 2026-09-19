/** PURE: is this model served off the user's own machine?
 *
 *  It matters because of what the pricing table does with an id it does not know: it returns the
 *  shared fallback ($3/$15 per 1M). For a hosted model that is a reasonable guess — some price is
 *  closer to the truth than zero. For a model running on your own GPU it is simply wrong, and wrong
 *  in the direction that invents spending: a Kimi session through Ollama was priced at $0.0072 of
 *  money that does not exist, and the error grows with every local session.
 *
 *  Matched on the PREFIX, never anywhere in the string. The prefix is the routing claim — the
 *  runtime that served the call — while "ollama" appearing later in a name says nothing about who
 *  ran it, and treating `acme-ollama-clone` as free would be the same class of mistake in reverse. */

/** Runtimes that serve models locally. A model behind one of these costs nothing to call. */
const LOCAL_RUNTIME_PREFIXES = [
  'ollama',      // covers `ollama/` and Kimi's `ollama-local/`
  'lmstudio',
  'llamacpp',
  'llama.cpp',
  'local/',
  'localhost',
] as const

export function isLocalModelId(modelId: string): boolean {
  const id = String(modelId ?? '').toLowerCase()
  return LOCAL_RUNTIME_PREFIXES.some(p => id.startsWith(p))
}

/** What a local call costs, per 1M tokens, in every column. */
export const LOCAL_MODEL_PRICE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } as const
