/**
 * session-role-args.ts — what `agentistics_session_role` sends to `/api/session-roles`. Pure.
 * `session` is always present (null without proof): the server refuses an unproven MCP instead of
 * mistaking it for the person at the browser.
 */
export interface SessionRoleArgs { ref?: unknown; role?: unknown; retirePredecessor?: unknown }

export function sessionRoleBody(a: SessionRoleArgs | undefined, session: unknown): Record<string, unknown> {
  const retire = typeof a?.retirePredecessor === "string" ? a.retirePredecessor.trim() : "";
  return {
    ...(a?.ref ? { ref: a.ref } : {}),
    ...(a?.role !== undefined ? { role: a.role } : {}),
    ...(retire ? { retirePredecessor: retire } : {}),
    session: session ?? null,
  };
}
