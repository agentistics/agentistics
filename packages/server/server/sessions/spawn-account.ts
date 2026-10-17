/**
 * spawn-account.ts — PURE (PLAN.ACCOUNTS D3, flag `multi-account`). Which harness ACCOUNT a spawn
 * runs on, decided once for every door: `POST /api/fleet/new`, `agentop session start --account`,
 * `session batch` and every reopen.
 *
 * Rules that must hold (spec §4, §6 "The hard rule"):
 * - **Flag off, nothing changes for the spawn.** No account is chosen, nothing is stamped, the
 *   spawn's argv/env are byte-identical. A request naming an account is REFUSED in words, never
 *   silently ignored. The availability rule still holds: an AGENT is refused when the account
 *   signed in to the default root is off for agents (the hidden-account rule is not a flag).
 * - **An account runs only where it is SIGNED IN.** Its root comes from the registry's bindings,
 *   never from `HarnessAccount.root` alone: a signed-out account's root reads `null`, which is NOT
 *   the default login. A signed-out account is refused in words (`account_signed_out`), never
 *   launched under whatever login holds a root now.
 * - **An account an agent may not use is refused only for an agent.** `account_unavailable` (403)
 *   when the account is off (or retired) AND the request carries a verified session identity; the
 *   owner's own browser/CLI may pick an account that is off for agents.
 * - **An unknown id is a usage error** (`unknown_account`, 422), never a fallback to the default root.
 * - **A retired account starts nothing** (`account_retired`): its root may be gone, and a session
 *   started there would sign in again under an account the owner removed.
 * - **The automatic pick never lands on a hidden account.** No `account` → the router's pick for
 *   that harness (the C2 budgets, which are already agent-visible), else the default root when its
 *   account is visible (or unknown), else the oldest visible account; an AGENT with nothing visible
 *   left is refused rather than handed a hidden one.
 * - **A recorded account is immutable**: a reopen spawns in the record's account, whatever the flag
 *   says now, and is never moved to another one. An AGENT reopening a row whose account is now off
 *   for agents is refused in words; the owner may still reopen it.
 */
import { pickAccount, type AccountBudget, type HarnessId } from '@agentistics/core'

/** What a spawn needs to know about one registered account — a structural subset of `HarnessAccount`. */
export interface SpawnAccountRow {
  id: string
  harness: HarnessId
  /** Where the account is SIGNED IN (from the bindings); `null`: the default root. Meaningless unless `bound`. */
  root: string | null
  /** A binding names this account: it is signed in at `root`. False = signed out everywhere. */
  bound: boolean
  available: boolean
  retired?: boolean
  firstSeen?: number
}

/** The account a spawn runs on. `root: null` adds nothing to the spawn. */
export interface SpawnAccount { id: string; root: string | null }

export type SpawnAccountRefusal =
  | 'accounts_disabled' | 'unknown_account' | 'account_unavailable' | 'account_retired' | 'account_signed_out'

export type SpawnAccountDecision =
  | { ok: true; account?: SpawnAccount }
  | { ok: false; reason: SpawnAccountRefusal; detail: string }

export interface SpawnAccountContext {
  /** `featureOn('multi-account')`. */
  enabled: boolean
  accounts: readonly SpawnAccountRow[]
  /** The router's account per harness (agent-visible budgets only), see `routerPicks`. */
  picks?: Partial<Record<HarnessId, string>>
}

const REFUSALS: readonly string[] = [
  'accounts_disabled', 'unknown_account', 'account_unavailable', 'account_retired', 'account_signed_out',
] satisfies SpawnAccountRefusal[]
export const isAccountRefusal = (reason: string): reason is SpawnAccountRefusal => REFUSALS.includes(reason)

const visible = (a: SpawnAccountRow) => a.available && !a.retired
const usable = (a: SpawnAccountRow) => visible(a) && a.bound
const at = (a: SpawnAccountRow): SpawnAccount => ({ id: a.id, root: a.root })
/** The account signed in to the harness's DEFAULT root, if the registry knows it. */
const homeOf = (mine: readonly SpawnAccountRow[]) => mine.find(a => a.bound && a.root === null && !a.retired)

/**
 * The hidden-account rule for a spawn that names no account and runs in the default root (flag off,
 * or a row recorded before accounts): an agent is refused when that root's login is off for agents.
 */
function defaultRootCheck(mine: readonly SpawnAccountRow[], agentCaller: boolean): SpawnAccountDecision {
  const home = homeOf(mine)
  return agentCaller && home && !home.available ? { ok: false, reason: 'account_unavailable', detail: home.id } : { ok: true }
}

/**
 * Decide the account of a FRESH spawn. `requested` is the id the caller named (absent = automatic);
 * `agentCaller` is true only when the request carries a VERIFIED session identity.
 */
export function decideSpawnAccount(input: {
  harness: HarnessId
  requested?: string
  agentCaller: boolean
  context: SpawnAccountContext
}): SpawnAccountDecision {
  const { harness, requested, agentCaller, context } = input
  const mine = context.accounts.filter(a => a.harness === harness)
  if (!context.enabled) {
    return requested ? { ok: false, reason: 'accounts_disabled', detail: requested } : defaultRootCheck(mine, agentCaller)
  }
  if (requested) {
    const found = mine.find(a => a.id === requested)
    if (!found) return { ok: false, reason: 'unknown_account', detail: requested }
    if (agentCaller && !visible(found)) return { ok: false, reason: 'account_unavailable', detail: requested }
    if (found.retired) return { ok: false, reason: 'account_retired', detail: requested }
    if (!found.bound) return { ok: false, reason: 'account_signed_out', detail: requested }
    return { ok: true, account: at(found) }
  }
  const live = mine.filter(a => !a.retired)
  if (!live.length) return { ok: true }
  const picked = context.picks?.[harness]
  const routed = picked ? live.find(a => a.id === picked && usable(a)) : undefined
  if (routed) return { ok: true, account: at(routed) }
  const home = homeOf(live)
  if (home && visible(home)) return { ok: true, account: at(home) }
  // A visible account signed in to a SECONDARY root comes before an unregistered (or hidden) default.
  const other = live.filter(usable).sort((a, b) => (a.firstSeen ?? 0) - (b.firstSeen ?? 0))[0]
  if (other) return { ok: true, account: at(other) }
  // The owner keeps the default root: its own (hidden) login, or an unregistered one as before
  // accounts existed. An agent with no allowed target left is refused rather than handed either.
  if (!agentCaller) return home ? { ok: true, account: at(home) } : { ok: true }
  const signedOut = live.find(visible)
  return signedOut
    ? { ok: false, reason: 'account_signed_out', detail: signedOut.id }
    : { ok: false, reason: 'account_unavailable', detail: (home ?? live[0]!).id }
}

/**
 * Decide the account of a REOPEN/attach/restart: the record's own, never a new choice and never
 * another account. A row with no `accountId` (before accounts, or flag off at spawn) reopens in the
 * default root exactly as before, under the same agent rule as a flag-off fresh spawn.
 */
export function decideRecordedAccount(
  accountId: string | undefined,
  accounts: readonly SpawnAccountRow[],
  caller: { agentCaller?: boolean; harness?: HarnessId } = {},
): SpawnAccountDecision {
  const agentCaller = caller.agentCaller === true
  if (!accountId) {
    return caller.harness ? defaultRootCheck(accounts.filter(a => a.harness === caller.harness), agentCaller) : { ok: true }
  }
  const found = accounts.find(a => a.id === accountId)
  if (!found) return { ok: false, reason: 'unknown_account', detail: accountId }
  if (found.retired) return { ok: false, reason: 'account_retired', detail: accountId }
  if (agentCaller && !found.available) return { ok: false, reason: 'account_unavailable', detail: accountId }
  if (!found.bound) return { ok: false, reason: 'account_signed_out', detail: accountId }
  return { ok: true, account: at(found) }
}

/**
 * The router's account per harness, from the AGENT-VISIBLE budgets (`planLimitsPayload().budgets`):
 * among the accounts that can take work, `pickAccount`'s policy (the one place it lives). A harness
 * whose accounts are all on hold or unregistered gets no pick, so the default rule applies.
 */
export function routerPicks(budgets: readonly AccountBudget[]): Partial<Record<HarnessId, string>> {
  const out: Partial<Record<HarnessId, string>> = {}
  const harnesses = [...new Set(budgets.map(b => b.harness))]
  for (const h of harnesses) {
    const eligible = budgets.filter(b => b.harness === h && b.account && b.account !== 'default'
      && b.spawnable !== false && b.plan !== 'unregistered' && b.status !== 'hold')
    const pick = pickAccount(eligible)
    if (pick?.account) out[h] = pick.account
  }
  return out
}

/** HTTP status of a refusal: an agent kept off an account is 403, the rest are the caller's input. */
export function spawnAccountStatus(reason: SpawnAccountRefusal): 403 | 409 | 422 {
  return reason === 'account_unavailable' ? 403 : reason === 'account_retired' || reason === 'account_signed_out' ? 409 : 422
}

/** The sentence for a refusal, in the caller's language. */
export function spawnAccountMessage(reason: SpawnAccountRefusal, detail: string, lang: 'en' | 'pt', reopen = false): string {
  const pt = lang === 'pt'
  switch (reason) {
    case 'accounts_disabled':
      return pt ? `Várias contas não estão ativadas nesta máquina, então a conta "${detail}" não pode ser escolhida.`
        : `Multiple accounts are not enabled on this machine, so account "${detail}" cannot be chosen.`
    case 'unknown_account':
      if (reopen) {
        return pt ? `Esta conversa pertence à conta "${detail}", que não está mais registrada, então não pode ser reaberta.`
          : `This conversation belongs to account "${detail}", which is no longer registered, so it cannot be reopened.`
      }
      return pt ? `Nenhuma conta "${detail}" deste assistente está registrada.`
        : `No account "${detail}" of this assistant is registered.`
    case 'account_unavailable':
      if (reopen) {
        return pt ? `Esta conversa pertence à conta "${detail}", que está desligada para agentes; só o dono pode reabri-la.`
          : `This conversation belongs to account "${detail}", which is off for agents; only the owner can reopen it.`
      }
      return pt ? `A conta "${detail}" está desligada para agentes; só o dono pode iniciar sessões nela.`
        : `Account "${detail}" is off for agents; only the owner can start sessions on it.`
    case 'account_signed_out':
      return pt ? `A conta "${detail}" não está conectada em nenhuma pasta deste assistente; entre nela de novo antes de ${reopen ? 'reabrir esta conversa' : 'iniciar uma sessão nela'}.`
        : `Account "${detail}" is not signed in anywhere for this assistant; sign in to it again before ${reopen ? 'reopening this conversation' : 'starting a session on it'}.`
    case 'account_retired':
      if (!reopen) {
        return pt ? `A conta "${detail}" foi removida, então nenhuma sessão pode ser iniciada nela.`
          : `Account "${detail}" was removed, so no session can start on it.`
      }
      return pt ? `Esta conversa pertence a uma conta que foi removida ("${detail}"), então não pode ser iniciada nela.`
        : `This conversation belongs to an account that was removed ("${detail}"), so nothing can start on it.`
  }
}
