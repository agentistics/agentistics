import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { CheckinState } from '../checkin'
import { ownerPresence, validPresenceReport } from './owner-presence'

export function waitingSessions(rows: readonly ControlSession[], agendas: Record<string, unknown>) {
  return rows.map(row => {
    const agenda = (agendas[row.conversationId ?? row.id] ?? agendas[row.id]) as CheckinState | undefined
    const needs = agenda?.last?.state === 'needs_you'
    return { id: row.id, conversationId: row.conversationId, title: row.title,
      waiting: row.state === 'waiting-approval' || (!['working', 'exited', 'closed', 'lost'].includes(row.state) && needs),
      ...(needs && agenda.lastRunAt != null ? { since: agenda.lastRunAt } : {}),
    }
  })
}
/** Routed behind the existing local fleet capability, central and host/auth gates. */
export async function handleOwnerPresence(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null)
  if (!validPresenceReport(body)) return Response.json({ error: 'invalid_presence' }, { status: 400 })
  const [{ readFleet }, { readPreferences }] = await Promise.all([import('./fleet-web'), import('../preferences')])
  const rows = (await readFleet(body.lang ?? 'pt')).rows
  return Response.json(ownerPresence.report(body, waitingSessions(rows, (await readPreferences()).checkin ?? {})))
}
