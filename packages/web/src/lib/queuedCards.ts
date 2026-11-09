import { pendingEchoes } from '@agentistics/core'
import { parseSystemEvent } from './systemEvent'
import { sendNowShown } from './promptHistory'

/**
 * FLUXO.AVISOS 10 — the actions a QUEUED message's own caption offers ("entregue à sessão — ela lê ao terminar o turno").
 * A queued message used to say it was waiting and give no way to stop waiting from where the person was looking; the only
 * "send now" lived in a pill under the whole conversation, claude-only. Each action is offered only where it can work:
 *  - `sendNow`: the existing sendNow verb — claude, mid-turn, no dialog open, and this card is the PERSON's own message
 *    (the harness submits its whole queue; the hint says so). No other harness has a measured keystroke, so none shows it.
 *  - `interrupt`: the existing stop verb — any harness whose row offers it enabled, mid-turn, no dialog open: the turn
 *    ends and the session reads what was waiting.
 * Hidden — never disabled-and-explained — otherwise: a control that cannot work is a control that teaches the wrong thing.
 */
export interface QueuedBubbleActions {
  sendNow: { label: string; hint: string } | null
  interrupt: { label: string; hint: string } | null
}

export function queuedBubbleActions(i: {
  text: string
  harness: string
  working: boolean
  dialogOpen: boolean
  /** The person's messages in the queue (system notices excluded) — the count the whole-queue hint speaks of. */
  personQueued: number
  sendNowRunning: boolean
  stopEnabled: boolean
  pt: boolean
}): QueuedBubbleActions {
  const person = parseSystemEvent(i.text) === null
  const pt = i.pt
  const sendNow = person && !i.sendNowRunning
    && sendNowShown({ harness: i.harness, working: i.working, queuedCount: i.personQueued, dialogOpen: i.dialogOpen })
  const interrupt = person && i.working && i.stopEnabled && !i.dialogOpen
  return {
    sendNow: sendNow ? {
      label: pt ? 'Enviar agora' : 'Send now',
      hint: i.personQueued > 1
        ? (pt ? `Envia agora as ${i.personQueued} mensagens da fila, em ordem — não só esta.` : `Sends all ${i.personQueued} queued messages now, in order — not only this one.`)
        : (pt ? 'Envia agora esta mensagem, sem esperar o fim do turno.' : 'Sends this message now, without waiting for the turn to end.'),
    } : null,
    interrupt: interrupt ? {
      label: pt ? 'Interromper' : 'Interrupt',
      hint: pt ? 'Para o turno atual; a sessão lê esta mensagem em seguida.' : 'Stops the current turn; the session reads this message next.',
    } : null,
  }
}

/**
 * The pill under the conversation. A single waiting message already carries its own "Send now"
 * (`queuedBubbleActions`), so drawing the pill too showed two buttons for one message. The pill is
 * for two or more, where it is the one control that says it sends the whole queue. `shown` is the
 * same per-harness rule (`sendNowShown`) both buttons obey, so no harness loses the action.
 */
export function sendNowPillOffered(shown: boolean, personQueued: number): boolean {
  return shown && personQueued >= 2
}

export interface QueuedCard { text: string; at?: number }

/** Only the person's messages offer send-now; injected notices still appear in the queue. */
export function personQueuedCount(queued: readonly QueuedCard[]): number {
  return queued.filter(q => parseSystemEvent(q.text) === null).length
}

/**
 * Which "delivered — not read yet" cards to draw.
 *
 * Until THIS session's transcript has loaded at least once, `userTurns` is empty or partial, so
 * nothing can be reconciled and a message the session already consumed would flash as unread.
 * Draw nothing until then except `local` — texts sent from this mount (an echo restored from
 * storage is NOT local: it may have been consumed while nobody watched). Afterwards the usual
 * containment rule (`pendingEchoes`) decides.
 */
export function visibleQueued(
  queued: QueuedCard[],
  userTurns: string[],
  transcriptLoaded: boolean,
  delivered: ReadonlySet<string> = new Set(),
  local: ReadonlySet<string> = new Set(),
): QueuedCard[] {
  // A message sent in THIS mount cannot have been consumed before it existed, so its card never
  // waits for the first transcript read; only the server's older copies do.
  if (!transcriptLoaded) return queued.filter(q => local.has(q.text) && !delivered.has(q.text))
  const still = new Set(pendingEchoes(queued.map(q => q.text), userTurns))
  return queued.filter(q => still.has(q.text) && !delivered.has(q.text))
}

/**
 * A send reported failure, but the server's own queue already holds the very text: the message DID
 * reach the conversation (it is drawn as "delivered — not read yet"). Handing the words back to the
 * composer would leave the same text sitting there beside its own delivered card, so a resend
 * duplicates it. Only a failure with no copy on the server restores the draft.
 */
export function shouldRestoreDraft(pending: { text: string }[] | undefined, sent: string): boolean {
  return !(pending ?? []).some(p => p.text === sent)
}
