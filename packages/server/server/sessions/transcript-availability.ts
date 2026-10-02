/**
 * transcript-availability.ts — PURE. Whether a session's transcript can be read, and WHY not.
 *
 * `chat-web.ts` used to answer every missing transcript with one sentence ("not found on this
 * machine"), which is four different facts:
 *
 *  - `not-yet-written`: the session is alive and has not said anything, so the harness has written
 *    no file yet. Temporary, and the one case where the composer must still be offered — sending the
 *    first message is what creates the file.
 *  - `expired`: the harness DELETES transcripts after a retention period, the period has passed
 *    since the conversation's last activity, and this says WHEN. Claude Code removes transcripts
 *    older than `cleanupPeriodDays` (30 by default) on every startup, so a person opening a month-old
 *    conversation was told the file "was not found", which reads as a bug in this product.
 *  - `deleted`: the file is gone and there is no retention rule that explains it. Said as exactly
 *    that: nobody removed it on a schedule this product knows about.
 *  - `unreadable`: the file is there and could not be read.
 *
 * `expired` is claimed ONLY for a harness whose retention rule has been established (a table below,
 * with its source), and only when the arithmetic agrees: a retention period that has not yet
 * elapsed cannot be the reason, and a date computed from a rule nobody verified would be a confident
 * wrong answer. Everything else that is missing is `deleted`, which makes no claim about why.
 *
 * Shaped so it can be lifted into `@agentistics/core/canonical` as an additive change: the names
 * (`TranscriptState`, `expiredAt`, one reason code per state) are the runtime leader's, so the lift
 * is a move and not a rename. The sentences are rendered here, in one place, for every harness.
 */

import type { HarnessId } from '@agentistics/core'

export type TranscriptState = 'present' | 'not-yet-written' | 'expired' | 'deleted' | 'unreadable'

export type TranscriptReason =
  | 'resolved'
  | 'live-no-file-yet'
  | 'past-retention'
  | 'no-file-found'
  | 'read-failed'

export interface TranscriptAvailability {
  state: TranscriptState
  reason: TranscriptReason
  /** ISO instant the retention rule says the transcript was removed. Only on `expired`. */
  expiredAt?: string
  /** The retention period behind `expired`, in days. Only on `expired`. */
  retentionDays?: number
}

/**
 * How long each harness keeps a transcript, or `null` when nobody has established a rule.
 *
 * claude: `cleanupPeriodDays`, 30 by default, applied on every startup — https://code.claude.com/docs/en/settings
 * (also recorded in `config.ts` and `transcript-path-memo.ts`). The caller may pass the user's own
 * setting; the default is only what applies when the setting is absent.
 *
 * Every other harness is `null`, and that is a finding and not a gap: none of them has been measured
 * deleting its own transcripts, and a guessed period would produce an `expiredAt` nobody can check.
 */
export const TRANSCRIPT_RETENTION: Record<HarnessId, { days: number; who: string } | null> = {
  claude: { days: 30, who: 'Claude Code' },
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
  opencode: null,
}

const DAY_MS = 86_400_000

export function transcriptAvailability(o: {
  harness: string
  /** The resolver found a file. */
  resolved: boolean
  /** The file was found and reading it failed. */
  readFailed?: boolean
  /** The session is running. */
  live: boolean
  /** The conversation's last activity, ms epoch. */
  lastActivityMs?: number
  nowMs: number
  /** The user's own retention setting for this harness, in days, when one is recorded. */
  retentionDays?: number
}): TranscriptAvailability {
  if (o.resolved) {
    return o.readFailed
      ? { state: 'unreadable', reason: 'read-failed' }
      : { state: 'present', reason: 'resolved' }
  }
  if (o.live) return { state: 'not-yet-written', reason: 'live-no-file-yet' }

  const rule = TRANSCRIPT_RETENTION[o.harness as HarnessId] ?? null
  if (rule && o.lastActivityMs !== undefined && Number.isFinite(o.lastActivityMs)) {
    const days = o.retentionDays !== undefined && o.retentionDays > 0 ? o.retentionDays : rule.days
    const at = o.lastActivityMs + days * DAY_MS
    if (o.nowMs >= at) {
      return { state: 'expired', reason: 'past-retention', expiredAt: new Date(at).toISOString(), retentionDays: days }
    }
  }
  return { state: 'deleted', reason: 'no-file-found' }
}

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
