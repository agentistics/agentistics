import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { accountRoots, type AccountRootsDeps } from './account-roots'
import { listHarnessAccounts, setAccountAvailable, updateAccount } from './harness-accounts'

/** Mounted after the same capability, CSRF and auth gates as billing detection. */
export async function handleAccountsRequest(
  req: Request, harnesses: readonly HarnessId[], headers: Record<string, string> = {}, rootsDeps?: AccountRootsDeps,
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  const path = new URL(req.url).pathname
  // multi-account roots: flag off reads as if the routes did not exist.
  if (path === '/api/accounts/roots' || path.startsWith('/api/accounts/roots/')) {
    const roots = accountRoots(rootsDeps)
    if (!roots.flagOn()) return json({ error: 'Not found' }, 404)
    if (path === '/api/accounts/roots') {
      if (req.method === 'GET') { roots.ensurePoller(); return json({ roots: await roots.list() }) }
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      let body: { harness?: unknown } | null
      try { body = await req.json() } catch { return json({ error: 'Invalid request' }, 400) }
      const harness = body && typeof body.harness === 'string' ? body.harness as HarnessId : null
      if (!harness || !HARNESS_ORDER.includes(harness)) return json({ error: 'Expected a harness' }, 400)
      const out = await roots.addRoot(harness)
      return out.ok ? json(out) : json({ error: out.reason, message: out.message }, out.reason === 'unsupported' ? 422 : out.reason === 'disabled' ? 404 : 502)
    }
    const m = /^\/api\/accounts\/roots\/([^/]+)$/.exec(path)
    if (!m) return json({ error: 'Not found' }, 404)
    if (req.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405)
    let confirm: unknown
    try { confirm = ((await req.json().catch(() => null)) as { confirm?: unknown } | null)?.confirm } catch { confirm = undefined }
    if (confirm !== undefined && typeof confirm !== 'string') return json({ error: 'confirm must be a string' }, 400)
    const out = await roots.removeRoot(decodeURIComponent(m[1]!), confirm === undefined ? {} : { confirm })
    return out.ok ? json(out) : json({ error: out.reason, message: out.message }, out.status)
  }
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
