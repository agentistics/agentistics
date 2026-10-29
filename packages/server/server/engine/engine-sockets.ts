/**
 * engine/engine-sockets.ts — the host's bookkeeping for WebSockets an engine route accepted.
 *
 * The engine decides WHAT a socket says; the host decides everything about its existence: whether it
 * may open at all (the caller has already run the guard, auth, Host and origin gates), how many may be
 * open per route and per session, how big a frame may be, and when it is closed — when the session it
 * declared ends, and when the engine is shut down. A socket that breaks a rule is closed, never
 * repaired.
 */
import {
  ENGINE_SOCKET_LIMITS,
  frameCap,
  type EngineSocket,
  type EngineSocketHandlers,
} from '@agentistics/engine-api'

/** WebSocket close codes the host uses. */
export const CLOSE = { tooBig: 1009, going: 1001, policy: 1008, sessionEnded: 4001 } as const

/** What the host's real socket offers, structurally. */
export interface RawSocket {
  send(data: string | Uint8Array): unknown
  close(code?: number, reason?: string): unknown
}

export interface EngineSocketEntry {
  readonly route: string
  readonly sessionId: string | undefined
  readonly cap: number
  readonly handlers: EngineSocketHandlers
  readonly raw: RawSocket
  readonly api: EngineSocket
  closed: boolean
}

const open = new Set<EngineSocketEntry>()

export type Admission = { ok: true } | { ok: false; reason: 'route-full' | 'session-full' }

/** PURE-ish. Would one more connection on `route` for `sessionId` be within the ceilings? */
export function admit(route: string, sessionId: string | undefined, entries: Iterable<{ route: string; sessionId: string | undefined }> = open): Admission {
  let perRoute = 0
  let perSession = 0
  for (const e of entries) {
    if (e.route === route) perRoute++
    if (sessionId !== undefined && e.sessionId === sessionId) perSession++
  }
  if (perRoute >= ENGINE_SOCKET_LIMITS.perRoute) return { ok: false, reason: 'route-full' }
  if (perSession >= ENGINE_SOCKET_LIMITS.perSession) return { ok: false, reason: 'session-full' }
  return { ok: true }
}

export type UpgradeRefusal =
  | { status: 404; error: 'not_found' }
  | { status: 403; error: 'forbidden_origin' }
  | { status: 503; error: 'too_many_streams'; reason: 'route-full' | 'session-full' }

/**
 * PURE. The handshake decision for an engine route, AFTER the capability guard, the auth gate and the
 * Host allowlist (all of which ran upstream and cannot be reached around: this path is only taken
 * from inside the reserved-prefix block). `null` = go ahead and upgrade.
 */
export function planEngineUpgrade(i: {
  routeCanUpgrade: boolean
  originOk: boolean
  handlers: EngineSocketHandlers | null
  sessionExists: boolean
  admission: Admission
}): UpgradeRefusal | null {
  if (!i.routeCanUpgrade) return { status: 404, error: 'not_found' }
  if (!i.originOk) return { status: 403, error: 'forbidden_origin' }
  if (!i.handlers) return { status: 404, error: 'not_found' }
  if (i.handlers.sessionId !== undefined && !i.sessionExists) return { status: 404, error: 'not_found' }
  if (!i.admission.ok) return { status: 503, error: 'too_many_streams', reason: i.admission.reason }
  return null
}

export interface EngineSocketState { route: string; handlers: EngineSocketHandlers; entry: EngineSocketEntry | null }

export function openEngineSocket(state: EngineSocketState, raw: RawSocket): void {
  const entry: EngineSocketEntry = {
    route: state.route,
    sessionId: state.handlers.sessionId,
    cap: frameCap(state.handlers.maxFrameBytes),
    handlers: state.handlers,
    raw,
    api: {
      send: d => { if (!entry.closed) raw.send(d) },
      close: (c, r) => { if (!entry.closed) raw.close(c, r) },
    },
    closed: false,
  }
  state.entry = entry
  open.add(entry)
  try { state.handlers.open?.(entry.api) } catch { raw.close(1011, 'engine error') }
}

/** The size of one frame in bytes. */
export function frameBytes(data: string | Uint8Array | ArrayBuffer): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}

export function onEngineSocketMessage(state: EngineSocketState, data: string | Uint8Array | ArrayBuffer | Buffer): void {
  const entry = state.entry
  if (!entry || entry.closed) return
  if (frameBytes(data) > entry.cap) { entry.raw.close(CLOSE.tooBig, 'frame too large'); return }
  const payload = typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer)
  try { entry.handlers.message(entry.api, payload) } catch { entry.raw.close(1011, 'engine error') }
}

export function closeEngineSocket(state: EngineSocketState, code: number, reason: string): void {
  const entry = state.entry
  if (!entry || entry.closed) return
  entry.closed = true
  open.delete(entry)
  try { entry.handlers.close?.(code, reason) } catch { /* the socket is gone either way */ }
}

export function closeAllEngineSockets(reason: string): void {
  for (const e of [...open]) e.raw.close(CLOSE.going, reason)
}

/** Close every socket whose declared session is no longer alive. Returns how many were closed. */
export async function sweepEndedSessions(alive: (sessionId: string) => Promise<boolean>): Promise<number> {
  let n = 0
  const ids = new Set<string>()
  for (const e of open) if (e.sessionId !== undefined) ids.add(e.sessionId)
  for (const id of ids) {
    if (await alive(id)) continue
    for (const e of [...open]) if (e.sessionId === id) { e.raw.close(CLOSE.sessionEnded, 'session ended'); n++ }
  }
  return n
}

/**
 * The open sockets that declared `sessionId`: the surfaces mounted for that session right now. The host
 * validated the id when it accepted the handshake, so this is the one authenticated statement of "which
 * session this surface was opened from".
 */
export function surfaceSockets(sessionId: string): EngineSocketEntry[] {
  return [...open].filter(e => e.sessionId === sessionId && !e.closed)
}

export function engineSocketCount(): number { return open.size }

/** Tests only. */
export function resetEngineSocketsForTests(): void { open.clear() }

let sweeper: ReturnType<typeof setInterval> | null = null
/** Starts the (single) liveness sweep; idempotent. */
export function startEngineSocketSweep(alive: (sessionId: string) => Promise<boolean>, everyMs = 5000): void {
  if (sweeper) return
  sweeper = setInterval(() => { void sweepEndedSessions(alive).catch(() => {}) }, everyMs)
  ;(sweeper as { unref?: () => void }).unref?.()
}
