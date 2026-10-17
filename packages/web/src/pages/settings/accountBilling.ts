/**
 * accountBilling.ts — PURE: the per-account half of Settings → Billing.
 *
 * A harness keeps its own default timeline (`profiles[h]`); an account may hold one of its own
 * (`accountProfiles[id]`). The arithmetic lives in @agentistics/core; this module only decides what
 * the SCREEN says about an account's plan and when to ask "which plan is this?".
 */
import {
  findPlan, plansForHarness, sortPeriods, validatePeriod,
  type BillingPeriod, type BillingSettings, type HarnessId,
} from '@agentistics/core'
import { applyPlan, emptyDraft, periodFromDraft, periodName, splitTimeline, validateDraft } from './billingForm'
import { isUnidentified, type AccountRowData } from './accountsSummary'
import type { PatchBody, PatchResult } from './accountMutations'

export interface BillingAccount extends AccountRowData { firstSeen?: number }

/** Accounts the plan arithmetic can price: identified, still signed in, of this harness, oldest first. */
export function billableAccounts<A extends BillingAccount>(accounts: readonly A[], harness: HarnessId): A[] {
  return accounts
    .filter(a => a.harness === harness && !isUnidentified(a) && !a.retired)
    .sort((x, y) => (x.firstSeen ?? 0) - (y.firstSeen ?? 0) || x.id.localeCompare(y.id))
}

export const ownPeriods = (billing: BillingSettings, id: string): BillingPeriod[] =>
  billing.accountProfiles?.[id]?.periods ?? []

/** What an account's row says about its plan today. `default` = it prices on the harness timeline. */
export function planSummary(
  billing: BillingSettings, a: Pick<BillingAccount, 'id' | 'harness'>, today: string,
): { name: string | null; source: 'own' | 'default' | 'none' } {
  const own = ownPeriods(billing, a.id)
  if (own.length > 0) {
    const cur = splitTimeline(sortPeriods(own), today).current
    return { name: cur ? periodName(cur) || null : null, source: 'own' }
  }
  const def = billing.profiles[a.harness]?.periods ?? []
  if (def.length > 0) {
    const cur = splitTimeline(sortPeriods(def), today).current
    return { name: cur ? periodName(cur) || null : null, source: 'default' }
  }
  return { name: null, source: 'none' }
}

/**
 * Accounts that raise the "which plan is this?" notice: no timeline of their own and nothing the
 * harness default can price for them (the default is counted ONCE — for the oldest account). A
 * first account with no default is the PRIMARY case: it is asked which plan it is.
 */
export function accountsNeedingPlan<A extends BillingAccount>(accounts: readonly A[], billing: BillingSettings, harnesses: readonly HarnessId[]): A[] {
  const out: A[] = []
  for (const h of harnesses) {
    const mine = billableAccounts(accounts, h)
    const hasDefault = (billing.profiles[h]?.periods.length ?? 0) > 0
    mine.forEach((a, i) => {
      if (ownPeriods(billing, a.id).length > 0) return
      if (i === 0 && hasDefault) return
      out.push(a)
    })
  }
  return out
}

/** The catalog plan a harness-reported plan name most likely means, to prefill the picker. */
export function matchDetectedPlan(harness: HarnessId, reported: string | undefined): string {
  const r = (reported ?? '').trim().toLowerCase()
  if (!r) return ''
  const hit = plansForHarness(harness).find(p => p.id.toLowerCase() === r || p.label.toLowerCase() === r)
    ?? plansForHarness(harness).find(p => p.label.toLowerCase().includes(r) || r.includes(p.id.toLowerCase()))
  return hit?.id ?? ''
}

const dayOf = (ms: number | undefined, fallback: string): string =>
  ms && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : fallback

/** A period from a catalog pick, starting the day the account was first seen. `null` when the entry
 *  needs more than a pick (a typed name or price) — the caller opens the editor instead. */
export function periodForPick(planId: string, from: string, newId: () => string): BillingPeriod | null {
  const entry = findPlan(planId)
  if (!entry) return null
  const draft = applyPlan({ ...emptyDraft(), from, ongoing: true }, entry)
  if (validateDraft(draft, [], newId).length > 0) return null
  return periodFromDraft(draft, newId)
}

/** "I don't know": the account prices as `unknown` (N/A, never 0) until a plan is registered. */
export function unknownPeriod(from: string, newId: () => string): BillingPeriod {
  return { id: newId(), mode: 'unknown', from }
}

export function withAccountPeriods(billing: BillingSettings, id: string, periods: BillingPeriod[]): BillingSettings {
  const accountProfiles = { ...(billing.accountProfiles ?? {}) }
  if (periods.length > 0) accountProfiles[id] = { periods }
  else delete accountProfiles[id]
  const { accountProfiles: _old, ...rest } = billing
  return Object.keys(accountProfiles).length > 0 ? { ...rest, accountProfiles } : rest
}

/** Answering the notice: writes `accountProfiles[id]`. A pick that needs more opens nothing here —
 *  it returns `null` and the caller routes to the editor. */
export function answerNotice(
  billing: BillingSettings, a: BillingAccount, planId: string | null, today: string, newId: () => string,
): BillingSettings | null {
  const from = dayOf(a.firstSeen, today)
  const period = planId === null ? unknownPeriod(from, newId) : periodForPick(planId, from, newId)
  if (!period || validatePeriod(period, []).length > 0) return null
  return withAccountPeriods(billing, a.id, [period])
}

/** The availability switch: ONE PATCH, addressed by account id. */
export function toggleAvailability<A>(
  mutator: { patch: (id: string, body: PatchBody) => Promise<PatchResult<A>> }, a: Pick<BillingAccount, 'id' | 'available'>,
): Promise<PatchResult<A>> {
  return mutator.patch(a.id, { available: !a.available })
}

/** Harnesses with a usage-limits reader (spec §6 sentence table). @harness-adapters-only: a reader table, adapters only. */
export const REPORTS_LIMITS: ReadonlySet<HarnessId> = new Set<HarnessId>(['claude', 'codex'])

/**
 * The notices on screen: every account still needing a plan, plus the ones whose answer is being
 * saved (or failed to save). An answer is never "gone" before it is stored — the notice stays, with
 * its state, until the write is confirmed and the account no longer needs a plan.
 */
export function noticeAccounts<A extends BillingAccount>(
  needPlan: readonly A[], billable: readonly A[], inFlight: ReadonlySet<string>,
): A[] {
  const ids = new Set(needPlan.map(a => a.id))
  const extra = billable.filter(a => inFlight.has(a.id) && !ids.has(a.id))
  return [...needPlan, ...extra]
}

export type CapabilityNote = 'noMeter' | 'noIdentity' | 'singleAccount'

/** The per-harness sentences Billing owes the reader (spec §6). */
// @harness-adapters-only: which ADAPTER harnesses cannot say who is signed in — a login fact of the vendor CLI
const IDENTITYLESS: Partial<Record<HarnessId, true>> = { gemini: true, kimi: true, antigravity: true }
export function capabilityNotes(harness: HarnessId): CapabilityNote[] {
  const out: CapabilityNote[] = []
  if (!REPORTS_LIMITS.has(harness)) out.push('noMeter')
  if (IDENTITYLESS[harness]) out.push('noIdentity')
  if (harness === 'antigravity') out.push('singleAccount')
  return out
}

/** Close the period drawer only once its write is stored; a refused one keeps the user's draft for a retry. */
export async function saveThenClose(persist: () => Promise<boolean>, close: () => void): Promise<boolean> {
  const ok = await persist()
  if (ok) close()
  return ok
}

export interface SaveError { msg: string; /** the notice-tracked account whose write failed, or null */ id: string | null }

/**
 * Where the save error is shown: once, inside the drawer while it is open, else below the section.
 * A failure whose own notice has since been settled (a later queued write stored it) is gone.
 */
export function saveErrorPlace(
  err: SaveError | null, notices: Readonly<Record<string, string>>, drawerOpen: boolean,
): 'drawer' | 'page' | null {
  if (!err) return null
  if (err.id !== null && notices[err.id] !== 'failed') return null
  return drawerOpen ? 'drawer' : 'page'
}
