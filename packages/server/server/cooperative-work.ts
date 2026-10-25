/** Share CPU time with HTTP while cold readers drain cached fs completions. Awaiting an
 * already-resolved promise is only a microtask; setImmediate lets sockets/timers run too. */
export function runSynchronously<T>(work: Generator<void, T, void>): T {
  let step = work.next()
  while (!step.done) step = work.next()
  return step.value
}

const CPU_SLICE_MS = 8
export async function runCooperatively<T>(work: Generator<void, T, void>): Promise<T> {
  // Also yield for small files. A cold directory can contain thousands of them, and fs promises
  // alone need not give the HTTP server a turn between completions.
  await new Promise<void>(resolve => setImmediate(resolve))
  let sliceStarted = performance.now()
  let step = work.next()
  while (!step.done) {
    if (performance.now() - sliceStarted >= CPU_SLICE_MS) {
      await new Promise<void>(resolve => setImmediate(resolve))
      sliceStarted = performance.now()
    }
    step = work.next()
  }
  return step.value
}
