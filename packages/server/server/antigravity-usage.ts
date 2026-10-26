/**
 * PLAN LIMITS — the Antigravity (agy) quota tap. agy keeps one weekly quota PER MODEL GROUP ("Gemini
 * models", "Claude and GPT models"); the CLI reads it from Google's `fetchAvailableModels`. This asks
 * the same call with the login agy already keeps in `antigravity-oauth-token`, parses it with
 * `parseAntigravityModels` and ingests the record. Modelled on `claude-usage.ts`.
 *
 * The credential rules (same as claude's): read in-process on every poll, held in a local variable
 * only long enough to build ONE `Authorization` header, never logged, never persisted, never put in a
 * skip code or an error, never copied or written back. An expired token is NOT refreshed — agy
 * refreshes its own while it runs, which is why the network is read only while an agy process is
 * alive. The poll then skips and the held record ages into `stale` on its own.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAntigravityModels, type PlanLimits } from '@agentistics/core'
import { ANTIGRAVITY_DIR, TEAM_CENTRAL } from './config'
import { ingestFromRoot } from './plan-limits'

export const ANTIGRAVITY_USAGE_POLL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const EXPIRY_MARGIN_MS = 60_000
const PLAN_LABEL_TTL_MS = 6 * 3_600_000

/** `auth_method` → host. Anything else is `unknown-auth`: no request. */
export const ANTIGRAVITY_HOSTS = {
  consumer: 'https://daily-cloudcode-pa.googleapis.com',
  gcp: 'https://cloudcode-pa.googleapis.com',
} as const
type AuthMethod = keyof typeof ANTIGRAVITY_HOSTS

export type AntigravitySkip =
  | 'no-credential' | 'expired' | 'unknown-auth' | 'no-project' | 'no-agy' | 'http' | 'rate-limited' | 'unparseable' | 'network'
export type AntigravityResult = { limits: PlanLimits } | { skip: AntigravitySkip }

const tokenFile = (root: string): string => join(root, 'antigravity-oauth-token')
const projectFile = (root: string): string => join(root, 'cache', 'default_project_id.txt')

/**
 * The access token and the host to ask, or why there is none. PURE over the file's text. Only
 * `token.access_token`, `token.expiry` and `auth_method` are read — nothing else is kept in a variable.
 */
export function antigravityAccessToken(raw: string | null, nowMs: number): { token: string; method: AuthMethod } | { skip: AntigravitySkip } {
  if (!raw) return { skip: 'no-credential' }
  let o: unknown
  try { o = JSON.parse(raw) } catch { return { skip: 'no-credential' } }
  const t = (o as { token?: { access_token?: unknown; expiry?: unknown } } | null)?.token
  const method = (o as { auth_method?: unknown } | null)?.auth_method
  if (!t || typeof t.access_token !== 'string' || !t.access_token) return { skip: 'no-credential' }
  const expiry = typeof t.expiry === 'string' ? Date.parse(t.expiry) : NaN
  if (!Number.isFinite(expiry) || expiry - EXPIRY_MARGIN_MS <= nowMs) return { skip: 'expired' }
  if (method !== 'consumer' && method !== 'gcp') return { skip: 'unknown-auth' }
  return { token: t.access_token, method }
}

export interface AntigravityUsageDeps {
  /** The account root (`ANTIGRAVITY_DIR`-shaped); default root when absent. */
  root?: string
  readToken?: (root: string) => Promise<string | null>
  readProjectId?: (root: string) => Promise<string | null>
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  /** Whether an agy process is alive (a scanned process or a live managed session). */
  agyLive?: () => Promise<boolean>
  ingest?: (limits: PlanLimits, root: string | null) => Promise<unknown>
  /** Extra account roots to read as well (A2); each is that account's own agy directory. */
  accountRoots?: () => Promise<string[]>
}

/** What "an agy is alive" reads: a scanned process, or a managed agy session whose pane is running. */
export interface AgyLiveSources {
  scanned: () => Promise<boolean>
  managedRunning: () => Promise<boolean>
}

export async function agyLiveFrom(src: AgyLiveSources): Promise<boolean> {
  // A source that cannot answer is "not alive" — it never fails the other one.
  if (await src.scanned().catch(() => false)) return true
  return src.managedRunning().catch(() => false)
}

const defaultAgyLive = (): Promise<boolean> => agyLiveFrom({
  scanned: async () => {
    const { scanProcesses } = await import('./live-sessions')
    return (await scanProcesses()).procs.some(p => p.harness === 'antigravity')
  },
  managedRunning: async () => {
    const [{ readRegistry }, { resolveBackend }, { reconcileSessions }] = await Promise.all([
      import('./sessions/registry'), import('./sessions/index'), import('./sessions/session-ref'),
    ])
    const rows = reconcileSessions(await readRegistry(), await (await resolveBackend()).list())
    return rows.some(r => r.status === 'running' && r.managed?.harness === 'antigravity')
  },
})

// The plan label is asked at most once per 6 h per root and kept in memory only.
const planLabels = new Map<string, { at: number; label?: string }>()
export const __resetAntigravityUsageForTest = (): void => planLabels.clear()

async function planLabelOf(host: string, root: string, token: string, projectId: string, deps: AntigravityUsageDeps, now: number): Promise<string | undefined> {
  const held = planLabels.get(root)
  if (held && now - held.at < PLAN_LABEL_TTL_MS) return held.label
  let label: string | undefined
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${host}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudaicompanionProject: projectId }),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const b = await res.json() as { paidTier?: { name?: unknown }; currentTier?: { name?: unknown } }
      const name = b.paidTier?.name ?? b.currentTier?.name
      if (typeof name === 'string' && name) label = name
    }
  } catch { /* the quota record never waits on its label */ }
  planLabels.set(root, { at: now, ...(label ? { label } : {}) })
  return label
}

/** One read of the quota. Never throws; the reason for nothing is a code, never text. */
export async function fetchAntigravityUsage(deps: AntigravityUsageDeps = {}): Promise<AntigravityResult> {
  const now = deps.now ?? Date.now
  const root = deps.root ?? ANTIGRAVITY_DIR
  if (!(await (deps.agyLive ?? defaultAgyLive)().catch(() => false))) return { skip: 'no-agy' }
  const cred = antigravityAccessToken(await (deps.readToken ?? ((r: string) => readFile(tokenFile(r), 'utf8').catch(() => null)))(root), now())
  if ('skip' in cred) return cred
  const projectId = ((await (deps.readProjectId ?? ((r: string) => readFile(projectFile(r), 'utf8').catch(() => null)))(root)) ?? '').trim()
  if (!projectId) return { skip: 'no-project' }
  const host = ANTIGRAVITY_HOSTS[cred.method]
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(`${host}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectId }),
      signal: AbortSignal.timeout(5000),
    })
  } catch { return { skip: 'network' } }
  if (res.status === 429) return { skip: 'rate-limited' }
  if (!res.ok) return { skip: 'http' } // incl. 401/403: no retry storm, the next tick tries again
  let body: unknown
  try { body = await res.json() } catch { return { skip: 'unparseable' } }
  const limits = parseAntigravityModels(body, now())
  if (!limits) return { skip: 'unparseable' }
  const plan = await planLabelOf(host, root, cred.token, projectId, deps, now())
  return { limits: plan ? { ...limits, plan } : limits }
}

/**
 * The server's poll: now, then every 5 minutes (under `PLAN_LIMITS_STALE_MS`), doubling up to 30 minutes
 * after a 429. `AGENTISTICS_ANTIGRAVITY_USAGE=0` turns it off, as does a team central. Returns the stop function.
 */
export function startAntigravityUsagePoll(deps: AntigravityUsageDeps = {}): () => void {
  if (process.env.AGENTISTICS_ANTIGRAVITY_USAGE === '0' || TEAM_CENTRAL) return () => {}
  let delay = ANTIGRAVITY_USAGE_POLL_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const ingest = deps.ingest ?? ((l: PlanLimits, root: string | null) => ingestFromRoot(l, root))
  const tick = async (): Promise<void> => {
    let limited = false
    const extra = await (deps.accountRoots?.() ?? Promise.resolve([])).catch(() => [] as string[])
    for (const root of [null, ...extra]) {
      const r = await fetchAntigravityUsage(root === null ? deps : { ...deps, root }).catch((): AntigravityResult => ({ skip: 'network' }))
      if ('limits' in r) await ingest(r.limits, root).catch(() => false)
      if ('skip' in r && r.skip === 'rate-limited') limited = true
    }
    delay = limited ? Math.min(MAX_BACKOFF_MS, delay * 2) : ANTIGRAVITY_USAGE_POLL_MS
    if (stopped) return
    timer = setTimeout(() => { void tick() }, delay)
    timer.unref?.()
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
