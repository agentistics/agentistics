/**
 * Which surfaces read the PROJECTED answer (`GET /api/runtime/metrics`) instead of the legacy
 * `/api/data` arithmetic — the per-surface rollout of P3 (cutover order MCP → VS Code → TUI → web).
 *
 * This is the surface's opt-in, nothing more. Whether projections EXIST is the server's
 * `AGENTISTICS_PROJECTIONS` gate: with it off the route answers 404 `projections_disabled`, and a
 * surface that opted in falls back to its legacy path. The two variables are separate because the
 * surfaces run in other processes (the MCP server, the TUI's CLI) whose environment is not the server's.
 *
 * **Absent reads as legacy everywhere.** A surface becomes default-projected only after its
 * surface-level parity check passes on a real store.
 */

export const PROJECTION_SURFACES_ENV = 'AGENTISTICS_PROJECTIONS_SURFACES'

export const PROJECTION_SURFACE_IDS = ['mcp', 'vscode', 'tui', 'web'] as const
export type ProjectionSurface = (typeof PROJECTION_SURFACE_IDS)[number]

type Env = Record<string, string | undefined>

export function projectionSurfaces(env: Env = process.env): ProjectionSurface[] {
  const names = (env[PROJECTION_SURFACES_ENV] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (names.includes('all')) return [...PROJECTION_SURFACE_IDS]
  return PROJECTION_SURFACE_IDS.filter(id => names.includes(id))
}

export function projectionSurfaceOn(surface: ProjectionSurface, env: Env = process.env): boolean {
  return projectionSurfaces(env).includes(surface)
}
