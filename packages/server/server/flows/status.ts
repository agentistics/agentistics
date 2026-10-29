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
