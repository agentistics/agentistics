export const FLEET_NEW_TIMEOUT_MS = 8_000
export const FLEET_NEW_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const
export const FLEET_NEW_MAX_ATTEMPTS = 5

export interface FleetNewRetryOptions {
  signal?: AbortSignal
  timeoutMs?: number
  retryDelaysMs?: readonly number[]
  maxAttempts?: number
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    return
  }
  const timer = globalThis.setTimeout(resolve, ms)
  signal.addEventListener('abort', () => {
    globalThis.clearTimeout(timer)
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }, { once: true })
})

/** Fetch one fleet snapshot, bounding each request and retrying transient failures. */
export async function fetchFleetNewWithRetry<T>(
  url: string,
  options: FleetNewRetryOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? wait
  const timeoutMs = options.timeoutMs ?? FLEET_NEW_TIMEOUT_MS
  const delays = options.retryDelaysMs ?? FLEET_NEW_RETRY_DELAYS_MS
  const maxAttempts = options.maxAttempts ?? FLEET_NEW_MAX_ATTEMPTS
  const parent = options.signal

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (parent?.aborted) throw parent.reason ?? new DOMException('Aborted', 'AbortError')
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(parent?.reason)
    parent?.addEventListener('abort', forwardAbort, { once: true })
    const timer = globalThis.setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`fleet/new responded ${response.status}`)
      return await response.json() as T
    } catch (error) {
      if (parent?.aborted) throw parent.reason ?? error
      if (attempt + 1 >= maxAttempts) throw error
      // A timed-out attempt has an aborted per-attempt signal; the parent signal is the one that
      // should cancel the backoff when the modal unmounts.
      const delaySignal = parent ?? new AbortController().signal
      await sleep(delays[attempt] ?? delays[delays.length - 1] ?? 0, delaySignal)
    } finally {
      globalThis.clearTimeout(timer)
      parent?.removeEventListener('abort', forwardAbort)
    }
  }
  throw new Error('fleet/new retries exhausted')
}
