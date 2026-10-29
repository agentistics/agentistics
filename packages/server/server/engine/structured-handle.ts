/**
 * engine/structured-handle.ts — `host.structuredSessions.get(id)` (engine-api 1.17).
 *
 * An engine surface acts on ONE session: the one it was opened from. The host knows which that is
 * because it accepted the surface's WebSocket handshake for a declared, live session
 * (`engine-sockets.ts`); the engine's word alone is never enough. The only other ids that resolve are
 * sessions this engine started itself (`markEngineOpened`). Everything else answers `null`, the same
 * for "unknown" and "somebody else's", and there is no way to list.
 *
 * The handle exposes three verbs and nothing else:
 *  - `follow` — the chat seam of that session;
 *  - `send` — a turn typed with an `[from agentistics · surface]` header, so a conversation never shows
 *    it as the owner's words (`parseInjectedHeader` makes the same call for every reader);
 *  - `cancel` — the turn in flight, nothing else.
 * It is invalidated when every surface socket it was handed out for has closed (the surface unmounted),
 * and when the session ends. A dead handle stays dead and does nothing.
 */
import type { EngineStructuredSessions, HarnessChat, HarnessChatDelta, StructuredSessionHandle } from '@agentistics/engine-api'
import type { SessionBackend } from '../sessions/types'
import { surfaceSockets, type EngineSocketEntry } from './engine-sockets'

/** The header every surface turn opens with — the parser in core classifies it as not the owner's. */
export const SURFACE_TURN_HEADER = '[from agentistics · surface]'

const engineOpened = new Set<string>()

/** A session this engine started itself: its handle needs no surface, only a living session. */
export function markEngineOpened(id: string): void { engineOpened.add(id) }
export function forgetEngineOpened(id: string): void { engineOpened.delete(id) }
/** Tests only. */
export function resetEngineOpenedForTests(): void { engineOpened.clear() }

export interface HandleDeps {
  backend(): Promise<Pick<SessionBackend, 'chatOf' | 'sendText' | 'cancelTurn' | 'isStructured' | 'attentionOf' | 'activityOf'>>
  /** Is the session still running? Judged against the registry, never the engine's say-so. */
  alive(id: string): Promise<boolean>
  /** The surfaces mounted for a session now. Defaults to the host's open engine sockets. */
  surfaces?: (id: string) => readonly Pick<EngineSocketEntry, 'closed'>[]
}

const NOOP = () => {}

export function createStructuredSessions(d: HandleDeps): EngineStructuredSessions {
  const surfaces = d.surfaces ?? surfaceSockets
  return {
    get(id) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null
      const bound = [...surfaces(id)]
      const owned = engineOpened.has(id)
      if (bound.length === 0 && !owned) return null

      let ended = false
      const valid = () => !ended && (owned || bound.some(e => !e.closed))
      // The session ending invalidates for good; checked lazily on use and eagerly by `check`.
      const check = async () => {
        if (!valid()) return false
        if (!(await d.alive(id).catch(() => false))) { ended = true; return false }
        return true
      }
      const handle: StructuredSessionHandle = {
        get live() { return valid() },
        follow(max, on) {
          if (!valid()) return NOOP
          let off: () => void = NOOP
          let stopped = false
          void (async () => {
            if (!(await check())) return
            const b = await d.backend().catch(() => null)
            const c = b?.chatOf?.(id)
            if (!c || stopped || !valid()) return
            const chat: HarnessChat = c.chat
            const src = await chat.resolve({ conversationId: c.conversationId }).catch(() => null)
            if (!src || stopped || !valid()) return
            off = chat.follow(src, Math.max(1, Math.min(200, Math.floor(max) || 1)), (delta: HarnessChatDelta) => {
              if (!stopped && valid()) on(delta)
            })
          })()
          return () => { stopped = true; off(); off = NOOP }
        },
        async send(text) {
          if (!valid() || typeof text !== 'string' || text.trim().length === 0) return false
          return sendTurn(d, id, text, valid, check)
        },
        async cancel() {
          if (!(await check())) return false
          const b = await d.backend().catch(() => null)
          // Only a turn in flight: an idle or waiting session has nothing to cancel.
          if (!b || !valid() || b.activityOf?.(id) !== 'working') return false
          return b.cancelTurn?.(id) ?? false
        },
      }
      return Object.freeze(handle)
    },
  }
}

async function sendTurn(d: HandleDeps, id: string, text: string, valid: () => boolean, check: () => Promise<boolean>): Promise<boolean> {
  if (!(await check())) return false
  const b = await d.backend().catch(() => null)
  if (!b || !valid()) return false
  // Structured sessions only: a tmux fallback would type keystrokes into a pane, which is not this door.
  if (!b.isStructured?.(id) || !b.chatOf?.(id)) return false
  // A request is open: a turn now would race the answer the person is being asked for.
  if (b.attentionOf?.(id)) return false
  return b.sendText(id, `${SURFACE_TURN_HEADER}\n${text}`)
}
