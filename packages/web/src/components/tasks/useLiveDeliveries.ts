import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { debounceWithMaxWait } from '../../lib/debounceMaxWait'
import { subscribeEvent } from '../../lib/eventStream'
import type { FleetRow } from '../../lib/fleet'
import type { LiveReply } from './liveDeliveryModel'

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
let lastReply: { reply: LiveReply; atMs: number } | null = null
export const LIVE_CACHE_MAX_AGE_MS = 10 * 60_000
export function cachedLiveReply(nowMs = Date.now()): LiveReply | null {
  return lastReply && nowMs - lastReply.atMs < LIVE_CACHE_MAX_AGE_MS ? lastReply.reply : null
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
      const res = await fetch('/api/tasks/live')
      if (res.ok) lastReply = { reply: await res.json() as LiveReply, atMs: Date.now() }
    } catch { /* the view reports its own errors */ } finally { prefetching = null }
  })()
  return prefetching
}

/** Test hook. */
export function resetLiveCache(): void { lastReply = null }

export function useLiveDeliveries(fleet: readonly FleetRow[]) {
  const [reply, setReply] = useState<LiveReply | null>(() => cachedLiveReply())
  const [error, setError] = useState<'down' | 'refused' | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks/live')
      if (res.status === 403 || res.status === 404) { setError('refused'); return }
      if (!res.ok) { setError('down'); return }
      const fresh = await res.json() as LiveReply
      lastReply = { reply: fresh, atMs: Date.now() }
      setReply(fresh)
      setError(null)
    } catch {
      setError('down')
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
      off(); clearInterval(tick); clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisible)
      later.cancel()
    }
  }, [load, later])

  // Only the live rows matter to which sessions a piece holds.
  const signature = useMemo(
    () => fleet.filter(r => r.state !== 'closed' && r.state !== 'exited').map(r => `${r.id}:${r.state}`).sort().join('|'),
    [fleet],
  )
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => void load(), 1500)
    return () => clearTimeout(t)
  }, [signature, load])

  return { reply, error, nowMs, reload: load }
}
