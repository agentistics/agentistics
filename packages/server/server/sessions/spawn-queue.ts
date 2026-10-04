/**
 * spawn-queue.ts — a spawn the admission gate refused WAITS instead of failing, and starts by itself
 * when room frees (RES.1 step 3).
 *
 * Owner, 2026-10-03: "as many sessions as the machine really holds, never a freeze". A refusal that
 * makes the user retry by hand is a refusal they retry five seconds later, every five seconds, until
 * one squeezes in at the worst moment. The queue is the gate's other half: the gate says NOT NOW,
 * the queue says WHEN.
 *
 * Rules:
 *  - **One start per tick, head first.** The gate is re-asked before every start, with a fresh
 *    measurement — starting three queued sessions because ONE fitted is the freeze the gate exists
 *    to prevent, by a different door.
 *  - **Bounded** (`QUEUE_MAX`): a queue that grows without limit is a fork bomb with a delay.
 *  - **Lives in the process that holds it** — the server for the web and the API, the cockpit for
 *    its own spawns — and SAYS so in the answer; nothing pretends it survives a restart.
 *  - **Cancelable**, and a start or a failure is ANNOUNCED: a session that appears by itself ten
 *    minutes later with nothing saying why is indistinguishable from a bug.
 *  - A queued spawn never ATTACHES: there is no terminal waiting for it when it finally starts.
 *
 * The ordering and the decision are PURE (`nextToStart`); the loop is a thin timer around them.
 */

import { randomUUID } from 'node:crypto'

export const QUEUE_MAX = 20
export const QUEUE_TICK_MS = 15_000

export interface QueuedSpawn<R = unknown> {
  id: string
  sinceMs: number
  /** What to show for it: the harness and the folder. */
  label: string
  request: R
}

export interface QueueRunner<R> {
  /** May ONE more start now? (the admission gate, freshly measured) */
  admit: () => Promise<boolean>
  /** Start it, bypassing the gate that `admit` already asked. */
  start: (request: R) => Promise<{ ok: boolean; message: string; id?: string }>
  notify: (n: { type: 'info' | 'warning'; code: string; meta: Record<string, unknown> }) => void
}

/** Which entry starts next — PURE. Oldest first; `null` when nothing is queued. */
export function nextToStart<R>(queue: readonly QueuedSpawn<R>[]): QueuedSpawn<R> | null {
  if (queue.length === 0) return null
  return [...queue].sort((a, b) => a.sinceMs - b.sinceMs || a.id.localeCompare(b.id))[0]!
}

/** The 1-based position of `id` — PURE. 0 when it is not queued. */
export function positionOf(queue: readonly QueuedSpawn[], id: string): number {
  const sorted = [...queue].sort((a, b) => a.sinceMs - b.sinceMs || a.id.localeCompare(b.id))
  return sorted.findIndex(q => q.id === id) + 1
}

export function createSpawnQueue<R>(runner: QueueRunner<R>, now: () => number = Date.now) {
  const queue: QueuedSpawn<R>[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  const stopIfEmpty = () => {
    if (queue.length === 0 && timer) { clearInterval(timer); timer = null }
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const head = nextToStart(queue)
      if (!head) return
      if (!(await runner.admit())) return
      queue.splice(queue.indexOf(head), 1)
      const out = await runner.start(head.request).catch(e => ({ ok: false, message: String(e) }))
      runner.notify(out.ok
        ? { type: 'info', code: 'hardware.spawn_started', meta: { label: head.label, waitedMin: Math.round((now() - head.sinceMs) / 60_000) } }
        : { type: 'warning', code: 'hardware.spawn_failed', meta: { label: head.label, reason: out.message } })
    } finally {
      ticking = false
      stopIfEmpty()
    }
  }

  return {
    /** Queue a refused spawn. `null` when the queue is full — the caller then refuses as before. */
    enqueue(label: string, request: R): { id: string; position: number } | null {
      if (queue.length >= QUEUE_MAX) return null
      const entry: QueuedSpawn<R> = { id: `q-${randomUUID().slice(0, 8)}`, sinceMs: now(), label, request }
      queue.push(entry)
      if (!timer) {
        timer = setInterval(() => { void tick() }, QUEUE_TICK_MS)
        ;(timer as { unref?: () => void }).unref?.()
      }
      return { id: entry.id, position: positionOf(queue, entry.id) }
    },
    cancel(id: string): boolean {
      const i = queue.findIndex(q => q.id === id)
      if (i < 0) return false
      queue.splice(i, 1)
      stopIfEmpty()
      return true
    },
    list(): Array<{ id: string; label: string; sinceMs: number; position: number }> {
      return queue.map(q => ({ id: q.id, label: q.label, sinceMs: q.sinceMs, position: positionOf(queue, q.id) }))
        .sort((a, b) => a.position - b.position)
    },
    /** Test seam / the governor's tick: run one pass now. */
    tick,
  }
}

export type SpawnQueue<R> = ReturnType<typeof createSpawnQueue<R>>

/** The server's queue, registered by the host that owns the spawn function (cli-start.ts). */
let registered: { list: () => ReturnType<SpawnQueue<unknown>['list']>; cancel: (id: string) => boolean } | null = null
export function registerSpawnQueue(q: { list: () => ReturnType<SpawnQueue<unknown>['list']>; cancel: (id: string) => boolean }): void {
  registered = q
}
export function registeredSpawnQueue() {
  return registered
}
