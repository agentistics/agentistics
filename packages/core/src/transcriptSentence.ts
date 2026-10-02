/**
 * transcriptSentence.ts — the EN/PT sentence for a transcript that is not `present`. Rendering, not
 * contract: the state itself is `canonical/transcript.ts`.
 */
import { TRANSCRIPT_RETENTION, type TranscriptAvailability } from './canonical/transcript'
import type { HarnessId } from './types'

const day = (iso: string, lang: 'pt' | 'en') =>
  new Date(iso).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', {
    day: '2-digit', month: lang === 'pt' ? '2-digit' : 'short', year: 'numeric',
  })

/** The sentence for a state that is not `present`, or `null` for one that needs none. */
export function transcriptSentence(
  a: TranscriptAvailability,
  lang: 'pt' | 'en',
  harness: string,
  lastActivityMs?: number,
): string | null {
  const pt = lang === 'pt'
  switch (a.state) {
    case 'present':
    case 'not-yet-written':
      return null
    case 'expired': {
      const who = TRANSCRIPT_RETENTION[harness as HarnessId]?.who ?? harness
      const last = lastActivityMs !== undefined ? day(new Date(lastActivityMs).toISOString(), lang) : null
      const when = day(a.expiredAt!, lang)
      return pt
        ? `Esta conversa expirou. O ${who} apaga as transcrições ${a.retentionDays} dias depois da última atividade`
          + `${last ? ` (aqui, ${last})` : ''}, então a transcrição foi removida por volta de ${when} e não está mais nesta máquina.`
        : `This conversation has expired. ${who} deletes transcripts ${a.retentionDays} days after the last activity`
          + `${last ? ` (here, ${last})` : ''}, so the transcript was removed around ${when} and is no longer on this machine.`
    }
    case 'deleted':
      return pt
        ? 'A transcrição desta conversa não está mais nesta máquina, e não há uma regra de expiração conhecida que explique isso — ela foi removida por outro meio.'
        : 'This conversation’s transcript is no longer on this machine, and no known expiry rule explains it — it was removed some other way.'
    case 'unreadable':
      return pt
        ? 'A transcrição desta conversa foi encontrada nesta máquina, mas não pôde ser lida.'
        : 'This conversation’s transcript was found on this machine, but could not be read.'
  }
}
