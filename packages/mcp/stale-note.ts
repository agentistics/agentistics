/** PURE — the note an MCP answer carries when the server served a previous build (`/api/data` `stale`). */
/**
 * PERF.SERVIDOR-OCIOSO (QA R5): the server answers a full `/api/data` read within ~5 s; when its build is slower it
 * answers the PREVIOUS build with `stale: true`. The agent is told so in a second text block (the JSON keeps its shape).
 */
export class StaleAnswer { constructor(readonly value: unknown, readonly note: string) {} }
export function staleNoteOf(data: unknown): string | null {
  const d = data as { stale?: unknown; staleBuiltAt?: unknown } | null
  if (!d || d.stale !== true) return null
  const at = typeof d.staleBuiltAt === "string" ? ` (built ${d.staleBuiltAt})` : "";
  return `Note: the server was still rebuilding its data; these figures are from the previous build${at} and may miss the last few minutes. Ask again shortly for current figures.`;
}
export function withStaleNote(value: unknown, data: unknown): unknown {
  const note = staleNoteOf(data);
  return note ? new StaleAnswer(value, note) : value;
}


/** A tool's MCP content: the JSON, plus the stale note as a second block when there is one. */
export const toolText = (value: unknown) => value instanceof StaleAnswer
  ? { content: [{ type: "text" as const, text: JSON.stringify(value.value, null, 2) }, { type: "text" as const, text: value.note }] }
  : { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
