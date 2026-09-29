/**
 * sessionMention.ts — PURE: mentioning ANOTHER SESSION from the composer, with `#`.
 *
 * WHY `#`. The composer's two other triggers are taken and mean something to the harness itself:
 * `/` is the assistant's own command table (`skillMenu.ts`) and `@` is an MCP server reference
 * (`atMenu.ts`). A third meaning on either would make one keystroke do two things.
 *
 * A MENTION IS A POINTER, NOT CONTEXT. It names a session briefly enough that the reader (the
 * assistant) can find it — its title and a short id — and nothing more. Carrying a conversation's
 * CONTENT across is what forwarding is for (`chatForward.ts`); a mention that pasted context would
 * spend the receiving session's window every time somebody merely referred to a neighbour.
 *
 * THE TOKEN IS SELF-CONTAINED. What sits in the draft is `#«Title · 3f5f21a8»` — the chip the
 * mirror paints (`commandMirror.ts`) — and it carries its own id. No side table maps a chip back to
 * a session, so a chip survives everything the draft survives (a reload, `sessionScratch`, a
 * copy-and-paste into another composer) and a chip whose text was edited simply stops being a chip.
 * The id is SHOWN on purpose: it is exactly what will be sent, so the field never promises one
 * reference and delivers another.
 *
 * THE `#` NEVER REACHES THE HARNESS. In Claude Code a message STARTING with `#` is a memory note,
 * not a prompt — so a message opening with a mention would silently be filed as memory and never
 * answered. `expandSessionMentions` rewrites every chip into `«Title» (session 3f5f21a8)` before
 * anything is sent, wherever in the message it sits.
 */

import type { MentionToken } from './mentionTokens'

/** What the picker and the chip need from a fleet row. Structural — `FleetRow` stays the source. */
export interface MentionCandidate {
  id: string
  title: string
  harness: string
  conversationId?: string
  project?: string
  cwd?: string
  task?: string
  /** Already localized by the server — the word the fleet list prints for this row's state. */
  stateLabel?: string
}

/** How many rows the picker lists. It is a pointer, not a browser: a longer query narrows it. */
export const MENTION_LIMIT = 8

/** How many characters of a title the chip keeps. A chip is read inline, inside a sentence. */
export const MENTION_TITLE_MAX = 60

/**
 * The short id a mention carries — eight hex characters, the prefix `agentop session` resolves.
 *
 * A managed row's id IS the managed id (ten hex characters); a `closed:` row is named only by its
 * conversation (see `scratchKey`), so the conversation's own prefix is the id there. Anything that
 * yields no usable prefix yields `''`, and a caller must then not build a chip at all — a pointer
 * with nothing to point with is worse than plain text.
 */
export function shortSessionId(row: { id: string; conversationId?: string }): string {
  const raw = row.id.startsWith('closed:') ? row.id.slice('closed:'.length) : row.id
  const hex = raw.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length >= 4) return hex.slice(0, 8).toLowerCase()
  const conv = (row.conversationId ?? '').replace(/[^0-9a-fA-F]/g, '')
  return conv.length >= 4 ? conv.slice(0, 8).toLowerCase() : ''
}

/**
 * The title as the chip may hold it: one line, no guillemets (they delimit the chip), no `·` run
 * that could be mistaken for the id separator, capped. Empty in, `''` out — the caller falls back
 * to a neutral word.
 */
export function mentionTitle(title: string): string {
  const one = title.replace(/[«»]/g, '').replace(/\s*·\s*/g, ' - ').replace(/\s+/g, ' ').trim()
  return one.length > MENTION_TITLE_MAX ? `${one.slice(0, MENTION_TITLE_MAX - 1).trimEnd()}…` : one
}

/** The chip text for one row, or `null` when the row has no id to point with. */
export function sessionMentionToken(row: MentionCandidate, pt: boolean): string | null {
  const id = shortSessionId(row)
  if (id === '') return null
  const title = mentionTitle(row.title) || (pt ? 'sessão sem título' : 'untitled session')
  return `#«${title} · ${id}»`
}

/**
 * The query after a `#` trigger at the end of `before`, or `null` when the caret is not in one.
 *
 * Same word-boundary rule as `atQuery`: the `#` must open the text or follow whitespace, so
 * `issue#12` and a URL fragment never open the picker. A space RIGHT AFTER the `#` closes it — that
 * is a markdown heading (`# Title`), not a search.
 *
 * The query MAY hold spaces after that, because session titles do: measured in the browser, typing
 * `#PROBE li` closed a one-word picker at the space and the next Enter sent `#PROBE li` raw. It
 * stays on one line and is bounded (`HASH_QUERY_MAX`), and a query with a space is only offered
 * while something matches (`hashPickerShown`), so prose like `#1 is the plan` closes on its own.
 */
export const HASH_QUERY_MAX = 48

export function hashQuery(before: string): string | null {
  const m = /(?:^|\s)#((?:[^\s#«»][^\n#«»]*)?)$/.exec(before)
  if (!m) return null
  const q = m[1]!
  return q.length > HASH_QUERY_MAX ? null : q
}

/**
 * Whether the picker is worth showing for this query. A one-word query shows even with no match (it
 * says so, which is how a typo is noticed); a query with a space shows only while it still matches.
 */
export function hashPickerShown(query: string, matches: number): boolean {
  return matches > 0 || !/\s/.test(query)
}

/** Everything a search may match on — title, folder, project/group, task, harness and state. */
export function mentionHaystack(row: MentionCandidate): string {
  return [row.title, row.project, row.cwd, row.task, row.harness, row.stateLabel, shortSessionId(row)]
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join('\n')
    .toLowerCase()
}

/**
 * The picker's rows for a query: the current session left out (mentioning yourself points nowhere
 * useful), one row per id, TITLE matches ahead of matches elsewhere, and otherwise the fleet's own
 * order — which already ranks live sessions first — so nothing reshuffles as a query grows.
 */
export function filterMentionCandidates<T extends MentionCandidate>(
  rows: Iterable<T>, query: string, self?: { id: string; conversationId?: string }, limit: number = MENTION_LIMIT,
): T[] {
  const q = query.trim().toLowerCase()
  const seen = new Set<string>()
  const title: T[] = []
  const other: T[] = []
  for (const r of rows) {
    if (!r.id || seen.has(r.id) || isSameSession(r, self)) continue
    seen.add(r.id)
    if (shortSessionId(r) === '') continue
    if (q === '') { title.push(r); continue }
    if (r.title.toLowerCase().includes(q)) title.push(r)
    else if (mentionHaystack(r).includes(q)) other.push(r)
  }
  return [...title, ...other].slice(0, limit)
}

/**
 * Is this row the session the composer belongs to? The same conversation reaches the fleet as
 * several rows (a live managed row, its `closed:` twin — see `scratchKey`), and every one of them
 * is "yourself".
 */
export function isSameSession(r: { id: string; conversationId?: string }, self?: { id: string; conversationId?: string }): boolean {
  if (!self) return false
  if (r.id === self.id) return true
  const conv = self.conversationId ?? (self.id.startsWith('closed:') ? self.id.slice(7) : undefined)
  if (!conv) return false
  return r.conversationId === conv || r.id === `closed:${conv}`
}

export interface MentionInsertion { text: string; caret: number }

/**
 * Write the chip where the `#query` is, followed by a space, and put the caret after it.
 *
 * With no trigger under the caret (a click on the list after the caret moved) the chip is appended,
 * the same fallback `applyAtServer` makes.
 */
export function applySessionMention(
  draft: string, caret: number, row: MentionCandidate, pt: boolean,
): MentionInsertion | null {
  const token = sessionMentionToken(row, pt)
  if (token === null) return null
  const at = Math.max(0, Math.min(caret, draft.length))
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const query = hashQuery(before)
  const inserted = after.startsWith(' ') ? token : `${token} `
  if (query === null) {
    const head = draft.replace(/\s+$/, '')
    const text = head === '' ? `${token} ` : `${head} ${token} `
    return { text, caret: text.length }
  }
  const start = before.length - query.length - 1
  return { text: draft.slice(0, start) + inserted + after, caret: start + inserted.length }
}

const CHIP = /#«([^«»\n]+?) · ([0-9a-f]{4,12})»/g

/** Every chip in the draft, as ranges the mirror paints. */
export function sessionMentionTokens(draft: string): MentionToken[] {
  const out: MentionToken[] = []
  for (const m of draft.matchAll(CHIP)) {
    const start = m.index ?? 0
    out.push({ start, end: start + m[0].length })
  }
  return out
}

/**
 * The message as the harness receives it: every chip rewritten as `«Title» (session id)`.
 *
 * Only the CHIPS are touched. A `#` the person typed themselves is theirs to send — rewriting prose
 * would change a message nobody asked to have changed.
 */
export function expandSessionMentions(text: string, pt: boolean): string {
  const word = pt ? 'sessão' : 'session'
  return text.replace(CHIP, (_all, title: string, id: string) => `«${title}» (${word} ${id})`)
}
