/**
 * accountBilling.ts — PURE: the per-account half of Settings → Billing.
 *
 * A harness keeps its own default timeline (`profiles[h]`); an account may hold one of its own
 * (`accountProfiles[id]`). The arithmetic lives in @agentistics/core; this module only decides what
 * the SCREEN says about an account's plan and when to ask "which plan is this?".
 */
import {
  accountProfileKey, accountProfileOf, dayFromIndex, dayIndex, findPlan, plansForHarness, sortPeriods, validatePeriod, SENTINEL_PLAN_IDS,
  type BillingDetection, type BillingPeriod, type BillingSettings, type HarnessId, type PlanLimits,
} from '@agentistics/core'
import type { PeriodDraft } from './billingForm'
import { applyPlan, emptyDraft, periodFromDraft, periodName, splitTimeline, validateDraft } from './billingForm'
import { isPlaceholderName, isUnidentified, type AccountRowData } from './accountsSummary'
import { accountLabelKey } from '../../lib/planLimits'
import type { PatchBody, PatchResult } from './accountMutations'

export interface BillingAccount extends AccountRowData { firstSeen?: number }

/** Accounts the plan arithmetic can price: identified, still signed in, of this harness, oldest first. */
export function billableAccounts<A extends BillingAccount>(accounts: readonly A[], harness: HarnessId): A[] {
  return accounts
    .filter(a => a.harness === harness && !isUnidentified(a) && !a.retired)
    .sort((x, y) => (x.firstSeen ?? 0) - (y.firstSeen ?? 0) || x.id.localeCompare(y.id))
}

export const ownPeriods = (billing: BillingSettings, a: Pick<BillingAccount, 'id' | 'harness'>): BillingPeriod[] =>
  accountProfileOf(billing.accountProfiles, a.harness, a.id)?.periods ?? []

/** What an account's row says about its plan today. `default` = it prices on the harness timeline. */
export function planSummary(
  billing: BillingSettings, a: Pick<BillingAccount, 'id' | 'harness'>, today: string,
): { name: string | null; source: 'own' | 'default' | 'none' } {
  const own = ownPeriods(billing, a)
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
 * harness default can price for them (the default is counted ONCE — for the first account without a
 * timeline of its own, as core's `selectedTimelines` does). A first account with no default is the
 * PRIMARY case: it is asked which plan it is.
 */
export function accountsNeedingPlan<A extends BillingAccount>(accounts: readonly A[], billing: BillingSettings, harnesses: readonly HarnessId[]): A[] {
  const out: A[] = []
  for (const h of harnesses) {
    const mine = foldUnnamed(billableAccounts(accounts, h), billing)
    for (const a of mine) if (rowScope(billing, mine, a).kind === 'none') out.push(a)
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

/**
 * The plan a row with nothing registered would be prefilled with: what the account itself reported,
 * else what detection pinned for its harness. `''` when nothing names one. Used by the editor (to
 * prefill) and by the row (to say "detected, confirm" instead of "no plan") — one answer for both.
 */
export function detectedPlanId(
  harness: HarnessId, account: Pick<BillingAccount, 'plan'> | null, detections: readonly BillingDetection[],
): string {
  const own = account ? matchDetectedPlan(harness, account.plan) : ''
  if (own) return own
  return detections.find(d => d.harness === harness && d.source !== 'none' && d.mode !== 'unknown')?.planId ?? ''
}

/**
 * Whether pressing Save must write the period. A change always does. A NEW period that arrived
 * prefilled (a detected plan and today's date) does too, even untouched: the drawer remembers what it
 * opened WITH, so comparing against that alone read the prefill as "already stored" and Save closed
 * without writing — the row stayed "No plan" while the editor showed the plan (CONTA.SEM.PLANO).
 */
export function planDraftWrites(draft: PeriodDraft, opened: PeriodDraft | null): boolean {
  if (JSON.stringify(draft) !== JSON.stringify(opened)) return true
  return draft.id === '' && draft.planId !== ''
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

export function withAccountPeriods(billing: BillingSettings, a: Pick<BillingAccount, 'id' | 'harness'>, periods: BillingPeriod[]): BillingSettings {
  const accountProfiles = { ...(billing.accountProfiles ?? {}) }
  // Written under `harness:account`; a bare-id key an older build wrote is the same timeline, so it goes.
  delete accountProfiles[a.id]
  if (periods.length > 0) accountProfiles[accountProfileKey(a.harness, a.id)] = { periods }
  else delete accountProfiles[accountProfileKey(a.harness, a.id)]
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
  return withAccountPeriods(billing, a, [period])
}

/** The availability switch: ONE PATCH, addressed by account id. */
export function toggleAvailability<A>(
  mutator: { patch: (id: string, body: PatchBody) => Promise<PatchResult<A>> }, a: Pick<BillingAccount, 'id' | 'available'>,
): Promise<PatchResult<A>> {
  return mutator.patch(a.id, { available: !a.available })
}

/** Harnesses with a usage-limits reader (spec §6 sentence table). @harness-adapters-only: a reader table, adapters only. */
export const REPORTS_LIMITS: ReadonlySet<HarnessId> = new Set<HarnessId>(['claude', 'codex', 'antigravity'])

/**
 * Why a session's stats card has no plan limits to draw, in words that agree with this screen. "Has
 * not reported yet — they will appear" is only true of a harness that DOES report them; said of
 * OpenCode, which has no plan quota at all, it contradicted "No plan quota for OpenCode" (QA
 * OPENCODE.COMPLETO item 4).
 */
export function planAbsentText(harness: string, label: string, pt: boolean): string {
  if (harness === 'opencode') return pt ? 'Sem cota de plano no OpenCode — não há limites de plano a mostrar.' : 'No plan quota for OpenCode — there are no plan limits to show.'
  if (!REPORTS_LIMITS.has(harness as HarnessId)) return pt ? `${label} não informa os limites do plano.` : `${label} does not report plan limits.`
  return pt
    ? `${label} ainda não informou os limites do plano — eles aparecem aqui assim que informar.`
    : `${label} has not reported plan limits yet — they will appear here when available.`
}

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

/**
 * Which timeline an account's row prices on — and therefore edits. The same rule core's
 * `selectedTimelines` applies: an account's own timeline, else the harness default for the FIRST
 * account (in list order) that has none, else nothing. A row never shows a plan it is not paying.
 */
export type RowScope = { kind: 'own'; id: string; harness: HarnessId } | { kind: 'default'; harness: HarnessId } | { kind: 'none'; id: string; harness: HarnessId }

export function rowScope(billing: BillingSettings, mine: readonly Pick<BillingAccount, 'id' | 'harness'>[], a: Pick<BillingAccount, 'id' | 'harness'>): RowScope {
  if (ownPeriods(billing, a).length > 0) return { kind: 'own', id: a.id, harness: a.harness }
  const hasDefault = (billing.profiles[a.harness]?.periods.length ?? 0) > 0
  const firstWithout = mine.find(x => ownPeriods(billing, x).length === 0)
  return hasDefault && firstWithout?.id === a.id && firstWithout.harness === a.harness ? { kind: 'default', harness: a.harness } : { kind: 'none', id: a.id, harness: a.harness }
}

export function scopePeriods(billing: BillingSettings, s: RowScope): BillingPeriod[] {
  return s.kind === 'default' ? billing.profiles[s.harness]?.periods ?? [] : ownPeriods(billing, s)
}

/** Writes a scope's periods back: an account's own timeline, or the harness default. */
export function withScopePeriods(billing: BillingSettings, s: RowScope, periods: BillingPeriod[]): BillingSettings {
  if (s.kind !== 'default') return withAccountPeriods(billing, s, periods)
  const profiles = { ...billing.profiles }
  if (periods.length > 0) profiles[s.harness] = { periods }
  else delete profiles[s.harness]
  return { ...billing, profiles }
}

/**
 * The limits a billing row shows. Matched by harness AND account: two assistants can both report the
 * account `'default'` (Antigravity and Claude Code on one machine), and an account-only match handed one
 * row the other's bars.
 */
export function limitsForRow(limits: readonly PlanLimits[] | null | undefined, row: Pick<BillingRow, 'harness' | 'account'> & { foldedIds?: readonly string[] }): PlanLimits | null {
  if (!row.account) return null
  const mine = limits?.filter(l => l.harness === row.harness) ?? []
  // A sign-in the harness cannot name is folded into the row (`foldUnnamed`), and the server may have filed
  // the reading under that folded account: it is the same login's meter.
  return mine.find(l => l.account === row.account!.id) ?? mine.find(l => row.foldedIds?.includes(l.account)) ?? null
}

/**
 * One row of Settings → Billing: an identified account, or — for an assistant with no identified
 * account at all — the assistant's own timeline. The registry's reserve row (`id: ''`) never becomes
 * a row of its own: with an identified account beside it, it is the same login said twice.
 */
export interface BillingRow {
  /** `harness:account` — two assistants can both report the account `'default'`. */
  key: string
  harness: HarnessId
  /** `null` = the assistant's own timeline (it cannot say which account is signed in). */
  account: BillingAccount | null
  /** Nickname, else the login, else the assistant's name (numbered when it has several). */
  title: string
  /** What the title does not already say: the assistant, plus the login beside a nickname. */
  sub: string
  scope: RowScope
  /** Accounts folded into this row (same sign-in seen again): their meters are this row's meters. */
  foldedIds?: string[]
  /** The assistant has NO login on this computer: the row says "not connected", never a placeholder account. */
  signedOut?: true
}

/** Old Codex readers used a ChatGPT id fragment as the login label. It names no person. */
const billingLogin = (a: BillingAccount, assistant: string): string | null =>
  isPlaceholderName(a.label) || (a.harness === 'codex' && /^ChatGPT\s+[0-9a-f-]+$/i.test(a.label.trim())) || a.label.trim().toLowerCase() === assistant.toLowerCase() ? null : a.label

export function billingRows(
  accounts: readonly BillingAccount[], billing: BillingSettings, harnesses: readonly HarnessId[],
  harnessLabel: (h: HarnessId) => string, pt: boolean,
  /** `accountLabelKey(harness, account) → name` as the server numbered it (Now, Limits and the bell say the same). */
  serverLabels: Readonly<Record<string, string>> = {},
): BillingRow[] {
  const out: BillingRow[] = []
  const unknownWho = pt ? 'conta não informada' : 'account not reported'
  for (const h of harnesses) {
    const label = harnessLabel(h)
    const mine = billableAccounts(accounts, h)
    if (mine.length === 0) {
      const signedOut = accounts.some(a => a.harness === h && a.signedOut && !a.retired)
      out.push({ key: `harness:${h}`, harness: h, account: null, title: label, sub: signedOut ? '' : unknownWho, scope: { kind: 'default', harness: h }, ...(signedOut ? { signedOut: true as const } : {}) })
      continue
    }
    const shown = foldUnnamed(mine, billing)
    const unnamed = shown.filter(a => !(a.nickname && !isPlaceholderName(a.nickname)) && billingLogin(a, label) === null)
    for (const a of shown) {
      const nick = a.nickname && !isPlaceholderName(a.nickname) ? a.nickname : null
      const login = billingLogin(a, label)
      const n = unnamed.indexOf(a)
      // An assistant's own name is no login: such an account is unnamed, and is told apart exactly as every other screen does.
      const assistantNamed = !nick && !login && !isPlaceholderName(a.label) && a.label.trim().toLowerCase() === label.toLowerCase()
      const title = nick ?? login ?? serverLabels[accountLabelKey(h, a.id)] ?? (unnamed.length > 1 ? `${label} #${n + 1}` : label)
      // What the title does not already say: never the assistant's name twice.
      const raw = nick ? (login ? `${label} · ${login}` : label) : login ? label : a.harness === 'codex' ? label : assistantNamed ? '' : unknownWho
      const sub = raw === title ? '' : raw
      const foldedIds = mine.filter(x => x.id !== a.id && !shown.includes(x)).map(x => x.id)
      out.push({ key: accountLabelKey(h, a.id), harness: h, account: a, title, sub, scope: rowScope(billing, shown, a), ...(foldedIds.length ? { foldedIds } : {}) })
    }
  }
  return out
}

/**
 * The registry's fallback for a harness that reports no login: keyed by the harness's own data
 * directory (`root:…`), placeholder label, no nickname. Two of them are the same sign-in seen from
 * two homes, never two people. An unnamed account under a real identity key is NOT one of these.
 */
const fallback = (a: Pick<BillingAccount, 'key' | 'label' | 'nickname'>): boolean =>
  (a.key ?? '').startsWith('root:') && isPlaceholderName(a.label) && !(a.nickname && !isPlaceholderName(a.nickname))

/**
 * The accounts that become rows. A fallback account (see `fallback`) is the same sign-in said again
 * whenever there is something it could be: beside exactly ONE other account it folds into it; with
 * no other account, several fallbacks are one login and only one row is kept — the one carrying a plan of its own, else the oldest. Beside two or more named
 * others there is no telling which it is, so it stays a row of its own.
 */
export function foldUnnamed<A extends BillingAccount>(mine: readonly A[], billing: BillingSettings): A[] {
  const withName = mine.filter(a => !fallback(a))
  const without = mine.filter(fallback)
  if (without.length === 0) return [...mine]
  if (withName.length === 1) return withName
  if (withName.length > 1) return [...mine]
  const keep = without.find(a => ownPeriods(billing, a).length > 0) ?? without[0]
  return keep ? [keep] : []
}

/** The plans a harness's picker offers: its own (plus the "other / I don't know" entries), and the
 *  one already chosen even when it belongs elsewhere, so an existing period never loses its plan. */
export function planOptionsFor(harness: HarnessId, keep?: string): ReturnType<typeof plansForHarness> {
  return plansForHarness(harness).filter(p => p.suggestedHarnesses.includes(harness) || (SENTINEL_PLAN_IDS as readonly string[]).includes(p.id) || p.id === keep)
}

/** Where a new plan starts: the day after the last earlier plan ended, else today. */
export function defaultStart(periods: readonly BillingPeriod[], today: string): string {
  let last: number | null = null
  for (const p of periods) {
    const d = p.to ? dayIndex(p.to) : null
    if (d !== null && (last === null || d > last)) last = d
  }
  if (last === null) return today
  const next = dayFromIndex(last + 1)
  return next > today ? today : next
}

/**
 * The seam of a plan change: the period `id` ends the day before `from`. Applied BEFORE the new
 * period is validated, or the plan still in force overlaps its own successor and the change can
 * never be saved. A change on the old period's first day replaces it. An earlier seam is left
 * alone — the new period then overlaps it and the editor says so.
 */
export function closeBefore(periods: readonly BillingPeriod[], id: string, from: string): BillingPeriod[] {
  const day = dayIndex(from)
  return periods.filter(p => !(p.id === id && day !== null && p.from === from)).map(p => {
    if (p.id !== id || p.to || day === null) return p
    const to = dayFromIndex(day - 1)
    return to < p.from ? p : { ...p, to }
  })
}

/** Unknown billing is an answer to the notice, but it is not an informed plan. */
export function planCoverageText(
  rows: readonly { plan: { mode: BillingPeriod['mode'] } | null; problem: boolean }[],
  lang: 'pt' | 'en',
): string {
  const informed = rows.filter(r => r.plan && r.plan.mode !== 'unknown' && !r.problem).length
  const missing = rows.length - informed
  const base = lang === 'pt'
    ? `${informed} de ${rows.length} com plano informado`
    : `${informed} of ${rows.length} with a plan`
  return missing ? `${base} · ${missing} ${lang === 'pt' ? 'sem informar' : 'not set'}` : base
}

/**
 * The plan that has not started yet: the earliest period whose first day is after `today`. A row whose
 * only plan starts tomorrow is not "no plan" — it says when the plan starts, and its editor opens THAT
 * period (where it can be removed) instead of a blank new one.
 */
export function upcomingPeriod(periods: readonly BillingPeriod[], today: string): BillingPeriod | null {
  const now = dayIndex(today)
  if (now === null) return null
  let best: BillingPeriod | null = null
  for (const p of periods) {
    const from = dayIndex(p.from)
    if (from === null || from <= now) continue
    if (!best || from < (dayIndex(best.from) ?? Infinity)) best = p
  }
  return best
}

/**
 * A stored timeline no row on screen edits: an account that left the list (retired, folded into another,
 * no longer identified, or its login was removed) or a harness default every account overrode. It was
 * reachable from nowhere — a plan the user could see the effect of and never delete. Listed under the
 * accounts so it can be removed; never priced or edited from here.
 */
export interface OrphanTimeline {
  /** `default:<harness>` for `profiles[h]`, else the `accountProfiles` key as stored. */
  key: string
  kind: 'account' | 'default'
  /** `null` for a legacy bare-id key whose harness the key does not carry. */
  harness: HarnessId | null
  periods: BillingPeriod[]
}

export function orphanTimelines(billing: BillingSettings, rows: readonly Pick<BillingRow, 'scope'>[]): OrphanTimeline[] {
  const usedAccount = new Set<string>()
  const usedDefault = new Set<HarnessId>()
  for (const r of rows) {
    if (r.scope.kind === 'default') usedDefault.add(r.scope.harness)
    else { usedAccount.add(accountProfileKey(r.scope.harness, r.scope.id)); usedAccount.add(r.scope.id) }
  }
  const out: OrphanTimeline[] = []
  for (const [h, t] of Object.entries(billing.profiles) as [HarnessId, { periods: BillingPeriod[] } | undefined][]) {
    if (t && t.periods.length > 0 && !usedDefault.has(h)) out.push({ key: `default:${h}`, kind: 'default', harness: h, periods: t.periods })
  }
  for (const [key, t] of Object.entries(billing.accountProfiles ?? {})) {
    if (t.periods.length === 0 || usedAccount.has(key)) continue
    const sep = key.indexOf(':')
    const h = sep > 0 ? key.slice(0, sep) as HarnessId : null
    out.push({ key, kind: 'account', harness: h, periods: t.periods })
  }
  return out
}

/** Drops one orphan timeline from the settings — the only write the orphan list makes. */
export function withoutOrphan(billing: BillingSettings, o: Pick<OrphanTimeline, 'key' | 'kind' | 'harness'>): BillingSettings {
  if (o.kind === 'default' && o.harness) {
    const profiles = { ...billing.profiles }
    delete profiles[o.harness]
    return { ...billing, profiles }
  }
  const accountProfiles = { ...(billing.accountProfiles ?? {}) }
  delete accountProfiles[o.key]
  const { accountProfiles: _old, ...rest } = billing
  return Object.keys(accountProfiles).length > 0 ? { ...rest, accountProfiles } : rest
}
