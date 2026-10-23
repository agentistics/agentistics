/**
 * PLAN LIMITS — the claude tap for TUI sessions. A session running in the terminal UI emits no
 * stream-json, so the `rate_limit_event` tap (`plan-limits.ts` `noteStructuredLine`) never fires
 * for it, and with every session in the TUI the claude record froze. This asks the endpoint Claude
 * Code's own `/usage` reads — `GET /api/oauth/usage` — with the login Claude Code already keeps in
 * `~/.claude/.credentials.json`. It is a READ: it spends no quota.
 *
 * The credential rules: read in-process on every poll, never logged, never persisted, never put in
 * an error. An access token that is expired (or about to be) is NOT refreshed here — a refresh
 * rotates the refresh token, and doing it behind Claude Code's back would sign the user out of it.
 * The poll then skips, and the held record ages into `stale` on its own, which is the honest answer.
 * No credentials file (macOS keeps it in the Keychain, which is never read) → nothing, never a 0.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseClaudeUsageResponse, type PlanLimits } from '@agentistics/core'
import { HOME_DIR } from './config'
import { ingestFromRoot } from './plan-limits'

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CLAUDE_USAGE_POLL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const EXPIRY_MARGIN_MS = 60_000

export const claudeCredentialsFile = (): string =>
  join(process.env.CLAUDE_CONFIG_DIR || join(HOME_DIR, '.claude'), '.credentials.json')

/** An extra account root's credential file — the root IS that login's `CLAUDE_CONFIG_DIR`. */
const readCredentialAt = (root: string): Promise<string | null> =>
  readFile(join(root, '.credentials.json'), 'utf8').catch(() => null)

/**
 * Every extra Claude login's root. A second account signs in inside its own root, so the default
 * credential file says nothing about it, and a session of it in the terminal UI emits no
 * `rate_limit_event` — so without this its limits were never read ("waiting for a reading" forever).
 */
async function claudeAccountRoots(deps: UsageDeps): Promise<string[]> {
  if (deps.accountRoots) return deps.accountRoots().catch(() => [])
  try {
    const [{ readAccounts }, { accountRootsFrom }] = await Promise.all([
      import('./harness-accounts'), import('./sessions/account-transcript-roots'),
    ])
    return accountRootsFrom(await readAccounts(), 'claude')
  } catch { return [] }
}

export type UsageSkip = 'no-credential' | 'expired' | 'no-scope' | 'http' | 'rate-limited' | 'unparseable' | 'network'
export type UsageResult = { limits: PlanLimits } | { skip: UsageSkip }

/** The access token, or why there is none. PURE over the file's text; the token is only returned. */
export function claudeAccessToken(raw: string | null, nowMs: number): { token: string } | { skip: UsageSkip } {
  if (!raw) return { skip: 'no-credential' }
  let o: unknown
  try { o = JSON.parse(raw) } catch { return { skip: 'no-credential' } }
  const c = (o as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; scopes?: unknown } } | null)?.claudeAiOauth
  if (!c || typeof c.accessToken !== 'string' || !c.accessToken) return { skip: 'no-credential' }
  if (typeof c.expiresAt === 'number' && c.expiresAt - EXPIRY_MARGIN_MS <= nowMs) return { skip: 'expired' }
  if (Array.isArray(c.scopes) && !c.scopes.includes('user:profile')) return { skip: 'no-scope' }
  return { token: c.accessToken }
}

export interface UsageDeps {
  readCredential?: () => Promise<string | null>
  /**
   * The extra Claude account roots to read as well (each extra login's own `CLAUDE_CONFIG_DIR`,
   * `account-roots.ts`), and how to read a root's credential file. Defaults: the account registry,
   * and `<root>/.credentials.json` read in-process under the same rules as the default one.
   */
  accountRoots?: () => Promise<string[]>
  readCredentialAt?: (root: string) => Promise<string | null>
  ingest?: (limits: PlanLimits, root: string | null) => Promise<unknown>
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
}

/** One read of the usage endpoint. Never throws; the reason for nothing is a code, never text. */
export async function fetchClaudeUsage(deps: UsageDeps = {}): Promise<UsageResult> {
  const now = deps.now ?? Date.now
  const read = deps.readCredential ?? (() => readFile(claudeCredentialsFile(), 'utf8').catch(() => null))
  const cred = claudeAccessToken(await read(), now())
  if ('skip' in cred) return cred
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
  } catch { return { skip: 'network' } }
  if (res.status === 429) return { skip: 'rate-limited' }
  if (!res.ok) return { skip: 'http' }
  let body: unknown
  try { body = await res.json() } catch { return { skip: 'unparseable' } }
  const limits = parseClaudeUsageResponse(body, now())
  return limits ? { limits } : { skip: 'unparseable' }
}

/**
 * The server's poll: now, then every 5 minutes (under `PLAN_LIMITS_STALE_MS`, so a working poll
 * never reads stale), doubling up to 30 minutes after a 429. `AGENTISTICS_CLAUDE_USAGE=0` turns it
 * off. Returns the stop function.
 */
export function startClaudeUsagePoll(deps: UsageDeps = {}): () => void {
  if (process.env.AGENTISTICS_CLAUDE_USAGE === '0') return () => {}
  let delay = CLAUDE_USAGE_POLL_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const ingest = deps.ingest ?? ((l: PlanLimits, root: string | null) => ingestFromRoot(l, root))
  const tick = async (): Promise<void> => {
    let limited = false
    for (const root of [null, ...await claudeAccountRoots(deps)]) {
      const r = await fetchClaudeUsage(root === null ? deps : {
        ...deps,
        readCredential: () => (deps.readCredentialAt ?? readCredentialAt)(root),
      }).catch((): UsageResult => ({ skip: 'network' }))
      // Attributed by the ROOT it was read from: the default home's binding, or that root's account.
      if ('limits' in r) await ingest(r.limits, root).catch(() => false)
      if ('skip' in r && r.skip === 'rate-limited') limited = true
    }
    delay = limited ? Math.min(MAX_BACKOFF_MS, delay * 2) : CLAUDE_USAGE_POLL_MS
    if (stopped) return
    timer = setTimeout(() => { void tick() }, delay)
    timer.unref?.()
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
