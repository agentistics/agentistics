/**
 * useNativeSessionRows — the NATIVE Agentistics sessions the aside lists (UI.3) and its summary line
 * counts (H17): the engine's own list (`GET /api/runtime/sessions`), read only where the engine
 * provides the native runtime, refreshed every 15 s and whenever the open session changes.
 */
import { useEffect, useState } from 'react'
import { useEngineCaps } from './useEngineCaps'
import { CREATE_URL } from '../lib/nativeSession'

export interface NativeSessionRow {
  sessionId: string
  title?: string
  model: string
  status: string
  updatedAt: string
  /** H17: `working` / `waiting-approval` / `waiting`, once the engine has seen a run of it. */
  activity?: string
}

const REFRESH_MS = 15_000

export function useNativeSessionRows(activeId?: string): NativeSessionRow[] {
  const { nativeRuntime } = useEngineCaps()
  const [rows, setRows] = useState<NativeSessionRow[]>([])
  useEffect(() => {
    if (nativeRuntime !== true) { setRows([]); return }
    let live = true
    const read = () => fetch(`${CREATE_URL}?limit=20`)
      .then(r => (r.ok ? r.json() : null))
      .then((b: { sessions?: NativeSessionRow[] } | null) => { if (live && b?.sessions) setRows(b.sessions) })
      .catch(() => {})
    void read()
    const t = setInterval(read, REFRESH_MS)
    return () => { live = false; clearInterval(t) }
  }, [nativeRuntime, activeId])
  return nativeRuntime === true ? rows : []
}
