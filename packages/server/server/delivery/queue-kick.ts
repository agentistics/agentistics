/**
 * delivery/queue-kick.ts — FILA.PRIORIDADE: "a worker ended, look at the queue now" (instead of waiting for the minute tick).
 *
 * Fire-and-forget and coalesced: a burst of sessions ending in the same poll runs the flow once, and the flow itself is
 * serialised with the tick, so kicking it can never open a session twice. A failure is logged and swallowed — the tick is
 * the floor and runs the same flow a minute later.
 */
let pending = false
let running = false

export function kickQueueNext(reason: string, run: () => Promise<{ actions: string[] }> = defaultRun): void {
  if (running) { pending = true; return }
  running = true
  void (async () => {
    try {
      do {
        pending = false
        const out = await run()
        if (out.actions.length) console.log(`[fila] ${reason}: ${out.actions.join(', ')}`)
      } while (pending)
    } catch (err) {
      console.error('[fila] kick:', err instanceof Error ? err.message : String(err))
    } finally { running = false }
  })()
}

async function defaultRun(): Promise<{ actions: string[] }> {
  return (await import('./host')).deliveryService().queueNext()
}
