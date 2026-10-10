/**
 * daemon.ts — the event producer riding along with the daemon that is already running.
 *
 * ## Why it rides along instead of being its own service
 *
 * The producer must be long-lived (see `producer.ts`: a single-invocation poll cannot tell a
 * working session from a finished one, because "working" is proven by the screen having MOVED since
 * last time). Something long-lived has to host it, and the choice was between a new service and one
 * that already exists.
 *
 * A new one loses. It would be a third thing to install, a third systemd unit, and — decisively —
 * a process the user has to remember to start, which means it is dead at the moment the fleet does
 * something worth knowing about. `otel-watcher` is already started by `agentop server`, already
 * covered by `agentop autostart`, and already the thing that lives as long as the machine's
 * agentistics does. So the producer starts here, and `agentop events run` exists for the person who
 * does not run the server at all.
 *
 * ## It never takes the daemon down with it
 *
 * Everything is wrapped: a machine with no tmux reports the reason once and the daemon carries on
 * doing what it was already doing. The event channel is an addition to that process, never a
 * condition of it.
 */

import { createHeartbeatWriter } from './producer-status'
import { createHostProducer, createHubProducer, type ProducerTick } from './producer'
import { isServerProcess } from '../sessions/shared-snapshot'
import { SESSION_POLL_MS } from '../sessions/sessions-host'

/** Set `AGENTISTICS_EVENTS=0` to keep the daemon from watching sessions at all. */
const enabled = (): boolean => process.env.AGENTISTICS_EVENTS !== '0'

export interface DaemonProducer {
  stop(): Promise<void>
}

/**
 * Start watching. Never throws; returns null when nothing was started, having said why.
 *
 * `log` is injected so the daemon's own prefix is used and this module owns no formatting.
 */
export async function startEventProducer(
  log: (line: string) => void = console.log,
): Promise<DaemonProducer | null> {
  if (!enabled()) {
    log('[events] disabled (AGENTISTICS_EVENTS=0)')
    return null
  }

  // INSIDE the server the producer polls NOTHING of its own: it consumes the server's ONE poller
  // (`session-hub.ts`), so the bell and the list read the same polls (ENGINE.MAP P-01). `agentop watch`
  // / `agentop events run` (no server in this process) keep their own poller, as before.
  if (isServerProcess()) return startHubProducer(log)

  let made: Awaited<ReturnType<typeof createHostProducer>>
  try {
    made = await createHostProducer({ onError: m => log(`[events] ${m}`) })
  } catch (e) {
    log(`[events] not watching: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }

  const beat = createHeartbeatWriter({ host: 'daemon' })

  if ('unavailable' in made) {
    // The producer cannot watch anything here, and that is a fact `agentop events status` must be
    // able to state — otherwise "no events" reads as "nothing happened" on a machine where nothing
    // ever could.
    log(`[events] not watching: ${made.unavailable}`)
    await beat.beat(made.unavailable)
    return { stop: async () => { await beat.clear() } }
  }

  let running = true
  const producer = made.producer

  void (async () => {
    await beat.beat()
    while (running) {
      try {
        const t = await producer.tick()
        await beat.beat(t.unavailable)
        for (const e of t.written) log(`[events] ${e.kind} · ${e.label ?? e.cwd}`)
        for (const l of t.delivery.lines) log(`[events] ${l}`)
      } catch (e) {
        log(`[events] ${e instanceof Error ? e.message : String(e)}`)
      }
      if (!running) break
      await new Promise(r => setTimeout(r, SESSION_POLL_MS))
    }
  })()

  log(`[events] watching sessions every ${SESSION_POLL_MS}ms — \`agentop events status\``)

  return {
    stop: async () => {
      running = false
      producer.stop()
      await beat.clear()
    },
  }
}

/**
 * How long after boot the in-server producer attaches to the hub. The hub lives behind `cli-start`
 * (which carries the cockpit's Ink tree); importing it while the server is still answering its first
 * `/api/data` would compete with the app's first paint. The first poll is a SEED anyway (nothing can
 * have changed about a session never seen before), so nothing is lost by waiting.
 */
const HUB_ATTACH_DELAY_MS = 3_000

async function startHubProducer(log: (line: string) => void): Promise<DaemonProducer | null> {
  const beat = createHeartbeatWriter({ host: 'daemon' })
  let running = true
  let off: (() => void) | null = null
  const attach = async (): Promise<void> => {
    try {
      const { ensureSessionHub } = await import('../cli-start')
      const hub = await ensureSessionHub()
      const made = await createHubProducer({ hub, onError: m => log(`[events] ${m}`) })
      if (!running) return
      if ('unavailable' in made) {
        log(`[events] not watching: ${made.unavailable}`)
        await beat.beat(made.unavailable)
        return
      }
      const producer = made.producer
      // One consume at a time, in poll order: the plan's memory only ever moves forward one poll.
      let queue: Promise<void> = Promise.resolve()
      // BACKGROUND demand: nobody is looking at this one, so the hub may idle slower (PERF.SLOW).
      off = hub.subscribe(snap => {
        queue = queue.then(async () => {
          if (!running) return
          try {
            const t: ProducerTick = await producer.consume(snap)
            await beat.beat(t.unavailable)
            for (const e of t.written) log(`[events] ${e.kind} · ${e.label ?? e.cwd}`)
            for (const l of t.delivery.lines) log(`[events] ${l}`)
          } catch (e) {
            log(`[events] ${e instanceof Error ? e.message : String(e)}`)
          }
        })
      }, { background: true })
      log(`[events] watching sessions on the server's poller (every ${SESSION_POLL_MS}ms) — \`agentop events status\``)
    } catch (e) {
      log(`[events] not watching: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  await beat.beat()
  const t = setTimeout(() => { void attach() }, HUB_ATTACH_DELAY_MS)
  return {
    stop: async () => {
      running = false
      clearTimeout(t)
      off?.()
      await beat.clear()
    },
  }
}
