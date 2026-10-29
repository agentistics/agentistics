/**
 * producer-status.ts — is anything actually watching?
 *
 * "No events arrived" has two causes that look identical from the outside: nothing happened, or
 * nobody was watching. The second is the one that makes a person stop trusting the channel, so it
 * has to be a state `agentop events status` can NAME. A running producer stamps a small heartbeat
 * file; `status` reads it and reports the producer as running, stale (a heartbeat whose process is
 * gone, i.e. a daemon that was killed) or absent.
 *
 * The heartbeat is throttled rather than written every tick: the poll runs every five seconds and
 * the point of this file is liveness, not a log.
 *
 * Liveness is confirmed against the PID, not against the timestamp alone — a machine that was
 * suspended for an hour has a stale-looking heartbeat and a perfectly alive daemon.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { durableWriteFile } from '../durable-write'

export const PRODUCER_STATUS_FILE =
  process.env.AGENTISTICS_EVENT_PRODUCER_FILE ?? join(AGENTISTICS_DATA_DIR, 'events-producer.json')

/** How often the heartbeat is refreshed. */
export const HEARTBEAT_MS = 30_000

export interface ProducerHeartbeat {
  pid: number
  /** `daemon` — riding along with `agentop server` / `agentop watch`. `foreground` — `events run`. */
  host: 'daemon' | 'foreground'
  startedAt: string
  updatedAt: string
  /** Set when the producer is up but cannot watch anything (no tmux here). */
  unavailable?: string
}

export async function readHeartbeat(file = PRODUCER_STATUS_FILE): Promise<ProducerHeartbeat | null> {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<ProducerHeartbeat>
    if (typeof raw.pid !== 'number') return null
    return {
      pid: raw.pid,
      host: raw.host === 'foreground' ? 'foreground' : 'daemon',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      ...(typeof raw.unavailable === 'string' ? { unavailable: raw.unavailable } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Is that pid still there? `kill(pid, 0)` asks the kernel and changes nothing.
 *
 * Both failures mean "not our producer": ESRCH is gone, and EPERM is a pid that now belongs to
 * another user — a recycled number, not the daemon that wrote this file. Reporting a producer as
 * running because some unrelated process holds its old pid is the one wrong answer here.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type ProducerState =
  | { state: 'running'; heartbeat: ProducerHeartbeat }
  | { state: 'stale'; heartbeat: ProducerHeartbeat }
  | { state: 'absent' }

export async function producerState(file = PRODUCER_STATUS_FILE): Promise<ProducerState> {
  const hb = await readHeartbeat(file)
  if (!hb) return { state: 'absent' }
  return pidAlive(hb.pid) ? { state: 'running', heartbeat: hb } : { state: 'stale', heartbeat: hb }
}

/** A writer that throttles itself. Returns a `beat()` to call from the loop and a `clear()` for a
 *  clean shutdown, so a producer that exits normally does not leave a heartbeat behind. */
export function createHeartbeatWriter(o: {
  host: ProducerHeartbeat['host']
  file?: string
  now?: () => number
  everyMs?: number
}): { beat(unavailable?: string): Promise<void>; clear(): Promise<void> } {
  const file = o.file ?? PRODUCER_STATUS_FILE
  const now = o.now ?? (() => Date.now())
  const every = o.everyMs ?? HEARTBEAT_MS
  const startedAt = new Date(now()).toISOString()
  let lastWrite = 0

  return {
    async beat(unavailable?: string) {
      const t = now()
      if (lastWrite !== 0 && t - lastWrite < every) return
      lastWrite = t
      const doc: ProducerHeartbeat = {
        pid: process.pid,
        host: o.host,
        startedAt,
        updatedAt: new Date(t).toISOString(),
        ...(unavailable !== undefined ? { unavailable } : {}),
      }
      try {
        await mkdir(dirname(file), { recursive: true })
        await durableWriteFile(file, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch { /* a heartbeat that cannot be written costs `status` a line, never the producer */ }
    },
    async clear() {
      // Only ours. A heartbeat belonging to another producer is not this one's to delete.
      try {
        const hb = await readHeartbeat(file)
        if (hb?.pid === process.pid) await rm(file)
      } catch { /* nothing to clear */ }
    },
  }
}
