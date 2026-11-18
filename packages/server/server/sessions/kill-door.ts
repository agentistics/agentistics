/**
 * The web/cockpit kill, with the hold guard.
 *
 * The owner pressing "end session" on a session something live is using is not the same as pressing it on an idle
 * one: the button cuts it off. So the first press is REFUSED, in words, with `held: true`; the surface asks once more
 * ("end anyway?") and re-sends with `force: true`, which cuts it off on purpose. Nothing is killed, flushed or recorded
 * on the refused press. The same guard (`killAndRetireSession`) stands behind this one, so a hold that starts in
 * between is seen too.
 */
import type { HoldObservation } from './retire-plan'
import { HoldError, observeHoldNow } from './hold-guard'

export interface HeldRefusal { ok: false; message: string; held: true }

/** The sentence a surface shows (and asks "end anyway?" over): the engine's own words for what holds it. PURE. */
export function heldSentence(hold: Exclude<HoldObservation, { state: 'none' }>, lang: 'en' | 'pt', now: number = Date.now()): string {
  const pt = lang === 'pt'
  if (hold.state === 'unknown') {
    return pt ? 'Não consegui saber se esta sessão está em uso agora. Encerrar mesmo assim pode cortar o que a usa.'
      : 'Could not tell whether this session is in use right now. Ending it anyway may cut off whatever uses it.'
  }
  const mins = Math.max(0, Math.round((now - hold.since) / 60_000))
  return pt ? `Esta sessão está em uso agora: ${hold.sentence.pt} (há ${mins} min). Encerrar corta o que a usa.`
    : `This session is in use right now: ${hold.sentence.en} (${mins} min ago). Ending it cuts off whatever uses it.`
}

export const heldRefusal = (hold: Exclude<HoldObservation, { state: 'none' }>, lang: 'en' | 'pt', now?: number): HeldRefusal =>
  ({ ok: false, message: heldSentence(hold, lang, now), held: true })

/** `null` = free to go on (nothing holds it, or `force`). Asked BEFORE anything else happens on a kill (a flush, a prompt to the successor). */
export async function refuseIfHeld(
  row: { id: string; conversationId?: string },
  o: { force: boolean; lang: 'en' | 'pt'; observe?: (row: { id: string; conversationId?: string }) => Promise<HoldObservation>; now?: () => number },
): Promise<HeldRefusal | null> {
  if (o.force) return null
  const hold = await (o.observe ?? observeHoldNow)(row).catch((): HoldObservation => ({ state: 'unknown' }))
  return hold.state === 'none' ? null : heldRefusal(hold, o.lang, o.now?.())
}

/** A `HoldError` out of `killAndRetireSession` (a hold started since the pre-check) as the same refusal; anything else rethrown. */
export function heldAsRefusal(e: unknown, lang: 'en' | 'pt'): HeldRefusal {
  if (e instanceof HoldError) return heldRefusal(e.hold, lang)
  throw e
}
