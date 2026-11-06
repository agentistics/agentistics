/**
 * A trailing debounce with a CEILING (the web twin of the server's `debounce-maxwait.ts`). A plain
 * trailing debounce restarts on every call, so a steady stream of `book` events 200 ms apart starves
 * the refetch for as long as the stream lasts. `maxWaitMs` bounds how long the first pending call may
 * be deferred. `cancel()` drops anything pending (unmount).
 */
export function debounceWithMaxWait(
  fn: () => void,
  delayMs: number,
  maxWaitMs: number,
  timers: { set: (fn: () => void, ms: number) => any; clear: (h: any) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h) },
): { (): void; cancel: () => void } {
  let trailing: any = null
  let ceiling: any = null
  const cancel = () => {
    if (trailing) timers.clear(trailing)
    if (ceiling) timers.clear(ceiling)
    trailing = null
    ceiling = null
  }
  const fire = () => { cancel(); fn() }
  const call = () => {
    if (trailing) timers.clear(trailing)
    trailing = timers.set(fire, delayMs)
    if (!ceiling) ceiling = timers.set(fire, maxWaitMs)
  }
  call.cancel = cancel
  return call
}
