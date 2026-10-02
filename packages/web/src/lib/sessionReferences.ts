/**
 * sessionReferences.ts — PURE: the "References" section of the session metrics card.
 *
 * Everything on that card that is a LINK — somewhere to go from the figures — is gathered into one
 * list at its foot instead of being scattered through it (the delivery at the top, the way to the
 * full reading at the bottom). This module decides WHICH rows exist, in what order and with what
 * words; the component only draws what it returns, and never asks "is there a delivery" itself.
 *
 * **A ROW EXISTS ONLY WHEN IT CAN DO WHAT IT SAYS.** A link to a tab that is not there, or to a
 * delivery the session is not filed under, is the dead control this product refuses everywhere, so
 * an unavailable row is ABSENT rather than disabled, and a list with nothing in it is EMPTY — the
 * caller then draws no heading over nothing.
 *
 * **THE LIVE ROW STATES WHAT IS RUNNING, AND OPENS THAT.** `live` is the edge strip's own fact
 * (`currentAction`, the newest event whose turn has not finished), so a session running `bun test`
 * says so here and the press lands on that command's row; one delegating to a subagent says that
 * and lands on the delegation. With nothing in flight the row is still a link to the Live tab —
 * the feed of what the session did is worth opening when nothing is happening right now — but it
 * then names nothing, because "nothing is running" is a claim only the conversation can back and
 * this list may be looking at one that is not being read (the terminal view).
 */

import { sessionTaskLink } from './sessionTaskLink'
import type { EdgeHint } from './artifactLayout'

/**
 * The verb for what is in flight, in the words the edge strip uses.
 *
 * `used` — a tool no rule above recognised, MCP calls being all of them — has a verb here that the
 * strip's own table lacks, so this row never reads `undefined · <tool>`.
 */
const LIVE_VERB: Record<EdgeHint['kind'], { pt: string; en: string }> = {
  wrote: { pt: 'escrevendo', en: 'writing' },
  read: { pt: 'lendo', en: 'reading' },
  ran: { pt: 'rodando', en: 'running' },
  thought: { pt: 'pensando', en: 'thinking' },
  delegated: { pt: 'delegando', en: 'delegating' },
  used: { pt: 'usando', en: 'using' },
}

export function liveVerb(kind: EdgeHint['kind'], pt: boolean): string {
  return pt ? LIVE_VERB[kind].pt : LIVE_VERB[kind].en
}

/** What pressing a row does. `null` on a row that only NAMES something (see `task`). */
export type ReferenceAction =
  | { type: 'task'; ref: string }
  /** `ref` names the step to land on; absent opens the feed from the top. */
  | { type: 'live'; ref?: string }
  | { type: 'full' }

export interface SessionReference {
  id: 'task' | 'live' | 'full'
  /** The row's own name, always present. */
  label: string
  /** The second line: the delivery's name, or what is in flight. Absent when there is nothing true to say. */
  detail?: string
  /** For a live row, the verb that leads `detail` — drawn apart from it, in accent. */
  detailVerb?: string
  /** `null`: the row names something and there is nowhere to go. */
  action: ReferenceAction | null
}

export interface ReferencesInput {
  pt: boolean
  /** The delivery's name off the fleet row — absent when the session is filed under nothing. */
  task?: string | undefined
  canOpenTask: boolean
  /** Can this surface open the aside's Live tab? Absent surfaces get no row. */
  canOpenLive: boolean
  /** What is in flight right now, or `null` — `currentAction`'s answer. */
  live: EdgeHint | null
  /** The full reading — withheld by the caller when the store has no record of the conversation. */
  canOpenFull: boolean
}

/**
 * The rows, in the order they are drawn: the WORK (delivery), what it is doing NOW (live), and the
 * full reading of what it spent. Empty when none applies.
 */
export function sessionReferences(input: ReferencesInput): SessionReference[] {
  const { pt } = input
  const rows: SessionReference[] = []

  const link = sessionTaskLink(input.task, input.canOpenTask)
  if (link.kind !== 'none') {
    rows.push({
      id: 'task',
      label: pt ? 'Tarefa' : 'Task',
      detail: link.title,
      action: link.kind === 'link' ? { type: 'task', ref: link.title } : null,
    })
  }

  if (input.canOpenLive) {
    const live = input.live
    const detail = live?.text.trim()
    rows.push({
      id: 'live',
      label: pt ? 'Ao vivo' : 'Live',
      // A live event with no text (it happens: a tool whose name was all there was to say) still
      // has a verb, so the verb alone is what is stated rather than nothing.
      ...(live ? { detailVerb: liveVerb(live.kind, pt) } : {}),
      ...(live && detail ? { detail } : {}),
      // `ref` is omitted, not empty, when the event has none — see `EdgeHint.ref`.
      action: { type: 'live', ...(live?.ref ? { ref: live.ref } : {}) },
    })
  }

  if (input.canOpenFull) {
    rows.push({
      id: 'full',
      label: pt ? 'Métricas completas' : 'Full metrics',
      detail: pt ? 'abre a aba Métricas no painel' : 'opens the Metrics tab in the panel',
      action: { type: 'full' },
    })
  }

  return rows
}
