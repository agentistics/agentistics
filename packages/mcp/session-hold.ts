/**
 * session-hold.ts — what `agentistics_session_hold` answers. Pure.
 *
 * The server's `GET /api/fleet/holds?session=<ref>` says what, if anything live, is using a session; this shapes it for a
 * model: a yes/no with the moment it began and the engine's own sentence. `available: false` is said as such — "this
 * build reports no holds" is not "nothing is using it".
 */
interface HoldReading { state: "none" | "held" | "unknown"; since?: number; sentence?: { en: string; pt: string } }
interface HoldsBody {
  available?: boolean;
  session?: { id: string; hold: HoldReading } | { error: "not-found" | "ambiguous"; matches?: string[] };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function holdAnswer(body: HoldsBody, ref: string): Record<string, unknown> {
  const available = body.available === true;
  if (!ref) return { available, error: "pass `ref`: a managed id, conversation id, exact title or unique id prefix" };
  const note = available ? {} : { note: "this build's engine reports no holds, so nothing can hold a session" };
  const s = body.session;
  if (!s) return { available, ref, ...note, ...(available ? { error: "the server did not resolve the session" } : {}) };
  if ("error" in s) return { available, ref, error: s.error, ...(s.matches ? { matches: s.matches } : {}) };
  if (s.hold.state === "unknown") return { available, id: s.id, held: null, note: "whether something is using it could not be read" };
  return {
    available,
    id: s.id,
    held: s.hold.state === "held",
    ...(s.hold.state === "held" && s.hold.since !== undefined ? { since: iso(s.hold.since) } : {}),
    ...(s.hold.state === "held" && s.hold.sentence ? { sentence: s.hold.sentence.en } : {}),
    ...note,
  };
}
