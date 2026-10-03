/**
 * Which surfaces read the PROJECTED answer (`GET /api/runtime/metrics`) instead of the legacy
 * `/api/data` arithmetic — the per-surface rollout of P3 (cutover order MCP → VS Code → TUI → web).
 *
 * **The projections are the DEFAULT on every surface** (the journal-backfill item): absent or blank
 * means all four. `legacy` (or `none`) is the FALLBACK flag, kept for one bundle, that puts every
 * surface back on `/api/data`; a list names exactly the surfaces that read the projections.
 *
 * This is the surface's side, nothing more. Whether projections EXIST is the server's
 * `AGENTISTICS_PROJECTIONS` gate: with it off the route answers 404 `projections_disabled`, and a
 * surface that opted in falls back to its legacy path. The two variables are separate because the
 * surfaces run in other processes (the MCP server, the TUI's CLI) whose environment is not the server's.
 *
 * A server without projections refuses (404), and every surface then reads `/api/data` by itself, so
 * the default costs nothing where the projections are off.
 */

export const PROJECTION_SURFACES_ENV = 'AGENTISTICS_PROJECTIONS_SURFACES'

export const PROJECTION_SURFACE_IDS = ['mcp', 'vscode', 'tui', 'web'] as const
export type ProjectionSurface = (typeof PROJECTION_SURFACE_IDS)[number]

type Env = Record<string, string | undefined>

/** The fallback flag's spellings: every surface back on `/api/data`. Deprecated after one bundle. */
export const LEGACY_SURFACES_VALUES = ['legacy', 'none'] as const

export function projectionSurfaces(env: Env = process.env): ProjectionSurface[] {
  const names = (env[PROJECTION_SURFACES_ENV] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (names.length === 0 || names.includes('all')) return [...PROJECTION_SURFACE_IDS]
  if (names.some(n => (LEGACY_SURFACES_VALUES as readonly string[]).includes(n))) return []
  return PROJECTION_SURFACE_IDS.filter(id => names.includes(id))
}

export function projectionSurfaceOn(surface: ProjectionSurface, env: Env = process.env): boolean {
  return projectionSurfaces(env).includes(surface)
}

/**
 * LIVE.2's `sessions` surface (the chat, the tail and the reopen list read the journal's SESSION_SURFACE
 * projection). It is NOT one of the four metric surfaces and is NOT in the default set: it is on only
 * when `sessions` is NAMED, because its default-on is the owner's call after the 24 h memory
 * measurement (LIVE.4, spec `2026-10-02-live-sessions-from-journal` §6 C5). It moves no metric surface (C1),
 * and `projectionSurfaces()` ignores the token. Inert without an engine (C2) — the caller checks that.
 */
export const SESSIONS_SURFACE_TOKEN = 'sessions'

export function sessionsSurfaceOn(env: Env = process.env): boolean {
  return (env[PROJECTION_SURFACES_ENV] ?? '').split(',').some(s => s.trim().toLowerCase() === SESSIONS_SURFACE_TOKEN)
}
