/**
 * engine/engine-surfaces.ts — which of an engine's announced surfaces the web is told about.
 *
 * `GET /api/engine` carries the list; the web draws one generic button per entry. A surface naming an
 * `experimental` flag is left out while that environment variable is not `1`, so it is never drawn and
 * its module is never requested. With no engine the list is empty.
 */
import { surfaceRefusals, type EngineSurface } from '@agentistics/engine-api'

export function engineSurfacesFor(
  surfaces: readonly EngineSurface[] | undefined,
  env: Record<string, string | undefined>,
): EngineSurface[] {
  if (!surfaces || surfaceRefusals(surfaces).length > 0) return []
  return surfaces
    .filter(s => s.experimental === undefined || env[s.experimental] === '1')
    .map(s => ({ ...s, label: { ...s.label } }))
}
