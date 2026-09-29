/**
 * chatModel.ts — PURE: the shape check for a model id a person TYPES into a picker whose list is the
 * server's incomplete fallback table (`server/model-catalog.ts`).
 */

/**
 * A typed id the server would accept as an argv value: one token, no spaces, never flag-shaped.
 * The server re-checks (`isSafeModelId`); this only stops the UI offering what will be refused.
 */
export function typedModelId(text: string): string | null {
  const id = text.trim()
  return id.length > 0 && id.length <= 200 && /^[\w.:@/[\]-]+$/.test(id) && !id.startsWith('-') ? id : null
}
