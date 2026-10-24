/**
 * teamMenu.ts — PURE (plus one fetch). The person's manual team gestures in the sessions aside:
 * "Tirar da equipe" (take a session out of its leader's team) and "Mover para a equipe de…" (pick a
 * leader). The rule lives on the server (`sessions/team-links.ts`, `POST /api/session-team`); this
 * module only decides which entries a row's menu shows, and what a "No leader" row says about itself.
 */

import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { MenuEntry } from './rowMenu'
import { createdByLabel, sessionParent } from './sessionParent'
import { sessionDisplayTitle } from './sessionDisplayTitle'
import { isChildOf } from './asideTabs'

export const TEAM_UNLINK = 'team-unlink'
export const TEAM_MOVE = 'team-move'

type Row = Pick<ControlSession, 'id' | 'conversationId' | 'title' | 'state' | 'parentSessionId' | 'parentConversationId'>

/** The leaders a row can be moved under: every live leader except itself and the one it is already with. */
export function teamLeaderChoices<R extends Row>(row: Row, leaders: readonly R[]): R[] {
  return leaders.filter(l => l.id !== row.id && !isChildOf(row, l))
}

/**
 * The row menu's team entries. A leader gets none: it sits at the root with the other leaders and is
 * never part of a team (changing that is the "Type" entries' job). The move entry is disabled, with
 * the reason, when there is no other leader to move to.
 */
export function teamMenuExtras(row: Row | undefined, isLeader: boolean, leaders: readonly Row[], pt: boolean): MenuEntry[] {
  if (!row || isLeader) return []
  const inTeam = !!(row.parentSessionId || row.parentConversationId)
  const choices = teamLeaderChoices(row, leaders)
  return [
    ...(inTeam ? [{ action: TEAM_UNLINK, label: pt ? 'Tirar da equipe' : 'Take out of the team', enabled: true, separatorBefore: true }] : []),
    {
      action: TEAM_MOVE,
      label: pt ? 'Mover para a equipe de…' : "Move to a leader's team…",
      enabled: choices.length > 0,
      ...(inTeam ? {} : { separatorBefore: true }),
      ...(choices.length === 0 ? { reason: pt ? 'Não há outro líder ativo.' : 'There is no other live leader.' } : {}),
    },
  ]
}

/** The picker's entries: one per leader, by its display title. */
export function leaderPickerEntries(row: Row, leaders: readonly Row[], pt: boolean): MenuEntry[] {
  return teamLeaderChoices(row, leaders).map(l => ({ action: l.id, label: sessionDisplayTitle(l.title), enabled: true, leader: true, leaderLabel: pt ? 'Líder' : 'Leader' }))
}

/**
 * What a "No leader" row says about itself, under its title: its project, and who started it when
 * that is known ("criada por Motor") — so an orphan can be told apart without opening it.
 */
export function looseFacts(
  row: Pick<ControlSession, 'project' | 'projectGroup' | 'parentSessionId' | 'parentConversationId'>,
  rows: readonly Pick<ControlSession, 'id' | 'conversationId' | 'title'>[],
  pt: boolean,
): string {
  const out: string[] = []
  const project = row.projectGroup || row.project
  if (project) out.push(project)
  // Only a parent the fleet can still NAME: a bare id ("criada por 53015bf9") identifies nothing.
  const parent = sessionParent(row, rows)
  if (parent?.title) out.push(createdByLabel({ ...parent, ...(parent.title ? { title: sessionDisplayTitle(parent.title) } : {}) }, pt))
  return out.join(' · ')
}

/** `POST /api/session-team`. `leader: null` takes the session out of its team. Never throws. */
export async function moveSessionTeam(id: string, leader: string | null, lang: 'pt' | 'en'): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch('/api/session-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, leader, lang }),
    })
    const out = await res.json().catch(() => ({})) as { ok?: boolean; message?: string }
    return { ok: out.ok === true, message: out.message ?? (lang === 'pt' ? 'Não foi possível mover a sessão.' : 'Could not move the session.') }
  } catch {
    return { ok: false, message: lang === 'pt' ? 'O servidor não respondeu.' : 'The server did not answer.' }
  }
}
