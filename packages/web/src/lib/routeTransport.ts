/** Bounded JSON transport for route-local reads. Route failures stay local to the route. */
export type RouteErrorKind = 'timeout' | 'unreachable' | 'server' | 'refused'
export interface RouteError { kind: RouteErrorKind; status?: number; detail: string }

export const ROUTE_TIMEOUT_MS = 5000
export const ROUTE_HARD_TIMEOUT_MS = 60_000
export function retryBackoffMs(attempt: number): number {
  return Math.min(4000, 250 * 2 ** Math.max(0, attempt))
}

export function classifyRouteError(error: unknown, status?: number): RouteError {
  if (status === 403 || status === 404) return { kind: 'refused', status, detail: `HTTP ${status}` }
  if (status !== undefined) return { kind: 'server', status, detail: `HTTP ${status}` }
  const name = (error as { name?: string } | null)?.name
  const detail = String((error as { message?: string } | null)?.message ?? error)
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(detail)) return { kind: 'timeout', detail }
  return { kind: 'unreachable', detail }
}

/** The timer remains armed until headers and the complete body have arrived. */
export async function fetchRouteJson<T>(url: string, options: { timeoutMs?: number; hardTimeoutMs?: number; signal?: AbortSignal; onSlow?: () => void } = {}): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? ROUTE_TIMEOUT_MS
  const hardTimeoutMs = options.hardTimeoutMs ?? ROUTE_HARD_TIMEOUT_MS
  let hardTimedOut = false
  const abort = () => controller.abort()
  const slowTimer = setTimeout(() => options.onSlow?.(), timeoutMs)
  const hardTimer = setTimeout(() => { hardTimedOut = true; controller.abort() }, hardTimeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw classifyRouteError(undefined, response.status)
    try { return await response.json() as T } catch (error) {
      if (hardTimedOut) throw classifyRouteError({ name: 'TimeoutError', message: 'request body timed out' })
      throw classifyRouteError(error)
    }
  } catch (error) {
    if ((error as RouteError)?.kind) throw error
    if (hardTimedOut) throw classifyRouteError({ name: 'TimeoutError', message: 'request timed out' })
    throw classifyRouteError(error)
  } finally {
    clearTimeout(slowTimer)
    clearTimeout(hardTimer)
    options.signal?.removeEventListener('abort', abort)
  }
}
