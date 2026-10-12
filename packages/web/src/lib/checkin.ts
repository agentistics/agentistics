import { useCallback, useEffect, useState } from 'react'
import { subscribeEvent } from './eventStream'

export type CheckinItemId = 'fleet' | 'handbacks' | 'limits' | 'releases' | 'mcp-configs' | 'handoff'
export type CheckinRoundState = 'ok' | 'resolved' | 'needs_you'
export type CheckinLink = { kind: 'session' | 'subtask' | 'task'; id: string; taskId?: string }
export interface CheckinNeedWire { subject: string; text: string; critical?: boolean; link?: CheckinLink }
export interface CheckinConfig {
  intervalMin: 15 | 30 | 60 | 120
  paused: null | { until: number | null }
  checklist: { id: CheckinItemId; enabled: boolean }[]
}
export interface CheckinState extends CheckinConfig {
  session: string
  lastRunAt: number | null
  nextRunAt: number | null
  /** `at` and `needs` ride the SSE event of a round (CONTRACT §3 data); optional so older servers still parse. */
  last: { state: CheckinRoundState; summary: string; at?: number; needs?: CheckinNeedWire[] } | null
}

export const CHECKIN_ITEMS: readonly { id: CheckinItemId; pt: string; en: string }[] = [
  { id: 'fleet', pt: 'Sessões e memória', en: 'Sessions and memory' },
  { id: 'handbacks', pt: 'Entregas dos workers', en: 'Worker handbacks' },
  { id: 'limits', pt: 'Limites de uso', en: 'Usage limits' },
  { id: 'releases', pt: 'Releases e motor', en: 'Releases and engine' },
  { id: 'mcp-configs', pt: 'Configs MCP dos harnesses', en: 'Harness MCP configs' },
  { id: 'handoff', pt: 'Passagem (HANDOFF)', en: 'Handoff' },
]

/** The prototype's clock: `21h40` in Portuguese, `21:40` in English. */
export function clockLabel(ms: number, pt = true): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0')
  return pt ? `${hh}h${mm}` : `${hh}:${mm}`
}

export function formatNextRun(nextRunAt: number | null, now = Date.now(), pt = true): string {
  if (nextRunAt === null) return pt ? 'pausado' : 'paused'
  const mins = Math.max(0, Math.ceil((nextRunAt - now) / 60_000))
  const when = clockLabel(nextRunAt, pt)
  return pt ? `${when} · em ${mins} min` : `${when} · in ${mins} min`
}

export function buildCheckinPatch(current: CheckinConfig, patch: Partial<CheckinConfig>): CheckinConfig {
  return { ...current, ...patch, ...(patch.checklist ? { checklist: patch.checklist.map(item => ({ ...item })) } : {}) }
}

async function request(sessionId: string, method: string, suffix = '', body?: unknown): Promise<Response> {
  return fetch(`/api/checkin/${encodeURIComponent(sessionId)}${suffix}`, {
    method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function useCheckin(sessionId: string | undefined): {
  state: CheckinState | null; update: (partial: Partial<CheckinConfig>) => Promise<void>; runNow: () => Promise<boolean>
} {
  const [state, setState] = useState<CheckinState | null>(null)
  const load = useCallback(async () => {
    if (!sessionId) { setState(null); return }
    const response = await request(sessionId, 'GET')
    if (response.status === 404) { setState(null); return }
    if (response.ok) setState(await response.json() as CheckinState)
  }, [sessionId])
  useEffect(() => {
    void load()
    if (!sessionId) return
    return subscribeEvent('checkin', event => {
      try {
        const next = JSON.parse(event.data) as CheckinState
        if (next.session === sessionId) setState(next)
      } catch { /* Ignore malformed broadcasts; the next event or reload repairs the view. */ }
    })
  }, [load, sessionId])
  const update = useCallback(async (partial: Partial<CheckinConfig>) => {
    if (!sessionId) return
    const response = await request(sessionId, 'PUT', '', partial)
    if (response.ok) setState(await response.json() as CheckinState)
  }, [sessionId])
  const runNow = useCallback(async () => {
    if (!sessionId) return false
    // The server says whether the prompt was actually typed into the leader; the panel says so too.
    try {
      const response = await request(sessionId, 'POST', '/run')
      const body = await response.json().catch(() => ({})) as { ok?: boolean }
      return response.ok && body.ok === true
    } catch { return false }
  }, [sessionId])
  return { state, update, runNow }
}
