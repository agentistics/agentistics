/**
 * PURE: how a folder's sessions are laid out — what is running first, what ended behind one
 * collapsible row, and BOTH blocks ordered by the aside's chosen sort ("Ordenar sessões por" plus
 * "Inverter a ordem"). A folder used to list its members in stored order, which ignored the sort and
 * buried the few live sessions among dozens of ended ones.
 */
import { sortSessions, type SessionOrder } from '@agentistics/tui/control/session-order'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

export interface FolderRows {
  live: ControlSession[]
  ended: ControlSession[]
}

export function splitFolderRows(
  rows: readonly ControlSession[],
  isActive: (s: ControlSession) => boolean,
  order: SessionOrder,
): FolderRows {
  return {
    live: sortSessions(rows.filter(isActive), order),
    ended: sortSessions(rows.filter(r => !isActive(r)), order),
  }
}
