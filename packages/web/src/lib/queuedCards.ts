import { pendingEchoes } from '@agentistics/core'
import { parseSystemEvent } from './systemEvent'

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
