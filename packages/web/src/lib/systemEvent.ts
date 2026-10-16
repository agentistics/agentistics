/**
 * systemEvent.ts — PURE: recognise a message agentistics itself injected into a session.
 *
 * Producers write a header line as the first line of the prompt: `[from agentistics · away]`
 * (server/away.ts), `[from agentistics · question]` (sessions/handoff-hint.ts) and
 * `[from session <id> · handback|block|question]` (the session-message route). The chat must not
 * draw them as something the person typed.
 */
export type SystemEventKind = 'away' | 'question' | 'handback' | 'block' | 'session-question'

export interface SystemEvent {
  kind: SystemEventKind
  /** The sending session's id (or short id) for `from session` headers. */
  sender?: string
  /** Everything after the header line. */
  body: string
}

const HEADER = /^\s*\[from (agentistics|session ([^\s\]·]+)) · ([a-z-]+)\]\s*(?:\r?\n|$)/

export function parseSystemEvent(text: string): SystemEvent | null {
  const m = HEADER.exec(text)
  if (!m) return null
  const what = m[3]!
  const body = text.slice(m[0].length).trim()
  if (m[1] === 'agentistics') {
    if (what === 'away' || what === 'question') return { kind: what, body }
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
    case 'away': return pt ? 'Modo ausente atualizado' : 'Away mode updated'
    case 'question': return pt ? 'Dica de passagem de contexto' : 'Context hand-off hint'
    case 'handback': return pt ? `Sessão ${name} entregou` : `Session ${name} handed back`
    case 'block': return pt ? `Sessão ${name} está bloqueada` : `Session ${name} is blocked`
    case 'session-question': return pt ? `Sessão ${name} perguntou` : `Session ${name} asked a question`
  }
}
