/**
 * useEngineSurfaces — the engine's announced surfaces for one placement. Read from `GET /api/engine`
 * once per page load (shared with the other engine readers' invalidation), `[]` until the answer lands
 * and on a community build, a refused request or a network error.
 */
import { useEffect, useState } from 'react'
import { onEngineCapsInvalidated } from '../lib/engineCapsBus'
import { surfacesFrom, type EngineSurfaceInfo, type SurfacePlacement } from '../lib/engineSurfaces'

let cached: Promise<unknown> | null = null

function readStatus(): Promise<unknown> {
  cached ??= fetch('/api/engine', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
  return cached
}

export function useEngineSurfaces(placement: SurfacePlacement): EngineSurfaceInfo[] {
  const [list, setList] = useState<EngineSurfaceInfo[]>([])
  useEffect(() => {
    let live = true
    const read = () => { void readStatus().then(s => { if (live) setList(surfacesFrom(s, placement)) }) }
    read()
    const off = onEngineCapsInvalidated(() => { cached = null; read() })
    return () => { live = false; off() }
  }, [placement])
  return list
}
