import { useMemo } from 'react'
import { sessionIdentityKey } from '@agentistics/core'
import { useFleet } from '../../lib/fleet'
import { useSessionRoles } from '../../lib/sessionRoles'
import type { TaskSessionRow } from '../../lib/tasks'
import { toPlanRows, type PlanRow } from './sessionsPlan'

/** The task's sessions joined with the LIVE fleet and the stored roles. The fleet is the shared 5s
 *  poll — joined here, never embedded by the server (two copies of one truth disagree and flicker). */
export function usePlanRows(sessions: readonly TaskSessionRow[]): PlanRow[] {
  const { fleet } = useFleet('en')
  const roles = useSessionRoles()
  return useMemo(() => {
    const live = new Map((fleet.sessions ?? []).map(r => [r.id, r.state as string]))
    return toPlanRows(
      sessions,
      id => live.get(id),
      row => (roles[row.id] ?? (row.conversationId ? roles[sessionIdentityKey({ id: row.id, conversationId: row.conversationId })] : undefined)) === 'leader',
    )
  }, [sessions, fleet.sessions, roles])
}
