/**
 * chatSearchBridge.ts — how the "Buscar na conversa" panel reaches the CHAT beside it.
 *
 * The panel and `SessionChat` are siblings in the layout, and the panel can sit on the rail, in the
 * bottom band or in a floating window — so there is no prop path between them, and building one
 * would thread a callback through every place a panel can be docked. Instead the chat REGISTERS
 * itself for its session while it is mounted, and the panel asks by session id. Two verbs, both the
 * chat's own: GO TO a message (its turn window + `goToTurn`'s flash) and FORWARD one (its own
 * forward modal, `chatForward.ts`). Nothing is duplicated; the panel only says which message.
 *
 * The answer is SYNCHRONOUS and says what happened, because the panel must say it in words:
 * `no-chat` (the chat is not on screen — the terminal view, a phone on another tab) and
 * `not-loaded` (the message is older than the part of the conversation the chat holds) are
 * different sentences, and neither may be a click that silently does nothing.
 */

export interface ChatSearchTurnRef {
  role: 'user' | 'assistant'
  text: string
  at?: string
}

export type ChatSearchRequest =
  | { kind: 'goto'; turn: ChatSearchTurnRef }
  | { kind: 'forward'; turn: ChatSearchTurnRef }

export type ChatSearchOutcome = 'done' | 'not-loaded' | 'no-chat'

type Handler = (req: ChatSearchRequest) => ChatSearchOutcome

/** Per session, the chats currently showing it — the most recently mounted answers. */
const targets = new Map<string, Handler[]>()

export function registerChatSearchTarget(sessionId: string, handler: Handler): () => void {
  const list = targets.get(sessionId) ?? []
  list.push(handler)
  targets.set(sessionId, list)
  return () => {
    const now = (targets.get(sessionId) ?? []).filter(h => h !== handler)
    if (now.length === 0) targets.delete(sessionId)
    else targets.set(sessionId, now)
  }
}

export function requestChatSearch(sessionId: string, req: ChatSearchRequest): ChatSearchOutcome {
  const list = targets.get(sessionId)
  const handler = list?.[list.length - 1]
  return handler ? handler(req) : 'no-chat'
}

/**
 * Which of the chat's turns a search hit names. The hit carries the whole message, its role and
 * its instant — the same three facts the chat's own identity (`chatForward.turnKey`) is built from —
 * so the match is exact. Two identical messages at the same instant are indistinguishable to a
 * reader too; the NEWEST is taken, as the search lists newest first.
 */
export function findTurnIndex(turns: readonly ChatSearchTurnRef[], ref: ChatSearchTurnRef): number {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const want = norm(ref.text)
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.role !== ref.role) continue
    if (ref.at !== undefined && t.at !== undefined && t.at !== ref.at) continue
    if (norm(t.text) === want) return i
  }
  return -1
}
