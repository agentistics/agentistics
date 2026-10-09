/**
 * hostSession.ts — what a `/api/team/session` read does with what it got back.
 *
 * That route is still the ONE place the server publishes the host gates it has already resolved —
 * `shellEnabled` (the per-session utility shell), `editorEnabled` (the Studio), `chatEnabled` and
 * `capabilities` — each the capability AND the user's own switch, never re-derived in the browser.
 * When the central/member UI was removed (v2.113.0) the read went with it and `App.tsx` held a
 * constant instead, so every one of those flags read as undefined -> OFF: the Shell and Studio tabs
 * vanished from every session's bottom band and rail, for every harness, on a machine whose server
 * answered `shellEnabled: true`. Keep the read; only the central half of the old state is gone.
 *
 * A REFRESH IS NOT THE FIRST READ. Before anything is known a failed read falls back to the boot
 * default; once something is known, a failed refresh keeps it — a network blip is not a retraction
 * of `shellEnabled` or `capabilities`.
 */
export const HOST_SESSION_PATH = '/api/team/session'

export function resolveHostSessionRefresh<T>(previous: T | undefined, fetched: T | null, bootDefault: T): T {
  if (fetched !== null) return fetched
  return previous ?? bootDefault
}
