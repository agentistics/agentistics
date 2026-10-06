/**
 * chatSearchApi.ts — where "Buscar na conversa" gets its answer.
 *
 * Every CLI harness: `GET /api/fleet/chat-search` (the server reads the whole transcript with the
 * chat's own readers — `chat-search-web.ts`). A NATIVE session has no transcript on this server's
 * disk — its conversation is the engine's store — so its pages are walked through the engine's own
 * `messages` route, shaped by the chat's own native pipeline (`nativeChatTurns`), and searched by
 * the SAME `searchChatTurns`. One matcher, two ways of reading.
 */

import { CHAT_SEARCH_PAGE, searchChatTurns, type ChatSearchPage } from '@agentistics/core'
import { isNativeSessionId } from './sessionRoute'
import { INITIAL_NATIVE_CHAT, nativeChatItems, nativeChatReducer, type NativeWindow } from './nativeChat'
import { nativeChatTurns } from './nativeChatSource'
import { NATIVE_HARNESS_ID, windowPageUrl } from './nativeSession'

export interface ChatSearchResult extends ChatSearchPage {
  harness?: string
  unavailable?: string
}

export type ChatSearchFetch =
  | { ok: true; result: ChatSearchResult }
  | { ok: false; text: string }

/** How many native pages (of 200 messages) one search walks at most. */
const NATIVE_PAGE_CAP = 50

/** The native conversation's messages, oldest first, every page of them (up to the cap). */
export async function nativeConversation(sessionId: string, get: typeof fetch = fetch): Promise<NativeWindow['messages'] | null> {
  let before: number | undefined
  const pages: NativeWindow['messages'][] = []
  for (let n = 0; n < NATIVE_PAGE_CAP; n++) {
    const res = await get(windowPageUrl(sessionId, before))
    if (!res.ok) return pages.length > 0 ? pages.reverse().flat() : null
    const w = await res.json() as NativeWindow
    const messages = w.messages ?? []
    pages.push(messages)
    const next = w.nextBefore
    // A cursor that does not move would walk forever; stop on it as on the end.
    if (next === undefined || next === before || messages.length === 0) break
    before = next
  }
  return pages.reverse().flat()
}

export async function fetchChatSearch(
  sessionId: string,
  query: string,
  lang: 'pt' | 'en',
  offset = 0,
  get: typeof fetch = fetch,
): Promise<ChatSearchFetch> {
  const pt = lang === 'pt'
  const failed = pt ? 'A busca não respondeu. Tente de novo.' : 'The search did not answer. Try again.'
  try {
    if (isNativeSessionId(sessionId)) {
      const messages = await nativeConversation(sessionId, get)
      if (messages === null) return { ok: false, text: failed }
      const window = { session: { sessionId, model: '', provider: '', status: '' }, messages } as NativeWindow
      const turns = nativeChatTurns(nativeChatItems(nativeChatReducer(INITIAL_NATIVE_CHAT, { type: 'window', window })), lang)
      return { ok: true, result: { ...searchChatTurns(turns, query, { offset, limit: CHAT_SEARCH_PAGE }), harness: NATIVE_HARNESS_ID } }
    }
    const qs = new URLSearchParams({ id: sessionId, q: query, lang, offset: String(offset) })
    const res = await get(`/api/fleet/chat-search?${qs}`)
    if (!res.ok) return { ok: false, text: failed }
    return { ok: true, result: await res.json() as ChatSearchResult }
  } catch {
    return { ok: false, text: failed }
  }
}
