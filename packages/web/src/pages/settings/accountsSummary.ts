/**
 * accountsSummary.ts — PURE: the arithmetic behind the collapsed harness rows of Settings → Accounts.
 *
 * A collapsed row says, per harness: how many accounts, how many the agents may use, the worst
 * plan-limit meter among them, how many are hidden from agents and what state the harness is in.
 * Every figure here is derived from the SAME account list the expanded rows draw, so the summary
 * can never disagree with what opens under it.
 */
import { currentUsedPct, windowKey } from '@agentistics/core'
import type { HarnessId, PlanLimits, PlanLimitWindow } from '@agentistics/core'

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
  /** The harness answered that it has no login here (never stored; see the server's `signedOut`). */
  signedOut?: true
  /**
   * HOTFIX.LOGIN-EXPIRADO — the server's word for whether this account can work now: `expired` (the
   * harness refused its login while running), `signed_out` (no login holds it). Absent from an older
   * server or for a retired account.
   */
  login?: 'ok' | 'expired' | 'signed_out'
  /** "Sign in again" can run from the app for this account, re-binding the same id. */
  relogin?: boolean
}

/** The literal the server stores when a harness cannot say whose account a folder holds. */
export const UNNAMED_LABEL = 'Conta padrão'

/** Either spelling of the placeholder, any case — as a label or as a typed nickname it names nobody. */
export function isPlaceholderName(v: string | undefined | null): boolean {
  const t = (v ?? '').trim().toLowerCase()
  return t === 'conta padrão' || t === 'default account'
}

/**
 * An account the registry could not identify (id ''): the harness fallback row. It has no route to
 * PATCH, so it can be neither switched nor nicknamed, and being listed proves nothing about a login.
 */
export function isUnidentified(a: Pick<AccountRowData, 'id'>): boolean {
  return a.id === ''
}

/** A key unique among rows: the id, or — for the unidentified fallback — the harness it stands for. */
export function accountKey(a: Pick<AccountRowData, 'id' | 'harness'>): string {
  return a.id !== '' ? a.id : `unidentified:${a.harness}`
}

export type AccountState = 'unconfirmed' | 'signed-out' | 'signed-in'

export function accountState(a: Pick<AccountRowData, 'id' | 'retired'>): AccountState {
  if (isUnidentified(a)) return 'unconfirmed'
  return a.retired ? 'signed-out' : 'signed-in'
}

export type HarnessState = 'ok' | 'unconfirmed' | 'needs-login' | 'error'

export interface HarnessSummary {
  harness: HarnessId
  total: number
  agentsOn: number
  hidden: number
  /** Accounts the harness no longer holds a login for. */
  signedOut: number
  /** Accounts the registry could not identify; their login is not confirmed. */
  unconfirmed: number
  /** Accounts whose last switch change failed. */
  failed: number
  state: HarnessState
  /** Per window kind, the highest reading across accounts (each with its own reset); `null` when none. */
  worst: PlanLimits | null
}

/** Nickname → login → "<Harness> account": never a bare "Conta padrão". */
export function accountTitle(a: Pick<AccountRowData, 'nickname' | 'label'>, harnessLabel: string, pt: boolean): string {
  if (a.nickname && !isPlaceholderName(a.nickname)) return a.nickname
  if (a.label && !isPlaceholderName(a.label)) return a.label
  return pt ? `Conta do ${harnessLabel}` : `${harnessLabel} account`
}

/** The second line: WHOSE account it is, or — when the harness cannot tell — that it cannot. */
export function accountWhose(a: Pick<AccountRowData, 'nickname' | 'label'>, pt: boolean): string | null {
  const nick = a.nickname && !isPlaceholderName(a.nickname) ? a.nickname : null
  if (isPlaceholderName(a.label)) {
    return nick ? null : (pt ? 'o assistente não informa qual conta é' : 'the assistant does not say which account')
  }
  return nick ? a.label : null
}

export function worstPct(limits: PlanLimits, now: number): number {
  return limits.windows.reduce((m, w) => Math.max(m, currentUsedPct(w, now)), 0)
}

/**
 * The worst bars across accounts: for EACH window kind independently, the reading with the highest
 * current percentage, carrying its own reset data. A single account's pair would hide another
 * account's higher window of the other kind.
 */
export function worstBars(limits: readonly PlanLimits[], now: number): PlanLimits | null {
  const best = new Map<string, { w: PlanLimitWindow; pct: number }>()
  let from: PlanLimits | null = null
  for (const l of limits) {
    for (const w of l.windows) {
      const pct = currentUsedPct(w, now)
      const k = windowKey(w)
      const cur = best.get(k)
      if (!cur || pct > cur.pct) best.set(k, { w, pct })
      from ??= l
    }
  }
  if (!from) return null
  return { ...from, windows: [...best.values()].map(b => b.w) }
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
    const live = mine.filter(a => !a.retired && !isUnidentified(a))
    const ids = new Set(live.map(a => a.id))
    const worst = worstBars((limits ?? []).filter(l => l.harness === harness && ids.has(l.account)), now)
    const signedOut = mine.filter(a => a.retired).length
    const unconfirmed = mine.filter(isUnidentified).length
    const failed = mine.filter(a => failedIds.has(a.id)).length
    out.push({
      harness,
      total: mine.length,
      agentsOn: live.filter(a => a.available).length,
      hidden: live.filter(a => !a.available).length,
      signedOut,
      unconfirmed,
      failed,
      state: failed > 0 ? 'error' : signedOut > 0 ? 'needs-login' : unconfirmed > 0 ? 'unconfirmed' : 'ok',
      worst,
    })
  }
  return out
}

/** One harness open at a time: pressing the open one closes it. */
export function nextOpen(current: HarnessId | null, clicked: HarnessId): HarnessId | null {
  return current === clicked ? null : clicked
}

/** The detail modal's line: WHOSE login (even beside a nickname — the owner needs it), then the plan. */
export function accountDetailLine(d: Pick<AccountRowData, 'label' | 'plan'>, pt: boolean, noPlan: string): string {
  return `${accountWhose({ label: d.label }, pt) ?? d.label} · ${d.plan ?? noPlan}`
}
