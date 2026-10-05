/**
 * useEngineCaps — what the loaded engine provides (`GET /api/engine`), read once per page load and
 * shared: the answer changes when the server restarts with another build, or when Settings →
 * Experimental flips the flag (`invalidateEngineCaps`). `nativeRuntime` is
 * `null` until the answer lands, then a boolean — `false` on a community build (no engine), on a
 * refused request, or on a network error. A gate that cannot ask says no.
 */
import { useEffect, useState } from 'react'
import { nativeRuntimeFrom } from '../lib/nativeSession'
import { onEngineCapsInvalidated } from '../lib/engineCapsBus'

let cached: Promise<boolean> | null = null

function readNativeRuntime(): Promise<boolean> {
  cached ??= fetch('/api/engine')
    .then(r => (r.ok ? r.json() : null))
    .then(nativeRuntimeFrom)
    .catch(() => false)
  return cached
}

/**
 * THE web gate for every native surface: true only once `GET /api/engine` has said the engine provides the
 * native runtime AND the experimental flag is on. Unknown reads as HIDDEN — a native row must never flash
 * on a machine where the runtime is off (v2.103 leaked it onto every metrics surface).
 */
export function useNativeVisible(): boolean {
  return useEngineCaps().nativeRuntime === true
}

export function useEngineCaps(): { nativeRuntime: boolean | null } {
  const [nativeRuntime, setNativeRuntime] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    const read = () => { void readNativeRuntime().then(v => { if (live) setNativeRuntime(v) }) }
    read()
    // The experimental switch changes the answer without a restart: forget it and ask again.
    const off = onEngineCapsInvalidated(() => { cached = null; read() })
    return () => { live = false; off() }
  }, [])
  return { nativeRuntime }
}
