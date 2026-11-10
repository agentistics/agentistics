import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { debounceWithMaxWait } from '../../lib/debounceMaxWait'
import { subscribeEvent } from '../../lib/eventStream'
import type { FleetRow } from '../../lib/fleet'
import type { LivePeriod } from '@agentistics/core'
import type { LiveReply } from './liveDeliveryModel'
import { readViewPrefs } from './liveCardModel'
import { fetchRouteJson, type RouteError, retryBackoffMs } from '../../lib/routeTransport'

/**
 * The Live Delivery read model, kept fresh by the app's own push channels — never a poll of its own:
 *  - the book's `change` event (a status move, a filing, a comment) refetches, debounced;
 *  - the fleet is ALREADY a stream (`useFleet`); only when the set of live session ids/states that
 *    a delivery could be holding changes does the model refetch, so a quiet fleet costs nothing.
 * The wall clock ticks every 15 s so "in this stage" and "total" keep counting between pushes.
 */
/** The slow safety refetch while the tab is visible. */
export const LIVE_HEARTBEAT_MS = 60_000

/**
 * The last good reply, kept for the page's life: opening the Live (a hover popover is opened and
 * closed many times) paints from it at once while the fresh read lands behind it — no blocking fetch
 * between the pointer and the first useful paint.
 */
let lastReply: { reply: LiveReply; atMs: number; period: LivePeriod } | null = null

/**
 * The ONE request the screen makes: every tab, inside the chosen Publicado period. The tabs, counts and
 * columns are then drawn from this answer with the same rules the server (and the MCP tool) applies, so a
 * period changes what the server SENDS rather than what the screen pretends to cut.
 */
export const liveUrl = (period: LivePeriod): string => `/api/tasks/live?tab=all&period=${period}`
export const LIVE_CACHE_MAX_AGE_MS = 10 * 60_000
export function cachedLiveReply(nowMs = Date.now(), period: LivePeriod = readViewPrefs().period): LiveReply | null {
  return lastReply && lastReply.period === period && nowMs - lastReply.atMs < LIVE_CACHE_MAX_AGE_MS ? lastReply.reply : null
}
/**
 * Warm the cache before anyone asks: the Sessions bar calls this shortly after it mounts and again on
 * hover intent, so the first open paints from the cache instead of waiting on the read. One read at a
 * time, failures are silent (the view's own load reports them).
 */
let prefetching: Promise<void> | null = null
export function prefetchLiveReply(): Promise<void> {
  if (prefetching) return prefetching
  prefetching = (async () => {
    try {
      const period = readViewPrefs().period
      const res = await fetch(liveUrl(period))
      if (res.ok) lastReply = { reply: await res.json() as LiveReply, atMs: Date.now(), period }
    } catch { /* the view reports its own errors */ } finally { prefetching = null }
  })()
  return prefetching
}

/** Test hook. */
export function resetLiveCache(): void { lastReply = null }

export function useLiveDeliveries(fleet: readonly FleetRow[], period: LivePeriod = readViewPrefs().period) {
  const [reply, setReply] = useState<LiveReply | null>(() => cachedLiveReply(Date.now(), period))
  // The period the reply on screen was ASKED for (known here, so the "still loading" state never depends on the server echoing it).
  const [replyPeriod, setReplyPeriod] = useState<LivePeriod>(period)
  const periodRef = useRef(period)
  periodRef.current = period
  const [error, setError] = useState<'down' | 'refused' | null>(null)
  const [routeError, setRouteError] = useState<RouteError | null>(null)
  const [slow, setSlow] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const generation = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const attempt = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setSlow(false)
    try {
      const asked = periodRef.current
      const fresh = await fetchRouteJson<LiveReply>(liveUrl(asked), { signal: controller.signal, onSlow: () => { if (mine === generation.current) setSlow(true) } })
      if (mine !== generation.current) return
      lastReply = { reply: fresh, atMs: Date.now(), period: asked }
      // A slow answer for a period the person already left must not overwrite the one they chose.
      if (asked === periodRef.current) { setReply(fresh); setReplyPeriod(asked) }
      setError(null); setRouteError(null); setSlow(false); attempt.current = 0
    } catch (reason) {
      if (controller.signal.aborted || mine !== generation.current) return
      const route = reason as RouteError
      if (route.kind === 'timeout') { setSlow(true); setRouteError(route); return }
      setRouteError(route)
      setError(route.kind === 'refused' ? 'refused' : 'down')
      attempt.current++
    }
  }, [])

  const later = useMemo(() => debounceWithMaxWait(() => void load(), 500, 2000), [load])

  useEffect(() => {
    void load()
    // `change` = session data moved; `book` = a task-book write (which `useData` ignores).
    const offChange = subscribeEvent('change', () => later())
    const offBook = subscribeEvent('book', () => later())
    const off = () => { offChange(); offBook() }
    const tick = setInterval(() => setNowMs(Date.now()), 15_000)
    // The push channel can drop while a tab is hidden (Safari suspends timers and sockets of a
    // background tab): coming back reads the line again at once, and a slow heartbeat — only while
    // the tab is visible — covers a `change` that never arrived. Neither is a poll of the fleet.
    const onVisible = () => { if (document.visibilityState === 'visible') { setNowMs(Date.now()); void load() } }
    document.addEventListener('visibilitychange', onVisible)
    const beat = setInterval(() => { if (document.visibilityState === 'visible') void load() }, LIVE_HEARTBEAT_MS)
    return () => {
      off(); clearInterval(tick); clearInterval(beat); abort.current?.abort()
      document.removeEventListener('visibilitychange', onVisible)
      later.cancel()
    }
  }, [load, later])

  // Only the live rows matter to which sessions a piece holds.
  const signature = useMemo(
    () => fleet.filter(r => r.state !== 'closed' && r.state !== 'exited').map(r => `${r.id}:${r.state}`).sort().join('|'),
    [fleet],
  )
  // A new period is a new question: ask again at once (the server decides what Publicado holds).
  const firstPeriod = useRef(true)
  useEffect(() => {
    if (firstPeriod.current) { firstPeriod.current = false; return }
    void load()
  }, [period, load])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => void load(), 1500)
    return () => clearTimeout(t)
  }, [signature, load])

  return { reply, replyPeriod, error, routeError, slow, nowMs, reload: async () => { await new Promise(resolve => setTimeout(resolve, retryBackoffMs(attempt.current))); return load() } }
}
