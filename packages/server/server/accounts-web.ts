import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { installedLoginHarnesses } from './account-login'
import { accountRoots, reloginRoot, reloginSupported, type AccountRootsDeps } from './account-roots'
import { accountLoginState, listHarnessAccounts, readAccounts, setAccountAvailable, updateAccount, type HarnessAccount } from './harness-accounts'
import { spawnRowsOf } from './sessions/spawn-account-io'
import { accountCredentialBroken } from './account-credentials'
import { parseAgentSchedule, type AgentSchedule, type PlanLimits } from '@agentistics/core'
import { agentUseView, setAccountAgentSchedule, toggleAccountAgentUse, type AgentUseView } from './agent-schedule-host'

const agentLimits = async (): Promise<readonly PlanLimits[]> =>
  (await import('./plan-limits')).storedPlanLimits().catch(() => [])
/** The effective agent-use state and its reason, next to the account (absent without an active schedule). */
function withAgentUse<T extends HarnessAccount>(a: T, limits: readonly PlanLimits[], now: Date): T & { agentUse?: AgentUseView } {
  if (!a.id) return a
  const view = agentUseView(a, limits, now)
  return view ? { ...a, agentUse: view } : a
}

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
    // HOTFIX.LOGIN-EXPIRADO — sign an existing account in again, in the folder it lives in (same id).
    // Under `/api/accounts/roots` so the capability guard's `localShell` prefix covers it: it starts a CLI.
    const reloginMatch = /^\/api\/accounts\/roots\/relogin\/([^/]+)(\/code)?$/.exec(path)
    if (reloginMatch) {
      let id: string
      try { id = decodeURIComponent(reloginMatch[1]!) } catch { return json({ error: 'Invalid request' }, 400) }
      if (reloginMatch[2]) {
        if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
        if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Expected application/json' }, 415)
        // Never logged, persisted or returned: the pasted authorization code.
        let body: { code?: unknown } | null
        try { body = await req.json() } catch { return json({ error: 'invalid_code' }, 400) }
        const out = await roots.reloginCode(id, body?.code)
        return out.ok ? json({ ok: true }) : json({ error: out.reason, message: out.message }, out.reason === 'not_found' ? 404 : 400)
      }
      if (req.method === 'GET') {
        await roots.pollRelogins().catch(() => [])
        const status = roots.reloginStatus(id)
        return status ? json(status) : json({ error: 'not_found', message: 'No sign-in is running for this account.' }, 404)
      }
      if (req.method === 'DELETE') return json({ ok: true, cancelled: await roots.cancelRelogin(id) })
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      const out = await roots.relogin(id, req.signal)
      if (out.ok) return json(out)
      const status = out.reason === 'not_found' ? 404 : out.reason === 'disabled' ? 404 : out.reason === 'unsupported' || out.reason === 'unsafe_path' || out.reason === 'retired' ? 422 : 502
      return json({ error: out.reason, message: out.message }, status)
    }
    if (path === '/api/accounts/roots') {
      if (req.method === 'GET') { roots.ensurePoller(); return json({ roots: await roots.list(), installed: (rootsDeps?.installed ?? installedLoginHarnesses)() }) }
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Expected application/json' }, 415)
      let body: { harness?: unknown } | null
      try { body = await req.json() } catch { return json({ error: 'Invalid request' }, 400) }
      const harness = body && typeof body.harness === 'string' ? body.harness as HarnessId : null
      if (!harness || !HARNESS_ORDER.includes(harness)) return json({ error: 'Expected a harness' }, 400)
      const out = await roots.addRoot(harness, req.signal)
      return out.ok ? json(out) : json({ error: out.reason, message: out.message }, out.reason === 'unsupported' || out.reason === 'unsafe_path' ? 422 : out.reason === 'disabled' ? 404 : 502)
    }
    const codeMatch = /^\/api\/accounts\/roots\/([^/]+)\/code$/.exec(path)
    if (codeMatch) {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Expected application/json' }, 415)
      // This endpoint never logs, persists or returns its request body.
      let body: { code?: unknown } | null
      try { body = await req.json() } catch { return json({ error: 'invalid_code' }, 400) }
      const out = await roots.submitCode(decodeURIComponent(codeMatch[1]!), body?.code)
      return out.ok ? json({ ok: true }) : json({ error: out.reason, message: out.message }, out.reason === 'not_found' ? 404 : 400)
    }
    const verifyMatch = /^\/api\/accounts\/roots\/([^/]+)\/verify$/.exec(path)
    if (verifyMatch) {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      const out = await roots.verifyPending(decodeURIComponent(verifyMatch[1]!))
      return out.ok ? json(out) : json({ error: out.reason, message: out.message }, out.reason === 'not_found' ? 404 : 400)
    }
    const m = /^\/api\/accounts\/roots\/([^/]+)$/.exec(path)
    if (!m) return json({ error: 'Not found' }, 404)
    if (req.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405)
    let confirm: unknown
    const raw = await req.clone().text().catch(() => '')
    if (raw && !(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Expected application/json' }, 415)
    try { confirm = ((await req.json().catch(() => null)) as { confirm?: unknown } | null)?.confirm } catch { confirm = undefined }
    if (confirm !== undefined && typeof confirm !== 'string') return json({ error: 'confirm must be a string' }, 400)
    const out = await roots.removeRoot(decodeURIComponent(m[1]!), confirm === undefined ? {} : { confirm })
    return out.ok ? json(out) : json({ error: out.reason, message: out.message }, out.status)
  }
  if (path === '/api/accounts' && req.method === 'GET') {
    const limits = await agentLimits()
    const now = new Date()
    return json({ accounts: withLoginState(await listHarnessAccounts(harnesses), await readAccounts().catch(() => null)).map(a => withAgentUse(a, limits, now)) })
  }
  const idMatch = /^\/api\/accounts\/([^/]+)$/.exec(path)
  if (idMatch) {
    if (req.method !== 'PATCH') return json({ error: 'Method not allowed' }, 405)
    let id: string, body: { available?: unknown; nickname?: unknown; agentSchedule?: unknown } | null
    try {
      id = decodeURIComponent(idMatch[1]!)
      body = await req.json()
    } catch { return json({ error: 'Invalid request' }, 400) }
    if (!body || Array.isArray(body) || (body.available === undefined && body.nickname === undefined && body.agentSchedule === undefined)
      || (body.available !== undefined && typeof body.available !== 'boolean')
      || (body.nickname !== undefined && typeof body.nickname !== 'string')) {
      return json({ error: 'Expected boolean available, string nickname or an agentSchedule' }, 400)
    }
    let schedule: AgentSchedule | null | undefined
    if (body.agentSchedule !== undefined) {
      schedule = body.agentSchedule === null ? null : parseAgentSchedule(body.agentSchedule)
      if (schedule === null && body.agentSchedule !== null) return json({ error: 'Invalid agentSchedule' }, 400)
    }
    let account = body.nickname !== undefined ? await updateAccount(id, { nickname: body.nickname as string }) : null
    if (schedule !== undefined) account = await setAccountAgentSchedule(id, schedule)
    if (typeof body.available === 'boolean') account = await toggleAccountAgentUse(id, body.available)
    if (!account) return json({ error: 'Account not found' }, 404)
    return json({ account: withAgentUse(account, await agentLimits(), new Date()) })
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
  const desired = (body as { available: boolean }).available
  // Same override path as PATCH /api/accounts/:id — a bare write here was undone by the next
  // schedule tick on a scheduled account. Accounts with no id (legacy rows) keep the plain write.
  const file = await readAccounts().catch(() => null)
  const found = file?.accounts.find(a => a.harness === harness && a.key === key)
  const account = found?.id
    ? await toggleAccountAgentUse(found.id, desired)
    : await setAccountAvailable(harness, key, desired)
  return account ? json({ account }) : json({ error: 'Account not found' }, 404)
}

/**
 * Each account with the state the screens share (`login`) and whether "Sign in again" can run for it
 * (`relogin`). Read from the SAME registry snapshot the spawn rules read, so the list and the session
 * bar can never disagree about an account.
 */
export function withLoginState(
  accounts: readonly HarnessAccount[], file: { accounts: HarnessAccount[]; bindings: Record<string, string> } | null,
): Array<HarnessAccount & { login?: 'ok' | 'expired' | 'signed_out'; relogin?: boolean; reloginable?: boolean }> {
  if (!file) return [...accounts]
  const rows = spawnRowsOf(file)
  return accounts.map(a => {
    if (!a.id) return a
    const row = rows.find(r => r.id === a.id)
    const login = accountLoginState(a, row?.bound ?? false, row?.bound ? accountCredentialBroken(a, row.root) : false)
    if (!login) return a
    const supported = reloginSupported({ ...a, root: reloginRoot(file, a) })
    // `relogin` keeps its meaning (a broken login that "Sign in again" fixes); `reloginable` is the
    // plain capability, so the plan-usage popup can offer "Sign in again" on a working account too.
    return { ...a, login, ...(login !== 'ok' ? { relogin: supported } : {}), ...(supported ? { reloginable: true } : {}) }
  })
}
