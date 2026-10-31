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
import { resolveSessionAccount, sessionAccountRow } from './session-account'
import { accountLabel, listSwitchTargets, readTailProbe, syncLoginExpiry } from './account-switch-io'
import { accountLoginState } from '../harness-accounts'
import { spawnRowsOf } from './spawn-account-io'
import type { AuthState } from './account-switch'
import { reloginSupported } from '../account-roots'
import type { SwitchUnavailableReason } from './account-switch'
import { fleetLang, hostForFleet, kickFleet } from './fleet-web'
import { readOpencodeLimit } from './opencode-limit'


/** The GET's answer. `limit` is `null` unless the conversation's last turn was refused by a limit. */
export interface SwitchInfo {
  ok: true
  supported: boolean
  current?: { id?: string; label?: string; harness?: string; plan?: string }
  options: { id: string; harness: string; label: string; plan?: string; recommended?: boolean }[]
  /** Every other live account, NOT a target, with the reason in a code the browser words (CONTA.LIMITES). */
  unavailable: { id: string; harness: string; label: string; plan?: string; reason: SwitchUnavailableReason }[]
  limit: { resetsAt?: number; at?: number; message?: string; pendingPreview?: string } | null
  /** The harness cannot switch accounts but its limit is read (OpenCode): the panel keeps polling and states it. */
  limitWatch?: boolean
  /**
   * HOTFIX.LOGIN-EXPIRADO: the session's account cannot work — its harness refused the login in this
   * conversation's last turn, or the registry holds it expired / signed out. `null` otherwise. `relogin`
   * says whether "Sign in again" can run from the app for this account (same folder, same id).
   */
  auth: {
    accountId: string
    label?: string
    state: 'expired' | 'signed_out'
    message?: string
    pendingPreview?: string
    /** The whole refused prompt (bounded), for the bar's "re-send" once the account works again. */
    pending?: string
    relogin: boolean
  } | null
}

/** The plan the registry holds for the session's own account, for the picker's "current" row. */
async function accountPlan(accountId: string | undefined): Promise<string | undefined> {
  if (!accountId) return undefined
  try { return (await readAccounts()).accounts.find(a => a.id === accountId)?.plan } catch { return undefined }
}

/**
 * PURE-ish: the bar's state for the session's account. The transcript's refusal wins (it is THIS
 * conversation's last word); otherwise the registry's state after the sync. Re-read after the sync so
 * a mark written a moment ago is the one reported.
 */
async function authOf(accountId: string | undefined, refused: AuthState | null): Promise<SwitchInfo['auth']> {
  if (!accountId) return null
  const file = await readAccounts().catch(() => null)
  const account = file?.accounts.find(a => a.id === accountId)
  if (!account || account.retired) return null
  const bound = spawnRowsOf(file!).find(r => r.id === accountId)?.bound ?? false
  // A refusal written before the last finished sign-in is the old token's: the login works now.
  const live = refused && !(account.loginRenewedAt !== undefined && (refused.at ?? 0) <= account.loginRenewedAt) ? refused : null
  refused = live
  const state = refused ? 'expired' : accountLoginState(account, bound)
  if (state !== 'expired' && state !== 'signed_out') return null
  return {
    accountId, state, relogin: reloginSupported(account),
    ...(refused?.message ? { message: refused.message } : {}),
    ...(refused?.pendingPrompt ? { pendingPreview: preview(refused.pendingPrompt), pending: refused.pendingPrompt.slice(0, 8000) } : {}),
  }
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
    const none: SwitchInfo = { ok: true, supported: false, options: [], unavailable: [], limit: null, auth: null }
    if (!id) return json(none)
    // CONTA.IDENTIDADE: the same rule the composer chip and plan_limits read (`session-account.ts`).
    const registry = await readRegistry()
    const found = sessionAccountRow(registry, { id, conversationId: id })
    if (!found || found.endedAt) return json(none)
    // OpenCode has no account to switch to, but its limit is still a fact the session panel states (QA
    // OPENCODE.COMPLETO): read from opencode's own log, with or without the multi-account flag.
    if (found.harness === 'opencode') {
      const hit = found.conversationId ? readOpencodeLimit(found.conversationId) : null
      return json({ ...none, limitWatch: true, limit: hit ? { at: hit.at, message: hit.message } : null })
    }
    if (!featureOn('multi-account')) return json(none)
    const accounts = await readAccounts().catch(() => null)
    const accountId = resolveSessionAccount(registry, { id: found.id }, accounts ?? undefined)
    const row = found
    const harness = row.harness as HarnessId
    const [{ options, unavailable }, label, tail, plan] = await Promise.all([
      listSwitchTargets({ harness, ...(accountId ? { accountId } : {}), agentCaller: false }),
      accountLabel(harness, accountId),
      row.conversationId
        // WHERE the transcript is (the row's own record, absent = default home) — see the host's
        // `location`; WHO it runs as is `accountId` above.
        ? readTailProbe({ harness, conversationId: row.conversationId, cwd: row.cwd, ...(row.accountId ? { accountId: row.accountId } : {}) }).catch(() => null)
        : Promise.resolve(null),
      accountPlan(accountId),
    ])
    const limit = tail?.limit.kind === 'limited' ? tail.limit.state : null
    if (tail) await syncLoginExpiry(accountId, tail)
    const auth = await authOf(accountId, tail?.auth ?? null)
    const info: SwitchInfo = {
      ok: true,
      supported: true,
      current: { harness, ...(accountId ? { id: accountId } : {}), ...(label ? { label } : {}), ...(plan ? { plan } : {}) },
      options,
      unavailable,
      limit: limit
        ? {
          ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          ...(limit.message ? { message: limit.message } : {}),
          ...(limit.pendingPrompt ? { pendingPreview: preview(limit.pendingPrompt) } : {}),
        }
        : null,
      auth: auth ? { ...auth, ...(label ? { label } : {}) } : null,
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
    // CONTA.IDENTIDADE: the same row the GET resolved — exact id, else the live, newest of the conversation.
    const target = sessionAccountRow(await readRegistry(), { id, conversationId: id })
    const host = await hostForFleet(fleetLang(url.searchParams.get('lang')))
    if (!host.switchSessionAccount) return json({ ok: false, message: 'unavailable' }, 501)
    const out = await host.switchSessionAccount({ id: target?.id ?? id, accountId, ...(harness ? { harness } : {}), resendPending: body?.resendPending === true, ...(callerVerified ? { callerVerified: true } : {}) })
    if (out.ok) kickFleet(out.id)
    const { status, ...rest } = out as typeof out & { status?: number }
    return json(rest, out.ok ? 200 : status ?? 409)
  }
  return null
}
