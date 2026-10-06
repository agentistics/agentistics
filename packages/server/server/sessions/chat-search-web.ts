/**
 * chat-search-web.ts — `GET /api/fleet/chat-search?id=&q=&offset=&limit=&lang=`: "Buscar na
 * conversa", over the WHOLE transcript of ONE session.
 *
 * NO PARSER OF ITS OWN. The conversation is read by `readSessionChatAll` — the chat view's own core
 * (`chat-web.ts`) with the window lifted — so every harness the chat can read is searchable the day
 * it gains a reader, and every refusal the chat states (no link, no reader, transcript gone) comes
 * back here as the SAME sentence. The matching is `searchChatTurns` in `@agentistics/core`, shared
 * with the web's search of a native session.
 *
 * READ ONLY, and scoped to one session by its id against the machine's own fleet — an id the fleet
 * does not list answers the chat's "no longer on this machine", never someone else's conversation.
 * It rides the `/api/fleet` prefix in `capability-guard.ts`, like every fleet route.
 *
 * THE PARSE IS MEMOIZED ON THE FILE'S STAT. The panel searches as the reader types (debounced on
 * the client), and a long Claude transcript is tens of megabytes: re-parsing it per keystroke would
 * spend a second of CPU on every letter. The memo is keyed on (path, mtime, size), so a conversation
 * that moved on is re-read and an unchanged one is not; it is small (`MEMO_MAX`) because one entry
 * can be a whole conversation's turns. The memo holds the READER's answer only — the rewind cut and
 * the vault scrub still run on every request, inside `readSessionChatAll`, exactly as for the chat.
 */

import { stat } from 'node:fs/promises'
import { CHAT_SEARCH_PAGE, searchChatTurns, type ChatSearchPage } from '@agentistics/core'
import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { readSessionChatAll } from './chat-web'
import { transcriptReaderFor, type HarnessTranscript, type TranscriptRead } from './harness-transcript'

export interface ChatSearchAnswer extends ChatSearchPage {
  /** The session's harness, so the panel can name who said each assistant message. */
  harness?: string
  /** Already-localized: why nothing could be searched (the chat's own sentence). */
  unavailable?: string
}

const MEMO_MAX = 3
const memo = new Map<string, TranscriptRead>()

/** A reader whose full read is memoized on the file's stat — see the header. */
function memoized(reader: HarnessTranscript): HarnessTranscript {
  return {
    ...reader,
    async read(path, max) {
      const st = await stat(path).catch(() => null)
      const key = st ? `${path}\0${st.mtimeMs}\0${st.size}\0${max}` : null
      const hit = key ? memo.get(key) : undefined
      if (hit) {
        memo.delete(key!)
        memo.set(key!, hit)
        // A fresh record each time: the caller REASSIGNS `turns` (rewind cut, vault scrub), and
        // that must never write into the memo's copy.
        return { turns: hit.turns, older: hit.older }
      }
      const read = await reader.read(path, max)
      if (key) {
        memo.set(key, { turns: read.turns, older: read.older })
        while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!)
      }
      return read
    },
  }
}

const memoizedReaderFor: typeof transcriptReaderFor = harness => {
  const r = transcriptReaderFor(harness)
  return r ? memoized(r) : null
}

/** Forget every memoized read — tests only. */
export function forgetChatSearchMemo(): void { memo.clear() }

export async function searchSessionChat(
  host: StartHost,
  lang: CliLang,
  id: string,
  query: string,
  page: { offset?: number; limit?: number } = {},
  readerFor: typeof transcriptReaderFor = memoizedReaderFor,
): Promise<ChatSearchAnswer> {
  // A refused query costs no read at all.
  const refused = searchChatTurns([], query, page)
  if (refused.tooShort) return refused
  let harness: string | undefined
  const payload = await readSessionChatAll(host, lang, id, readerFor, row => { harness = row.harness || undefined })
  const found = searchChatTurns(payload.turns, query, { limit: CHAT_SEARCH_PAGE, ...page })
  return {
    ...found,
    ...(harness ? { harness } : {}),
    ...(payload.unavailable ? { unavailable: payload.unavailable } : {}),
  }
}
