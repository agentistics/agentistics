/**
 * `GET /api/fleet/calls[?session=<ref>]` — the live voice calls, read from the engine's voice (engine-api
 * 1.29) in THIS process. `session` resolves a managed id, a conversation id, an exact title or a unique id
 * prefix against the registry and narrows the answer to that session.
 */
import type { WireCall } from './call-state'

export interface FleetCallsBody {
  /** Does this build have a voice that can report calls? `false` = none can exist. */
  voice: boolean
  calls: WireCall[]
  /** With `?session=`: the registry id it resolved to, and the call on it. */
  session?: { id: string; call: WireCall | null } | { error: 'not-found' | 'ambiguous'; matches?: string[] }
}

export async function fleetCallsBody(sessionRef: string | null): Promise<FleetCallsBody> {
  const { engine, loadEngine } = await import('../engine/load')
  await loadEngine().catch(() => undefined)
  const voice = engine()?.voice
  if (!voice) return { voice: false, calls: [] }
  const calls = voice.activeCalls().map(c => ({ callId: c.callId, sessionId: c.sessionId, startedAt: c.startedAt }))
  if (!sessionRef) return { voice: true, calls }
  const { readRegistry } = await import('./registry')
  const { resolveSessionRef } = await import('./session-ref')
  const found = resolveSessionRef(await readRegistry(), sessionRef)
  if (!found.ok) return { voice: true, calls, session: found.reason === 'not-found' ? { error: 'not-found' } : { error: 'ambiguous', matches: found.matches } }
  const row = found.session as { id: string; conversationId?: string }
  const call = calls.find(c => c.sessionId === row.id || (row.conversationId !== undefined && c.sessionId === row.conversationId)) ?? null
  return { voice: true, calls, session: { id: row.id, call } }
}
