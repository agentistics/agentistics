/**
 * handoff-relay.ts — HANDOFF.RELAY (owner 16/10): a leader hand-off must never swallow the owner's
 * answer. PURE: given the predecessor's turns, what the successor has to be told, and what is still
 * owed to it after the hand-off began.
 *
 * Measured case, 16/10 11:53 BRT: the owner asked the leader something, the leader answered, the
 * hand-off hint arrived 19 s later, the leader handed off and the successor killed it within
 * minutes. The answer lived only in the killed session; the successor never knew it existed. So:
 *  - the successor's briefing carries the owner's messages and the predecessor's last reply
 *    (`planRelay` + `relaySection`), with the instruction to restate it first;
 *  - anything the owner writes into the predecessor AFTER that snapshot is forwarded
 *    (`planForward`), never dropped;
 *  - the kill of a predecessor with something still owed flushes it first (the IO half).
 *
 * WHAT IS AN OWNER MESSAGE: a `user` turn that is not a harness note (`system`, which is how
 * `<task-notification>` and the other injected entries arrive) and not a message another session or
 * agentistics typed in (`[from session …]`, `[from agentistics …]`), nor the context block. Those
 * share the user's role in every transcript and must not be relayed as if the owner had said them.
 */
import { parseInjectedHeader, type ChatTurn } from '@agentistics/core'

/** At most this many owner messages travel; older ones are named by count. */
export const RELAY_MAX_OWNER_MESSAGES = 10
/** Per message and for the reply; the TAIL of a reply is kept (the conclusion is at the end). */
export const RELAY_MAX_CHARS = 2_000
export const RELAY_MAX_REPLY_CHARS = 6_000

const NOT_OWNER = /^(?:\[from session\b|\[from agentistics\b|<agentistics-context>|<agent-message(?:\s|>)|<task-notification>|<system-reminder>|<local-command|<command-name>|<session_context>|<scheduled-task|<cron\b|<user-prompt-submit-hook|CRON\s+\d{1,2}h\d{2}\b|\[(?:cron|scheduled)\b|\[SCHEDULED\b)/i

export function isOwnerTurn(turn: Pick<ChatTurn, 'role' | 'text' | 'system'>): boolean {
  if (turn.role !== 'user' || turn.system) return false
  const text = turn.text.trim()
  // A header makes it someone else's even inside the harness's `<pasted_content>` wrapper.
  return text.length > 0 && !NOT_OWNER.test(text) && !parseInjectedHeader(text)
}

/** "Sessão <id> (handback)" for a message another session typed in; null for everything else. */
export function injectedLabel(turn: Pick<ChatTurn, 'role' | 'text' | 'system'>): string | null {
  if (turn.role !== 'user' || turn.system) return null
  const h = parseInjectedHeader(turn.text)
  return h && h.origin === 'session' ? `Sessão ${h.sender ?? '?'} (${h.kind})` : null
}
function injectedMessages(turns: readonly ChatTurn[]): RelayMessage[] {
  const out: RelayMessage[] = []
  for (const t of turns) {
    const label = injectedLabel(t)
    if (!label) continue
    out.push({ ...(t.at ? { at: t.at } : {}), text: head(parseInjectedHeader(t.text)!.body, RELAY_MAX_CHARS), label })
  }
  return out.slice(-RELAY_MAX_OWNER_MESSAGES)
}

function after(turn: Pick<ChatTurn, 'at'>, since: string | undefined): boolean {
  if (!since) return true
  if (!turn.at) return false
  const a = Date.parse(turn.at), s = Date.parse(since)
  return Number.isFinite(a) && Number.isFinite(s) ? a > s : false
}

function head(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)} […]` : t
}

function tail(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `[…] ${t.slice(t.length - max)}` : t
}

export interface RelayMessage { at?: string; text: string; /** Set on a message another session sent — never the owner. */ label?: string }

export interface HandoffRelay {
  /** Owner messages, oldest first (capped). */
  owner: RelayMessage[]
  /** Messages other sessions typed in (handbacks, blocks…), labelled with their sender. */
  injected: RelayMessage[]
  /** Owner messages older than the cap, counted, never silently dropped. */
  omitted: number
  /** The predecessor's reply after the owner's latest message — all its assistant text there. */
  reply?: RelayMessage
  /** The owner's latest message got no assistant text after it. */
  unanswered: boolean
  /** The time of the last turn the snapshot saw: the forward cursor. */
  cursor?: string
}

/** The assistant text after `turns[from]`, joined (an answer is often split by tool calls). */
function replyAfter(turns: readonly ChatTurn[], from: number): RelayMessage | undefined {
  const parts: string[] = []
  let at: string | undefined
  for (let i = from + 1; i < turns.length; i++) {
    const t = turns[i]!
    if (t.role === 'assistant' && t.text.trim()) { parts.push(t.text.trim()); at = t.at ?? at }
  }
  if (parts.length === 0) return undefined
  return { ...(at ? { at } : {}), text: tail(parts.join('\n\n'), RELAY_MAX_REPLY_CHARS) }
}

/** The "owner has an unanswered message" gate expires: a stale message must not hold a hint forever. */
export const OWNER_WAIT_MAX_MS = 30 * 60 * 1000

/**
 * The owner's latest message is recent (< 30 min) and the assistant has produced NOTHING after it —
 * a tool-only or interrupted turn still counts as having answered, and an old message never blocks.
 */
export function ownerWaitingFresh(turns: readonly ChatTurn[], now = Date.now()): boolean {
  let last = -1
  turns.forEach((t, i) => { if (isOwnerTurn(t)) last = i })
  if (last < 0) return false
  if (turns.slice(last + 1).some(t => t.role === 'assistant')) return false
  const at = turns[last]!.at ? Date.parse(turns[last]!.at!) : NaN
  return Number.isFinite(at) && now - at <= OWNER_WAIT_MAX_MS
}

function lastTurnAt(turns: readonly ChatTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.at) return turns[i]!.at
  return undefined
}

/**
 * The snapshot the successor is briefed with. `since` is the predecessor's own previous hand-off
 * (its spawn, for a session that was itself a successor) — owner messages before it belong to an
 * older leader and were relayed then.
 */
export function planRelay(turns: readonly ChatTurn[], since?: string): HandoffRelay {
  const ownerIdx: number[] = []
  turns.forEach((t, i) => { if (isOwnerTurn(t) && after(t, since)) ownerIdx.push(i) })
  const kept = ownerIdx.slice(-RELAY_MAX_OWNER_MESSAGES)
  const owner = kept.map(i => ({ ...(turns[i]!.at ? { at: turns[i]!.at } : {}), text: head(turns[i]!.text, RELAY_MAX_CHARS) }))
  const last = ownerIdx[ownerIdx.length - 1]
  const reply = last !== undefined ? replyAfter(turns, last) : undefined
  const cursor = lastTurnAt(turns)
  return {
    owner,
    injected: injectedMessages(turns.filter(t => after(t, since))),
    omitted: ownerIdx.length - kept.length,
    ...(reply ? { reply } : {}),
    unanswered: last !== undefined && !reply,
    ...(cursor ? { cursor } : {}),
  }
}

export interface RelayForward {
  owner: RelayMessage[]
  injected: RelayMessage[]
  reply?: RelayMessage
  /** Where the cursor moves once this was delivered. */
  cursor?: string
  /** Still waiting for an answer to an owner message (carried to the next pass). */
  awaiting: boolean
}

/**
 * What is OWED to the successor since `cursor`: owner messages written after the snapshot, and the
 * predecessor's assistant text after them — or, when the snapshot ended on an UNANSWERED owner
 * message (`awaiting`), the answer the predecessor wrote after the hand-off began. `null` = nothing.
 */
export function planForward(turns: readonly ChatTurn[], cursor: string | undefined, awaiting: boolean): RelayForward | null {
  const fresh = turns.filter(t => after(t, cursor))
  if (fresh.length === 0) return null
  const ownerIdx: number[] = []
  fresh.forEach((t, i) => { if (isOwnerTurn(t)) ownerIdx.push(i) })
  const last = ownerIdx[ownerIdx.length - 1]
  const reply = last !== undefined ? replyAfter(fresh, last) : awaiting ? replyAfter(fresh, -1) : undefined
  const owner = ownerIdx.map(i => ({ ...(fresh[i]!.at ? { at: fresh[i]!.at } : {}), text: head(fresh[i]!.text, RELAY_MAX_CHARS) }))
  const nextAwaiting = last !== undefined ? !reply : awaiting && !reply
  const nextCursor = lastTurnAt(fresh) ?? cursor
  if (owner.length === 0 && !reply) {
    // Only the predecessor's own chatter moved: advance past it, nothing to deliver.
    const injected = injectedMessages(fresh)
    if (injected.length > 0) return { owner: [], injected, awaiting: nextAwaiting, ...(nextCursor ? { cursor: nextCursor } : {}) }
    return { owner: [], injected: [], awaiting: nextAwaiting, ...(nextCursor ? { cursor: nextCursor } : {}) }
  }
  return { owner, injected: injectedMessages(fresh), ...(reply ? { reply } : {}), awaiting: nextAwaiting, ...(nextCursor ? { cursor: nextCursor } : {}) }
}

/** A forward with something in it (as opposed to a cursor move only). */
export function forwardHasContent(f: RelayForward | null): f is RelayForward {
  return !!f && (f.owner.length > 0 || f.injected.length > 0 || f.reply !== undefined)
}

function quote(text: string): string {
  return text.split('\n').map(l => `> ${l}`).join('\n')
}

function stamp(at: string | undefined): string {
  if (!at) return ''
  const d = new Date(at)
  return Number.isFinite(d.getTime()) ? ` (${d.toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''
}

/**
 * The briefing section. `unavailable` is the sentence when the predecessor's conversation could not
 * be read — said, never silently skipped, so the successor knows to ask.
 */
export function relaySection(predecessorId: string, relay: HandoffRelay | null, unavailable?: string): string {
  const title = 'Mensagens do dono e a última resposta do antecessor'
  if (!relay) {
    return [
      `${title}:`,
      `Não foi possível ler a conversa da sessão anterior (${predecessorId}): ${unavailable ?? 'motivo desconhecido'}.`,
      'Na sua PRIMEIRA resposta, diga isso ao dono e peça que repita qualquer pergunta que tenha feito à sessão anterior e que ainda não teve resposta.',
    ].join('\n')
  }
  const lines = [`${title} (sessão anterior ${predecessorId}):`]
  if (relay.owner.length === 0) {
    lines.push('O dono não escreveu nada à sessão anterior desde a passagem que a criou.')
  } else {
    if (relay.omitted > 0) lines.push(`(${relay.omitted} mensagem(ns) mais antiga(s) do dono omitida(s).)`)
    for (const m of relay.owner) lines.push(`Dono${stamp(m.at)}:`, quote(m.text))
  }
  for (const m of relay.injected) lines.push(`${m.label}${stamp(m.at)}:`, quote(m.text))
  if (relay.reply) lines.push(`Última resposta do antecessor${stamp(relay.reply.at)}:`, quote(relay.reply.text))
  else if (relay.unanswered) lines.push('A última mensagem do dono ficou SEM resposta na sessão anterior.')
  if (relay.owner.length > 0) {
    lines.push(
      'Na sua PRIMEIRA resposta: reafirme, em poucas linhas, a última resposta do antecessor ao dono' +
      ' (ele pode não tê-la visto) e responda a tudo que o dono perguntou e ficou sem resposta.' +
      ' Mensagens que o dono escrever na sessão anterior depois disto serão encaminhadas a você.',
    )
  }
  return lines.join('\n')
}

/** The text typed into the successor for what arrived after the snapshot. */
export function forwardText(predecessorId: string, f: RelayForward): string {
  const lines = [`[from agentistics · relay]`, `Chegou na sessão anterior (${predecessorId}) depois da passagem:`]
  for (const m of f.owner) lines.push(`Dono${stamp(m.at)}:`, quote(m.text))
  for (const m of f.injected) lines.push(`${m.label}${stamp(m.at)}:`, quote(m.text))
  if (f.reply) lines.push(`Resposta do antecessor${stamp(f.reply.at)}:`, quote(f.reply.text))
  lines.push(f.owner.length === 0 && !f.reply
    ? 'São mensagens de outras sessões, não do dono: trate-as como tal; não há pergunta do dono a responder.'
    : f.owner.length > 0
    ? 'Responda ao dono aqui (reafirme a resposta do antecessor, se houver) — ele pode não ter visto a sessão anterior.'
    : 'Reafirme esta resposta ao dono aqui — ele pode não tê-la visto na sessão anterior.')
  return lines.join('\n')
}
