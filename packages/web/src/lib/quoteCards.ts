/**
 * quoteCards.ts — PURE: several quotes INSIDE the draft, each followed by the words answering it.
 *
 * The reply used to be a strip ABOVE the composer, so "answer question 1, then question 2" could
 * only be written as one block of quotes on top and one block of answers below — the reader of the
 * message had to pair them up. A quote is now a CARD that lives at a position in the draft:
 *
 *     [card: question one]
 *     my answer to it
 *     [card: question two]
 *     my answer to that
 *
 * THE DRAFT STAYS ONE STRING. The composer is a plain textarea with a mirror painted behind it
 * (`commandMirror.ts`), and every feature it has — the `/` and `@` and `#` pickers, dictation, the
 * per-session draft persistence — works on that string. A card is therefore a MARKER LINE in it:
 *
 *     U+2063 <id in zero-width bits> U+2064 <label> " ✕" U+2063
 *
 * The sentinels and the id bits are default-ignorable characters, which render at zero width both
 * in the textarea and in the mirror, so the mirror still lays out character-for-character with the
 * field and can paint the label as a card. The id is what ties a marker to its `ReplyTarget`: the
 * label is only ever a PREVIEW, and the quote that travels comes from the stored target, never from
 * text somebody could have edited.
 *
 * A MARKER IS ATOMIC. The caret is never left inside one (`snapCaret`), Backspace/Delete at its
 * edge remove it whole (`atomicDelete`), and any edit that damaged one anyway is repaired or dropped
 * by `syncQuotes`, which is also what keeps the list of targets and the markers in the draft equal:
 * a target whose card is gone is dropped, a marker whose target is unknown is removed.
 */
import { quoteFor, replyPreview, type ReplyTarget } from './replyQuote'

export const QUOTE_START = '⁣'
export const QUOTE_SEP = '⁤'
const BIT0 = '​'
const BIT1 = '‌'
/** What the card's remove control is, in the text. Its own run so the mirror can make it a button. */
export const QUOTE_CLOSE = ' ✕'
/** How long a card's preview runs before it is cut. A card is a pointer, not the quote. */
export const LABEL_MAX = 64

const MARK_RE = /⁣([​‌]+)⁤([^⁣⁤\n]*)⁣/g
const STRAY_RE = /[⁣⁤​‌]/g

/** One marker in a draft. `end` is exclusive; `closeStart` is where ` ✕` begins. */
export interface QuoteMark {
  id: string
  start: number
  end: number
  /** Where the visible label begins (after the zero-width prefix). */
  labelStart: number
  closeStart: number
}

export function encodeQuoteId(id: string): string {
  const n = Math.max(0, Math.floor(Number(id)) || 0)
  return n.toString(2).split('').map(b => (b === '1' ? BIT1 : BIT0)).join('')
}

function decodeBits(bits: string): string {
  return String(parseInt([...bits].map(c => (c === BIT1 ? '1' : '0')).join(''), 2))
}

/** Every well-formed marker, in draft order. */
export function quoteMarks(draft: string): QuoteMark[] {
  const out: QuoteMark[] = []
  for (const m of draft.matchAll(MARK_RE)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    const labelStart = start + 1 + m[1]!.length + 1
    const body = m[2]!
    const closeStart = body.endsWith(QUOTE_CLOSE) ? end - 1 - QUOTE_CLOSE.length : end - 1
    out.push({ id: decodeBits(m[1]!), start, end, labelStart, closeStart })
  }
  return out
}

/** The visible preview a card shows: who, then the first words. Never contains a sentinel. */
export function quoteLabel(target: ReplyTarget, author: string, max: number = LABEL_MAX): string {
  const clean = (s: string) => s.replace(STRAY_RE, '').replace(/\s+/g, ' ').trim()
  let preview = clean(replyPreview(target.text))
  if (preview.length > max) preview = `${preview.slice(0, max - 1).trimEnd()}…`
  return `↩ ${clean(author)}: ${preview}`
}

export function quoteMarker(id: string, label: string): string {
  return `${QUOTE_START}${encodeQuoteId(id)}${QUOTE_SEP}${label}${QUOTE_CLOSE}${QUOTE_START}`
}

/** A fresh id: one past the largest numeric id in use. */
export function nextQuoteId(list: readonly ReplyTarget[]): string {
  const max = list.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)
  return String(max + 1)
}

/**
 * Put a card at the caret, on a line of its own, and leave the caret on the line after it — the
 * next thing the person does is type the answer.
 */
export function insertQuote(draft: string, caret: number, marker: string): { draft: string; caret: number } {
  const at = snapCaret(draft, Math.max(0, Math.min(caret, draft.length)))
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const pre = before === '' || before.endsWith('\n') ? '' : '\n'
  // Text (or another card) already following the caret moves to its own line, so the answer is
  // typed on an EMPTY line under the new card instead of being glued to what came after.
  const post = after === '' || after.startsWith('\n') ? '\n' : '\n\n'
  const ins = `${pre}${marker}${post}`
  const caretAt = at + pre.length + marker.length + 1
  return { draft: before + ins + after, caret: caretAt }
}

/** Remove one card and the line break that followed it, so no empty line is left in its place. */
export function removeQuote(draft: string, id: string): string {
  const m = quoteMarks(draft).find(x => x.id === id)
  if (!m) return draft
  let end = m.end
  let start = m.start
  if (draft[end] === '\n') end += 1
  else if (start > 0 && draft[start - 1] === '\n') start -= 1
  return draft.slice(0, start) + draft.slice(end)
}

/**
 * The caret may sit before or after a card, never inside one. `prev` says which way it was moving,
 * so an arrow key walks OVER the card instead of bouncing off it.
 */
export function snapCaret(draft: string, pos: number, prev?: number): number {
  for (const m of quoteMarks(draft)) {
    if (pos > m.start && pos < m.end) {
      if (prev !== undefined && prev >= m.end) return m.start
      if (prev !== undefined && prev <= m.start) return m.end
      return pos - m.start < m.end - pos ? m.start : m.end
    }
  }
  return pos
}

/**
 * Backspace right after a card (or at the start of the line below it) and Delete right before one
 * remove the WHOLE card. `null` when the key is not touching a card and should do what it does.
 */
export function atomicDelete(
  draft: string, caret: number, key: 'Backspace' | 'Delete',
): { draft: string; caret: number; id: string } | null {
  for (const m of quoteMarks(draft)) {
    const hit = key === 'Backspace'
      ? caret === m.end || (caret === m.end + 1 && draft[m.end] === '\n')
      : caret === m.start
    if (!hit) continue
    const next = removeQuote(draft, m.id)
    return { draft: next, caret: Math.min(m.start, next.length), id: m.id }
  }
  return null
}

/**
 * Bring the draft and the list of targets back into agreement after ANY edit.
 *
 * - a marker whose id names a known target gets that target's canonical label back (an edit that
 *   reached into the label is undone rather than kept as a lie about what is quoted);
 * - a marker whose id is unknown, and any stray sentinel left by a damaged marker, are removed;
 * - a target with no marker left is dropped — deleting the card is how a quote is removed.
 *
 * `caret` is mapped through the rewrite so the cursor stays where the person left it.
 */
export function syncQuotes(
  draft: string,
  replies: readonly ReplyTarget[],
  labelOf: (t: ReplyTarget) => string,
  caret: number = draft.length,
): { draft: string; replies: ReplyTarget[]; caret: number } {
  const byId = new Map(replies.filter(r => r.id !== undefined).map(r => [r.id!, r]))
  const seen = new Set<string>()
  let out = ''
  let at = 0
  let newCaret = caret
  const emit = (srcFrom: number, srcTo: number, text: string) => {
    // Map the caret: inside a rewritten span it lands at the span's end.
    if (caret >= srcTo) newCaret += text.length - (srcTo - srcFrom)
    else if (caret > srcFrom) newCaret = out.length + text.length
    out += text
  }
  const plain = (from: number, to: number) => {
    const raw = draft.slice(from, to)
    const kept = raw.replace(STRAY_RE, '')
    if (kept === raw) { out += raw; return }
    // Per-character so the caret maps exactly.
    for (let i = from; i < to; i++) {
      const ch = draft[i]!
      if (/[⁣⁤​‌]/.test(ch)) emit(i, i + 1, '')
      else out += ch
    }
  }
  for (const m of quoteMarks(draft)) {
    plain(at, m.start)
    const target = byId.get(m.id)
    if (target && !seen.has(m.id)) {
      seen.add(m.id)
      // A card is always a line of its own: text typed against either edge is moved off it.
      const lead = out !== '' && !out.endsWith('\n') ? '\n' : ''
      const next = draft[m.end]
      const trail = next !== undefined && next !== '\n' ? '\n' : ''
      emit(m.start, m.end, lead + quoteMarker(m.id, labelOf(target)) + trail)
    } else {
      emit(m.start, m.end, '')
    }
    at = m.end
  }
  plain(at, draft.length)
  return {
    draft: out,
    replies: replies.filter(r => r.id !== undefined && seen.has(r.id)),
    caret: Math.max(0, Math.min(newCaret, out.length)),
  }
}

/**
 * A draft stored before quotes lived inside it carries targets with no marker (and maybe no id).
 * They are given ids and placed at the TOP, in their stored order — which is where the old strip
 * put them in the message — so nothing a person composed is silently dropped on upgrade.
 */
export function placeOrphans(
  draft: string,
  replies: readonly ReplyTarget[],
  labelOf: (t: ReplyTarget) => string,
): { draft: string; replies: ReplyTarget[] } {
  const present = new Set(quoteMarks(draft).map(m => m.id))
  const list: ReplyTarget[] = []
  let maxId = replies.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)
  const orphans: ReplyTarget[] = []
  for (const r of replies) {
    const t = r.id !== undefined && !list.some(x => x.id === r.id) ? r : { ...r, id: String(++maxId) }
    list.push(t)
    if (!present.has(t.id!)) orphans.push(t)
  }
  if (orphans.length === 0) return { draft, replies: list }
  const head = orphans.map(t => `${quoteMarker(t.id!, labelOf(t))}\n`).join('')
  return { draft: head + draft, replies: list }
}

/** The draft with every card taken out — what the person themselves wrote. */
export function stripQuotes(draft: string): string {
  return draft.replace(MARK_RE, '').replace(STRAY_RE, '')
}

/** The targets in the order their cards appear in the draft. */
export function quotesInOrder(draft: string, replies: readonly ReplyTarget[]): ReplyTarget[] {
  const byId = new Map(replies.filter(r => r.id !== undefined).map(r => [r.id!, r]))
  return quoteMarks(draft).flatMap(m => (byId.has(m.id) ? [byId.get(m.id)!] : []))
}

export type QuotedSegment = { kind: 'text'; text: string } | { kind: 'quote'; target: ReplyTarget }

/** The draft cut into the person's text and the quotes between it. Unknown markers vanish. */
export function splitQuoted(draft: string, replies: readonly ReplyTarget[]): QuotedSegment[] {
  const byId = new Map(replies.filter(r => r.id !== undefined).map(r => [r.id!, r]))
  const out: QuotedSegment[] = []
  let at = 0
  for (const m of quoteMarks(draft)) {
    if (m.start > at) out.push({ kind: 'text', text: draft.slice(at, m.start) })
    const t = byId.get(m.id)
    if (t) out.push({ kind: 'quote', target: t })
    at = m.end
  }
  if (at < draft.length) out.push({ kind: 'text', text: draft.slice(at) })
  return out.map(s => (s.kind === 'text' ? { kind: 'text', text: s.text.replace(STRAY_RE, '') } : s))
}

/**
 * The message that travels: each quote as a `> ` block, then the words written after it, every
 * block a BLANK LINE apart — the same CommonMark rule `composeReply` documents (a single newline
 * lets lazy continuation pull the answer into the quote). `mapText` is applied to the person's own
 * text only, so `#` mentions are expanded in what they wrote and never inside a quoted passage.
 *
 *     > …the first question…
 *
 *     my answer to it
 *
 *     > …the second question…
 *
 *     my answer to that
 */
export function composeQuoted(
  draft: string,
  replies: readonly ReplyTarget[],
  mapText: (s: string) => string = s => s,
): string {
  return splitQuoted(draft, replies)
    .map(s => (s.kind === 'quote' ? quoteFor(s.target) : mapText(s.text)))
    .map(b => b.trim())
    .filter(b => b !== '')
    .join('\n\n')
}

/**
 * Where an excerpt sits in a run of text nodes, for highlighting it on screen.
 *
 * The bubble renders markdown, so what is on screen differs from the source in whitespace and in
 * the ellipses `markExcerpt` added at the ends it does not reach; both are normalised away. Returns
 * `[start, end)` offsets into the CONCATENATED text, or `null` when the excerpt cannot be found —
 * then the caller flashes the whole message instead of guessing a span.
 */
export function locateExcerpt(haystack: string, excerpt: string): [number, number] | null {
  const needle = excerpt.replace(/^…|…$/g, '').replace(/\s+/g, ' ').trim()
  if (needle === '') return null
  // Build the whitespace-collapsed haystack while remembering each kept char's original index.
  const map: number[] = []
  let flat = ''
  let prevSpace = true
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i]!
    const space = /\s/.test(ch)
    if (space && prevSpace) continue
    flat += space ? ' ' : ch
    map.push(i)
    prevSpace = space
  }
  const at = flat.indexOf(needle)
  if (at < 0) return null
  return [map[at]!, map[at + needle.length - 1]! + 1]
}
