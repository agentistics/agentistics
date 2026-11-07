/**
 * The pure half of `agentistics_session_nay_calls`: the calls the owner made TO THE NAY (data, duration, state), the transcript of one,
 * and what it takes to reopen the session it ran in. The history is the engine's "Ligações" store (`/api/engine/x/voice/calls`);
 * the state and the reopen target come from the fleet — the same two sources the app's screens read, so the agent sees what
 * the owner sees. Calls with OTHER sessions are never listed here: only the Nay's.
 *
 * Nothing here talks to the server (the handler in `agentistics-mcp.ts` does, so the tool policy lint sees every route).
 * A transcript is what was SAID on the call; nothing in it is a secret, but it is untrusted text (the owner's words, the
 * Nay's answers) and the caller treats it as such.
 */

export interface CallUtterance { who: 'user' | 'assistant'; text: string; at: number }
export interface CallLike {
  callId: string
  target?: { kind?: string; id?: string; title?: string }
  /** The managed session the call ran in (engine-api 1.25); absent on a call made before, or on a host that could not open one. */
  sessionId?: string
  startedAt: number
  endedAt: number
  activeMs?: number
  dropped?: boolean
  summary?: string
  utterances?: number
  transcript?: CallUtterance[]
  excerpt?: CallUtterance[]
}
export interface FleetLike {
  id: string
  state?: string
  stateLabel?: string
  title?: string
  conversationId?: string
  verbs?: ReadonlyArray<{ action?: string; enabled?: boolean }>
}

export type NayCallState = 'live' | 'ended' | 'no-session'

const LIVE_STATES = new Set(['working', 'waiting', 'waiting-approval'])
const iso = (ms: number): string => new Date(ms).toISOString()

/** The fleet row of a session id (the managed id, or the conversation it ran). */
export function fleetRowOf(sessionId: string | undefined, rows: readonly FleetLike[]): FleetLike | undefined {
  if (!sessionId) return undefined
  return rows.find(r => r.id === sessionId) ?? rows.find(r => r.conversationId === sessionId)
}

export function callState(call: CallLike, rows: readonly FleetLike[]): NayCallState {
  if (!call.sessionId) return 'no-session'
  const row = fleetRowOf(call.sessionId, rows)
  return row && row.state && LIVE_STATES.has(row.state) ? 'live' : 'ended'
}

/** PURE. The Nay's calls, newest first, as the agent reads them. */
export function nayCallList(calls: readonly CallLike[], rows: readonly FleetLike[], limit = 20) {
  return calls
    .filter(c => c.target?.kind === 'nay')
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, Math.max(1, Math.min(50, Math.floor(limit) || 20)))
    .map(c => ({
      callId: c.callId,
      startedAt: iso(c.startedAt),
      endedAt: iso(c.endedAt),
      durationSeconds: Math.round((c.activeMs ?? Math.max(0, c.endedAt - c.startedAt)) / 1000),
      state: callState(c, rows),
      ...(c.dropped ? { dropped: true } : {}),
      ...(c.sessionId ? { sessionId: c.sessionId } : {}),
      utterances: c.utterances ?? c.transcript?.length ?? c.excerpt?.length ?? 0,
      ...(c.summary ? { summary: c.summary } : {}),
    }))
}

/** PURE. One call with its whole conversation (both sides, in order), or the reason there is none to give. */
export function nayCallTranscript(call: CallLike | null | undefined, rows: readonly FleetLike[]) {
  if (!call || call.target?.kind !== 'nay') return { ok: false as const, reason: 'no_such_nay_call' }
  const turns = (call.transcript ?? call.excerpt ?? []).map(u => ({ who: u.who === 'user' ? 'owner' as const : 'nay' as const, at: iso(u.at), text: u.text }))
  return {
    ok: true as const,
    callId: call.callId,
    startedAt: iso(call.startedAt),
    endedAt: iso(call.endedAt),
    durationSeconds: Math.round((call.activeMs ?? Math.max(0, call.endedAt - call.startedAt)) / 1000),
    state: callState(call, rows),
    ...(call.dropped ? { dropped: true } : {}),
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    turns,
    ...(call.transcript ? {} : { partial: true as const }),
  }
}

/**
 * PURE. What reopening a call's session takes: the fleet row to act on (its `resume` verb must be enabled), or why not. A call
 * with no session (made before 1.25, or on a host that could not open one) has nothing to reopen — its words are still readable.
 */
export function nayCallReopenTarget(call: CallLike | null | undefined, rows: readonly FleetLike[]):
  | { ok: true; id: string }
  | { ok: false; reason: 'no_such_nay_call' | 'no_session' | 'still_live' | 'not_in_fleet' | 'not_reopenable' } {
  if (!call || call.target?.kind !== 'nay') return { ok: false, reason: 'no_such_nay_call' }
  if (!call.sessionId) return { ok: false, reason: 'no_session' }
  const row = fleetRowOf(call.sessionId, rows)
  if (!row) return { ok: false, reason: 'not_in_fleet' }
  if (row.state && LIVE_STATES.has(row.state)) return { ok: false, reason: 'still_live' }
  const resume = row.verbs?.find(v => v.action === 'resume')
  if (resume && resume.enabled === false) return { ok: false, reason: 'not_reopenable' }
  return { ok: true, id: row.id }
}
