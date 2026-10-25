/**
 * account-transcript-roots.ts — where a SECOND account's conversations are on disk (PLAN.ACCOUNTS).
 *
 * An extra login runs in its own config root (`<data>/accounts/<harness>/r_<id>`, moved there by the
 * harness's ONE isolation variable — `account-isolation.ts`), so the harness writes that account's
 * transcripts under the ROOT, never under `~/.claude` / `~/.codex` / …. Measured 2026-10-23: a Claude
 * Pro session started on such a root answered in its terminal while its chat stayed empty and its
 * messages read "delivered — not read yet" forever, because every reader looked in the default home
 * only; once it ended, the chat said its transcript had been removed — the file was in the root.
 *
 * The rule: a reader that misses in the default store looks for the SAME conversation id in each
 * account root of that harness. The id is the harness's own, exact — a hit is that conversation, never
 * a guess by directory — so no row can land in another's chat. Roots come from the account registry
 * (both the binding keys and each account's `root`, retired accounts included: their history stays).
 *
 * `storeDirOf` is PURE; `accountRootsFor` / `accountRootOf` read the registry, cached briefly — the
 * chat poll runs every few seconds and the registry changes when somebody signs in.
 */
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'

/** The registry fields this module reads (a subset of `harness-accounts.ts`'s `AccountsFile`). */
export interface AccountRootsSource {
  accounts: ReadonlyArray<{ id: string; harness: HarnessId; root: string | null }>
  bindings: Readonly<Record<string, string>>
  aliases?: Readonly<Record<string, string>>
}

/**
 * PURE. Inside a config root (what the isolation variable points at), the directory the transcript
 * reader of that harness scans. `null`: the harness has no per-account root (one login per computer).
 * Gemini's variable is a HOME: the CLI creates `.gemini` inside it (`account-roots.ts` ROOT_CONFIG_SUBDIR).
 */
export function storeDirOf(harness: HarnessId, root: string): string | null {
  switch (harness) {
    case 'claude': return join(root, 'projects')
    case 'codex': return join(root, 'sessions')
    case 'copilot': return join(root, 'session-state')
    case 'kimi': return join(root, 'sessions')
    case 'gemini': return join(root, '.gemini', 'tmp')
    case 'antigravity': return null
    case 'opencode': return null
  }
}

/** PURE. Every non-default config root the registry knows for one harness, deduplicated, stable order. */
export function accountRootsFrom(file: AccountRootsSource, harness: HarnessId): string[] {
  const out: string[] = []
  const add = (root: string | null | undefined) => { if (root && !out.includes(root)) out.push(root) }
  for (const a of file.accounts) if (a.harness === harness) add(a.root)
  const prefix = `${harness}:`
  for (const key of Object.keys(file.bindings)) {
    if (key.startsWith(prefix) && key.length > prefix.length) add(key.slice(prefix.length))
  }
  return out
}

/** PURE. The config root of one account id (aliases followed), or `null` for the default home / unknown. */
export function accountRootFrom(file: AccountRootsSource, accountId: string): string | null {
  const id = file.aliases?.[accountId] ?? accountId
  const account = file.accounts.find(a => a.id === id)
  if (account?.root) return account.root
  for (const [key, bound] of Object.entries(file.bindings)) {
    const at = key.indexOf(':')
    if (bound === id && at >= 0 && key.length > at + 1) return key.slice(at + 1)
  }
  return null
}

const TTL_MS = 15_000
let cached: { at: number; file: AccountRootsSource } | null = null
let override: (() => Promise<AccountRootsSource>) | null = null

async function registry(now = Date.now()): Promise<AccountRootsSource> {
  if (override) return override()
  if (cached && now - cached.at < TTL_MS) return cached.file
  try {
    const { readAccounts } = await import('../harness-accounts')
    const file = await readAccounts()
    cached = { at: now, file }
    return file
  } catch {
    return cached?.file ?? { accounts: [], bindings: {} }
  }
}

/** The stores to search, after the default one, for a conversation of this harness. */
export async function accountStoreDirs(harness: HarnessId): Promise<string[]> {
  const dirs: string[] = []
  for (const root of accountRootsFrom(await registry(), harness)) {
    const dir = storeDirOf(harness, root)
    if (dir) dirs.push(dir)
  }
  return dirs
}

/** The config root an account runs in, or `null` (the default home, or an unknown id). */
export async function accountRootOf(accountId: string | undefined): Promise<string | null> {
  if (!accountId) return null
  return accountRootFrom(await registry(), accountId)
}

/** Tests only: answer from a fixed registry (or `null` to restore the real one) and drop the cache. */
export function __setAccountRootsForTest(next: AccountRootsSource | null): void {
  override = next ? async () => next : null
  cached = null
}
