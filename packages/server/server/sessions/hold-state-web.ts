/**
 * `GET /api/fleet/holds?session=<ref>` — what the engine says holds a session, read in THIS process.
 * `session` resolves a managed id, a conversation id, an exact title or a unique id prefix against the registry.
 * An engine without `holds` answers `available: false`: nothing can hold a session there.
 */
import type { HoldObservation } from './retire-plan'

export interface FleetHoldsBody {
  /** Does this build have an engine that can report holds? `false` = nothing can hold a session. */
  available: boolean
  /** The registry id the reference resolved to, and what holds it; or why it did not resolve. */
  session?: { id: string; hold: HoldObservation } | { error: 'not-found' | 'ambiguous'; matches?: string[] }
}

export async function fleetHoldsBody(sessionRef: string | null): Promise<FleetHoldsBody> {
  const { engine, loadEngine } = await import('../engine/load')
  await loadEngine().catch(() => undefined)
  const holds = engine()?.holds
  if (!holds) return { available: false }
  if (!sessionRef) return { available: true }
  const { readRegistry } = await import('./registry')
  const { resolveSessionRef } = await import('./session-ref')
  const found = resolveSessionRef(await readRegistry(), sessionRef)
  if (!found.ok) return { available: true, session: found.reason === 'not-found' ? { error: 'not-found' } : { error: 'ambiguous', matches: found.matches } }
  const row = found.session as { id: string; conversationId?: string }
  const { probeHold } = await import('./hold-state')
  return { available: true, session: { id: row.id, hold: await probeHold(row, holds) } }
}
