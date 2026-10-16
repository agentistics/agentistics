/**
 * accountsSummary.ts — PURE: the arithmetic behind the collapsed harness rows of Settings → Accounts.
 *
 * A collapsed row says, per harness: how many accounts, how many the agents may use, the worst
 * plan-limit meter among them, how many are hidden from agents and what state the harness is in.
 * Every figure here is derived from the SAME account list the expanded rows draw, so the summary
 * can never disagree with what opens under it.
 */
import { currentUsedPct } from '@agentistics/core'
import type { HarnessId, PlanLimits } from '@agentistics/core'

export interface AccountRowData {
  id: string
  harness: HarnessId
  key: string
  label: string
  nickname?: string
  plan?: string
  root: string | null
  available: boolean
  retired?: boolean
}

/** The literal the server stores when a harness cannot say whose account a folder holds. */
export const UNNAMED_LABEL = 'Conta padrão'

export type HarnessState = 'ok' | 'needs-login' | 'error'

export interface HarnessSummary {
  harness: HarnessId
  total: number
  agentsOn: number
  hidden: number
  /** Accounts the harness no longer holds a login for. */
  signedOut: number
  /** Accounts whose last switch change failed. */
  failed: number
  state: HarnessState
  /** The limits of the account whose worst window is highest; `null` when none reported a window. */
  worst: PlanLimits | null
}

/** Nickname → login → "<Harness> account": never a bare "Conta padrão". */
export function accountTitle(a: Pick<AccountRowData, 'nickname' | 'label'>, harnessLabel: string, pt: boolean): string {
  if (a.nickname) return a.nickname
  if (a.label && a.label !== UNNAMED_LABEL) return a.label
  return pt ? `Conta do ${harnessLabel}` : `${harnessLabel} account`
}

/** The second line: WHOSE account it is, or — when the harness cannot tell — that it cannot. */
export function accountWhose(a: Pick<AccountRowData, 'nickname' | 'label'>, pt: boolean): string | null {
  if (a.label === UNNAMED_LABEL) {
    return a.nickname ? null : (pt ? 'o assistente não informa qual conta é' : 'the assistant does not say which account')
  }
  return a.nickname ? a.label : null
}

export function worstPct(limits: PlanLimits, now: number): number {
  return limits.windows.reduce((m, w) => Math.max(m, currentUsedPct(w, now)), 0)
}

/** One summary per harness present, in the order given; accounts keep their input order. */
export function summarizeHarnesses(
  accounts: readonly AccountRowData[],
  limits: readonly PlanLimits[] | null,
  now: number,
  order: readonly HarnessId[],
  failedIds: ReadonlySet<string> = new Set(),
): HarnessSummary[] {
  const out: HarnessSummary[] = []
  for (const harness of order) {
    const mine = accounts.filter(a => a.harness === harness)
    if (mine.length === 0) continue
    const live = mine.filter(a => !a.retired)
    const ids = new Set(live.map(a => a.id))
    let worst: PlanLimits | null = null
    let worstValue = -1
    for (const l of limits ?? []) {
      if (l.harness !== harness || !ids.has(l.account) || l.windows.length === 0) continue
      const v = worstPct(l, now)
      if (v > worstValue) { worst = l; worstValue = v }
    }
    const signedOut = mine.length - live.length
    const failed = mine.filter(a => failedIds.has(a.id)).length
    out.push({
      harness,
      total: mine.length,
      agentsOn: live.filter(a => a.available).length,
      hidden: live.filter(a => !a.available).length,
      signedOut,
      failed,
      state: failed > 0 ? 'error' : signedOut > 0 ? 'needs-login' : 'ok',
      worst,
    })
  }
  return out
}

/** One harness open at a time: pressing the open one closes it. */
export function nextOpen(current: HarnessId | null, clicked: HarnessId): HarnessId | null {
  return current === clicked ? null : clicked
}
