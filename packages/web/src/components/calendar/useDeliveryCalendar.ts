import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarReply } from '@agentistics/core'
import { debounceWithMaxWait } from '../../lib/debounceMaxWait'
import { subscribeEvent } from '../../lib/eventStream'
import { fetchRouteJson, type RouteError, retryBackoffMs } from '../../lib/routeTransport'

/** The slow safety refetch while the tab is visible — the push channels below do the real work. */
export const CALENDAR_HEARTBEAT_MS = 60_000

/**
 * The Delivery calendar's whole read (`GET /api/deliveries/calendar?filter=0`), kept fresh by the app's own push
 * channels (`change` and `book`, the same ones the Live line follows) — never a poll of its own. It holds the WHOLE
 * calendar and the page filters it in the browser with core's `filterCalendar`, so a filter click costs no round
 * trip and the screen, the route and the MCP tool apply literally the same function.
 * The wall clock ticks every 15 s so "now" and the late marks keep counting between pushes.
 */
export function useDeliveryCalendar(): { reply: CalendarReply | null; error: RouteError | null; slow: boolean; nowMs: number; reload: () => Promise<void> } {
  const [reply, setReply] = useState<CalendarReply | null>(null)
  const [error, setError] = useState<RouteError | null>(null)
  const [slow, setSlow] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const alive = useRef(true)
  const generation = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const attempt = useRef(0)

  const load = useCallback(async (replace = false) => {
    // Heartbeats and push events share the pending read instead of resetting its deadline.
    if (abort.current && !replace) return
    const mine = ++generation.current
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setSlow(false)
    try {
      const fresh = await fetchRouteJson<CalendarReply>('/api/deliveries/calendar?filter=0', { signal: controller.signal, onSlow: () => { if (alive.current && mine === generation.current) setSlow(true) } })
      if (!alive.current || mine !== generation.current) return
      setReply(fresh)
      setError(null); attempt.current = 0
    } catch (reason) {
      if (!alive.current || mine !== generation.current || controller.signal.aborted) return
      const routeError = reason as RouteError
      setError(routeError)
      attempt.current++
    } finally {
      if (mine === generation.current) abort.current = null
    }
  }, [])

  const later = useMemo(() => debounceWithMaxWait(() => void load(), 500, 2000), [load])

  useEffect(() => {
    alive.current = true
    void load()
    const offChange = subscribeEvent('change', () => later())
    const offBook = subscribeEvent('book', () => later())
    const tick = setInterval(() => setNowMs(Date.now()), 15_000)
    const onVisible = () => { if (document.visibilityState === 'visible') { setNowMs(Date.now()); void load() } }
    document.addEventListener('visibilitychange', onVisible)
    const beat = setInterval(() => { if (document.visibilityState === 'visible') void load() }, CALENDAR_HEARTBEAT_MS)
    return () => {
      alive.current = false
      abort.current?.abort()
      abort.current = null
      generation.current++
      offChange(); offBook(); clearInterval(tick); clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisible)
      later.cancel()
    }
  }, [load, later])

  return { reply, error, slow, nowMs, reload: async () => { await new Promise(resolve => setTimeout(resolve, retryBackoffMs(attempt.current))); return load(true) } }
}
