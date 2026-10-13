import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { listHarnessAccounts, setAccountAvailable } from './harness-accounts'

/** Mounted after the same capability, CSRF and auth gates as billing detection. */
export async function handleAccountsRequest(req: Request, harnesses: readonly HarnessId[], headers: Record<string, string> = {}): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  const path = new URL(req.url).pathname
  if (path === '/api/accounts' && req.method === 'GET') return json({ accounts: await listHarnessAccounts(harnesses) })
  const match = /^\/api\/accounts\/([^/]+)\/([^/]+)$/.exec(path)
  if (!match) return json({ error: 'Not found' }, 404)
  if (req.method !== 'PATCH') return json({ error: 'Method not allowed' }, 405)
  let harness: HarnessId, key: string, body: unknown
  try {
    harness = decodeURIComponent(match[1]!) as HarnessId
    key = decodeURIComponent(match[2]!)
    body = await req.json()
  } catch { return json({ error: 'Invalid request' }, 400) }
  if (!HARNESS_ORDER.includes(harness) || typeof (body as { available?: unknown } | null)?.available !== 'boolean') {
    return json({ error: 'Expected a harness and boolean available' }, 400)
  }
  const account = await setAccountAvailable(harness, key, (body as { available: boolean }).available)
  return account ? json({ account }) : json({ error: 'Account not found' }, 404)
}
