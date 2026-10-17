/**
 * spawn-account-io.ts — the I/O half of `spawn-account.ts`: read the account registry (no probe),
 * the flag, and — only when a spawn names no account — the router's pick from the agent-visible
 * plan-limits budgets. Every door (`/api/fleet/new`, `agentop session start|batch`, every reopen)
 * reads its context here, so none of them can grow a second idea of which accounts exist.
 */
import { featureOn, type HarnessId } from '@agentistics/core'
import { readAccounts } from '../harness-accounts'
import {
  decideRecordedAccount, routerPicks, type SpawnAccountContext, type SpawnAccountDecision, type SpawnAccountRow,
} from './spawn-account'

/** The registry as spawn rows. An unreadable registry is NO accounts (the default root), never a throw. */
export async function spawnAccountRows(): Promise<SpawnAccountRow[]> {
  try {
    return (await readAccounts()).accounts.map(a => ({
      id: a.id, harness: a.harness, root: a.root, available: a.available,
      ...(a.retired ? { retired: true } : {}), firstSeen: a.firstSeen,
    }))
  } catch { return [] }
}

/**
 * The context `decideSpawnAccount` reads. `harnesses` are the ones being spawned: the plan-limits
 * read (the router pick) happens only when one of them has two or more live accounts and the
 * request named none, so a single-account machine never pays for it.
 */
export async function spawnAccountContext(
  needPicksFor: readonly HarnessId[] = [],
): Promise<SpawnAccountContext> {
  if (!featureOn('multi-account')) return { enabled: false, accounts: [] }
  const accounts = await spawnAccountRows()
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

/** A reopen's account: the record's own. No record → the default root, with no registry read. */
export async function recordedSpawnAccount(accountId: string | undefined): Promise<SpawnAccountDecision> {
  if (!accountId) return { ok: true }
  return decideRecordedAccount(accountId, await spawnAccountRows())
}
