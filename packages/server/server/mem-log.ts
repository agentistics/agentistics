/**
 * mem-log.ts — what the server holds, logged every `AGENTISTICS_PERF_MEM` seconds (PERF.1 step 4).
 * Off unless that variable is set (the soak test sets it). One line per sample: RSS, the JS heap, and
 * the object types whose counts grew most since the previous sample — names and counts only.
 */
export function startMemLog(env: Record<string, string | undefined> = process.env): void {
  const sec = Number(env.AGENTISTICS_PERF_MEM)
  if (!Number.isFinite(sec) || sec <= 0) return
  let prev: Record<string, number> = {}
  const t = setInterval(async () => {
    const { heapStats } = await import('bun:jsc')
    Bun.gc(true)
    const h = heapStats()
    const counts = h.objectTypeCounts as Record<string, number>
    const grew = Object.entries(counts).map(([k, n]) => [k, n - (prev[k] ?? 0)] as const).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]).slice(0, 6)
    prev = counts
    const mb = (n: number) => Math.round(n / 1048576)
    console.log(`[mem] rss ${mb(process.memoryUsage().rss)} MB, heap ${mb(h.heapSize)} MB, objects ${h.objectCount}; grew: ${grew.map(([k, d]) => `${k} +${d}`).join(', ')}`)
  }, sec * 1000)
  t.unref()
}
