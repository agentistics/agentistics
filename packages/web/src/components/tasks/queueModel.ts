/**
 * queueModel — the PURE half of the task page's "Fila" tab (FILA.PRIORIDADE).
 *
 * The data is `GET /api/deliveries/queue/<taskId>` — the same view the Live card, the CLI and the MCP read — so this file
 * holds no rule about ORDER or ELIGIBILITY (the server decides and numbers each row); it only says things in words a
 * person reads: why a piece is waiting, when a scheduled one starts, what the leader was asked.
 */
import { humanSlotReason } from './liveCardModel'
import { clock, startsLine } from './queueTime'

type Pt = boolean

export interface QueueMember { id: string; title: string; status: string }
export interface QueueNote { author: string; at: string; body: string }
export interface QueueRow {
  subtaskId: string; taskId: string; title: string; taskTitle: string
  priority: string
  position: number; globalPosition: number
  since: string
  group: { members: QueueMember[] } | null
  predispatch: { ok: boolean; missing?: string[]; harness: string | null; model: string | null; effort: string | null; account: string | null; accountName: string | null; cwd: string | null; prompt: string }
  slot: { ok: boolean; reason: string | null; at: string } | null
  hold: { kind: 'nao' | 'agendar'; reason: string; at: string; actor: string; until?: string; active: boolean } | null
  ask: { at: string; delivered: boolean; approved: boolean; expiresAt: string; leaderSessionId?: string; onTimeout: 'sim' | 'esperar' } | null
  leaderSessionId: string | null; leaderAlive: boolean
  notes: { total: number; last: QueueNote[] }
}
export interface QueueRecent { subtaskId: string; taskId: string; title: string; phase: string; at: string; actor: string; auto: boolean; sessionId: string | null }
export interface QueueReply { generatedAt: string; autonomous: boolean; total: number; items: QueueRow[]; recent: QueueRecent[] }

const two = (n: number) => String(n).padStart(2, '0')
export { clock, startsLine }

export type RowTone = 'wait' | 'ask' | 'hold' | 'ready' | 'approved'

/** PURE: the one-line state of a queued piece, strongest fact first (a hold beats a question beats a slot verdict). */
export function stateLine(r: QueueRow, nowMs: number, pt: Pt, accountName?: (h: string, a: string) => string): { text: string; tone: RowTone } {
  if (r.hold?.active) {
    return r.hold.kind === 'nao'
      ? { text: pt ? `não por enquanto: ${r.hold.reason}` : `not for now: ${r.hold.reason}`, tone: 'hold' }
      : { text: `${startsLine(r.hold.until ?? '', nowMs, pt)} · ${r.hold.reason}`, tone: 'hold' }
  }
  if (r.ask?.approved) return { text: pt ? 'aprovada — abre quando houver vaga' : 'approved — opens when a slot is free', tone: 'approved' }
  if (r.ask) {
    const left = Math.max(0, Math.ceil((Date.parse(r.ask.expiresAt) - nowMs) / 60_000))
    const tail = r.ask.onTimeout === 'sim'
      ? (pt ? (left > 0 ? `sem resposta em ${left} min segue como sim` : 'sem resposta, segue como sim') : (left > 0 ? `no answer in ${left} min carries on as yes` : 'no answer, carrying on as yes'))
      : (pt ? 'o modo autônomo está desligado: espera a resposta' : 'autonomous mode is off: waiting for the answer')
    return { text: `${r.ask.delivered ? (pt ? 'perguntei ao líder' : 'asked the leader') : (pt ? 'pergunta ao líder ainda não entregue' : 'question not delivered yet')} · ${tail}`, tone: 'ask' }
  }
  if (!r.predispatch.ok) return { text: pt ? `pré-dispatch incompleto: ${(r.predispatch.missing ?? []).join(', ')}` : `pre-dispatch incomplete: ${(r.predispatch.missing ?? []).join(', ')}`, tone: 'wait' }
  if (!r.slot) return { text: pt ? 'vaga: ainda não checada' : 'slot: not checked yet', tone: 'wait' }
  if (!r.slot.ok) return { text: humanSlotReason(r.slot.reason, pt, accountName), tone: 'wait' }
  return { text: pt ? 'vaga livre agora — espera a vez' : 'slot free now — waiting its turn', tone: 'ready' }
}

/** PURE: "claude · opus · high · conta Vini" — a field nobody staged is left out, never guessed. */
export function predispatchLine(p: QueueRow['predispatch'], pt: Pt): string {
  return [p.harness, p.model, p.effort, p.accountName ? `${pt ? 'conta' : 'account'} ${p.accountName}` : null].filter(Boolean).join(' · ')
}

/** PURE: a collapsed brief — the first lines up to `max` characters, and whether anything was cut. */
export function briefPreview(prompt: string, max = 220): { short: string; cut: boolean } {
  const flat = prompt.trim().replace(/\s*\n+\s*/g, ' · ')
  return flat.length <= max ? { short: flat, cut: false } : { short: `${flat.slice(0, max).trimEnd()}…`, cut: true }
}

/** PURE: the folder in a short form ("…/fila-prioridade") so a long worktree path never widens the row. */
export function shortCwd(cwd: string | null): string | null {
  if (!cwd) return null
  const parts = cwd.split('/').filter(Boolean)
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`
}

/** PURE: the datetime-local value (local clock, no zone) for an instant. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`
}

/** PURE: the ISO the server wants, from a datetime-local value; null when it is empty, invalid or not in the future. */
export function scheduleIso(local: string, nowMs: number): string | null {
  if (!local) return null
  const ms = new Date(local).getTime()
  return Number.isFinite(ms) && ms > nowMs ? new Date(ms).toISOString() : null
}

export type QueueAction = 'start' | 'schedule' | 'dequeue'

/** PURE: the request body for each of the tab's actions — the same doors the CLI and the MCP use. */
export function actionRequest(action: QueueAction, o: { reason?: string; untilIso?: string }): { body: Record<string, unknown> } | { error: string } {
  const reason = (o.reason ?? '').trim()
  if (action === 'start') return { body: { action: 'queue-answer', answer: 'sim' } }
  if (action === 'dequeue') return reason ? { body: { action: 'dequeue', reason } } : { error: 'reason' }
  if (!o.untilIso) return { error: 'when' }
  return reason ? { body: { action: 'queue-answer', answer: `agendar ${o.untilIso} ${reason}` } } : { error: 'reason' }
}
