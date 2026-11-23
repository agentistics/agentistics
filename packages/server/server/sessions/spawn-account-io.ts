/**
 * spawn-account-io.ts — the I/O half of `spawn-account.ts`: read the account registry (no probe),
 * the flag, and — only when a spawn names no account — the router's pick from the agent-visible
 * plan-limits budgets. Every door (`/api/fleet/new`, `agentop session start|batch`, every reopen)
 * reads its context here, so none of them can grow a second idea of which accounts exist.
 */
import { featureOn, type HarnessId } from '@agentistics/core'
import { readAccounts, type AccountsFile } from '../harness-accounts'
import { resolveChatTranscriptPath } from './chat-tail'
import { storeDirOf, transcriptMtimeMs } from './account-transcript-roots'
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
    ...(a.retired ? { retired: true } : {}), ...(a.loginExpiredAt !== undefined ? { expired: true as const } : {}), firstSeen: a.firstSeen,
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
 * The account a closed conversation LIVES on, found from its transcript when the registry row that
 * said so is gone (2026-11 disk fault: the account existed only in the lost registry, and reopening
 * a conversation stored under a second login's root failed with "No conversation found" because it
 * was resumed on the default one). Exact by conversation id — a hit in a root IS that conversation.
 * `undefined`: it lives in the default store, or nowhere we can read — the default rule then applies.
 * Claude only: it is the harness whose resolver walks account roots by id.
 */
export async function accountOfConversation(
  harness: HarnessId, cwd: string, conversationId: string,
  deps: { file?: AccountsFile; resolve?: typeof resolveChatTranscriptPath; mtime?: (path: string) => Promise<number> } = {},
): Promise<string | undefined> {
  if (harness !== 'claude') return undefined
  const resolve = deps.resolve ?? resolveChatTranscriptPath
  const mtime = deps.mtime ?? transcriptMtimeMs
  try {
    // An account switch COPIES the transcript, so one id can live in several stores and only the
    // newest keeps growing: the NEWEST copy decides (same rule as `newestTranscript`), never the first hit.
    const hits: { account: string | undefined; at: number }[] = []
    const defaultHit = await resolve(cwd, conversationId)
    if (defaultHit) hits.push({ account: undefined, at: await mtime(defaultHit).catch(() => -1) })
    const file = deps.file ?? await readAccounts()
    for (const a of file.accounts) {
      if (a.harness !== 'claude' || !a.root || a.retired) continue
      const dir = storeDirOf('claude', a.root)
      const hit = dir ? await resolve(cwd, conversationId, dir) : null
      if (hit) hits.push({ account: a.id, at: await mtime(hit).catch(() => -1) })
    }
    let best: (typeof hits)[number] | undefined
    for (const h of hits) if (!best || h.at > best.at) best = h
    return best?.account
  } catch { /* unreadable registry or store: default rule */ }
  return undefined
}

/** The account a reopen runs on: the recorded one, else the root whose store holds the transcript. ONE helper for every door. */
export async function accountForReopen(
  recorded: string | undefined, harness: HarnessId, cwd: string, conversationId: string,
  deps: Parameters<typeof accountOfConversation>[3] = {},
): Promise<string | undefined> {
  return recorded ?? await accountOfConversation(harness, cwd, conversationId, deps)
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

/**
 * CONTA.AUTO (B) — the account a leader's hand-off successor starts on when no account was named: the plan router's pick
 * among the accounts of its harness that have room (`handoffAccount`), never the predecessor's own while it is
 * limit-blocked. `undefined`: no opinion (accounts off, fewer than two, nobody with room, a plan-limits read that failed) —
 * the ordinary spawn rule then decides, exactly as before. An explicit account never reaches here. With NOBODY having room it
 * still answers — the usable account whose window reopens soonest, `room: false` — and the caller says so: the default rule would
 * hand the successor the limit-blocked predecessor account.
 */
export async function handoffAccountChoice(o: {
  harness: HarnessId
  /** The predecessor's registry row (the leader being replaced), when it is known. */
  predecessor?: { id: string; conversationId?: string | undefined; cwd: string; accountId?: string | undefined; harness: string; model?: string | undefined } | undefined
  agentCaller: boolean
}): Promise<{ id: string; room: boolean; resetsAt?: number } | undefined> {
  try {
    if (!featureOn('multi-account')) return undefined
    const accounts = await spawnAccountRows()
    const mine = accounts.filter(a => a.harness === o.harness && !a.retired)
    if (mine.length < 2) return undefined
    const context: SpawnAccountContext = { enabled: true, accounts }
    const usable = mine.filter(a => decideSpawnAccount({ harness: o.harness, requested: a.id, agentCaller: o.agentCaller, context }).ok).map(a => a.id)
    if (usable.length < 1) return undefined
    const [{ planLimitsPayload }, { readPreferences }, { handoffAccount }] = await Promise.all([import('../plan-limits'), import('../preferences'), import('./auto-switch')])
    const budgets = (await planLimitsPayload((await readPreferences()).billing, Date.now())).budgets
    const p = o.predecessor
    let predecessor: { account?: string; limited: boolean } | undefined
    if (p && p.harness === o.harness) {
      const { readLimitState } = await import('./account-switch-io')
      const { resolveSessionAccount, registryOfSpawnRows } = await import('./session-account')
      const account = resolveSessionAccount([p as never], { id: p.id }, registryOfSpawnRows(accounts)) ?? p.accountId
      const limited = p.conversationId
        ? !!(await readLimitState({ harness: o.harness, conversationId: p.conversationId, cwd: p.cwd, ...(p.accountId ? { accountId: p.accountId } : {}) }).catch(() => null))
        : false
      predecessor = { ...(account ? { account } : {}), limited }
    }
    return handoffAccount({ harness: o.harness, usable, budgets, ...(predecessor ? { predecessor } : {}), ...(p?.model ? { model: p.model } : {}) })
  } catch { return undefined }
}
