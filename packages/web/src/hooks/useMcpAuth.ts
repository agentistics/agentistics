import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpAuthView, McpHarnessOverview, McpHarnessStatus } from '../lib/mcpAuth'

/**
 * The MCP-by-harness client: what each harness lists and says, and the harness's own sign-in.
 * Every function is total — a network failure is a `null`/`{ok:false}` the caller words, never a throw.
 */

export async function fetchMcpOverview(): Promise<McpHarnessOverview[] | null> {
  try {
    const res = await fetch('/api/mcp/harnesses')
    if (!res.ok) return null
    return ((await res.json()) as { harnesses: McpHarnessOverview[] }).harnesses
  } catch { return null }
}

export async function fetchMcpStatus(harness: string, refresh = false): Promise<McpHarnessStatus | null> {
  try {
    const res = await fetch(`/api/mcp/status?harness=${encodeURIComponent(harness)}${refresh ? '&refresh=1' : ''}`)
    if (!res.ok) return null
    return (await res.json()) as McpHarnessStatus
  } catch { return null }
}

export type McpAuthCall =
  | { ok: true; flow: McpAuthView }
  | { ok: false; message: string }

async function post(body: Record<string, unknown>): Promise<McpAuthCall> {
  try {
    const res = await fetch('/api/mcp/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json() as { ok?: boolean; flow?: McpAuthView; message?: string }
    if (json.ok && json.flow) return { ok: true, flow: json.flow }
    return { ok: false, message: json.message ?? '' }
  } catch { return { ok: false, message: '' } }
}

export const startMcpSignIn = (harness: string, server: string, lang: 'pt' | 'en') =>
  post({ action: 'start', harness, server, lang })
export const pasteMcpSignIn = (id: string, redirect: string, lang: 'pt' | 'en') =>
  post({ action: 'paste', id, redirect, lang })
export const cancelMcpSignIn = (id: string, lang: 'pt' | 'en') => post({ action: 'cancel', id, lang })

export async function pollMcpSignIn(id: string, lang: 'pt' | 'en'): Promise<McpAuthView | null> {
  try {
    const res = await fetch(`/api/mcp/auth?id=${encodeURIComponent(id)}&lang=${lang}`)
    if (!res.ok) return null
    return ((await res.json()) as { flow?: McpAuthView }).flow ?? null
  } catch { return null }
}

/** One harness's MCP servers. `reload(true)` re-reads past the server's 45 s cache. */
export function useMcpHarness(harness: string, enabled: boolean) {
  const [status, setStatus] = useState<McpHarnessStatus | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const load = useCallback(async (refresh: boolean) => {
    const mine = ++seq.current
    setLoading(true)
    const next = await fetchMcpStatus(harness, refresh)
    if (mine !== seq.current) return
    if (next) { setStatus(next); setFailed(false) } else setFailed(true)
    setLoading(false)
  }, [harness])
  useEffect(() => { if (enabled) void load(false); else setLoading(false) }, [enabled, load])
  return { status, loading, failed, reload: (refresh = true) => { void load(refresh) } }
}
