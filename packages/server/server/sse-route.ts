/**
 * PERF.SERVIDOR-OCIOSO — PURE. Which rebuild pace a file change goes to: the watched one (5–10 s, a dashboard is
 * connected and will be told `change`), the unwatched one (30–60 s, nobody is looking; the data is marked dirty and a
 * reader builds before answering), or none (a process that does not serve `/api/data`).
 */
export function rebuildRoute(o: { rebuildOnChange: boolean; clients: number }): 'watched' | 'unwatched' | 'notify-only' {
  if (!o.rebuildOnChange) return 'notify-only'
  return o.clients > 0 ? 'watched' : 'unwatched'
}

/** The unwatched pace (see `sse.ts`): the first change after a quiet spell builds after the debounce; a steady stream
 *  of writes builds at most every 30 s (60 s after a slow build). Readers of the consolidate store lag by at most this. */
export const UNWATCHED_DEBOUNCE_MS = 300
export const UNWATCHED_MIN_GAP_MS = 30_000
export const UNWATCHED_MAX_GAP_MS = 60_000
export const UNWATCHED_LOAD_FACTOR = 4
