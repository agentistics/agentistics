/**
 * browser-web.ts — the server's ONE browser host and the `/api/browser/*` door (NAVEGADOR S1 + S2).
 *
 * The MCP (`agentistics_browser_*`) and, from S5 on, the web read and drive the SAME host through these
 * routes — never a second instance, never a second set of rules. `/api/browser` is a `localShell`
 * prefix in `capability-guard.ts` (an exposed profile refuses it before authentication) and
 * `browser-gate.ts`'s `browserAllowed` is applied in `index.ts` before this module is reached.
 *
 * Routes (S2):
 * - `GET  /api/browser/status` — the host's snapshot (read-only, sanitised URLs and titles).
 * - `POST /api/browser/session/<action>` — the model's verbs. Needs the MCP's HMAC session proof in
 *   `body.session`; the browser driven is THAT session's and nothing in the body can name another.
 * - `POST /api/browser/personal/<action>` — the person's own browser; refused to any request carrying a
 *   session identity.
 * Action-level refusals (a blocked URL, a stale ref, a full tab list) are `200 {ok:false, error,
 * sentence}` — an answer the model reads; auth / validation / a browser that could not start are 4xx/5xx.
 *
 * S3 puts the lock in front of every `action` through `ActionGate` (S2: always proceeds).
 *
 * The host is created lazily (no browser is ever started by the server's boot). The boot only SWEEPS.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readMemory } from '../sessions/memory-probe'
import { ACTION_KIND, ALWAYS_PROCEED, PERSONAL_ACTIONS, isBrowserAction, parseActionArgs, type ActionGate, type BrowserAction } from './browser-action-spec'
import type { ActionHost } from './browser-actions'
import { decideDriver } from './browser-gate'
import { createBrowserHost, type BrowserHost, type StartResult, type StopReason } from './browser-host'
import { ownerKey, type BrowserOwner } from './browser-spec'

let host: BrowserHost | null = null
let exitHooked = false
/** The latest `sessionLive` any caller handed in — the host is a singleton created by whichever caller
 *  came first (the boot sweep has no fleet), so it reads this through a closure instead of a copy. */
let liveFn: BrowserWebOpts['sessionLive'] | undefined

export interface BrowserWebOpts {
  dataDir: string
  agentisticsPorts: readonly number[]
  /** Is this managed session still running? (the fleet hub's last snapshot) — `undefined` = unknown. */
  sessionLive?: (managedId: string) => boolean | undefined
}

export function browserHost(opts: BrowserWebOpts): BrowserHost {
  if (opts.sessionLive) liveFn = opts.sessionLive
  if (host) return host
  host = createBrowserHost({
    dataDir: opts.dataDir,
    agentisticsPorts: opts.agentisticsPorts,
    memAvailable: async () => (await readMemory())?.available ?? null,
    sessionLive: (id) => liveFn?.(id),
    log: (line) => console.log(line),
  })
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', () => { host?.killAllSync() })
  }
  return host
}

/** Boot-time orphan sweep, off the startup path. Does nothing when there was never a browser here. */
export function scheduleBrowserSweep(opts: BrowserWebOpts, delayMs = 5_000): void {
  const t = setTimeout(() => {
    if (!existsSync(join(opts.dataDir, 'browser'))) return
    void browserHost(opts).sweep().catch((e) => console.warn('[browser] sweep failed:', e instanceof Error ? e.message : String(e)))
  }, delayMs)
  ;(t as any).unref?.()
}

/** `GET /api/browser/status` body. */
export async function browserStatusBody(opts: BrowserWebOpts): Promise<unknown> {
  return browserHost(opts).status()
}

// ---------------------------------------------------------------------------------------------------
// The dispatcher — everything a route decides, over a narrow host interface so it is tested with fakes.

export interface RouteHost {
  start(owner: BrowserOwner): Promise<StartResult>
  stop(key: string, reason: StopReason): Promise<void>
  actionHost(key: string): ActionHost | null
  status(): Promise<unknown>
}

export interface RouteDeps {
  host: RouteHost
  verify: (id: unknown, token: unknown) => Promise<string | null>
  run: (h: ActionHost, args: import('./browser-action-spec').ActionArgs) => Promise<Record<string, unknown>>
  gate?: ActionGate
  /** A session that has ended gets no browser (the watcher would stop it on its next tick anyway). */
  sessionLive?: (managedId: string) => boolean | undefined
}

export interface RouteAnswer { status: number; body: unknown }

/** `null` = not a browser route this module serves (the caller answers 404). */
export async function browserRoute(method: string, pathname: string, body: unknown, deps: RouteDeps): Promise<RouteAnswer | null> {
  if (pathname === '/api/browser/status') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 200, body: await deps.host.status() }
  }
  const m = /^\/api\/browser\/(session|personal)\/([a-z_]+)$/.exec(pathname)
  if (!m) return null
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const route = m[1] as 'session' | 'personal'
  const action = m[2]!
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>

  const s = b.session as { id?: unknown; token?: unknown } | undefined
  const carriesSession = s !== undefined && s !== null
  const verifiedId = route === 'session' && s && typeof s === 'object' ? await deps.verify(s.id, s.token) : null
  const who = decideDriver({ route, carriesSession, verifiedId })
  if (!who.ok) return { status: who.status, body: { ok: false, error: who.error, sentence: who.sentence } }

  if (!isBrowserAction(action) || (route === 'personal' && !PERSONAL_ACTIONS.includes(action))) {
    return { status: 404, body: { ok: false, error: 'unknown_action', sentence: `No browser action "${action.slice(0, 40)}".` } }
  }
  const parsed = parseActionArgs(action, b)
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error, sentence: parsed.sentence } }

  const owner = who.owner
  if (owner.kind === 'session' && deps.sessionLive?.(owner.managedId) === false) {
    return { status: 403, body: { ok: false, error: 'session_not_running', sentence: 'This session is not running, so it cannot use a browser.' } }
  }
  const key = ownerKey(owner)
  if (ACTION_KIND[action] === 'action') {
    // S3: the lock decides here (held / refused / proceed). S2 always proceeds.
    const g = await (deps.gate ?? ALWAYS_PROCEED)(key, action)
    if (!g.proceed) return { status: 200, body: g.result }
  }

  if (action === 'close') {
    const live = deps.host.actionHost(key) !== null
    if (live) await deps.host.stop(key, 'requested')
    return { status: 200, body: { ok: true, closed: live, sentence: live ? 'The browser of this session was closed.' : 'This session had no browser open.' } }
  }
  let h = deps.host.actionHost(key)
  if (!h && action === 'tabs') return { status: 200, body: { ok: true, live: false, tabs: [] } }
  if (!h) {
    const started = await deps.host.start(owner)
    if (!started.ok) {
      const status = started.reason === 'invalid-owner' ? 400 : started.reason === 'no-executable' ? 501 : 503
      return { status, body: { ok: false, error: started.reason, sentence: started.sentence } }
    }
    h = deps.host.actionHost(key)
    if (!h) return { status: 503, body: { ok: false, error: 'start-failed', sentence: 'The browser could not be started.' } }
  }
  return { status: 200, body: await deps.run(h, parsed.args) }
}

/** Wire the dispatcher to the real host. */
export function browserRouteDeps(opts: BrowserWebOpts, verify: RouteDeps['verify'], gate?: ActionGate): RouteDeps {
  const h = browserHost(opts)
  return {
    host: h,
    verify,
    gate,
    sessionLive: opts.sessionLive,
    run: async (ah, args) => {
      const { runAction } = await import('./browser-actions')
      return runAction(ah, args)
    },
  }
}

export type { BrowserAction }
