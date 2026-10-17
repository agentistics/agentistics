/**
 * systemEvent.ts — PURE: recognise a message agentistics itself injected into a session.
 *
 * Producers write a header line as the first line of the prompt: `[from agentistics · away]`
 * (server/away.ts), `[from agentistics · question]` (sessions/handoff-hint.ts) and
 * `[from session <id> · handback|block|question]` (the session-message route). The chat must not
 * draw them as something the person typed.
 *
 * The session-message route types the prompt into the harness's terminal, and Claude Code wraps a
 * typed-in block like that as `<pasted_content id="…">…</pasted_content id="…">` before storing it,
 * so the header is no longer the first line. One whole-message wrapper is unwrapped before matching;
 * a wrapper the person really pasted around ordinary text still finds no header and stays theirs.
 */
export type SystemEventKind = 'away' | 'away-off' | 'question' | 'handback' | 'block' | 'session-question' | 'checkin'

export interface SystemEvent {
  kind: SystemEventKind
  /** The sending session's id (or short id) for `from session` headers. */
  sender?: string
  /** Everything after the header line, or the full legacy prompt. */
  body: string
}

const HEADER = /^\s*\[from (agentistics|session ([^\s\]·]+)) · ([a-z-]+)\]\s*(?:\r?\n|$)/
const PASTED = /^\s*<pasted_content id="([^"]+)">[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?<\/pasted_content id="\1">\s*$/

/** The text inside ONE wrapper spanning the whole message, else the text unchanged. */
function unwrapPasted(text: string): string {
  const m = PASTED.exec(text)
  return m ? m[2]! : text
}

// Before the producer added a header, these prompts were stored as ordinary user turns.
const LEGACY_CHECKIN = /^\s*(?:Faça o check-in da liderança agora\.|Run the leadership check-in now\.)/

export function parseSystemEvent(raw: string): SystemEvent | null {
  const text = unwrapPasted(raw)
  const m = HEADER.exec(text)
  if (!m) return LEGACY_CHECKIN.test(text) ? { kind: 'checkin', body: text } : null
  const what = m[3]!
  const body = text.slice(m[0].length).trim()
  if (m[1] === 'agentistics') {
    if (what === 'check-in') return { kind: 'checkin', body }
    if (what === 'away') return { kind: /away mode is now OFF/i.test(body) ? 'away-off' : 'away', body }
    if (what === 'question') return { kind: 'question', body }
    return null
  }
  if (what === 'handback' || what === 'block') return { kind: what, sender: m[2], body }
  if (what === 'question') return { kind: 'session-question', sender: m[2], body }
  return null
}

/** The one short localized line. `who` is the sender's title when known, else its id. */
export function systemEventLine(e: SystemEvent, pt: boolean, who?: string): string {
  const name = who || e.sender || ''
  switch (e.kind) {
    case 'checkin': return pt ? 'Check-in da liderança · sistema' : 'Leadership check-in · system'
    case 'away-off': return pt ? 'Modo ausente desligado nesta sessão' : 'Away mode turned off for this session'
    case 'away': return pt ? 'Modo ausente atualizado' : 'Away mode updated'
    case 'question': return pt ? 'Dica de passagem de contexto' : 'Context hand-off hint'
    case 'handback': return pt ? `Sessão ${name} entregou` : `Session ${name} handed back`
    case 'block': return pt ? `Sessão ${name} está bloqueada` : `Session ${name} is blocked`
    case 'session-question': return pt ? `Sessão ${name} perguntou` : `Session ${name} asked a question`
  }
}
