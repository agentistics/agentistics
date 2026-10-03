/**
 * useEngineCaps — what the loaded engine provides (`GET /api/engine`), read ONCE per page load and
 * shared: the answer only changes when the server restarts with another build. `nativeRuntime` is
 * `null` until the answer lands, then a boolean — `false` on a community build (no engine), on a
 * refused request, or on a network error. A gate that cannot ask says no.
 */
import { useEffect, useState } from 'react'
import { nativeRuntimeFrom } from '../lib/nativeSession'

let cached: Promise<boolean> | null = null

function readNativeRuntime(): Promise<boolean> {
  cached ??= fetch('/api/engine')
    .then(r => (r.ok ? r.json() : null))
    .then(nativeRuntimeFrom)
    .catch(() => false)
  return cached
}

export function useEngineCaps(): { nativeRuntime: boolean | null } {
  const [nativeRuntime, setNativeRuntime] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void readNativeRuntime().then(v => { if (live) setNativeRuntime(v) })
    return () => { live = false }
  }, [])
  return { nativeRuntime }
}
