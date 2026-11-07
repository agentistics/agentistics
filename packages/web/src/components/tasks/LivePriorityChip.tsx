/**
 * LivePriorityChip — a card's Agentask priority, read-only. It wears the SAME chip recipe and the SAME colours
 * as the Priority column of the board (`chipStyle` from ChipSelect + `PRIORITY` from board.ts); only the word is
 * translated here, because the Live is read in the reader's language.
 *
 * An absent priority, the legacy `none` and an unknown word all read as `low` — the rule `taskSort.ts` and the
 * server (`migratePriority`) already apply, so the chip, the sort and the book can never disagree.
 */

import { priorityRank, PRIORITY_ORDER, type TaskPriorityId } from '@agentistics/core'
import { PRIORITY } from './board'
import { chipStyle } from './ChipSelect'

const WORD: Record<string, { pt: string; en: string }> = {
  urgent: { pt: 'Urgente', en: 'Urgent' }, high: { pt: 'Alta', en: 'High' }, medium: { pt: 'Média', en: 'Medium' }, low: { pt: 'Baixa', en: 'Low' },
}

/** PURE: the canonical id a chip shows for any stored value. */
export function priorityIdOf(p: string | null | undefined): Exclude<TaskPriorityId, 'none'> {
  return PRIORITY_ORDER[priorityRank(p)] as Exclude<TaskPriorityId, 'none'>
}

export function priorityWord(p: string | null | undefined, pt: boolean): string {
  return WORD[priorityIdOf(p)]![pt ? 'pt' : 'en']
}

export function LivePriorityChip({ priority, pt }: { priority: string | null | undefined; pt: boolean }) {
  const id = priorityIdOf(priority)
  const st = PRIORITY[id]!
  return (
    <span data-live-priority={id} title={`${pt ? 'Prioridade' : 'Priority'}: ${priorityWord(id, pt)}`} style={{ ...chipStyle(st.color, st.dim), height: 18, padding: '0 6px', fontSize: 10.5, borderRadius: 4, flexShrink: 0 }}>
      {priorityWord(id, pt)}
    </span>
  )
}
