/**
 * A trailing debounce with a CEILING. A plain trailing debounce restarts its timer on every call, so
 * a steady stream of writes (one every 110 ms for 3 s) emits once, at the very end — and a client
 * watching that stream sees nothing until it stops. `maxWaitMs` bounds how long the first pending
 * call may be deferred: past it the callback fires even though calls keep arriving.
 */
export function debounceWithMaxWait(
  fn: () => void,
  delayMs: number,
  maxWaitMs: number,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
): () => void {
  let trailing: ReturnType<typeof setTimeout> | null = null
  let ceiling: ReturnType<typeof setTimeout> | null = null
  const fire = () => {
    if (trailing) timers.clear(trailing)
    if (ceiling) timers.clear(ceiling)
    trailing = null
    ceiling = null
    fn()
  }
  return () => {
    if (trailing) timers.clear(trailing)
    trailing = timers.set(fire, delayMs)
    if (!ceiling) ceiling = timers.set(fire, maxWaitMs)
  }
}
