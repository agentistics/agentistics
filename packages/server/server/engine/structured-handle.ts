/**
 * engine/structured-handle.ts — a surface's handle on a session (engine-api 1.17).
 *
 * An engine surface acts on ONE session: the one its WebSocket was opened for. The host knows which that
 * is because it accepted the handshake for a declared, live session (`engine-sockets.ts`), so the handle
 * is handed out BY THE SOCKET (`EngineSocket.structured`) and bound to that socket's entry — an id the
 * engine supplies never selects the session. The one id-taking door, `host.structuredSessions.get`,
 * resolves only sessions this engine started itself (`markEngineOpened`) and answers `null` for the rest.
 *
 * 1.21 (ADAPTER.LIMITES E7) adds the keyed members — `submit` / `amend` (typed with the same header), `cancelRequest`,
 * `requestState`, `limits` — each routed to the session's driver, which runs it exactly-once by its key.
 *
 * The handle exposes three verbs and nothing else:
 *  - `follow` — the chat seam of that session;
 *  - `send` — a turn typed with an `[from agentistics · surface]` header, so a conversation never shows
 *    it as the owner's words (`parseInjectedHeader` makes the same call for every reader);
 *  - `cancel` — the turn in flight, nothing else.
 * It is invalidated when ITS socket closes (not when another surface of the same session does) and when the
 * session ends; a dead handle stays dead and releases its subscriptions. Every method is total.
 *
 * Who may open a socket for a session is the host's gate: `/api/engine/x` is `localShell`, refused on a
 * central and on any exposed profile, so a socket exists only for the machine's own, authenticated owner.
 */
import { ENGINE_SOCKET_LIMITS, validIdempotencyKey, type EngineStructuredSessions, type HarnessChat, type HarnessChatDelta, type StructuredSessionHandle } from '@agentistics/engine-api'
import type { SessionBackend } from '../sessions/types'
import type { EngineSocketEntry } from './engine-sockets'

/** The header every surface turn opens with — the parser in core classifies it as not the owner's. */
export const SURFACE_TURN_HEADER = '[from agentistics · surface]'
/** A turn's text, in bytes: the same ceiling a socket frame has. */
export const MAX_SURFACE_TURN_BYTES = ENGINE_SOCKET_LIMITS.maxFrameBytes
const MAX_ENGINE_OPENED = 1000

const engineOpened = new Set<string>()

/** A session this engine started itself: `get(id)` resolves it while it lives. */
export function markEngineOpened(id: string): void {
  engineOpened.add(id)
  if (engineOpened.size > MAX_ENGINE_OPENED) { const first = engineOpened.values().next().value; if (first !== undefined) engineOpened.delete(first) }
}
export function forgetEngineOpened(id: string): void { engineOpened.delete(id) }
/** Tests only. */
export function resetEngineOpenedForTests(): void { engineOpened.clear() }

export interface HandleDeps {
  backend(): Promise<Pick<SessionBackend, 'chatOf' | 'sendText' | 'cancelTurn' | 'isStructured' | 'attentionOf' | 'activityOf'
    | 'submitRequest' | 'amendRequest' | 'cancelRequest' | 'requestStateOf' | 'limitsOf'>>
  /** Is the session still running? Judged against the registry, never the engine's say-so. */
  alive(id: string): Promise<boolean>
}

const NOOP = () => {}

/** What a handle is bound to: a session, and the thing whose end ends the handle. */
interface Binding { id: string; open(): boolean; owned: boolean }

interface Internal { handle: StructuredSessionHandle; kill(): void }
const bySocket = new WeakMap<object, Internal>()

function makeHandle(d: HandleDeps, b: Binding): Internal {
  let ended = false
  const offs = new Set<() => void>()
  const kill = () => {
    ended = true
    for (const off of [...offs]) { try { off() } catch { /* a subscription that will not close */ } }
    offs.clear()
    if (b.owned) forgetEngineOpened(b.id)
  }
  const valid = () => {
    if (!ended && !b.open()) kill()
    return !ended
  }
  const check = async () => {
    if (!valid()) return false
    let alive: boolean
    try { alive = await d.alive(b.id) } catch { return false } // unknown: refuse this use, but do not end the handle
    if (!alive) kill()
    return valid()
  }
  const backend = async () => { try { return await d.backend() } catch { return null } }
  const textFits = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= MAX_SURFACE_TURN_BYTES
  /** The backend, when the handle is valid, the session alive and STRUCTURED (a tmux fallback is not this door). */
  const structuredBackend = async () => {
    if (!(await check())) return null
    const be = await backend()
    return be && valid() && be.isStructured?.(b.id) ? be : null
  }

  const handle: StructuredSessionHandle = {
    get live() { return valid() },
    follow(max, on) {
      if (!valid()) return NOOP
      let off: () => void = NOOP
      let stopped = false
      const stop = () => { stopped = true; try { off() } catch { /* gone */ } off = NOOP; offs.delete(stop) }
      offs.add(stop)
      void (async () => {
        try {
          if (!(await check())) return
          const c = (await backend())?.chatOf?.(b.id)
          if (!c || stopped || !valid()) return
          const chat: HarnessChat = c.chat
          const src = await chat.resolve({ conversationId: c.conversationId })
          if (!src || stopped || !valid()) return
          off = chat.follow(src, Math.max(1, Math.min(200, Math.floor(max) || 1)), (delta: HarnessChatDelta) => {
            if (stopped || !valid()) return
            try { on(delta) } catch { /* the engine's callback must not break the chat seam */ }
          })
        } catch { /* a source that cannot be read stays silent */ }
      })()
      return stop
    },
    async send(text) {
      try {
        if (!valid() || typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text) > MAX_SURFACE_TURN_BYTES) return false
        if (!(await check())) return false
        const be = await backend()
        if (!be || !valid()) return false
        // Structured sessions only: a tmux fallback would type keystrokes into a pane, which is not this door.
        if (!be.isStructured?.(b.id) || !be.chatOf?.(b.id)) return false
        // A request is open: a turn now would race the answer the person is being asked for.
        if (be.attentionOf?.(b.id)) return false
        return await be.sendText(b.id, `${SURFACE_TURN_HEADER}\n${text}`)
      } catch { return false }
    },
    // 1.21 (E7) — keyed members, structured sessions only; null = not possible here (invalid handle, not structured, the
    // driver has no such member, or a malformed key / text). The driver decides everything else, with its receipt.
    async submit(r) {
      try {
        if (!r || !textFits(r.text) || typeof r.requestId !== 'string' || !validIdempotencyKey(r.idempotencyKey)) return null
        const be = await structuredBackend()
        return be?.submitRequest ? await be.submitRequest(b.id, { ...r, text: `${SURFACE_TURN_HEADER}\n${r.text}` }) : null
      } catch { return null }
    },
    async amend(requestId, text, key) {
      try {
        if (!textFits(text) || typeof requestId !== 'string' || !validIdempotencyKey(key)) return null
        const be = await structuredBackend()
        return be?.amendRequest ? await be.amendRequest(b.id, requestId, `${SURFACE_TURN_HEADER}\n${text}`, key) : null
      } catch { return null }
    },
    async cancelRequest(requestId, key) {
      try {
        if (typeof requestId !== 'string' || !validIdempotencyKey(key)) return null
        const be = await structuredBackend()
        return be?.cancelRequest ? await be.cancelRequest(b.id, requestId, key) : null
      } catch { return null }
    },
    async requestState(requestId) {
      try {
        if (typeof requestId !== 'string') return null
        const be = await structuredBackend()
        return be?.requestStateOf ? be.requestStateOf(b.id, requestId) : null
      } catch { return null }
    },
    async limits() {
      try {
        if (!(await check())) return null
        const be = await backend()
        return be?.limitsOf && valid() ? be.limitsOf(b.id) : null
      } catch { return null }
    },
    async cancel() {
      try {
        if (!(await check())) return false
        const be = await backend()
        // Only a turn in flight: an idle or waiting session has nothing to cancel.
        if (!be || !valid() || be.activityOf?.(b.id) !== 'working') return false
        return be.cancelTurn?.(b.id) ?? false
      } catch { return false }
    },
  }
  return { handle: Object.freeze(handle), kill }
}

export interface StructuredSessionsHost {
  /** `host.structuredSessions`: engine-started sessions only. */
  engine: EngineStructuredSessions
  /** `EngineSocket.structured` for one accepted socket: its declared session, bound to it. */
  forSocket(entry: Pick<EngineSocketEntry, 'sessionId' | 'closed'>): () => StructuredSessionHandle | null
  /** The socket closed: its handles die and release their subscriptions. */
  socketClosed(entry: object): void
}

export function createStructuredSessions(d: HandleDeps): StructuredSessionsHost {
  return {
    engine: {
      get(id) {
        if (typeof id !== 'string' || !engineOpened.has(id)) return null
        return makeHandle(d, { id, open: () => engineOpened.has(id), owned: true }).handle
      },
    },
    forSocket(entry) {
      return () => {
        const id = entry.sessionId
        if (typeof id !== 'string' || id.length === 0 || entry.closed) return null
        // one handle per socket: asking again returns it, so repeated calls never pile up
        let h = bySocket.get(entry)
        if (!h) bySocket.set(entry, (h = makeHandle(d, { id, open: () => !entry.closed, owned: false })))
        return h.handle
      }
    },
    socketClosed(entry) {
      const h = bySocket.get(entry)
      bySocket.delete(entry)
      h?.kill()
    },
  }
}
