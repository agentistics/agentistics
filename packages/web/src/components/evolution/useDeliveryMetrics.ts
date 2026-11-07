import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MetricsReply } from '@agentistics/core'
import { debounceWithMaxWait } from '../../lib/debounceMaxWait'
import { subscribeEvent } from '../../lib/eventStream'

/** The slow safety refetch while the tab is visible — the push channels below do the real work. */
export const METRICS_HEARTBEAT_MS = 60_000

/**
 * The Delivery evolution's read (`GET /api/deliveries/metrics?<query>`). The SERVER computes every figure (the same
 * function the MCP tool and `agentop flow evolucao` call), so the screen never re-derives a metric in the browser:
 * a filter change is a new query, a push (`change` / `book`, the channels the Live line follows) is a refetch.
 * `reply` keeps the previous answer while the next one loads, so the page does not blank on every filter click.
 */
export function useDeliveryMetrics(query: string): { reply: MetricsReply | null; loading: boolean; error: boolean; reload: () => Promise<void> } {
  const [reply, setReply] = useState<MetricsReply | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const alive = useRef(true)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const mine = ++latest.current
    try {
      const res = await fetch(`/api/deliveries/metrics?${query}`)
      if (!alive.current || mine !== latest.current) return
      if (!res.ok) { setError(true); setLoading(false); return }
      const fresh = await res.json() as MetricsReply
      if (!alive.current || mine !== latest.current) return
      setReply(fresh); setError(false); setLoading(false)
    } catch {
      if (alive.current && mine === latest.current) { setError(true); setLoading(false) }
    }
  }, [query])

  const later = useMemo(() => debounceWithMaxWait(() => void load(), 500, 2000), [load])

  useEffect(() => {
    alive.current = true
    setLoading(true)
    void load()
    const offChange = subscribeEvent('change', () => later())
    const offBook = subscribeEvent('book', () => later())
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    const beat = setInterval(() => { if (document.visibilityState === 'visible') void load() }, METRICS_HEARTBEAT_MS)
    return () => {
      alive.current = false
      offChange(); offBook(); clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisible)
      later.cancel()
    }
  }, [load, later])

  return { reply, loading, error, reload: load }
}
