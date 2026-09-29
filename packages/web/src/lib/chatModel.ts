/**
 * chatModel.ts — PURE: which model the Nay chat runs, and what it is called, read off the server's
 * `/api/chat-harnesses` answer (the ONE model catalog — `server/model-catalog.ts`). The hardcoded
 * `chatModels.ts` list is gone: it had drifted months behind every CLI it named.
 */

export interface ChatModelSource {
  models: { id: string; label: string }[]
  /** The list is the incomplete fallback table, so an unlisted id may still be asked for. */
  modelFreeText?: boolean
  /** The machine's configured default, or `''` (the CLI's own — no `--model` at all). */
  defaultModel: string
}

/**
 * The model to send. The chosen one when this harness can take it (listed, or free text allowed);
 * otherwise the harness's configured default, then the first model it lists, and `''` when it
 * names none — which the server turns into "no --model flag", never an invented id.
 */
export function resolveChatModel(chosen: string | null, harness: ChatModelSource | null): string {
  if (!harness) return chosen ?? ''
  if (chosen && (harness.models.some(m => m.id === chosen) || harness.modelFreeText)) return chosen
  return harness.defaultModel || harness.models[0]?.id || ''
}

/** The name to print for an id: the harness's own label, else the id itself, never a guessed one. */
export function chatModelLabel(id: string, harnesses: { models: { id: string; label: string }[] }[], lang: 'pt' | 'en'): string {
  if (!id) return lang === 'pt' ? 'padrão do assistente' : "assistant's default"
  for (const h of harnesses) {
    const hit = h.models.find(m => m.id === id)
    if (hit) return hit.label
  }
  return id
}

/**
 * A typed id the server would accept as an argv value: one token, no spaces, never flag-shaped.
 * The server re-checks (`isSafeModelId`); this only stops the UI offering what will be refused.
 */
export function typedModelId(text: string): string | null {
  const id = text.trim()
  return id.length > 0 && id.length <= 200 && /^[\w.:@/[\]-]+$/.test(id) && !id.startsWith('-') ? id : null
}
