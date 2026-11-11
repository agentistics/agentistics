/**
 * hostSession.ts — what a `/api/session` read does with what it got back.
 *
 * That route is the ONE place the server publishes the host gates it has already resolved —
 * `shellEnabled` (the per-session utility shell), `editorEnabled` (the Studio), `chatEnabled` and
 * `capabilities` — each the capability AND the user's own switch, never re-derived in the browser.
 *
 * A REFRESH IS NOT THE FIRST READ. Before anything is known a failed read falls back to the boot
 * default; once something is known, a failed refresh keeps it — a network blip is not a retraction
 * of `shellEnabled` or `capabilities`.
 */
export const HOST_SESSION_PATH = '/api/session'

export function resolveHostSessionRefresh<T>(previous: T | undefined, fetched: T | null, bootDefault: T): T {
  if (fetched !== null) return fetched
  return previous ?? bootDefault
}
