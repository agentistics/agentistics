/**
 * accountSwitch.ts — CONTA.TROCA on the browser side: read what a session could move to, and ask the
 * server to move it. The rules (which accounts, what is refused) are the server's; this module holds
 * only the wire shapes and the words.
 */

import { HARNESS_LABELS } from '@agentistics/core'
import { withReopening } from './reopeningStore'
import type { SessionAuth } from './accountRelogin'

/** One account a session could move to. `harness` other than the session's own = a hand-off (new conversation + summary). */
export interface SwitchOption { id: string; harness: string; label: string; plan?: string; recommended?: boolean }

/** Why an account is not a target (the server's code; `accountPicker.ts` words it). */
export type SwitchUnavailableReason = 'not_agentic' | 'signed_out' | 'login_expired' | 'cant_carry' | 'harness_unavailable' | 'unavailable'

export interface SwitchUnavailable { id: string; harness: string; label: string; plan?: string; reason: SwitchUnavailableReason }

export interface SwitchInfo {
  ok: boolean
  /** False when multiple accounts are off (or the session is gone). */
  supported: boolean
  current?: { id?: string; label?: string; harness?: string; plan?: string }
  options: SwitchOption[]
  /** Every other account of this machine, with why it cannot be picked. Absent from an older server. */
  unavailable?: SwitchUnavailable[]
  /** The conversation's last turn was refused by the account's usage limit. */
  limit: { resetsAt?: number; at?: number; message?: string; pendingPreview?: string } | null
  /**
   * The harness has no account to switch to but its limit is still read (OpenCode, from its own log):
   * keep polling, and show the limit notice without a switch. Absent from an older server.
   */
  limitWatch?: boolean
  /** HOTFIX.LOGIN-EXPIRADO: the session's account cannot work (login refused / signed out). Absent from an older server. */
  auth?: SessionAuth | null
}

/** `ended` + `endedId`: the session WAS ended and could not be given back — the row to Reopen. */
export interface SwitchOutcome { ok: boolean; message: string; id?: string; code?: string; ended?: boolean; endedId?: string }

export async function fetchSwitchInfo(id: string, lang: string): Promise<SwitchInfo | null> {
  try {
    const r = await fetch(`/api/fleet/switch-account?id=${encodeURIComponent(id)}&lang=${lang === 'pt' ? 'pt' : 'en'}`)
    if (!r.ok) return null
    return await r.json() as SwitchInfo
  } catch { return null }
}

export async function postSwitch(id: string, accountId: string, resendPending: boolean, lang: string, harness?: string): Promise<SwitchOutcome> {
  return withReopening([id], async () => {
    try {
      const r = await fetch(`/api/fleet/switch-account?lang=${lang === 'pt' ? 'pt' : 'en'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, accountId, ...(harness ? { harness } : {}), resendPending }),
      })
      const body = await r.json().catch(() => null) as SwitchOutcome | null
      return body ?? { ok: false, message: lang === 'pt' ? 'O servidor não respondeu.' : 'The server did not answer.' }
    } catch {
      return { ok: false, message: lang === 'pt' ? 'O servidor não respondeu.' : 'The server did not answer.' }
    }
  })
}

/**
 * The account the dialog starts on: the router's pick, else the first option. The server lists the
 * session's own harness first, so a pick there wins over one on another harness.
 */
export const defaultTarget = (options: readonly SwitchOption[]): string => (options.find(o => o.recommended) ?? options[0])?.id ?? ''

export const harnessName = (h: string | undefined): string =>
  h ? (HARNESS_LABELS as Record<string, string>)[h] ?? h : ''

/** The harnesses the dialog offers, in the server's order (own harness first), each once. */
export function switchHarnesses(info: SwitchInfo): string[] {
  const out: string[] = []
  const own = info.current?.harness
  if (own && info.options.some(o => o.harness === own)) out.push(own)
  for (const o of info.options) if (!out.includes(o.harness)) out.push(o.harness)
  return out
}

/** Moving to `harness` starts a NEW conversation there (another harness cannot read this one). */
export const isHandoff = (info: SwitchInfo, harness: string | undefined): boolean =>
  !!harness && !!info.current?.harness && harness !== info.current.harness

/** The notice is shown only when there is somewhere to go. */
export const showLimitNotice = (info: SwitchInfo | null): boolean => !!info?.supported && !!info.limit && info.options.length > 0

/** A limit on a harness with nowhere to switch (OpenCode): the notice states it, with no switch to offer. */
export const showLimitOnly = (info: SwitchInfo | null): boolean => !!info?.limitWatch && !!info.limit

/** The menu item exists only when there is somewhere to go. */
export const canSwitch = (info: SwitchInfo | null): boolean => !!info?.supported && info.options.length > 0

export const optionLabel = (o: SwitchOption, pt: boolean): string =>
  `${o.label}${o.plan ? ` · ${o.plan}` : ''}${o.recommended ? (pt ? ' · com folga' : ' · has room') : ''}`

/** "resets at 15:40" in the reader's clock, or nothing when the harness did not say. */
export function resetPhrase(resetsAt: number | undefined, pt: boolean, now = Date.now()): string {
  if (!resetsAt || resetsAt <= now) return ''
  const t = new Date(resetsAt).toLocaleTimeString(pt ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' })
  return pt ? `libera às ${t}` : `resets at ${t}`
}

export function noticeTitle(info: SwitchInfo, pt: boolean): string {
  const target = info.options.find(o => o.id === defaultTarget(info.options))
  const where = info.options.length === 1 && target
    ? `${target.label}${isHandoff(info, target.harness) ? ` (${harnessName(target.harness)})` : ''}`
    : (pt ? 'outra conta' : 'another account')
  return pt ? `Esta conta bateu o limite — continuar na ${where}?` : `This account hit its limit — continue on ${where}?`
}
