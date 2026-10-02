/**
 * sessionTime.ts — how a session's duration is DISPLAYED.
 *
 * Two numbers, never one:
 *   - active  = time actually worked (Σ per-turn, see @agentistics/core activeTime.ts)
 *   - elapsed = wall clock, first event → last event
 *
 * Elapsed alone is what made a session read as "958h 14m". Active alone would hide that the
 * session was reopened across three weeks. So every surface shows the active time as the headline
 * and the elapsed as its qualifier — and when active is unknown (a transcript Claude already
 * deleted, or a harness that records no timing) it says so instead of quietly falling back.
 */

import { format, isValid, parseISO } from 'date-fns'
import { fmtDuration, type SessionMeta } from '@agentistics/core'

export interface SessionTimeDisplay {
  /** Formatted active time, or null when the session carries none. */
  active: string | null
  /** Formatted wall-clock time. Always present. */
  elapsed: string
  /** "3h 12m ativo · 958h decorrido" — the one-line form for chips and table cells. */
  combined: string
  /** Long-form explanation for a `title` tooltip. */
  tooltip: string
  /** The word that names the active figure ("ativo"/"active") — a headline number rendered
   *  without it is unreadable next to the elapsed one. */
  activeLabel: string
  /** The word that names the wall-clock figure ("decorrido"/"elapsed"). */
  elapsedLabel: string
  /** One short line saying what the active figure IS, for display next to the number.
   *  Belongs on the card, not only in a tooltip — a number nobody can name is not information. */
  activeExplain: string
  /** Same, for the wall-clock figure. Says "first to last EVENT", which is what it measures:
   *  the first event of a session is often an attachment or a system line, minutes before the
   *  first message, and the last is often a system line after the final reply. */
  elapsedExplain: string
}

export function sessionTime(
  s: Pick<SessionMeta, 'duration_minutes' | 'active_minutes'> | null | undefined,
  lang: 'pt' | 'en',
): SessionTimeDisplay {
  const pt = lang === 'pt'
  const elapsedMin = s?.duration_minutes ?? 0
  const activeMin = s?.active_minutes
  const elapsed = fmtDuration(elapsedMin * 60_000)
  const active = activeMin === undefined ? null : fmtDuration(activeMin * 60_000)

  const activeWord = pt ? 'ativo' : 'active'
  const elapsedWord = pt ? 'decorrido' : 'elapsed'

  // One-line form for chips and table cells. Each figure carries its word, so the pair is
  // readable without a tooltip; the tooltip then explains what each one measures.
  const combined = active === null
    ? `${elapsed} ${elapsedWord}`
    : `${active} ${activeWord} · ${elapsed} ${elapsedWord}`

  // Headline label. The big number MUST carry its own word: shown bare next to "105h decorrido"
  // it reads as an unlabelled mystery figure, and the reader cannot tell which is which.
  const activeLabel = activeWord
  const elapsedLabel = elapsedWord

  const activeExplain = pt
    ? 'soma da duração de cada turno (seu prompt → o assistente terminar)'
    : "sum of each turn's duration (your prompt → the assistant finishing)"
  const elapsedExplain = pt
    ? 'do primeiro ao último evento da sessão'
    : "first to last event of the session"

  const tooltip = active === null
    ? (pt
      ? `${elapsed} entre o primeiro e o último evento da sessão. O tempo ativo não pôde ser calculado: o transcript desta sessão não está mais disponível.`
      : `${elapsed} between the session's first and last event. Active time could not be computed: this session's transcript is no longer available.`)
    : (pt
      ? `ATIVO ${active}: soma da duração de cada turno (do seu prompt até o assistente terminar). `
        + `Não conta o tempo entre um turno acabar e você mandar o próximo. `
        + `Ainda conta um turno que ficou parado esperando você (ex.: aprovação de permissão).\n`
        + `DECORRIDO ${elapsed}: do primeiro ao último evento da sessão, incluindo dias em que ela ficou só aberta.`
      : `ACTIVE ${active}: the sum of each turn's duration (your prompt until the assistant finishes). `
        + `It excludes the time between a turn ending and your next prompt. `
        + `It still counts a turn that sat waiting on you (e.g. a permission prompt).\n`
        + `ELAPSED ${elapsed}: first to last event of the session, including days it merely stayed open.`)

  return {
    active, elapsed, combined, tooltip,
    activeLabel, elapsedLabel, activeExplain, elapsedExplain,
  }
}

/**
 * When the session was OPENED, in the reader's own clock, or `null` when the record carries no
 * usable start. `null` and not a dash: the caller decides whether a row with nothing to say is
 * drawn at all, and an unparseable value must never reach `format`, which throws on one.
 *
 * It is the `start_time` the drilldown already prints — the first turn the harness recorded — so
 * the two surfaces cannot name different moments for one conversation.
 */
export function sessionOpened(
  startTime: string | null | undefined,
  lang: 'pt' | 'en',
): string | null {
  if (!startTime) return null
  const d = parseISO(startTime)
  if (!isValid(d)) return null
  return format(d, lang === 'pt' ? 'dd/MM/yyyy HH:mm' : 'MMM d, yyyy HH:mm')
}
