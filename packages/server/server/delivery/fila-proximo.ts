/**
 * delivery/fila-proximo.ts — FILA.PRIORIDADE, the PURE half of the `fila-proximo` flow.
 *
 * The queue ("Na fila") leaves in ONE order: the task's priority (urgent → low), then the time the piece entered the
 * queue, then its id. Changing a priority on a card therefore changes the order things LEAVE in — there is no second
 * list. When a slot opens the flow picks the next piece, puts ONE question to its task's leader (no model involved)
 * and acts on the answer:
 *
 *   sim                        the piece starts
 *   nao <motivo>               it stays queued with the reason on the card; the flow moves on to the next
 *   agendar <ISO> <motivo>     it stays queued and only becomes a candidate again at that instant
 *   (no answer in 10 min)      autonomous mode ON: carried on as `sim`, and recorded; OFF: keeps waiting and reminds
 *
 * Nothing here reads the machine; `service.ts` owns the I/O and the slot gate.
 */
import { priorityRank } from '@agentistics/core'
import type { QueueAsk, QueueHold } from './machine'

/** Ten minutes without an answer: autonomous mode carries on as `sim`; otherwise the leader is reminded. */
export const ASK_TIMEOUT_MS = 10 * 60_000
/** A spawn claim older than this was abandoned (the process died between the claim and the session). */
export const START_CLAIM_MS = 3 * 60_000
/** The header of the system question typed into the leader's composer. */
export const QUEUE_HEADER = 'from flow fila · confirmar'

export interface QueueItem {
  subtaskId: string
  taskId: string
  title: string
  /** urgent | high | medium | low — the TASK's, never `none`. */
  priority: string
  /** When the piece entered the queue (the delivery record's creation). */
  since: string
  hold?: QueueHold
  ask?: QueueAsk
}

/** PURE: the order the queue leaves in. Total (priority → entered the queue → id), so nothing reshuffles on a re-read. */
export function orderQueue<T extends Pick<QueueItem, 'priority' | 'since' | 'subtaskId'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.since.localeCompare(b.since) || a.subtaskId.localeCompare(b.subtaskId))
}

export type HoldState = 'nao' | 'agendado' | null

/** PURE: does the leader's hold still keep the piece out? `nao` holds until someone changes it; `agendar` until its instant. */
export function holdState(hold: QueueHold | undefined, nowMs: number): HoldState {
  if (!hold) return null
  if (hold.kind === 'nao') return 'nao'
  const until = Date.parse(hold.until ?? '')
  return Number.isFinite(until) && until > nowMs ? 'agendado' : null
}

export type QueueAnswer =
  | { kind: 'sim' }
  | { kind: 'nao'; reason: string }
  | { kind: 'agendar'; until: string; reason: string }

export type ParsedAnswer = { ok: true; answer: QueueAnswer } | { ok: false; sentence: string }

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * PURE: the leader's answer. Accepts the raw sentence (`sim`, `nao porque …`, `agendar 2026-11-08T14:00:00Z porque …`; accents,
 * case and `não`/`nao`/`sim`/`yes`/`y` all read) or the structured form the screen sends. A `nao` without a reason, an
 * `agendar` without a valid FUTURE instant or without a reason is refused in a sentence — the card has to say why.
 */
export function parseQueueAnswer(input: unknown, nowMs: number): ParsedAnswer {
  const bad = (sentence: string): ParsedAnswer => ({ ok: false, sentence })
  let word = ''
  let rest = ''
  let at: string | undefined
  if (typeof input === 'string') {
    const m = input.trim().match(/^(\S+)\s*([\s\S]*)$/)
    if (!m) return bad('answer with `sim`, `nao <motivo>` or `agendar <ISO> <motivo>`')
    word = m[1]!; rest = m[2]!.trim()
    if (word.toLowerCase().replace(/[̀-ͯ]/g, '') === 'agendar') {
      const t = rest.match(/^(\S+)\s*([\s\S]*)$/)
      if (!t) return bad('agendar needs an ISO date-time: `agendar 2026-11-08T14:00:00-03:00 <motivo>`')
      at = t[1]; rest = t[2]!.trim()
    }
  } else if (input && typeof input === 'object') {
    const o = input as { decision?: unknown; reason?: unknown; at?: unknown; until?: unknown }
    word = typeof o.decision === 'string' ? o.decision.trim() : ''
    rest = typeof o.reason === 'string' ? o.reason.trim() : ''
    const when = typeof o.until === 'string' ? o.until : typeof o.at === 'string' ? o.at : ''
    at = when.trim() || undefined
  } else return bad('answer with `sim`, `nao <motivo>` or `agendar <ISO> <motivo>`')
  const kind = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (kind === 'sim' || kind === 'y' || kind === 'yes' || kind === 's') return { ok: true, answer: { kind: 'sim' } }
  if (kind === 'nao' || kind === 'n' || kind === 'no') {
    return rest ? { ok: true, answer: { kind: 'nao', reason: rest } } : bad('`nao` needs a reason: `nao <motivo>` — the card shows it')
  }
  if (kind === 'agendar' || kind === 'schedule') {
    if (!at || !ISO.test(at)) return bad('agendar needs an ISO date-time: `agendar 2026-11-08T14:00:00-03:00 <motivo>`')
    const ms = Date.parse(at.replace(' ', 'T'))
    if (!Number.isFinite(ms)) return bad(`"${at}" is not a date-time`)
    if (ms <= nowMs) return bad('agendar needs a FUTURE instant; use `sim` to start now')
    return rest ? { ok: true, answer: { kind: 'agendar', until: new Date(ms).toISOString(), reason: rest } } : bad('`agendar` needs a reason: `agendar <ISO> <motivo>`')
  }
  return bad('answer with `sim`, `nao <motivo>` or `agendar <ISO> <motivo>`')
}

export interface QueuePlan<T extends QueueItem = QueueItem> {
  /** In leaving order: queued, pre-dispatch complete, not held, not under another open question of the same task. */
  candidates: T[]
  /** Asked more than 10 min ago and still unanswered. */
  expired: T[]
  /** Open questions that have not reached the leader's composer yet. */
  undelivered: T[]
}

/**
 * PURE: what one tick looks at. `items` are the queued, non-dequeued, non-group-member pieces with a complete pre-dispatch (the
 * caller filters them). A task with an OPEN question holds its other pieces back: one question per leader at a time.
 */
export function planQueue<T extends QueueItem>(items: readonly T[], nowMs: number): QueuePlan<T> {
  const ordered = orderQueue(items)
  const askedTasks = new Set(ordered.filter(i => i.ask).map(i => i.taskId))
  return {
    candidates: ordered.filter(i => !i.ask && holdState(i.hold, nowMs) === null && !askedTasks.has(i.taskId)),
    expired: ordered.filter(i => i.ask && !i.ask.approved && nowMs - Date.parse(i.ask.at) >= ASK_TIMEOUT_MS),
    undelivered: ordered.filter(i => i.ask && !i.ask.approved && !i.ask.delivered),
  }
}

/** PURE: should a leader be reminded again (autonomous OFF, the question is open past 10 min and the last reminder is too)? */
export function reminderDue(ask: QueueAsk, nowMs: number): boolean {
  if (ask.approved) return false
  const last = Date.parse(ask.remindedAt ?? ask.at)
  return nowMs - Date.parse(ask.at) >= ASK_TIMEOUT_MS && nowMs - last >= ASK_TIMEOUT_MS
}

/** PURE: a spawn claim still counts (a younger one means another tick is opening the session right now). */
export const startClaimLive = (ask: QueueAsk | undefined, nowMs: number): boolean => {
  const t = Date.parse(ask?.startingAt ?? '')
  return Number.isFinite(t) && nowMs - t < START_CLAIM_MS
}

export interface QuestionFacts {
  subtaskId: string
  title: string
  priority: string
  position: number
  total: number
  harness?: string
  model?: string
  effort?: string
  accountName?: string
  why: string
}

const PRIORITY_PT: Record<string, string> = { urgent: 'urgente', high: 'alta', medium: 'média', low: 'baixa' }

/** PURE: the system question typed into the leader's composer. Header first, answer syntax last; no ids except the one to answer with. */
export function questionText(f: QuestionFacts): string {
  const agent = [f.harness, f.model, f.effort, f.accountName ? `conta ${f.accountName}` : null].filter(Boolean).join(' · ')
  return [
    `[${QUEUE_HEADER}]`,
    `Há vaga e o próximo da fila é "${f.title}" (${f.subtaskId}), ${f.position}º de ${f.total}, prioridade ${PRIORITY_PT[f.priority] ?? f.priority}.`,
    agent ? `Vai abrir: ${agent}.` : null,
    `Por que ele: ${f.why}`,
    'Responda com agentistics_task_queue_answer (ou `agentop flow fila responder --subtask ' + f.subtaskId + ' "<resposta>"`):',
    '  sim                       abre a sessão agora',
    '  nao <motivo>              fica na fila com o motivo no cartão; o fluxo passa ao próximo',
    '  agendar <ISO> <motivo>    fica na fila e só volta a ser candidato nessa hora',
    'Sem resposta em 10 min: com o modo autônomo ligado ele segue como sim; desligado, eu espero e lembro.',
  ].filter((l): l is string => l !== null).join('\n')
}

/** PURE: the one-line "why this one", from the facts the flow decided on. */
export function whyNext(o: { priority: string; position: number; total: number; slot: string }): string {
  const rank = o.position === 1 ? 'é o primeiro da fila' : `é o ${o.position}º da fila (os anteriores estão em espera: não, agendados ou sem vaga para o modelo deles)`
  return `prioridade ${PRIORITY_PT[o.priority] ?? o.priority}; ${rank}; ${o.slot}.`
}
