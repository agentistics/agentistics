import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarReply } from '@agentistics/core'
import { debounceWithMaxWait } from '../../lib/debounceMaxWait'
import { subscribeEvent } from '../../lib/eventStream'

/** The slow safety refetch while the tab is visible — the push channels below do the real work. */
export const CALENDAR_HEARTBEAT_MS = 60_000

/**
 * The Delivery calendar's whole read (`GET /api/deliveries/calendar?filter=0`), kept fresh by the app's own push
 * channels (`change` and `book`, the same ones the Live line follows) — never a poll of its own. It holds the WHOLE
 * calendar and the page filters it in the browser with core's `filterCalendar`, so a filter click costs no round
 * trip and the screen, the route and the MCP tool apply literally the same function.
 * The wall clock ticks every 15 s so "now" and the late marks keep counting between pushes.
 */
export function useDeliveryCalendar(): { reply: CalendarReply | null; error: boolean; nowMs: number; reload: () => Promise<void> } {
  const [reply, setReply] = useState<CalendarReply | null>(null)
  const [error, setError] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/deliveries/calendar?filter=0')
      if (!res.ok) { if (alive.current) setError(true); return }
      const fresh = await res.json() as CalendarReply
      if (!alive.current) return
      setReply(fresh); setError(false)
    } catch { if (alive.current) setError(true) }
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
      offChange(); offBook(); clearInterval(tick); clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisible)
      later.cancel()
    }
  }, [load, later])

  return { reply, error, nowMs, reload: load }
}
