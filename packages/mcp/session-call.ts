/**
 * session-call.ts — what `agentistics_session_call` answers. Pure.
 *
 * The server's `GET /api/fleet/calls[?session=<ref>]` says who is on a voice line; this shapes it for a
 * model: a yes/no per session with the moment the call began, or the list of every live call. `voice:
 * false` is said as such — "this build has no voice" is not "nobody is calling".
 */
interface WireCall { callId: string; sessionId: string; startedAt: number }
interface CallsBody {
  voice?: boolean
  calls?: WireCall[]
  session?: { id: string; call: WireCall | null } | { error: "not-found" | "ambiguous"; matches?: string[] }
}

const iso = (ms: number): string => new Date(ms).toISOString()

export function callAnswer(body: CallsBody, ref: string): Record<string, unknown> {
  const voice = body.voice === true;
  if (!ref) {
    return {
      voice,
      calls: (body.calls ?? []).map(c => ({ sessionId: c.sessionId, callId: c.callId, since: iso(c.startedAt) })),
      ...(voice ? {} : { note: "this build has no voice mode, so no call can exist" }),
    };
  }
  const s = body.session;
  if (!s) return { voice, ref, error: "the server did not resolve the session" };
  if ("error" in s) return { voice, ref, error: s.error, ...(s.matches ? { matches: s.matches } : {}) };
  return {
    voice,
    id: s.id,
    inCall: s.call !== null,
    ...(s.call ? { since: iso(s.call.startedAt), callId: s.call.callId } : {}),
    ...(voice ? {} : { note: "this build has no voice mode, so no call can exist" }),
  };
}
