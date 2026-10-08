/**
 * pastedContent.ts — PURE: Claude Code wraps long pasted text in
 * `<pasted_content id="…">…</pasted_content id="…">` before it reaches the transcript. The tags are
 * plumbing and the id is meaningless to a person, so a message is split into prose and PASTE
 * segments: the bubble draws prose as before and each paste as a collapsible block, never showing
 * the tags or the id.
 *
 * An unterminated block (a truncated window) runs to the end of the text rather than leaking the
 * opening tag.
 */

export type PastedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }

const OPEN = /<pasted_content(?:\s+id="[^"]*")?\s*>/i
const CLOSE = /<\/pasted_content(?:\s+id="[^"]*")?\s*>/i

export function hasPastedContent(text: string): boolean {
  return OPEN.test(text)
}

export function splitPastedContent(text: string): PastedSegment[] {
  const out: PastedSegment[] = []
  let rest = text
  for (;;) {
    const open = OPEN.exec(rest)
    if (!open) break
    const before = rest.slice(0, open.index)
    if (before.trim() !== '') out.push({ kind: 'text', text: before.trim() })
    const after = rest.slice(open.index + open[0].length)
    const close = CLOSE.exec(after)
    const body = close ? after.slice(0, close.index) : after
    if (body.trim() !== '') out.push({ kind: 'paste', text: body.replace(/^\n+|\s+$/g, '') })
    if (!close) { rest = ''; break }
    rest = after.slice(close.index + close[0].length)
  }
  if (rest.trim() !== '') out.push({ kind: 'text', text: rest.trim() })
  return out
}

/** Remove transcript plumbing when the server proved the block came from our composer. */
export function unwrapPastedContent(text: string): string {
  return text
    .replace(OPEN, '')
    .replace(CLOSE, '')
    .trim()
}

/** Reload fallback: a whole pasted block containing only reply quote lines is ours. */
export function isQuoteOnlyPastedBlob(text: string): boolean {
  const segments = splitPastedContent(text)
  if (segments.length !== 1 || segments[0]?.kind !== 'paste') return false
  const lines = segments[0].text.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.length > 0 && lines.every(line => line.startsWith('> '))
}

/** First `n` non-empty lines, and how many lines the whole paste has. */
export function pastePreview(text: string, n = 3): { head: string; total: number; truncated: boolean } {
  const lines = text.split('\n')
  const head = lines.slice(0, n).join('\n')
  return { head, total: lines.length, truncated: lines.length > n }
}

const INJECTED = /<(system-reminder|local-command-caveat|local-command-stdout|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/gi

/**
 * Harness blocks that ride INSIDE a person's message (a reminder appended after their prose). The
 * leading-tag case is `chat-envelope.ts`'s; this removes the embedded one, bodies included, so a
 * reminder never shows. An unterminated block is left alone — hiding text we cannot bound is the
 * expensive direction.
 */
export function stripInjectedBlocks(text: string): string {
  const out = text.replace(INJECTED, '').replace(/\n{3,}/g, '\n\n').trim()
  return out === '' && text.trim() !== '' ? text : out
}
