import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { listHarnessAccounts, setAccountAvailable, updateAccount } from './harness-accounts'

/** Mounted after the same capability, CSRF and auth gates as billing detection. */
export async function handleAccountsRequest(req: Request, harnesses: readonly HarnessId[], headers: Record<string, string> = {}): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  const path = new URL(req.url).pathname
  if (path === '/api/accounts' && req.method === 'GET') return json({ accounts: await listHarnessAccounts(harnesses) })
  const idMatch = /^\/api\/accounts\/([^/]+)$/.exec(path)
  if (idMatch) {
    if (req.method !== 'PATCH') return json({ error: 'Method not allowed' }, 405)
    let id: string, body: { available?: unknown; nickname?: unknown } | null
    try {
      id = decodeURIComponent(idMatch[1]!)
      body = await req.json()
    } catch { return json({ error: 'Invalid request' }, 400) }
    if (!body || Array.isArray(body) || (body.available === undefined && body.nickname === undefined)
      || (body.available !== undefined && typeof body.available !== 'boolean')
      || (body.nickname !== undefined && typeof body.nickname !== 'string')) {
      return json({ error: 'Expected boolean available or string nickname' }, 400)
    }
    const account = await updateAccount(id, body as { available?: boolean; nickname?: string })
    return account ? json({ account }) : json({ error: 'Account not found' }, 404)
  }
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
