/**
 * spawn-account-io.ts — the I/O half of `spawn-account.ts`: read the account registry (no probe),
 * the flag, and — only when a spawn names no account — the router's pick from the agent-visible
 * plan-limits budgets. Every door (`/api/fleet/new`, `agentop session start|batch`, every reopen)
 * reads its context here, so none of them can grow a second idea of which accounts exist.
 */
import { featureOn, type HarnessId } from '@agentistics/core'
import { readAccounts, type AccountsFile } from '../harness-accounts'
import {
  decideRecordedAccount, decideSpawnAccount, routerPicks, spawnAccountMessage, type SpawnAccountContext, type SpawnAccountDecision, type SpawnAccountRefusal, type SpawnAccountRow,
} from './spawn-account'

/**
 * The registry as spawn rows. WHERE an account runs is read from the BINDINGS (`<harness>:<root>` →
 * id), never from `HarnessAccount.root` alone: a signed-out account's root reads `null` too, and that
 * is not the default login. An account no binding names is `bound: false`.
 */
export function spawnRowsOf(file: Pick<AccountsFile, 'accounts' | 'bindings'>): SpawnAccountRow[] {
  const boundAt = new Map<string, string | null>()
  const defaultBound = new Set<string>()
  for (const [key, id] of Object.entries(file.bindings)) {
    const account = file.accounts.find(a => a.id === id)
    if (!account || !key.startsWith(`${account.harness}:`)) continue
    const root = key.slice(account.harness.length + 1) || null
    if (root === null) defaultBound.add(id)
    // Two bindings for one account (a stale one): the account's own recorded root wins.
    if (!boundAt.has(id) || root === account.root) boundAt.set(id, root)
  }
  return file.accounts.map(a => ({
    id: a.id, harness: a.harness, root: boundAt.get(a.id) ?? null, bound: boundAt.has(a.id), ...(defaultBound.has(a.id) ? { defaultRoot: true } : {}), available: a.available,
    ...(a.retired ? { retired: true } : {}), firstSeen: a.firstSeen,
  }))
}

/**
 * The newest registry row that drove `conversationId` — the trusted record a resume with no
 * `replaces` (an external process, a closed conversation) inherits its account from. Same lookup as
 * the CLI takeover. `undefined`: agentop never ran it, so it has no recorded account.
 */
export function newestRowOfConversation<T extends { conversationId?: string; harness: string; createdAt: string }>(
  entries: readonly T[], conversationId: string, harness?: string,
): T | undefined {
  return entries
    .filter(m => m.conversationId === conversationId && (harness === undefined || m.harness === harness))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

/** The registry as spawn rows. An unreadable registry is NO accounts (the default root), never a throw. */
export async function spawnAccountRows(): Promise<SpawnAccountRow[]> {
  try { return spawnRowsOf(await readAccounts()) } catch { return [] }
}

/**
 * The context `decideSpawnAccount` reads. `harnesses` are the ones being spawned: the plan-limits
 * read (the router pick) happens only when one of them has two or more live accounts and the
 * request named none, so a single-account machine never pays for it.
 */
export async function spawnAccountContext(
  needPicksFor: readonly HarnessId[] = [],
): Promise<SpawnAccountContext> {
  // Read with the flag off too: the hidden-account rule for an agent's default-root spawn is not a flag.
  const accounts = await spawnAccountRows()
  if (!featureOn('multi-account')) return { enabled: false, accounts }
  const several = needPicksFor.filter(h => accounts.filter(a => a.harness === h && !a.retired).length > 1)
  if (!several.length) return { enabled: true, accounts }
  try {
    const [{ planLimitsPayload }, { readPreferences }] = await Promise.all([import('../plan-limits'), import('../preferences')])
    const payload = await planLimitsPayload((await readPreferences()).billing)
    return { enabled: true, accounts, picks: routerPicks(payload.budgets) }
  } catch {
    return { enabled: true, accounts }
  }
}

/**
 * A reopen's account: the record's own. No record and no agent caller → the default root, with no
 * registry read. `agentCaller` is true only for a VERIFIED session identity.
 */
export async function recordedSpawnAccount(
  accountId: string | undefined,
  caller: { agentCaller?: boolean; harness?: HarnessId } = {},
): Promise<SpawnAccountDecision> {
  if (!accountId && !caller.agentCaller) return { ok: true }
  return decideRecordedAccount(accountId, await spawnAccountRows(), caller)
}

/**
 * The account of a spawn that reached the HOST without one decided — the cockpit wizard's own start.
 * `/api/fleet/new` decides in `planFleetSpawn` and says so (`accountDecided`); a LOGIN session carries
 * its own root (`account`) and is never re-decided. Same rule as every other door: `decideSpawnAccount`.
 */
export async function hostSpawnAccount(req: {
  harness: HarnessId
  accountId?: string
  accountDecided?: boolean
  login?: boolean
  callerVerified?: boolean
}, lang: 'en' | 'pt'): Promise<{ ok: true; accountId?: string } | { ok: false; message: string; reason: SpawnAccountRefusal }> {
  if (req.login || req.accountDecided || req.accountId !== undefined) {
    return { ok: true, ...(req.accountId ? { accountId: req.accountId } : {}) }
  }
  const decided = decideSpawnAccount({
    harness: req.harness, agentCaller: req.callerVerified === true, context: await spawnAccountContext([req.harness]),
  })
  if (!decided.ok) return { ok: false, message: spawnAccountMessage(decided.reason, decided.detail, lang), reason: decided.reason }
  return { ok: true, ...(decided.account ? { accountId: decided.account.id } : {}) }
}
