/**
 * owner-questions.ts — FLUXO.CICLO-COMPLETO item 7(b): an owner QUESTION to a leader is not a request.
 *
 * Measured (s-1d57ab4c2b, «quando sai as coisas?»): the leader answered in the same turn, and the question still became a pedido,
 * a staged piece (`encaixe-do-pedido` places a pedido the moment it is registered when the leader is busy) and a 10-minute
 * reminder. The engine registers and places in ONE dispatch, so the only sound place to stop it is BEFORE the `owner.message` is
 * emitted: a message `classifyOwnerMessage` calls a question is HELD here instead, and the minute tick resolves it:
 *
 *   - the leader's reply lands after it (assistant text after that very turn) → `answered`, with the reply's tail: never a pedido,
 *     never a piece, never a reminder;
 *   - no reply 30 minutes after it was asked → `promoted`: emitted exactly as an ordinary request (same conversation, same
 *     instant, so the pedido id is the one the composer would have made), and the request flow takes over unchanged.
 *
 * Work requests never pass through here. `resolveQuestion` is pure; the IO is injected.
 */
import type { DeliveryStore, OwnerQuestion } from '../delivery/store'

export const QUESTION_PROMOTE_MS = 30 * 60_000
/** Resolved questions are kept this long (the Live/MCP can still say "answered"), then dropped. */
export const QUESTION_KEEP_MS = 7 * 24 * 3600_000
/** The question's own turn is looked for from a little before the moment the composer recorded it (clock skew). */
const TURN_SKEW_MS = 5 * 60_000
const NOTE_MAX = 280

export interface QuestionTurn { role: string; text: string; at?: string; system?: unknown }

export type QuestionVerdict = { kind: 'answered'; at: string; note: string } | { kind: 'promote' } | { kind: 'wait' }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * PURE. The question's turn is the LAST user turn carrying its text, at or after the moment it was asked (minus a small skew);
 * it is answered when assistant TEXT follows that turn (a tool-only step is not an answer). No turns (an unreadable
 * conversation) and no answer both wait until the promotion time.
 */
export function resolveQuestion(q: Pick<OwnerQuestion, 'text' | 'at'>, turns: readonly QuestionTurn[] | null, nowMs: number): QuestionVerdict {
  const askedMs = Date.parse(q.at)
  if (turns) {
    const want = norm(q.text)
    let idx = -1
    turns.forEach((t, i) => {
      if (t.role !== 'user' || t.system) return
      const at = Date.parse(t.at ?? '')
      if (Number.isFinite(askedMs) && Number.isFinite(at) && at < askedMs - TURN_SKEW_MS) return
      const text = norm(t.text)
      if (text === want || text.endsWith(want)) idx = i
    })
    if (idx >= 0) {
      const replies = turns.slice(idx + 1).filter(t => t.role === 'assistant' && t.text.trim())
      if (replies.length) {
        const joined = replies.map(t => t.text.trim()).join('\n\n')
        const note = joined.length > NOTE_MAX ? `[…] ${joined.slice(joined.length - NOTE_MAX)}` : joined
        return { kind: 'answered', at: replies[0]!.at ?? new Date(nowMs).toISOString(), note }
      }
    }
  }
  return Number.isFinite(askedMs) && nowMs - askedMs >= QUESTION_PROMOTE_MS ? { kind: 'promote' } : { kind: 'wait' }
}

/** Hold a question (idempotent by id: the same composer send recorded twice is one question). */
export async function holdOwnerQuestion(store: DeliveryStore, q: Omit<OwnerQuestion, 'state'>): Promise<void> {
  await store.update(doc => {
    const all = doc.ownerQuestions ??= {}
    all[q.id] ??= { ...q, state: 'waiting' }
  })
}

export interface QuestionsTickDeps {
  store: DeliveryStore
  now(): number
  /** The conversation of the session the question went to; null = could not be read now. */
  turns(q: OwnerQuestion): Promise<readonly QuestionTurn[] | null>
  /** Emit the question as an ordinary owner request (the existing path). true = recorded. */
  promote(q: OwnerQuestion): Promise<boolean>
}

/** The minute tick's half: resolve every waiting question, drop old resolved ones. Returns the actions taken. */
export async function questionsTick(d: QuestionsTickDeps): Promise<string[]> {
  const actions: string[] = []
  const doc = await d.store.read()
  const all = Object.values(doc.ownerQuestions ?? {})
  const nowMs = d.now()
  const stale = all.filter(q => q.state !== 'waiting' && nowMs - Date.parse(q.answer?.at ?? q.promotedAt ?? q.at) > QUESTION_KEEP_MS).map(q => q.id)
  if (stale.length) await d.store.update(x => { for (const id of stale) delete x.ownerQuestions?.[id] })
  for (const q of all.filter(x => x.state === 'waiting')) {
    const v = resolveQuestion(q, await d.turns(q).catch(() => null), nowMs)
    if (v.kind === 'wait') continue
    if (v.kind === 'answered') {
      await d.store.update(x => { const c = x.ownerQuestions?.[q.id]; if (c?.state === 'waiting') { c.state = 'answered'; c.answer = { at: v.at, note: v.note } } })
      actions.push(`question-answered ${q.id}`)
      continue
    }
    const ok = await d.promote(q).catch(() => false)
    if (ok) await d.store.update(x => { const c = x.ownerQuestions?.[q.id]; if (c?.state === 'waiting') { c.state = 'promoted'; c.promotedAt = new Date(nowMs).toISOString() } })
    actions.push(`${ok ? 'question-promoted' : 'question-promote-failed'} ${q.id}`)
  }
  return actions
}
