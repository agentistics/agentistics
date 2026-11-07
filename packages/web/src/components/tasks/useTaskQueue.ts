/**
 * useTaskQueue — the task's queue as `GET /api/deliveries/queue/<taskId>` states it (FILA.PRIORIDADE).
 *
 * One source for the Fila tab, its count, the Live card and the MCP. It polls while mounted (a leader answering, a worker
 * ending or a priority change moves the queue without any click here) and refetches on demand after an action.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueueReply } from './queueModel'

export const QUEUE_POLL_MS = 10_000

export function useTaskQueue(taskId: string, enabled = true): { queue: QueueReply | null; error: string | null; reload: () => Promise<void> } {
  const [queue, setQueue] = useState<QueueReply | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/deliveries/queue/${encodeURIComponent(taskId)}`)
      if (!res.ok) throw new Error(String(res.status))
      const body = await res.json() as QueueReply
      if (alive.current) { setQueue(body); setError(null) }
    } catch (e) {
      // Keep the last reading on screen; a failed poll is said, never turned into an empty queue.
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [taskId])
  useEffect(() => {
    alive.current = true
    if (!enabled) return () => { alive.current = false }
    void reload()
    const t = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void reload() }, QUEUE_POLL_MS)
    return () => { alive.current = false; clearInterval(t) }
  }, [reload, enabled])
  return { queue, error, reload }
}

/** POST one of the tab's actions to the delivery door (no session proof: the server reads that as the owner). */
export async function postQueueAction(subtaskId: string, body: Record<string, unknown>): Promise<{ ok: true; warnings: string[] } | { ok: false; sentence: string }> {
  try {
    const res = await fetch(`/api/deliveries/${encodeURIComponent(subtaskId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const out = await res.json().catch(() => ({})) as { sentence?: string; error?: string; warnings?: string[] }
    return res.ok ? { ok: true, warnings: out.warnings ?? [] } : { ok: false, sentence: out.sentence ?? out.error ?? String(res.status) }
  } catch (e) {
    return { ok: false, sentence: e instanceof Error ? e.message : String(e) }
  }
}
