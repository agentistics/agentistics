import { isFlowRunId } from '@agentistics/core'

/** Decode once, validate before asking the engine to read any record. */
export async function flowStatusResponse(encodedId: string, status: (id: string) => Promise<unknown>) {
  let id: string
  try { id = decodeURIComponent(encodedId) } catch { return badId() }
  if (id.includes('/') || id.includes('\\') || id.includes('..') || !isFlowRunId(id)) return badId()
  const body = await status(id)
  return body ? { body, status: 200 } : { body: { error: 'not_found' }, status: 404 }
}
const badId = () => ({ body: { error: 'bad_request', sentence: 'invalid flow run id' }, status: 400 })

/** No gate bypass in this release, from any door (SECRETS.4 brings the owner credential). */
export const OWNER_CREDENTIAL_REQUIRED = 'owner override needs the owner credential (SECRETS.4), not available yet'

/** PURE. The inputs of `POST /api/flows/run`: an override of any kind is REFUSED with the sentence, never dropped silently. */
export function flowRunInputs(raw: unknown): { ok: true; inputs: Record<string, unknown> } | { ok: false; sentence: string } {
  const inputs = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw as Record<string, unknown> } : {}
  if ('override' in inputs || 'overrideBy' in inputs || 'overrideReason' in inputs) return { ok: false, sentence: OWNER_CREDENTIAL_REQUIRED }
  return { ok: true, inputs }
}
