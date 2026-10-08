/**
 * replyQuote.ts — PURE: what replying to a message means here.
 *
 * There is no reply THREAD to send. The transport types a line into a tmux pane and these CLIs have
 * one linear conversation, so a reply is a QUOTE: the lines are `> `-prefixed and sent above what
 * you write, which is what the assistant actually reads and is what mail has always done. Saying
 * that plainly beats a UI implying threading the session cannot do.
 *
 * Three decisions, each of which can be wrong, and none of which belongs in JSX:
 *
 * 1. WHAT TRAVELS. The quote is spent CONTEXT — a reply echoing forty lines back at the session
 *    costs it window for nothing it does not already have. Four lines name the message; an ellipsis
 *    says there was more.
 * 2. WHAT THE BAR SHOWS. The first line or two, with the blank lines dropped: a message that opens
 *    with a fenced block or a heading would otherwise preview as two empty rows, which reads as a
 *    reply to nothing.
 * 3. WHO IS BEING REPLIED TO. "Replying to" with no name is the one thing the bar exists to answer.
 *    The user's own turn is "You"; an assistant turn is the HARNESS, by the name the rest of the
 *    product calls it.
 */

/** The turn being replied to, as the composer holds it. Structural — this module imports no view. */
export interface ReplyTarget {
  role: 'user' | 'assistant'
  text: string
  /**
   * The text is a SELECTED EXCERPT of the turn, not the turn.
   *
   * It changes two things and is therefore a field rather than something inferred from length: the
   * quote is not capped (see `quoteFor`), and the bar says "an excerpt of" rather than naming the
   * message, because a preview showing the middle of a paragraph with no such warning reads as the
   * whole of a very short message.
   */
  excerpt?: boolean
  /**
   * The turn this quote came from (`chatForward.ts`'s `turnKey`), when known. It is what puts
   * several quotes back in CONVERSATION order and stops the same message being added twice.
   * Absent for a target stored before replies became a list.
   */
  key?: string
  /**
   * Which card in the draft this quote is (`quoteCards.ts`). The draft carries the id in a marker
   * line, so the quote can sit BETWEEN the person's answers instead of above all of them.
   */
  id?: string
  /**
   * The person's own words written BETWEEN the previous quote (or the start of the message) and
   * this one. A reply answers each passage right under it — `[quote 1] reply 1 [quote 2] reply 2` —
   * so a quote carries the field that sits ABOVE it, and the composer's main field is the text after
   * the last quote. Absent (a target stored before quotes interleaved) reads as nothing written
   * there, which is exactly the old stacked layout, so no stored draft needs migrating.
   */
  before?: string
}

/** How many lines of the quoted message travel with the reply. See decision 1. */
export const QUOTE_LINES = 4

/** How many lines of it the bar above the composer shows. See decision 2. */
export const PREVIEW_LINES = 2

/**
 * A quoted excerpt, `> `-prefixed and bounded.
 *
 * A quote of nothing is EMPTY, not a lone `> ` — the caller joins this with the paths and the
 * typed text and filters empties out, so a blank marker would put a stray quote character at the
 * top of a message nobody quoted anything into.
 */
export function quoteLines(text: string, max: number = QUOTE_LINES): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const lines = trimmed.split('\n')
  const head = lines.slice(0, max).map(l => `> ${l}`)
  if (lines.length > max) head.push('> …')
  return head.join('\n')
}

/**
 * The first line or two, for the bar above the composer.
 *
 * BLANK LINES ARE DROPPED, not counted: a message opening with a fence or a heading followed by an
 * empty line would preview as one word and a gap, which reads as a reply to nothing. The ellipsis
 * is appended only when something was actually left out — a two-line message must not look
 * truncated.
 */
export function replyPreview(text: string, max: number = PREVIEW_LINES): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '')
  if (lines.length === 0) return ''
  const head = lines.slice(0, max).join(' ')
  return lines.length > max ? `${head} …` : head
}

/**
 * An excerpt, marked at the ends it does not reach.
 *
 * REPLYING TO A SELECTION IS A DIFFERENT ACT from replying to a message: the sender has said which
 * part they mean, and the reason they did it is that the whole message is expensive to send back.
 * So the excerpt travels VERBATIM and WHOLE — capping what somebody deliberately selected sends a
 * different message from the one they composed, which is the one thing a quote may never do.
 *
 * What it must not do is read as the whole turn. So an ellipsis is added at each end the excerpt
 * does not reach. **An excerpt that cannot be located in the turn is marked at BOTH ends**: the
 * bubble renders markdown, so a selection taken off the screen legitimately differs from the source
 * text, and between "claim it is complete" and "say it may be partial" only the second is wrong in
 * the harmless direction.
 *
 * Whitespace is normalised for the comparison ONLY. The returned text keeps the selection's own
 * line breaks, because they are what the reader saw.
 */
export function markExcerpt(full: string, selected: string): string {
  const text = selected.trim()
  if (text === '') return ''
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const haystack = norm(full)
  const needle = norm(text)
  const at = needle === '' ? -1 : haystack.indexOf(needle)
  const lead = at !== 0
  const trail = at < 0 || at + needle.length !== haystack.length
  return `${lead ? '…' : ''}${text}${trail ? '…' : ''}`
}

/**
 * The `> ` block that actually travels, for either kind of target.
 *
 * ONE function, because the cap is the difference and a caller choosing between two quoting
 * helpers is a caller that will one day cap an excerpt. A whole message is an INFERRED quantity and
 * is bounded (decision 1); an excerpt was CHOSEN and is not.
 */
export function quoteFor(target: ReplyTarget): string {
  return target.excerpt ? quoteLines(target.text, Number.POSITIVE_INFINITY) : quoteLines(target.text)
}

/** Insert a reply as ordinary markdown at the current caret. The textarea remains the only
 * layout surface: there are no sentinels, cards, or mirrored quote glyphs to drift from it. */
export function insertReplyQuote(
  draft: string,
  caret: number,
  target: ReplyTarget,
): { draft: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length))
  const quote = quoteFor(target)
  if (quote === '') return { draft, caret: at }
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const prefix = before === '' || before.endsWith('\n') ? '' : '\n\n'
  const suffix = after === '' || after.startsWith('\n') ? '\n\n' : '\n\n'
  const inserted = `${prefix}${quote}${suffix}`
  return { draft: before + inserted + after, caret: at + inserted.length }
}

/** Remove markdown quote prefixes while retaining the selected passage's line breaks. */
export function unquoteLines(text: string): string {
  return text.split('\n').map(line => line.startsWith('> ') ? line.slice(2) : line).join('\n').trim()
}

const isQuoteLine = (line: string): boolean => line.startsWith('> ') || line === '>'

/**
 * EVERY leading quote block of a message, and what follows them.
 *
 * A reply to several passages is sent as several `> ` blocks, a blank line apart (`quoteAll`), and
 * then the person's own words. Reading only the FIRST block left the second one inside `rest`,
 * where it rendered as an ordinary blockquote with no collapse control and no way back to its
 * source — the same message drawn two different ways. Blank lines BETWEEN blocks are consumed; the
 * first non-blank line that is not a quote line ends the run, and everything from there is `rest`.
 */
export function leadingQuotes(text: string): { quotes: string[]; rest: string } {
  const lines = text.split('\n')
  const quotes: string[] = []
  let i = 0
  for (;;) {
    let j = i
    while (j < lines.length && lines[j]!.trim() === '') j++
    if (j >= lines.length || !isQuoteLine(lines[j]!)) break
    let end = j
    while (end < lines.length && isQuoteLine(lines[end]!)) end++
    const quote = unquoteLines(lines.slice(j, end).join('\n'))
    if (quote !== '') quotes.push(quote)
    i = end
  }
  if (quotes.length === 0) return { quotes: [], rest: text }
  return { quotes, rest: lines.slice(i).join('\n').replace(/^\n+/, '') }
}

/** The leading quote block in a sent user message, if it has one. See `leadingQuotes`. */
export function leadingQuote(text: string): { quote: string; rest: string } | null {
  const { quotes, rest } = leadingQuotes(text)
  if (quotes.length === 0) return null
  const [first, ...others] = quotes
  return { quote: first!, rest: [quoteAll(others.map(q => ({ role: 'assistant' as const, text: q, excerpt: true }))), rest].filter(b => b.trim() !== '').join('\n\n') }
}

/**
 * A draft read back into the composer: its quotes, each carrying the words written ABOVE it
 * (`before`), and the words after the last quote, which go in the main field.
 *
 * EVERY `> ` run is a quote, wherever it sits — a reply answers each passage right under it, so a
 * draft is `[quote 1] reply 1 [quote 2] reply 2 … free text` and reading only the LEADING blocks
 * pushed every later quote into the free text as raw markdown. See `parseFields`.
 *
 * A lifted quote is an EXCERPT: its text is already what travels (capped and ellipsised when it was
 * first quoted), and marking it whole again would cap it a second time. Its source turn is not
 * known, so it carries no `key`; the composer finds the source by text, as the sent bubble does.
 */
export function splitQuotedDraft(draft: string): { replies: ReplyTarget[]; text: string } {
  const f = parseFields(draft)
  if (f.quotes.length === 0) return { replies: [], text: draft }
  const { replies, draft: text } = fromFields(f)
  return { replies, text }
}

/**
 * The composer's state as it is LOADED from storage, normalised to "quotes in the list, words in
 * the fields".
 *
 * An older version inserted every quote INTO the draft and also stored the same targets in the list
 * (unused at send). Loading that verbatim would draw each quote twice — once as a block, once as
 * `> ` text — and send it twice. So a stored target whose quote already sits in the draft is dropped
 * from the list, and the draft's quotes are lifted into it instead. A list written by this version
 * never appears in its own draft, so it passes through untouched.
 */
export function normalizeComposer(
  draft: string, replies: readonly ReplyTarget[],
): { draft: string; replies: ReplyTarget[] } {
  const kept = replies.filter(t => { const q = quoteFor(t); return q === '' || !draft.includes(q) })
  const { replies: lifted, text } = splitQuotedDraft(draft)
  return { draft: text, replies: lifted.reduce<ReplyTarget[]>((list, t) => addReply(list, t), kept) }
}

// ---------------------------------------------------------------------------
// INTERLEAVED QUOTES AND REPLIES.
//
// The composer is an ORDERED list: field 0, quote 1, field 1, quote 2, field 2 … quote n, field n.
// Field 0 is what was written above the first quote, field i the reply to quote i, and field n — the
// composer's own main textarea — the free text after the last quote. `fields.length` is always
// `quotes.length + 1`. Stored as the quote list with each field kept on the quote BELOW it
// (`before`) plus the main draft, so an old stack loads unchanged.
// ---------------------------------------------------------------------------

/** The composer as one ordered list. `fields.length === quotes.length + 1`. */
export interface ComposerFields { quotes: ReplyTarget[]; fields: string[] }

/** Where the caret is: which field, and the offset in it. */
export interface FieldCaret { field: number; caret: number }

/** Stored shape → ordered list. */
export function toFields(replies: readonly ReplyTarget[], draft: string): ComposerFields {
  return {
    quotes: replies.map(({ before: _b, ...t }) => t),
    fields: [...replies.map(r => r.before ?? ''), draft],
  }
}

/** Ordered list → stored shape. An empty field is not stored, so an unchanged target compares equal. */
export function fromFields(f: ComposerFields): { replies: ReplyTarget[]; draft: string } {
  return {
    replies: f.quotes.map((q, i) => {
      const { before: _b, ...t } = q
      const before = f.fields[i] ?? ''
      return before === '' ? t : { ...t, before }
    }),
    draft: f.fields[f.quotes.length] ?? '',
  }
}

/**
 * Add a quote AT THE CARET: the field being edited is split there, the quote goes in between, and
 * the text after the caret becomes the new quote's reply. With the caret at the end of a field this
 * is "after the segment being edited" — never stacked at the top. The caret lands at the start of
 * the new reply field, which is where the answer to that quote is written.
 *
 * The same quote twice is not added (`addReply`'s rule); the state comes back unchanged.
 */
export function insertQuoteAt(
  f: ComposerFields, at: FieldCaret, target: ReplyTarget,
): { fields: ComposerFields; focus: FieldCaret } {
  const field = Math.max(0, Math.min(at.field, f.quotes.length))
  const text = f.fields[field] ?? ''
  const caret = Math.max(0, Math.min(at.caret, text.length))
  if (target.text.trim() === '' || f.quotes.some(q => sameReply(q, target))) {
    return { fields: { quotes: [...f.quotes], fields: [...f.fields] }, focus: { field, caret } }
  }
  const { before: _b, ...clean } = target
  const left = text.slice(0, caret).replace(/\s+$/, '')
  const right = text.slice(caret).replace(/^\s+/, '')
  const quotes = [...f.quotes]
  quotes.splice(field, 0, clean)
  const fields = [...f.fields]
  fields.splice(field, 1, left, right)
  return { fields: { quotes, fields }, focus: { field: field + 1, caret: 0 } }
}

/**
 * Remove quote `i` and MERGE its reply into the field above it — typed text is never lost. The
 * caret lands where the two met.
 */
export function removeQuoteAt(f: ComposerFields, i: number): { fields: ComposerFields; focus: FieldCaret } {
  if (i < 0 || i >= f.quotes.length) return { fields: { quotes: [...f.quotes], fields: [...f.fields] }, focus: { field: 0, caret: 0 } }
  const above = f.fields[i] ?? ''
  const reply = f.fields[i + 1] ?? ''
  const joint = above.trim() !== '' && reply.trim() !== '' ? '\n\n' : ''
  const merged = above.trim() === '' ? reply : reply.trim() === '' ? above : above.replace(/\s+$/, '') + joint + reply.replace(/^\s+/, '')
  const quotes = f.quotes.filter((_, k) => k !== i)
  const fields = [...f.fields]
  fields.splice(i, 2, merged)
  const caret = above.trim() === '' ? 0 : reply.trim() === '' ? merged.length : above.replace(/\s+$/, '').length + joint.length
  return { fields: { quotes, fields }, focus: { field: i, caret } }
}

/**
 * What the harness receives: the attachment paths (leading, which is where `splitMessage` reads
 * them), then field 0, quote 1, field 1, quote 2 … field n, each block a blank line apart. The blank
 * line is load-bearing — see `composeReply` — and empty blocks are dropped. `mapText` transforms
 * each field (the `#` mention expansion) without touching the quotes.
 */
export function serializeFields(
  f: ComposerFields, paths: readonly string[] = [], mapText: (s: string) => string = s => s,
): string {
  const blocks: string[] = [paths.join('\n')]
  f.fields.forEach((text, i) => {
    blocks.push(mapText(text))
    const q = f.quotes[i]
    if (q) blocks.push(quoteFor(q))
  })
  return blocks.map(b => b.trim()).filter(b => b !== '').join('\n\n')
}

/**
 * The inverse of `serializeFields` for a text with no paths: every `> ` run is a quote (an EXCERPT —
 * see `splitQuotedDraft`), and the text between runs is the field. A run that unquotes to nothing
 * stays text.
 */
export function parseFields(text: string): ComposerFields {
  const lines = text.split('\n')
  const quotes: ReplyTarget[] = []
  const fields: string[] = []
  let buf: string[] = []
  let i = 0
  // A `> ` line inside a fenced code block is code, not a quote.
  let fenced = false
  while (i < lines.length) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) fenced = !fenced
    if (fenced || !isQuoteLine(lines[i]!)) { buf.push(lines[i]!); i++; continue }
    let end = i
    while (end < lines.length && isQuoteLine(lines[end]!)) end++
    const run = lines.slice(i, end)
    const quote = unquoteLines(run.join('\n'))
    if (quote === '') buf.push(...run)
    else {
      fields.push(buf.join('\n').trim())
      quotes.push({ role: 'assistant', text: quote, excerpt: true })
      buf = []
    }
    i = end
  }
  fields.push(buf.join('\n').trim())
  return { quotes, fields }
}

/**
 * The SENT message as the bubble draws it: quote and text segments in the order they were written,
 * so each reply sits under the passage it answers.
 */
export type SentSegment = { kind: 'quote'; text: string } | { kind: 'text'; text: string }
export function sentSegments(text: string): SentSegment[] {
  const f = parseFields(text)
  const out: SentSegment[] = []
  f.fields.forEach((t, i) => {
    if (t !== '') out.push({ kind: 'text', text: t })
    const q = f.quotes[i]
    if (q) out.push({ kind: 'quote', text: q.text })
  })
  return out
}

/**
 * Text arriving from outside (a queued message handed back, a rewind) joins the composer: its own
 * leading text joins the main field (`join`, the caller's `applyDraftRequest`), and its quotes and
 * replies follow, in their order.
 */
export function appendIncoming(f: ComposerFields, text: string, join: (draft: string, text: string) => string): ComposerFields {
  const inc = parseFields(text)
  const last = f.fields[f.fields.length - 1] ?? ''
  const lead = inc.fields[0] ?? ''
  let quotes = [...f.quotes]
  const fields = [...f.fields.slice(0, -1), lead === '' ? last : join(last, lead)]
  inc.quotes.forEach((q, k) => {
    if (quotes.some(x => sameReply(x, q))) {
      // Already here: its reply joins the field it would have opened rather than being lost.
      const reply = inc.fields[k + 1] ?? ''
      if (reply !== '') fields[fields.length - 1] = join(fields[fields.length - 1]!, reply)
      return
    }
    quotes = [...quotes, q]
    fields.push(inc.fields[k + 1] ?? '')
  })
  return { quotes, fields }
}

/** Text written by the person, excluding markdown quote lines. */
export function stripQuotedLines(text: string): string {
  return text.split('\n').filter(line => !line.startsWith('> ') && line !== '>').join('\n')
}

/**
 * Who said it.
 *
 * The assistant side is the harness's own label, passed in rather than looked up here: the label
 * table lives with the rest of the harness chrome and a second copy of it is a second place for
 * the two to disagree. An empty or missing label falls back to a neutral word instead of rendering
 * "Replying to" followed by nothing — the name is the whole point of the line.
 */
export function replyAuthor(
  role: 'user' | 'assistant',
  harnessLabel: string | undefined,
  lang: 'pt' | 'en',
): string {
  const pt = lang === 'pt'
  if (role === 'user') return pt ? 'Você' : 'You'
  const label = (harnessLabel ?? '').trim()
  if (label !== '') return label
  return pt ? 'o assistente' : 'the assistant'
}

/**
 * Parse a stored reply target.
 *
 * Storage is a string somebody else's code can also write, and a half-read entry here becomes a
 * quote sent to a session that nobody composed — so anything that is not a `{role, text}` pair with
 * a role this product knows and a non-empty text is dropped. Same rule, and the same reason, as
 * `parseAttachments`.
 */
export function parseReply(raw: string | null): ReplyTarget | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const { role, text } = v as Record<string, unknown>
    if (role !== 'user' && role !== 'assistant') return null
    if (typeof text !== 'string' || text.trim() === '') return null
    // The mark is only ever honoured when it is literally `true`: a stored value of any other
    // shape is a document this code did not write, and reading it as truthy would uncap the quote.
    const excerpt = (v as Record<string, unknown>).excerpt === true
    const key = (v as Record<string, unknown>).key
    const id = (v as Record<string, unknown>).id
    const before = (v as Record<string, unknown>).before
    return {
      role, text,
      ...(excerpt ? { excerpt: true } : {}),
      ...(typeof key === 'string' && key !== '' ? { key } : {}),
      ...(typeof id === 'string' && /^\d+$/.test(id) ? { id } : {}),
      ...(typeof before === 'string' && before !== '' ? { before } : {}),
    }
  } catch { return null }
}

// ---------------------------------------------------------------------------
// SEVERAL QUOTES AT ONCE.
//
// A long answer often asks several questions, and answering each means quoting each. So the reply
// is a LIST: the message menu's Reply ADDS to it (never replaces), and selection mode's
// "Reply (N)" adds every ticked message. What travels is each quote, briefly (`quoteFor`'s own
// cap), in CONVERSATION order, a blank line between them — and a blank line before the typed text,
// the `composeReply` rule, so the answer never falls into the last quote.
// ---------------------------------------------------------------------------

/**
 * A stored reply list. Reads the old single-object shape too, so a draft written before replies
 * became a list still sends its quote. Unusable entries are dropped, as `parseReply` drops them.
 */
export function parseReplies(raw: string | null): ReplyTarget[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    const items = Array.isArray(v) ? v : [v]
    return items.flatMap(x => {
      const t = parseReply(JSON.stringify(x))
      return t ? [t] : []
    })
  } catch { return [] }
}

function sameReply(a: ReplyTarget, b: ReplyTarget): boolean {
  return a.text === b.text && Boolean(a.excerpt) === Boolean(b.excerpt)
    && (a.key ?? '') === (b.key ?? '') && a.role === b.role
}

/** Add one quote to the list — appended, and never twice. */
export function addReply(list: readonly ReplyTarget[], target: ReplyTarget): ReplyTarget[] {
  if (target.text.trim() === '' || list.some(t => sameReply(t, target))) return [...list]
  return [...list, target]
}

/** The list in the order the messages appear in the conversation. Unplaceable ones keep theirs, last. */
export function orderReplies(list: readonly ReplyTarget[], turnKeys: readonly string[]): ReplyTarget[] {
  const at = new Map(turnKeys.map((k, i) => [k, i]))
  return list
    .map((t, i) => ({ t, i, pos: t.key !== undefined && at.has(t.key) ? at.get(t.key)! : Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.pos - b.pos) || (a.i - b.i))
    .map(x => x.t)
}

/** Every quote, each capped as `quoteFor` caps it, a blank line apart. Empty for an empty list. */
export function quoteAll(list: readonly ReplyTarget[]): string {
  return list.map(quoteFor).filter(q => q !== '').join('\n\n')
}


/**
 * The message a reply actually sends: the quote, then the attachment paths, then what was typed.
 *
 * THE BLANK LINE AFTER THE QUOTE IS THE POINT. These were joined with a single `\n`, which is
 * valid Markdown for something else entirely: CommonMark's LAZY CONTINUATION pulls a plain line
 * that follows a `>` line straight into the blockquote. So
 *
 *     > what the session said
 *     reabre essa sessao e manda meu prompt
 *
 * renders as ONE quote containing both — the person's own words sat inside the grey bar, credited
 * to the turn they were answering. Reported exactly that way: "apenas a parte mencionada deve ficar
 * nessa linha vertical cinza, a minha parte do texto deve ficar como texto branco e fora dessa
 * barra".
 *
 * A blank line ends the block, and everything after it is the writer's own paragraph. The paths get
 * the same treatment for the same reason — a bare path swallowed by the quote reads as something
 * the session said rather than a file being handed to it.
 *
 * Empty parts are dropped, so a message with no quote is exactly what was typed and gains no
 * leading blank line.
 */
export function composeReply(
  { quote, paths, text }: { quote: string; paths: readonly string[]; text: string },
): string {
  const blocks = [quote, paths.join('\n'), text].map(b => b.trim()).filter(b => b !== '')
  return blocks.join('\n\n')
}
