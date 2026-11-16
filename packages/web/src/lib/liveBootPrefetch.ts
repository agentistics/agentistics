/**
 * LIVE.12S — the Live read starts WITH the page, not after it.
 *
 * `useLiveDeliveries` only asked for `/api/tasks/live` once the Tasks page had mounted, and that page
 * mounts after its own chunk and the board's first `/api/tasks` answer: on a cold load the read began
 * ~1.7 s in and queued behind the app shell's other requests (a browser keeps ~6 HTTP/1.1 connections
 * per origin). Opening `/tasks/live` is itself the request, so `main.tsx` starts it before React runs
 * and the screen takes the answer when it mounts.
 *
 * Deliberately a LEAF module (only `@agentistics/core`, which the entry bundle already carries): it is
 * imported by `main.tsx`, so anything heavy here would land in the first paint's critical path.
 * The URL and the stored period are the screen's own (`liveUrl` in `useLiveDeliveries.ts`,
 * `readViewPrefs` in `liveCardModel.ts`) — a test pins both so a second copy cannot drift.
 */
import { parseLivePeriod, type LivePeriod } from '@agentistics/core'

/** The screen's own storage key (`liveCardModel.ts`). */
export const LIVE_VIEW_KEY = 'agentistics.live.view.v2'

type Reply = unknown
type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

let pending: { period: LivePeriod; promise: Promise<Reply | null> } | null = null

export const isLivePath = (pathname: string): boolean => /^\/tasks\/live\/?$/.test(pathname)

export function bootLivePeriod(storage: Pick<Storage, 'getItem'> | null): LivePeriod {
  try {
    const raw = storage?.getItem(LIVE_VIEW_KEY)
    if (!raw) return parseLivePeriod(undefined)
    return parseLivePeriod((JSON.parse(raw) as Record<string, unknown>).period)
  } catch { return parseLivePeriod(undefined) }
}

export const liveReadUrl = (period: LivePeriod): string => `/api/tasks/live?tab=all&period=${period}`

/** Start the early read when the page being opened IS the Live screen; a no-op anywhere else. */
export function startBootLivePrefetch(
  pathname: string,
  storage: Pick<Storage, 'getItem'> | null,
  doFetch: FetchLike = (u => fetch(u)) as FetchLike,
): void {
  if (!isLivePath(pathname)) return
  const period = bootLivePeriod(storage)
  const promise = (async () => {
    try {
      const res = await doFetch(liveReadUrl(period))
      return res.ok ? await res.json() : null
    } catch { return null }
  })()
  pending = { period, promise }
}

/**
 * The early read, ONCE and only for the period it was made for — the screen's own fetch is the
 * fallback for everything else (a null answer included), so this can never be the only road.
 */
export function takeBootLivePrefetch(period: LivePeriod): Promise<Reply | null> | null {
  if (!pending || pending.period !== period) return null
  const { promise } = pending
  pending = null
  return promise
}

export function resetBootPrefetch(): void { pending = null }
