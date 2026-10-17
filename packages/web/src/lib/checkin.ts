import { useCallback, useEffect, useState } from 'react'
import { subscribeEvent } from './eventStream'

export type CheckinItemId = 'fleet' | 'handbacks' | 'limits' | 'releases' | 'mcp-configs' | 'handoff'
export type CheckinRoundState = 'ok' | 'resolved' | 'needs_you'
export type CheckinLink = { kind: 'session' | 'subtask' | 'task'; id: string; taskId?: string }
export interface CheckinNeedWire { subject: string; text: string; critical?: boolean; link?: CheckinLink }
export interface CheckinDelivered { text: string; ref?: string }
export interface CheckinInProgress { item: string; stage: string; release?: string; session?: string }
export interface CheckinNext { text: string; when?: string }
export type CheckinHealthState = 'ok' | 'warn' | 'bad'
export interface CheckinHealth { label: string; value: string; state: CheckinHealthState }
export interface CheckinRound {
  state: CheckinRoundState; summary: string; headline?: string; delivered?: CheckinDelivered[]
  inProgress?: CheckinInProgress[]; next?: CheckinNext[]; health?: CheckinHealth[]; at?: number; needs?: CheckinNeedWire[]
}
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
  last: CheckinRound | null
  skipped?: { count: number; lastAt: number }
}

export function formatSkipped(skipped: CheckinState['skipped'], pt = true): string | null {
  if (!skipped || skipped.count < 1) return null
  return pt
    ? `${skipped.count} rodada${skipped.count === 1 ? '' : 's'} pulada${skipped.count === 1 ? '' : 's'} (nada mudou) · última às ${clockLabel(skipped.lastAt, true)}`
    : `${skipped.count} skipped round${skipped.count === 1 ? '' : 's'} (nothing changed) · last at ${clockLabel(skipped.lastAt, false)}`
}

export const CHECKIN_ITEMS: readonly { id: CheckinItemId; pt: string; en: string }[] = [
  { id: 'fleet', pt: 'Sessões e memória', en: 'Sessions and memory' },
  { id: 'handbacks', pt: 'Entregas dos workers', en: 'Worker handbacks' },
  { id: 'limits', pt: 'Limites de uso', en: 'Usage limits' },
  { id: 'releases', pt: 'Releases e motor', en: 'Releases and engine' },
  { id: 'mcp-configs', pt: 'Configs MCP dos harnesses', en: 'Harness MCP configs' },
  { id: 'handoff', pt: 'Passagem (HANDOFF)', en: 'Handoff' },
]

/** Same built-in agenda as the server; saved defaults only allow an indefinite pause. */
export function checkinDefaults(value?: unknown): CheckinConfig {
  const saved = value && typeof value === 'object' ? value as Partial<CheckinConfig> : {}
  return {
    intervalMin: [15, 30, 60, 120].includes(saved.intervalMin as number) ? saved.intervalMin! : 30,
    paused: saved.paused?.until === null ? { until: null } : null,
    checklist: CHECKIN_ITEMS.map(({ id }) => ({ id, enabled: Array.isArray(saved.checklist)
      ? saved.checklist.find(item => item?.id === id && typeof item.enabled === 'boolean')?.enabled ?? true : true })),
  }
}

export async function saveCheckinDefaults(config: CheckinConfig): Promise<void> {
  const response = await fetch('/api/preferences', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkinDefaults: config }),
  })
  if (!response.ok) throw new Error('save failed')
}

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

/** The last state seen per session, so a second reader (the chat's "Open check-in" button, the modal)
 *  paints from what is known instead of flashing "nothing". Also the seam tests use. */
const known = new Map<string, CheckinState>()
export function rememberCheckinState(sessionId: string, state: CheckinState | null): void {
  if (state) known.set(sessionId, state); else known.delete(sessionId)
}

export function useCheckin(sessionId: string | undefined): {
  state: CheckinState | null; update: (partial: Partial<CheckinConfig>) => Promise<void>; runNow: () => Promise<boolean>
} {
  const [state, setStateRaw] = useState<CheckinState | null>(() => (sessionId ? known.get(sessionId) ?? null : null))
  const setState = useCallback((next: CheckinState | null) => {
    if (sessionId) rememberCheckinState(sessionId, next)
    setStateRaw(next)
  }, [sessionId])
  const load = useCallback(async () => {
    if (!sessionId) { setState(null); return }
    const response = await request(sessionId, 'GET')
    if (response.status === 404) { setState(null); return }
    if (response.ok) setState(await response.json() as CheckinState)
  }, [sessionId, setState])
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
