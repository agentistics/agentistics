/**
 * account-switch-web.ts — CONTA.TROCA's HTTP door, under `/api/fleet` (so `capability-guard.ts`'s
 * `localShell` prefix entry covers it by having been added there, not by a second table).
 *
 *   GET  /api/fleet/switch-account?id=<row>   what the session could move to, and whether its last
 *                                             turn stopped on a usage limit
 *   POST /api/fleet/switch-account            { id, accountId, harness?, resendPending?, session? } — do it
 *
 * The GET never says anything when `multi-account` is off: the notice and the menu item are ABSENT
 * there, never present and failing. Options span every harness that can start a session here
 * (CONTA.TROCA v2); the same harness is offered only where its conversation can be carried.
 */
import { featureOn, type HarnessId } from '@agentistics/core'
import { readJsonLimited } from '../limits'
import { readRegistry } from './registry'
import { readAccounts } from '../harness-accounts'
import { accountLabel, listSwitchTargets, readLimitState } from './account-switch-io'
import type { SwitchUnavailableReason } from './account-switch'
import { fleetLang, hostForFleet, kickFleet } from './fleet-web'


/** The GET's answer. `limit` is `null` unless the conversation's last turn was refused by a limit. */
export interface SwitchInfo {
  ok: true
  supported: boolean
  current?: { id?: string; label?: string; harness?: string; plan?: string }
  options: { id: string; harness: string; label: string; plan?: string; recommended?: boolean }[]
  /** Every other live account, NOT a target, with the reason in a code the browser words (CONTA.LIMITES). */
  unavailable: { id: string; harness: string; label: string; plan?: string; reason: SwitchUnavailableReason }[]
  limit: { resetsAt?: number; message?: string; pendingPreview?: string } | null
}

/** The plan the registry holds for the session's own account, for the picker's "current" row. */
async function accountPlan(accountId: string | undefined): Promise<string | undefined> {
  if (!accountId) return undefined
  try { return (await readAccounts()).accounts.find(a => a.id === accountId)?.plan } catch { return undefined }
}

const PREVIEW = 160
const preview = (s: string) => s.length > PREVIEW ? `${s.slice(0, PREVIEW - 1)}…` : s

export async function handleAccountSwitchRoute(req: Request, url: URL, cors: Record<string, string>): Promise<Response | null> {
  if (url.pathname !== '/api/fleet/switch-account') return null
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })
  if (req.method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const none: SwitchInfo = { ok: true, supported: false, options: [], unavailable: [], limit: null }
    if (!featureOn('multi-account') || !id) return json(none)
    const row = (await readRegistry()).find(m => m.id === id || (m.conversationId === id && !m.endedAt))
    if (!row || row.endedAt) return json(none)
    const harness = row.harness as HarnessId
    const [{ options, unavailable }, label, limit, plan] = await Promise.all([
      listSwitchTargets({ harness, ...(row.accountId ? { accountId: row.accountId } : {}), agentCaller: false }),
      accountLabel(harness, row.accountId),
      row.conversationId
        ? readLimitState({ harness, conversationId: row.conversationId, cwd: row.cwd, ...(row.accountId ? { accountId: row.accountId } : {}) }).catch(() => null)
        : Promise.resolve(null),
      accountPlan(row.accountId),
    ])
    const info: SwitchInfo = {
      ok: true,
      supported: true,
      current: { harness, ...(row.accountId ? { id: row.accountId } : {}), ...(label ? { label } : {}), ...(plan ? { plan } : {}) },
      options,
      unavailable,
      limit: limit
        ? {
          ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          ...(limit.message ? { message: limit.message } : {}),
          ...(limit.pendingPrompt ? { pendingPreview: preview(limit.pendingPrompt) } : {}),
        }
        : null,
    }
    return json(info)
  }
  if (req.method === 'POST') {
    const read = await readJsonLimited<Record<string, unknown> | null>(req, 4096).catch(() => null)
    const body = read && read.ok && read.value && typeof read.value === 'object' ? read.value : null
    const id = typeof body?.id === 'string' ? body.id : ''
    const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
    const harness = typeof body?.harness === 'string' && body.harness ? body.harness : undefined
    if (!id || !accountId) return json({ ok: false, message: 'id and accountId are required' }, 400)
    const { markCallerVerified } = await import('./session-roles')
    const { verifySessionIdentity } = await import('./session-identity')
    const callerVerified = await markCallerVerified({ session: body?.session }, verifySessionIdentity)
    // The MCP passes whatever reference it holds: a managed id, or the conversation id of a live row.
    const target = (await readRegistry()).find(m => m.id === id) ?? (await readRegistry()).find(m => m.conversationId === id && !m.endedAt)
    const host = await hostForFleet(fleetLang(url.searchParams.get('lang')))
    if (!host.switchSessionAccount) return json({ ok: false, message: 'unavailable' }, 501)
    const out = await host.switchSessionAccount({ id: target?.id ?? id, accountId, ...(harness ? { harness } : {}), resendPending: body?.resendPending === true, ...(callerVerified ? { callerVerified: true } : {}) })
    if (out.ok) kickFleet(out.id)
    const { status, ...rest } = out as typeof out & { status?: number }
    return json(rest, out.ok ? 200 : status ?? 409)
  }
  return null
}
