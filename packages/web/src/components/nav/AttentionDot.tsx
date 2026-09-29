/**
 * Attention on a FOLDED group: "something in here is waiting on you".
 *
 * A folded group shows only a name and a count, so a session inside it that has stopped to ask
 * something is invisible, and every header looks the same — somebody seeing the list for the first
 * time reads an orange row as decoration. The signal is the group's own LEFT EDGE turning orange
 * and pulsing, softly (`.ag-attn-bar` in `index.css`). It is the group's EXISTING edge that changes
 * colour, never a second element laid over it — an added strip beside the original read as a tab
 * that did not belong to the design. The edge costs no space and moves nothing, and the slow pulse
 * is what says it is a signal and not the layout. (A dot beside the chevron was tried first and it
 * crowded the header.)
 *
 * What counts is exactly what the rest of the product marks as needing a person: a session that is
 * WAITING (a finished turn, or a permission dialog), and never one that is working.
 *
 * DISMISSING it — from the group's own ⋮ menu — answers "I saw this turn". It is held in memory
 * only, so a restart brings it back, and it is forgotten per session the moment that session stops
 * waiting (see `pruneDismissed`), so the NEXT turn that ends waiting counts again.
 */

import type { ControlSession } from '@agentistics/tui/control/session-fleet'

/** True for a session that wants a person: a turn that ended, or a dialog that is open. */
export function needsAttention(s: Pick<ControlSession, 'state'>): boolean {
  return s.state === 'waiting' || s.state === 'waiting-approval'
}

/**
 * How many of these rows want a person and have NOT been dismissed.
 *
 * `dismissed` holds session ids. It is cleared per session the moment that session stops waiting
 * (see `pruneDismissed`), so the NEXT time it waits it counts again — a dismissal answers "I saw
 * this turn", never "never tell me about this session".
 */
export function attentionCount(
  rows: readonly Pick<ControlSession, 'id' | 'state'>[],
  dismissed?: ReadonlySet<string>,
): number {
  let n = 0
  for (const r of rows) if (needsAttention(r) && !(dismissed?.has(r.id))) n++
  return n
}

/** The ids of `rows` that count right now — what a dismiss writes down. */
export function attentionIds(
  rows: readonly Pick<ControlSession, 'id' | 'state'>[],
  dismissed?: ReadonlySet<string>,
): string[] {
  return rows.filter(r => needsAttention(r) && !(dismissed?.has(r.id))).map(r => r.id)
}

/**
 * Forget every dismissal whose session is not waiting any more. Returns the same set when nothing
 * changed, so a caller can skip a state update.
 */
export function pruneDismissed(
  dismissed: ReadonlySet<string>,
  rows: readonly Pick<ControlSession, 'id' | 'state'>[],
): ReadonlySet<string> {
  if (dismissed.size === 0) return dismissed
  const waiting = new Set(rows.filter(needsAttention).map(r => r.id))
  let changed = false
  const next = new Set<string>()
  for (const id of dismissed) {
    if (waiting.has(id)) next.add(id)
    else changed = true
  }
  return changed ? next : dismissed
}

/** Makes a folded group's OWN left edge breathe to orange (see `index.css`, `.ag-attn-bar`). */
export const ATTN_BAR_CLASS = 'ag-attn-bar'
/** The same signal on an automatic band's heading, which has no edge: its count breathes instead. */
export const ATTN_COUNT_CLASS = 'ag-attn-count'
