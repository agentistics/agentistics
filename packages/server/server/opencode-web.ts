/**
 * opencode-web.ts — `/api/opencode/*`: one door for everything the OpenCode account surface asks of
 * this host. `auth` writes a credential file; `usage` and `plan` read the local OpenCode store and
 * preferences. The whole prefix is one `localShell` entry in `capability-guard.ts`.
 */

import { readJsonLimited } from './limits'
import { handleOpencodeAuthRequest } from './opencode-auth-web'
import { opencodeUsage, setOpencodePlan } from './opencode-usage'

export async function handleOpencodeRequest(req: Request, headers: Record<string, string> = {}): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  const path = new URL(req.url).pathname
  if (path === '/api/opencode/auth' || path.startsWith('/api/opencode/auth/')) return handleOpencodeAuthRequest(req, headers)
  if (path === '/api/opencode/usage') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
    return json(await opencodeUsage())
  }
  if (path === '/api/opencode/plan') {
    if (req.method !== 'PUT') return json({ error: 'Method not allowed' }, 405)
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Expected application/json' }, 415)
    const body = await readJsonLimited<{ plan?: unknown }>(req, 1024)
    if (!body.ok) return json({ error: 'Invalid request' }, 400)
    const plan = body.value?.plan === 'auto' ? null : body.value?.plan
    if (!(await setOpencodePlan(plan))) return json({ error: 'bad_plan', message: 'Unknown plan.' }, 400)
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}
