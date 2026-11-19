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
 * S3 — the padlock (`browser-lock.ts`): every verb passes the gate; a session's ACTION is held while the
 * person drives (never executed). `POST /api/browser/lock {owner, lock}` is the person's (any session
 * identity ⇒ 403 `session_cannot_unlock`); `POST /api/browser/session/wait_unlock` waits for the person.
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
import { ownerKey, statusTitle, statusUrl, type BrowserOwner } from './browser-spec'
import type { HarnessId } from '@agentistics/core'
import { decideLockRequest, holdMsFor, ownerProofRefusal, type OwnerProofVerdict, type PageFacts } from './browser-lock'
import { BrowserLocks } from './browser-lock-host'
import { callerRefusal, type CallerVerdict } from './browser-caller'
import { personalDoorRefusal, personalRefusalBody } from './personal-grant'

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
  /** A padlock-less gate (tests; the personal browser). `locks` wins for a session's browser. */
  gate?: ActionGate
  /** S3: the padlock of every session browser. Absent = no padlock (every verb proceeds). */
  locks?: BrowserLocks
  /** S3: the harness of a managed session — its measured tool timeout bounds how long a call is held. */
  harnessOf?: (managedId: string) => HarnessId | undefined
  /** S3: `browser.lock` / `browser.unlock` audit (who, when, which session — never content). */
  audit?: (ev: { action: 'browser.lock' | 'browser.unlock'; managedId: string }) => void
  /** A session that has ended gets no browser (the watcher would stop it on its next tick anyway). */
  sessionLive?: (managedId: string) => boolean | undefined
  /**
   * S4/F1: WHO is on the other end of THIS request, read from the socket (`browser-caller.ts`). The
   * padlock route refuses a session AND a caller it cannot identify; ABSENT = cannot identify = refused
   * (fail-closed — a door wired without the check is a closed door, never an open one).
   */
  caller?: () => CallerVerdict
  /**
   * S4b: spend the person's single-use vault grant for THIS browser (`X-Agentop-Owner-Grant`, minted by
   * `POST /api/vault/browser-unlock`). The proof every unlock owes — the socket check above is only a hint
   * (a session that drops its inheritance looks like the person). ABSENT = no proof possible = refused.
   */
  ownerProof?: (managedId: string) => Promise<OwnerProofVerdict>
  /**
   * S10 r3: does THIS request carry the owner's valid personal-browser grant (`X-Agentop-Personal-Grant`,
   * minted by the vault proof)? The person's own browser answers only to it; ABSENT = no proof = refused.
   */
  personalGrant?: () => boolean
  /** The language of the refusal sentences (the vault's, so one setting speaks everywhere). */
  lang?: () => 'en' | 'pt'
}

export interface RouteAnswer { status: number; body: unknown }

function holdFor(deps: RouteDeps, managedId: string): number {
  return holdMsFor(deps.harnessOf?.(managedId))
}

/** The gate a verb goes through: the padlock for a session's browser, else the padlock-less one. */
function gateFor(deps: RouteDeps, owner: BrowserOwner): ActionGate {
  const locks = deps.locks
  if (owner.kind === 'session' && locks) {
    const holdMs = holdFor(deps, owner.managedId)
    return (key, action, ctx) => locks.gate(key, action, { isRead: ctx?.isRead ?? false, holdMs })
  }
  return deps.gate ?? ALWAYS_PROCEED
}

/** What is on the active tab now — the sentence a returned action carries. */
function pageOf(deps: RouteDeps, key: string): PageFacts | undefined {
  const h = deps.host.actionHost(key)
  if (!h) return undefined
  const t = h.tabs().find(x => x.active) ?? h.tabs()[0]
  return t ? { title: statusTitle(t.title), url: statusUrl(t.url) } : undefined
}

/** Each live SESSION browser in the status carries its padlock (`personal` has none). */
function withLocks(status: unknown, deps: RouteDeps): unknown {
  const locks = deps.locks
  if (!locks || !status || typeof status !== 'object' || !Array.isArray((status as { live?: unknown }).live)) return status
  const s = status as { live: Array<Record<string, unknown>> }
  return {
    ...s,
    live: s.live.map((e) => {
      const o = e.owner as BrowserOwner | undefined
      if (!o || o.kind !== 'session') return e
      return { ...e, lock: locks.view(ownerKey(o)) }
    }),
  }
}

/**
 * S10 r3 F2b: the person's own browser — its tabs (urls, titles) and last action — is shown in the status only
 * to a caller holding the owner's grant. Without it the personal part is omitted (the entry is dropped, so a
 * session cannot even tell whether the person has a browser open).
 */
function withoutPersonal(status: unknown, grantOk: boolean): unknown {
  if (!status || typeof status !== 'object' || !Array.isArray((status as { live?: unknown }).live)) return status
  // `personalAccess` tells the page whether the grant it holds is still good (a restart forgets every grant).
  if (grantOk) return { ...(status as object), personalAccess: true }
  const s = status as { live: Array<Record<string, unknown>>; recentStops?: unknown }
  const isPersonal = (o: unknown) => !!o && typeof o === 'object' && (o as { kind?: unknown }).kind === 'personal'
  const out: Record<string, unknown> = { ...s, personalAccess: false, live: s.live.filter(e => !isPersonal(e.owner)) }
  if (Array.isArray(s.recentStops)) out.recentStops = s.recentStops.filter(e => !isPersonal((e as { owner?: unknown } | null)?.owner) && (e as { key?: unknown } | null)?.key !== 'personal')
  return out
}

/** `POST /api/browser/lock {owner, lock}` — the person's padlock. */
async function lockRoute(body: unknown, deps: RouteDeps): Promise<RouteAnswer> {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const d = decideLockRequest({ carriesSession: b.session !== undefined && b.session !== null, owner: b.owner, lock: b.lock })
  if (!d.ok) return { status: d.status, body: { ok: false, error: d.error, sentence: d.sentence } }
  // F1: the body's word is not enough — a session that omits `session` is still a session. The socket says
  // so when it CAN (a known session is refused outright, whatever it carries). S4b: it cannot always — a
  // detached child with a clean environment looks like the person — so the socket is a hint and the vault
  // proof below is what an unlock owes. An unidentified caller (no /proc, macOS, Windows) is therefore not
  // refused here: locking only reduces exposure, and unlocking still needs the person's proof.
  const caller = deps.caller ? deps.caller() : { kind: 'unknown' as const, reason: 'no-peer' as const }
  if (caller.kind === 'session') {
    const refused = callerRefusal(caller)!
    return { status: refused.status, body: { ok: false, error: refused.error, sentence: refused.sentence } }
  }
  if (!deps.locks) return { status: 501, body: { ok: false, error: 'no_padlock', sentence: 'This build has no browser padlock.' } }
  const key = ownerKey({ kind: 'session', managedId: d.managedId })
  // Unlocking a browser that is not open hands the person nothing; locking is always allowed (and idempotent).
  if (d.mode === 'unlocked' && !deps.host.actionHost(key)) {
    return { status: 409, body: { ok: false, error: 'no_browser', sentence: 'This session has no browser open, so there is nothing to unlock.' } }
  }
  if (d.mode === 'unlocked') {
    // Spent only once the unlock can happen (a 409 above leaves the grant for the retry).
    const proof: OwnerProofVerdict = deps.ownerProof
      ? await deps.ownerProof(d.managedId)
      : ownerProofRefusal('grant-invalid', 'en', false)
    if (!proof.ok) {
      const { ok: _ok, status, ...rest } = proof
      return { status, body: { ok: false, ...rest } }
    }
    // The person may have locked (or the browser closed) while the proof was checked.
    if (!deps.host.actionHost(key)) {
      return { status: 409, body: { ok: false, error: 'no_browser', sentence: 'This session has no browser open, so there is nothing to unlock.' } }
    }
  }
  const r = deps.locks.setLock(key, d.mode, 'person', pageOf(deps, key))
  if (r.changed) deps.audit?.({ action: d.mode === 'locked' ? 'browser.lock' : 'browser.unlock', managedId: d.managedId })
  return { status: 200, body: { ok: true, lock: r.view.mode, changed: r.changed, since: r.view.since } }
}

/** `null` = not a browser route this module serves (the caller answers 404). */
export async function browserRoute(method: string, pathname: string, body: unknown, deps: RouteDeps): Promise<RouteAnswer | null> {
  if (pathname === '/api/browser/status') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 200, body: withoutPersonal(withLocks(await deps.host.status(), deps), deps.personalGrant?.() === true) }
  }
  if (pathname === '/api/browser/lock') {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
    return lockRoute(body, deps)
  }
  const m = /^\/api\/browser\/(session|personal)\/([a-z_]+)$/.exec(pathname)
  if (!m) return null
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const route = m[1] as 'session' | 'personal'
  const action = m[2]!
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>

  // S10/F2: the person's own browser is decided by the SOCKET, never by the body (`session` omitted is still a
  // session). Absent `caller` = cannot identify = refused (fail-closed). Before anything else: not even a 404.
  if (route === 'personal') {
    const refused = personalDoorRefusal({ grantOk: deps.personalGrant?.() === true, caller: deps.caller ? deps.caller() : { kind: 'unknown', reason: 'no-peer' }, lang: deps.lang?.() ?? 'en' })
    if (refused) return { status: refused.status, body: personalRefusalBody(refused) }
  }

  const s = b.session as { id?: unknown; token?: unknown } | undefined
  const carriesSession = s !== undefined && s !== null

  // `wait_unlock` is not a browser verb: it reads the padlock, needs no browser and never starts one.
  if (route === 'session' && action === 'wait_unlock') {
    const verifiedId = s && typeof s === 'object' ? await deps.verify(s.id, s.token) : null
    const who = decideDriver({ route, carriesSession, verifiedId })
    if (!who.ok) return { status: who.status, body: { ok: false, error: who.error, sentence: who.sentence } }
    if (who.owner.kind !== 'session') return null
    if (deps.sessionLive?.(who.owner.managedId) === false) {
      return { status: 403, body: { ok: false, error: 'session_not_running', sentence: 'This session is not running, so it cannot use a browser.' } }
    }
    if (!deps.locks) return { status: 200, body: { ok: true, locked: true, waitedMs: 0, sentence: 'The browser is yours (the padlock is locked; the person is not using it).' } }
    const answer = await deps.locks.waitUnlock(ownerKey(who.owner), b.maxMs, holdFor(deps, who.owner.managedId))
    return { status: 200, body: answer }
  }
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
  // S3: the padlock sees EVERY verb and decides (a read always proceeds; an action is held while the
  // person drives). A held action is never run: its answer is the padlock's.
  const g = await gateFor(deps, owner)(key, action, { isRead: ACTION_KIND[action] === 'read' })
  if (!g.proceed) return { status: 200, body: g.result }

  if (action === 'close') {
    const live = deps.host.actionHost(key) !== null
    if (live) await deps.host.stop(key, 'requested')
    return { status: 200, body: { ok: true, closed: live, sentence: live ? 'The browser of this session was closed.' : 'This session had no browser open.' } }
  }
  let h = deps.host.actionHost(key)
  if (!h && action === 'tabs') return { status: 200, body: { ok: true, live: false, tabs: [] } }
  // A READ never starts a Chromium: there is nothing to read, and "this changes nothing" must be true.
  if (!h && ACTION_KIND[action] === 'read') {
    return { status: 200, body: { ok: false, error: 'no_browser', sentence: 'This session has no browser open yet, so there is nothing to read. Open a page first with agentistics_browser_navigate.' } }
  }
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

// ---------------------------------------------------------------------------------------------------
// The padlock singleton (S3): one per server, beside the one host.

let locks: BrowserLocks | null = null
let autoLockTimer: ReturnType<typeof setInterval> | null = null
const AUTO_LOCK_TICK_MS = 30_000

export function browserLocks(opts: BrowserWebOpts): BrowserLocks {
  if (locks) return locks
  const h = browserHost(opts)
  const l = new BrowserLocks({
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  })
  locks = l
  h.onStopped((key, reason) => l.browserStopped(key, reason))
  // Unlocked and forgotten: 15 min without the person's input and nobody watching closes it by itself.
  autoLockTimer = setInterval(() => {
    if (l.unlockedKeys().length === 0) return
    void h.status().then((st) => {
      const viewers = (key: string) => st.live.find(e => e.key === key)?.viewers ?? 0
      const page = (key: string) => {
        const t = st.live.find(e => e.key === key)?.tabs.find(x => x.active)
        return t ? { title: statusTitle(t.title), url: statusUrl(t.url) } : undefined
      }
      for (const key of l.autoLock(viewers, page)) console.log(`[browser] ${key}: unlocked and unattended for 15 min — locked again`)
    }).catch(() => {})
  }, AUTO_LOCK_TICK_MS)
  ;(autoLockTimer as any).unref?.()
  return l
}

/** Wire the dispatcher to the real host. */
export function browserRouteDeps(
  opts: BrowserWebOpts,
  verify: RouteDeps['verify'],
  extra: { harnessOf?: RouteDeps['harnessOf']; audit?: RouteDeps['audit']; caller?: RouteDeps['caller']; ownerProof?: RouteDeps['ownerProof']; personalGrant?: RouteDeps['personalGrant']; lang?: RouteDeps['lang'] } = {},
): RouteDeps {
  const h = browserHost(opts)
  return {
    host: h,
    verify,
    locks: browserLocks(opts),
    harnessOf: extra.harnessOf,
    audit: extra.audit,
    caller: extra.caller,
    ownerProof: extra.ownerProof,
    personalGrant: extra.personalGrant,
    lang: extra.lang,
    sessionLive: opts.sessionLive,
    run: async (ah, args) => {
      const { runAction } = await import('./browser-actions')
      return runAction(ah, args)
    },
  }
}

export type { BrowserAction }
