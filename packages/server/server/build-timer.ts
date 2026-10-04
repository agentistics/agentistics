/**
 * build-timer.ts — where a `/api/data` build spends its time (PERF.1), logged as ONE `[data]` line per
 * build: names of phases and harnesses with milliseconds, nothing else. A slow build on a real machine
 * then says which phase is slow without anyone copying that machine's data.
 */
export interface BuildTimer {
  /** Ends the current phase under `name` (a repeated name accumulates). */
  mark(name: string): void
  line(): string
}

export function createBuildTimer(now: () => number = () => performance.now()): BuildTimer {
  const start = now()
  let last = start
  const phases = new Map<string, number>()
  return {
    mark(name) { const t = now(); phases.set(name, (phases.get(name) ?? 0) + (t - last)); last = t },
    line() {
      const shown = [...phases].filter(([, ms]) => ms >= 1)
      const slowest = shown.reduce<[string, number] | null>((m, p) => (!m || p[1] > m[1] ? p : m), null)
      const parts = shown.map(([n, ms]) => `${n} ${Math.round(ms)}${slowest && n === slowest[0] ? ' (slowest)' : ''}`)
      return `built in ${Math.round(last - start)} ms: ${parts.join(', ')}`
    },
  }
}
