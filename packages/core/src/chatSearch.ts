/**
 * chatSearch.ts — PURE: "Buscar na conversa". Which messages of ONE conversation carry a query, and
 * the excerpt each result row shows with the match marked.
 *
 * ONE implementation for every harness. The server runs it over the turns its existing readers
 * (`harness-transcript.ts`) already produce for the chat view — the WHOLE transcript, not the
 * 400-turn chat window — and the web runs it over a native session's own pages. A turn is a turn
 * whoever wrote it, so there is no per-harness rule here and there must never be one.
 *
 * IGNORES CASE AND ACCENTS. A Portuguese reader types `funcao` for `função` and `ACAO` for `ação`;
 * a search that only finds the spelling with the accent is a search that says "nothing" over text
 * that is right there. Folding is per CHARACTER (`foldForSearch`) and keeps a map back to the
 * original offsets, so the highlight lands on the original `função` and never on a normalised copy
 * the reader has never seen.
 *
 * A QUERY TOO SHORT TO MEAN ANYTHING IS REFUSED, not run: one letter matches nearly every message
 * of a long conversation. `tooShort` says so; the panel turns it into a sentence.
 *
 * NEWEST FIRST — the order a person searching a chat expects (what did we say about X LAST), and
 * the order that puts the message most likely still in the loaded window at the top.
 */

/** Below this many characters (after trimming) a query is refused rather than run. */
export const CHAT_SEARCH_MIN_CHARS = 2
/** One page of results. Each hit carries the whole message (copy/forward need it), so not more. */
export const CHAT_SEARCH_PAGE = 40
/** How much of a message a result row shows. */
const EXCERPT_CHARS = 180
/** How much context stays visible BEFORE the first match. */
const EXCERPT_LEAD = 48

/** A turn as this module needs it — every reader's `ChatTurn` satisfies it structurally. */
export interface ChatSearchTurn {
  role: 'user' | 'assistant'
  text: string
  at?: string
  /** A harness note (`chat-envelope.ts`) — not something anybody SAID, so never a result. */
  system?: unknown
}

/** A half-open range `[start, end)` of UTF-16 offsets. */
export interface ChatSearchSpan { start: number; end: number }

export interface ChatSearchHit {
  /** Position in the whole conversation, oldest = 0. Stable for one read of the transcript. */
  index: number
  role: 'user' | 'assistant'
  at?: string
  /** The whole message — what Copy and Forward act on, and what identifies the chat's bubble. */
  text: string
  /** One line of the message around its first match, whitespace collapsed, `…` where cut. */
  excerpt: string
  /** Where the query sits inside `excerpt`. */
  highlights: ChatSearchSpan[]
  /** How many times the query occurs in the whole message. */
  matches: number
}

export interface ChatSearchPage {
  query: string
  /** How many messages matched in total — the page holds at most `CHAT_SEARCH_PAGE` of them. */
  total: number
  offset: number
  hits: ChatSearchHit[]
  /** How many messages were searched — the honest denominator ("in N messages"). */
  scanned: number
  /** The query was refused for being shorter than `CHAT_SEARCH_MIN_CHARS`; nothing was searched. */
  tooShort?: true
}

/**
 * Lower-case and strip combining marks, one ORIGINAL character at a time, keeping where each folded
 * code unit came from. `map[k]` is the original offset of folded unit `k`; `map[folded.length]` is
 * the original length, so an end offset always resolves.
 */
export function foldForSearch(s: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let i = 0
  for (const ch of s) {
    const f = ch.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    for (let k = 0; k < f.length; k++) map.push(i)
    folded += f
    i += ch.length
  }
  map.push(s.length)
  return { folded, map }
}

/** The folded query, or `''` when it is too short to search. */
export function foldQuery(query: string): string {
  const q = foldForSearch(query.trim().replace(/\s+/g, ' ')).folded
  return q.length >= CHAT_SEARCH_MIN_CHARS ? q : ''
}

/** Every non-overlapping occurrence of `q` (already folded) in `text`, in ORIGINAL offsets. */
export function findMatches(text: string, q: string): ChatSearchSpan[] {
  if (q === '') return []
  const { folded, map } = foldForSearch(text)
  const out: ChatSearchSpan[] = []
  let from = 0
  for (;;) {
    const at = folded.indexOf(q, from)
    if (at < 0) break
    out.push({ start: map[at]!, end: map[at + q.length]! })
    from = at + q.length
  }
  return out
}

const isSpace = (c: string): boolean => /\s/.test(c)

/**
 * One line of `text` around its first match, with every match inside it marked.
 *
 * The window leads the match by a little context and is snapped to word boundaries, whitespace runs
 * (newlines included) collapse to one space so a row is one readable line, and a cut end says so
 * with `…`. Highlights are recomputed against the collapsed string — never the raw offsets, which
 * would drift by every collapsed run before them.
 */
export function excerptAround(text: string, matches: readonly ChatSearchSpan[]): { excerpt: string; highlights: ChatSearchSpan[] } {
  const first = matches[0]
  let a = first ? Math.max(0, first.start - EXCERPT_LEAD) : 0
  // Leading whitespace says nothing; skip it before snapping.
  while (a < text.length && isSpace(text[a]!)) a++
  if (a > 0 && first) {
    // Start on a word: the next space before the match, if there is one close enough.
    const sp = text.slice(a, first.start).search(/\s/)
    if (sp >= 0 && sp < 16) a = a + sp + 1
  }
  let b = Math.min(text.length, a + EXCERPT_CHARS)
  if (first && b < first.end) b = Math.min(text.length, first.end + 24)
  if (b < text.length) {
    const back = text.slice(a, b).search(/\s\S*$/)
    if (back > 0 && first && a + back >= first.end) b = a + back
  }
  const lead = a > 0 ? '…' : ''
  let out = lead
  const pos: number[] = []
  for (let i = a; i < b; i++) {
    pos.push(out.length)
    const c = text[i]!
    if (isSpace(c)) {
      if (!out.endsWith(' ') && out !== lead) out += ' '
    } else out += c
  }
  pos.push(out.length)
  const trimmed = out.replace(/\s+$/, '')
  const excerpt = trimmed + (b < text.length ? '…' : '')
  const highlights: ChatSearchSpan[] = []
  for (const m of matches) {
    const s = Math.max(m.start, a)
    const e = Math.min(m.end, b)
    if (e <= s) continue
    const hs = pos[s - a]!
    const he = Math.min(pos[e - a]!, trimmed.length)
    if (he > hs) highlights.push({ start: hs, end: he })
  }
  return { excerpt, highlights }
}

/**
 * Search a conversation. `turns` oldest first (the readers' own order); results newest first,
 * paged by `offset`/`limit`.
 */
export function searchChatTurns(
  turns: readonly ChatSearchTurn[],
  query: string,
  page: { offset?: number; limit?: number } = {},
): ChatSearchPage {
  const offset = Math.max(0, Math.floor(page.offset ?? 0))
  const limit = Math.max(1, Math.min(CHAT_SEARCH_PAGE, Math.floor(page.limit ?? CHAT_SEARCH_PAGE)))
  const q = foldQuery(query)
  const scanned = turns.reduce((n, t) => n + (searchable(t) ? 1 : 0), 0)
  if (q === '') return { query, total: 0, offset, hits: [], scanned, tooShort: true }
  const matching: Array<{ index: number; spans: ChatSearchSpan[] }> = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (!searchable(t)) continue
    const spans = findMatches(t.text, q)
    if (spans.length > 0) matching.push({ index: i, spans })
  }
  const hits = matching.slice(offset, offset + limit).map(({ index, spans }): ChatSearchHit => {
    const t = turns[index]!
    const { excerpt, highlights } = excerptAround(t.text, spans)
    return {
      index, role: t.role, ...(t.at ? { at: t.at } : {}), text: t.text,
      excerpt, highlights, matches: spans.length,
    }
  })
  return { query, total: matching.length, offset, hits, scanned }
}

function searchable(t: ChatSearchTurn): boolean {
  return !t.system && typeof t.text === 'string' && t.text.trim() !== ''
}
