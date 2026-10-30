/**
 * useEngineSurfaces — the engine's announced surfaces for one placement. Read from `GET /api/engine`
 * once per page load (shared with the other engine readers' invalidation), `[]` until the answer lands
 * and on a community build, a refused request or a network error.
 */
import { useEffect, useState } from 'react'
import { onEngineCapsInvalidated } from '../lib/engineCapsBus'
import { surfacesFrom, type EngineSurfaceInfo, type SurfacePlacement } from '../lib/engineSurfaces'

let cached: Promise<unknown> | null = null
// Forgotten ONCE per invalidation, before any reader re-asks (registered at module load, so first).
onEngineCapsInvalidated(() => { cached = null })

/** The shared `GET /api/engine` answer (`null` on a community build, a refusal or a network error). */
export function readEngineStatus(): Promise<unknown> { return readStatus() }

function readStatus(): Promise<unknown> {
  // No fetch at all (a bare test renderer) reads as no engine, never as a crash in every nav.
  cached ??= typeof fetch !== 'function' ? Promise.resolve(null)
    : fetch('/api/engine', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
  return cached
}

export function useEngineSurfaces(placement: SurfacePlacement): EngineSurfaceInfo[] {
  return useEngineSurfaceList(placement) ?? NONE
}
const NONE: EngineSurfaceInfo[] = []

/** The same list, but `null` until the first answer lands — for a screen that must tell "loading" from "absent". */
export function useEngineSurfaceList(placement: SurfacePlacement): EngineSurfaceInfo[] | null {
  const [list, setList] = useState<EngineSurfaceInfo[] | null>(null)
  useEffect(() => {
    let live = true
    const read = () => { void readStatus().then(s => { if (live) setList(surfacesFrom(s, placement)) }) }
    read()
    const off = onEngineCapsInvalidated(read)
    return () => { live = false; off() }
  }, [placement])
  return list
}
