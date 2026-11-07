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
 * Who may start: the person (a browser/CLI call, no `session` field) or a VERIFIED leader session — a
 * worker may not ring the owner. Reading the state is open to every authenticated caller.
 */

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
  const start = waiting && !r.active
  if (store.requestedAt !== null) store.requestedAt = null
  return { ok: true, start }
}

export type StartError = 'no_voice' | 'no_browser' | 'unverified_sender' | 'leader_only'
export type StartReply =
  | { ok: true; already: boolean; view: NayCallView }
  | { ok: false; error: StartError }

export interface StartDeps {
  verify: (id: unknown, token: unknown) => Promise<string | null>
  roleOf: (managedId: string) => Promise<'leader' | 'worker' | undefined>
  now: () => number
}

export async function requestStart(store: NayCallStore, surface: CallSurfaceRef | null, body: unknown, deps: StartDeps): Promise<StartReply> {
  const o = (body && typeof body === 'object' ? body : {}) as { session?: { id?: unknown; token?: unknown } }
  if (o.session !== undefined) {
    const sender = await deps.verify(o.session?.id, o.session?.token)
    if (!sender) return { ok: false, error: 'unverified_sender' }
    if ((await deps.roleOf(sender)) !== 'leader') return { ok: false, error: 'leader_only' }
  }
  const now = deps.now()
  const view = callView(store, surface, now)
  if (!view.available) return { ok: false, error: 'no_voice' }
  if (!view.browser) return { ok: false, error: 'no_browser' }
  if (view.call?.active) return { ok: true, already: true, view }
  store.requestedAt = now
  return { ok: true, already: false, view: callView(store, surface, now) }
}

export function startStatus(r: StartReply | { ok: false; error: 'bad_report' }): number {
  if (r.ok) return 200
  return r.error === 'unverified_sender' ? 401 : r.error === 'leader_only' ? 403 : r.error === 'bad_report' ? 400 : 409
}
