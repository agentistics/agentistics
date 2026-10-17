/**
 * injectedHeader.ts — PURE: the `[from agentistics · <kind>]` / `[from session <id> · <kind>]` header
 * every message agentistics (or another session) types into a conversation opens with. One parser for
 * both the chat (web) and the hand-off relay (server), so "who said this" has ONE answer: a message
 * carrying such a header is never the owner's, whatever its kind.
 *
 * The harness may wrap a typed-in block as `<pasted_content id="…">…</pasted_content id="…">`; ONE
 * wrapper spanning the whole message is unwrapped before matching.
 */
export interface InjectedHeader {
  origin: 'agentistics' | 'session'
  /** The sending session's id (or short id) for `from session` headers. */
  sender?: string
  /** The header's kind word, verbatim (`handback`, `relay`, `whatever-comes-next`). */
  kind: string
  /** Everything after the header line. */
  body: string
}

const HEADER = /^\s*\[from (agentistics|session ([^\s\]·]+)) · ([^\]\r\n]+?)\]\s*(?:\r?\n|$)/
const PASTED = /^\s*<pasted_content id="([^"]+)">[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?<\/pasted_content id="\1">\s*$/

/** The text inside ONE wrapper spanning the whole message, else the text unchanged. */
export function unwrapPasted(text: string): string {
  const m = PASTED.exec(text)
  return m ? m[2]! : text
}

export function parseInjectedHeader(raw: string): InjectedHeader | null {
  const text = unwrapPasted(raw)
  const m = HEADER.exec(text)
  if (!m) return null
  return {
    origin: m[1] === 'agentistics' ? 'agentistics' : 'session',
    ...(m[2] ? { sender: m[2] } : {}),
    kind: m[3]!.trim(),
    body: text.slice(m[0].length).trim(),
  }
}
