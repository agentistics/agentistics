/**
 * nay-call.ts — the "call Nay" button, readable and pressable by agents (MCP `agentistics_nay_call`).
 *
 * The voice call is the ENGINE's `composer` surface with the phone icon; it lives in the BROWSER (it is
 * mounted by the web host, with the microphone). This module is the server's mirror of the one button:
 *
 *  - `available` / `surface` come from the same announced-surface list `GET /api/engine` serves, so the
 *    MCP and the button agree on whether a call can be placed (community build, voice kill switch or an
 *    engine without voice → not available, and the pop shows no button either);
 *  - the call's STATE (`active`, `parked`, which session, since when) is what a browser REPORTS from its
 *    mounted-surface store — the very state the top-bar pill reads — with a heartbeat. A report older
 *    than `STALE_MS` is dropped: "no call" is never claimed from a browser that stopped answering;
 *  - `start` records a REQUEST; the browser that next reports receives it in the reply and presses the
 *    same button the person would. With no browser open the request is refused (`no_browser`), never
 *    queued for later: a phone that rings an hour after an agent asked is worse than no call.
 *
 * Who may start: the person's DASHBOARD (a request the browser itself marks same-origin, `dashboardRequest`)
 * or a VERIFIED leader session (`session` proof + stored role) — a worker may not ring the owner, and a
 * direct client that sends neither is refused: OMITTING `session` is never proof of being the person (it
 * was, for one round, and a worker could POST `{}`). Who may REPORT the state: the dashboard only, so a
 * session cannot forge a call or consume a pending start. Reading the state is open to every authenticated
 * caller.
 *
 * Stated limit: `Sec-Fetch-Site`/`Origin` are headers a same-user process can also forge — they separate a
 * browser page from an agent's HTTP client, exactly as `csrf.ts` does; they are not a secret. The leader
 * proof has the same stated limit as every other `session` proof (`session-identity.ts`).
 */
import { vaultRequestAllowed } from './vault/http'

export const STALE_MS = 20_000
/** A start request nobody collected in this long is forgotten. */
export const REQUEST_TTL_MS = 15_000

export interface CallSurfaceRef { id: string; label: { pt: string; en: string } }

/** PURE. The announced surface that places a call: a `composer` surface whose icon is the phone. */
export function callSurfaceFrom(surfaces: readonly { id: string; placement: string; icon?: string; label: { pt: string; en: string } }[]): CallSurfaceRef | null {
  const s = surfaces.find(x => x.placement === 'composer' && x.icon === 'phone')
  return s ? { id: s.id, label: { ...s.label } } : null
}

export interface CallReport {
  active: boolean
  parked: boolean
  sessionId: string | null
  /** Epoch ms the call began (the pill's timer), when the surface said. */
  since: number | null
  at: number
}

export interface NayCallStore {
  report: CallReport | null
  /** When a start was asked for, or null. */
  requestedAt: number | null
}

export const newNayCallStore = (): NayCallStore => ({ report: null, requestedAt: null })

let singleton: NayCallStore | null = null
/** The process's one store (the server holds one machine's state). */
export const nayCallStore = (): NayCallStore => (singleton ??= newNayCallStore())

/** PURE. A browser's report, validated; anything malformed is `null` (and ignored). */
export function parseReport(body: unknown, now: number): CallReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (typeof b.active !== 'boolean') return null
  const sessionId = typeof b.sessionId === 'string' && b.sessionId.length > 0 && b.sessionId.length <= 128 ? b.sessionId : null
  const since = typeof b.since === 'number' && Number.isFinite(b.since) && b.since >= 0 ? b.since : null
  return { active: b.active, parked: b.active && b.parked === true, sessionId: b.active ? sessionId : null, since: b.active ? since : null, at: now }
}

export interface NayCallView {
  available: boolean
  surface: CallSurfaceRef | null
  /** A browser answered in the last `STALE_MS`: the state below is a statement, not a guess. */
  browser: boolean
  /** `null` when no browser is reporting: the state is unknown, never "no call". */
  call: { active: boolean; parked: boolean; sessionId: string | null; since: number | null } | null
  /** A start was asked for and no browser has collected it yet. */
  startRequested: boolean
}

export function callView(store: NayCallStore, surface: CallSurfaceRef | null, now: number): NayCallView {
  const fresh = store.report !== null && now - store.report.at <= STALE_MS
  const r = fresh ? store.report : null
  return {
    available: surface !== null,
    surface,
    browser: fresh,
    call: r ? { active: r.active, parked: r.parked, sessionId: r.sessionId, since: r.since } : null,
    startRequested: store.requestedAt !== null && now - store.requestedAt <= REQUEST_TTL_MS,
  }
}

/** A browser reported: store it, and hand back whether a start request is waiting (consuming it). */
export function acceptReport(store: NayCallStore, body: unknown, now: number): { ok: true; start: boolean } | { ok: false; error: 'bad_report' } {
  const r = parseReport(body, now)
  if (!r) return { ok: false, error: 'bad_report' }
  store.report = r
  const waiting = store.requestedAt !== null && now - store.requestedAt <= REQUEST_TTL_MS
  // A call already in progress satisfies the request; there is nothing left to press.
  // A PARKED call is handed back to like an idle one: "back to the call" is the same button the person presses.
  const start = waiting && (!r.active || r.parked)
  if (store.requestedAt !== null) store.requestedAt = null
  return { ok: true, start }
}

export type StartError = 'no_voice' | 'no_browser' | 'unverified_sender' | 'leader_only' | 'bad_request'
export type StartReply =
  | { ok: true; already: boolean; view: NayCallView }
  | { ok: false; error: StartError }

export interface StartDeps {
  verify: (id: unknown, token: unknown) => Promise<string | null>
  roleOf: (managedId: string) => Promise<'leader' | 'worker' | undefined>
  now: () => number
  /** The request is the person's dashboard (`dashboardRequest`). */
  dashboard: boolean
}

export async function requestStart(store: NayCallStore, surface: CallSurfaceRef | null, body: unknown, deps: StartDeps): Promise<StartReply> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_request' }
  const o = body as { session?: { id?: unknown; token?: unknown } }
  if (o.session !== undefined) {
    // An agent: a verified LEADER only. A claimed session never falls back to the dashboard branch.
    const sender = await deps.verify(o.session?.id, o.session?.token)
    if (!sender) return { ok: false, error: 'unverified_sender' }
    if ((await deps.roleOf(sender)) !== 'leader') return { ok: false, error: 'leader_only' }
  } else if (!deps.dashboard) {
    // No session proof AND not the dashboard: a direct client with nothing to show.
    return { ok: false, error: 'unverified_sender' }
  }
  const now = deps.now()
  const view = callView(store, surface, now)
  if (!view.available) return { ok: false, error: 'no_voice' }
  if (!view.browser) return { ok: false, error: 'no_browser' }
  // A call on screen is `already`; a PARKED one is returned to, like the button ("Voltar à ligação").
  if (view.call?.active && !view.call.parked) return { ok: true, already: true, view }
  store.requestedAt = now
  return { ok: true, already: false, view: callView(store, surface, now) }
}

export function startStatus(r: StartReply | { ok: false; error: 'bad_report' }): number {
  if (r.ok) return 200
  return r.error === 'unverified_sender' ? 401 : r.error === 'leader_only' ? 403 : r.error === 'bad_report' || r.error === 'bad_request' ? 400 : 409
}

/** The per-request facts `dashboardRequest` reads (the server's own host and allowed origins). */
export interface OriginCtx { host: string; allowlist: string[]; dev: boolean }

/**
 * PURE. Did this request come from a page of the dashboard? It is EXACTLY the vault's predicate
 * (`vaultRequestAllowed`, `vault/http.ts`), not a variant: `Content-Type: application/json` required, and
 * `Sec-Fetch-Site: same-origin` (or, only when that header is absent, an `Origin` that is this host / allowlisted).
 * Every other `Sec-Fetch-Site` value (`same-site`, `cross-site`, `none`) is refused.
 *
 * ACCEPTED THREAT MODEL, the same as the vault's: this is browser provenance, not authentication. A local
 * process of the same user that forges `Sec-Fetch-Site`/`Origin` passes here exactly as it passes there.
 * What it stops is a web page (cross-site, text/plain "simple" POSTs) and a client sending neither header.
 * Only for non-GET requests (the predicate waves GET through; the two callers are PUT and POST).
 */
export function dashboardRequest(req: { method: string; headers: Headers }, ctx: OriginCtx): boolean {
  return vaultRequestAllowed(req, ctx.host, { allowlist: ctx.allowlist, dev: ctx.dev }).ok
}

const dashboardOf = (req: Request, ctx: OriginCtx): boolean => dashboardRequest(req, ctx)

/** A state report is a few fields; anything bigger is not one. */
export const STATE_MAX_BYTES = 1024
export const START_MAX_BYTES = 2048

async function readSmall(req: Request, max: number): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const { readJsonLimited } = await import('./limits')
  const r = await readJsonLimited<unknown>(req, max)
  if (r.ok) return r
  return { ok: false, status: r.error === 'too_large' ? 413 : 400, error: r.error }
}

/** PUT /api/nay-call/state — the dashboard only. Returns `{ body, status }`. */
export async function handleStateWrite(req: Request, store: NayCallStore, ctx: OriginCtx, now: number): Promise<{ body: unknown; status: number }> {
  if (!dashboardOf(req, ctx)) return { body: { ok: false, error: 'not_dashboard' }, status: 403 }
  const read = await readSmall(req, STATE_MAX_BYTES)
  if (!read.ok) return { body: { ok: false, error: read.error }, status: read.status }
  const out = acceptReport(store, read.value, now)
  return { body: out, status: out.ok ? 200 : 400 }
}

/** POST /api/nay-call/start — the dashboard, or a verified leader session. */
export async function handleStart(req: Request, store: NayCallStore, surface: CallSurfaceRef | null, ctx: OriginCtx, deps: Omit<StartDeps, 'dashboard'>): Promise<{ body: unknown; status: number }> {
  const read = await readSmall(req, START_MAX_BYTES)
  if (!read.ok) return { body: { ok: false, error: read.status === 413 ? 'too_large' : 'bad_request' }, status: read.status }
  const out = await requestStart(store, surface, read.value, { ...deps, dashboard: dashboardOf(req, ctx) })
  return { body: out, status: startStatus(out) }
}
