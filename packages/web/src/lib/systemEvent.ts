import { parseInjectedHeader, roleLine, slashInvocation, unwrapAllPasted } from '@agentistics/core'

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
 * so the header is no longer the first line. Whole-message wrappers are unwrapped before matching;
 * a wrapper the person really pasted around ordinary text still finds no header and stays theirs.
 */
export type SystemEventKind = 'away' | 'away-off' | 'question' | 'handback' | 'block' | 'session-question' | 'checkin' | 'role' | 'rename' | 'relay' | 'notice' | 'session-note'

export interface SystemEvent {
  kind: SystemEventKind
  /** The sending session's id (or short id) for `from session` headers. */
  sender?: string
  /** Everything after the header line, or the full legacy prompt. */
  body: string
  /** The header's own kind word, for the generic kinds (`notice`, `session-note`). */
  label?: string
}

// Before the producer added a header, these prompts were stored as ordinary user turns.
const LEGACY_CHECKIN = /^\s*(?:Faça o check-in da liderança agora\.|Run the leadership check-in now\.)/

export function parseSystemEvent(raw: string): SystemEvent | null {
  const text = unwrapAllPasted(raw)
  const h = parseInjectedHeader(raw)
  if (!h) {
    const invocation = slashInvocation(text)
    if (invocation?.command === '/rename' && invocation.args && !/[\r\n]/.test(invocation.args)) {
      return { kind: 'rename', body: invocation.args }
    }
    // Match the entire historical producer output, never a mention of its marker in typed prose.
    if ((['leader', 'worker', null] as const).some(role =>
      text.trim() === `[agentistics] your role is now ${role ? role.toUpperCase() : 'AUTO'} — ${roleLine(role)}`,
    )) return { kind: 'role', body: text.trim() }
    return LEGACY_CHECKIN.test(text) ? { kind: 'checkin', body: text } : null
  }
  const { kind: what, body } = h
  if (h.origin === 'agentistics') {
    if (what === 'role') return { kind: 'role', body }
    if (what === 'check-in') return { kind: 'checkin', body }
    if (what === 'away') return { kind: /away mode is now OFF/i.test(body) ? 'away-off' : 'away', body }
    if (what === 'question') return { kind: 'question', body }
    if (what === 'relay') return { kind: 'relay', body }
    // Fail closed: a header nobody listed is still agentistics talking, never the person.
    return { kind: 'notice', label: what, body }
  }
  if (what === 'handback' || what === 'block') return { kind: what, sender: h.sender, body }
  if (what === 'question') return { kind: 'session-question', sender: h.sender, body }
  return { kind: 'session-note', sender: h.sender, label: what, body }
}

/** Session titles are shown without the role prefix used by the sidebar. */
export function systemEventTitle(title?: string): string | undefined {
  return title?.replace(/^\[\s*(?:LÍDER|LEADER)\s*\]\s*-\s*/i, '').trim() || undefined
}

/** Resolve against all fleet rows, including ended sessions; never guess an ambiguous prefix. */
export function systemEventSender<T extends { id: string; conversationId?: string }>(rows: readonly T[], id: string): T | undefined {
  const exact = rows.find(row => row.id === id || row.conversationId === id)
  if (exact) return exact
  const matches = rows.filter(row => row.id.startsWith(id) || row.conversationId?.startsWith(id))
  return matches.length === 1 ? matches[0] : undefined
}

/** The one short localized line. Unknown senders are omitted, never shown as raw ids. */
export function systemEventLine(e: SystemEvent, pt: boolean, who?: string): string {
  const title = systemEventTitle(who)
  const suffix = title ? ` · ${title}` : ''
  switch (e.kind) {
    case 'rename': return pt ? `Sessão renomeada para “${e.body}”` : `Session renamed to “${e.body}”`
    case 'role': return pt ? 'Papel da sessão atualizado' : 'Session role updated'
    case 'checkin': return pt ? 'Check-in da liderança · sistema' : 'Leadership check-in · system'
    case 'away-off': return pt ? 'Modo ausente desligado nesta sessão' : 'Away mode turned off for this session'
    case 'away': return pt ? 'Modo ausente atualizado' : 'Away mode updated'
    case 'question': return pt ? 'Dica de passagem de contexto' : 'Context hand-off hint'
    case 'handback': return (pt ? 'Tarefa entregue' : 'Task handed back') + suffix
    case 'block': return (pt ? 'Sessão bloqueada' : 'Session blocked') + suffix
    case 'session-question': return (pt ? 'Pergunta de uma sessão' : 'Question from a session') + suffix
    case 'relay': return pt ? 'Mensagem encaminhada da sessão anterior' : 'Forwarded from the previous session'
    case 'notice': return pt ? `Aviso do agentistics (${e.label ?? 'aviso'})` : `agentistics notice (${e.label ?? 'notice'})`
    case 'session-note': return (pt ? `Mensagem de uma sessão (${e.label ?? 'mensagem'})` : `Message from a session (${e.label ?? 'message'})`) + suffix
  }
}
