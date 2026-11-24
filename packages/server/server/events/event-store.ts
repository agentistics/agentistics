/**
 * event-store.ts — the inbox on disk. Every DECISION here is already made by a pure module
 * (`event-line.ts` for the bytes, `event-rotate.ts` for the cursor and the cap); this file opens
 * files.
 *
 * ## Why there is an inbox at all
 *
 * A Claude session only exists while it is being invoked. An event delivered to a session that is
 * parked is an event that happened to nobody. The inbox is what makes the channel work for the
 * consumer that is not running: it reads what happened since it last looked, on its own schedule.
 * Everything else in this feature — the socket, the toast — is a way of making that read HAPPEN
 * SOONER, never a replacement for it.
 *
 * ## Appends are serialized in-process and atomic on disk
 *
 * Several producers can exist (the daemon, a foreground `agentop events run`, the Stop hook firing
 * from Claude Code). `appendFile` with `O_APPEND` is atomic for writes under PIPE_BUF on Linux and
 * each line is far smaller than that, so two writers interleave whole lines rather than shredding
 * one. The in-process chain on top of it keeps `seq` monotonic within one producer; two producers
 * can in principle both hand out the same seq, which is why `seq` is documented as a CURSOR
 * ordinal and never as an identity.
 *
 * ## Permissions
 *
 * The file holds screen tails, which are the user's own text. It is created 0600 under
 * `~/.agentistics`, the same directory (and the same expectation) as the rest of this app's local
 * state, and nothing in this feature sends it off the machine.
 */

import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { parseEvents, serializeEvent } from './event-line'
import {
  EMPTY_CURSOR, MAX_INBOX_BYTES, advanceCursor, planRead, planRotation, type EventCursor,
} from './event-rotate'
import type { SessionEvent } from './event-types'

export const EVENTS_FILE = process.env.AGENTISTICS_EVENTS_FILE ?? join(AGENTISTICS_DATA_DIR, 'events.jsonl')
/** Exactly one previous generation. See `event-rotate.ts` for why one. */
export const EVENTS_FILE_PREVIOUS = `${EVENTS_FILE}.1`

const MODE = 0o600

async function fileBytes(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

/** The highest `seq` the current file holds, so a fresh producer continues the numbering rather
 *  than restarting it in the middle of a file and breaking every cursor pointing into it. */
async function lastSeq(file: string): Promise<number> {
  const size = await fileBytes(file)
  if (size === 0) return 0
  // Only the tail is read: the answer is on the last readable line, and a two-megabyte read to
  // learn one number is a cost paid on every producer start.
  const from = Math.max(0, size - 64 * 1024)
  const text = await readSlice(file, from)
  const { events } = parseEvents(text)
  return events.length > 0 ? (events[events.length - 1]!.seq ?? 0) : 0
}

async function readSlice(file: string, from: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const size = (await fh.stat()).size
    if (from >= size) return ''
    const length = size - from
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, from)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Every event still on disk, oldest first: the previous generation, then the current file. A reader of history (the benchmark's archived-session link) needs both. */
export async function readAllEvents(file = EVENTS_FILE): Promise<SessionEvent[]> {
  const out: SessionEvent[] = []
  for (const f of [`${file}.1`, file]) {
    try { out.push(...parseEvents(await readFile(f, 'utf8')).events) } catch { /* a generation that is not there */ }
  }
  return out
}

export interface EventStore {
  /** Append these events, stamping `seq`. Returns them as written. */
  append(events: readonly SessionEvent[]): Promise<SessionEvent[]>
  /** The most recent `count` events, oldest first. */
  recent(count: number): Promise<{ events: SessionEvent[]; unreadable: number; cursor: EventCursor }>
  /** Everything after a cursor. `rotated` says the cursor could not be honoured. */
  since(cursor: EventCursor): Promise<{
    events: SessionEvent[]; unreadable: number; cursor: EventCursor; rotated: boolean
  }>
  /** For `status`: how big it is and where it is. */
  info(): Promise<{ file: string; bytes: number; previousBytes: number; seq: number }>
}

export function createEventStore(file = EVENTS_FILE, maxBytes = MAX_INBOX_BYTES): EventStore {
  const previous = `${file}.1`
  // The next sequence number, resolved lazily from the file and then held. A promise rather than a
  // number so two concurrent appends cannot both read "the file ends at 7" and both write 8.
  let chain: Promise<number> | null = null

  async function nextSeqStart(): Promise<number> {
    return (await lastSeq(file)) + 1
  }

  async function append(events: readonly SessionEvent[]): Promise<SessionEvent[]> {
    if (events.length === 0) return []
    const run = async (seed: number): Promise<{ seq: number; written: SessionEvent[] }> => {
      let seq = seed
      const written = events.map(e => ({ ...e, seq: seq++ }))
      const text = written.map(serializeEvent).join('')

      await mkdir(dirname(file), { recursive: true })
      const size = await fileBytes(file)
      if (planRotation(size, Buffer.byteLength(text), maxBytes)) {
        // Rename rather than copy-and-truncate: a reader mid-file keeps reading the inode it opened
        // instead of watching its bytes vanish under it.
        try { await rename(file, previous) } catch { /* gone already — the write below recreates it */ }
        // The numbering restarts with the file, which is exactly what `planRead` cross-checks a
        // cursor against.
        seq = 1
        const renumbered = events.map(e => ({ ...e, seq: seq++ }))
        await writeFile(file, renumbered.map(serializeEvent).join(''), { encoding: 'utf8', mode: MODE })
        return { seq, written: renumbered }
      }

      if (!existsSync(file)) await writeFile(file, '', { encoding: 'utf8', mode: MODE })
      await appendFile(file, text, { encoding: 'utf8', mode: MODE })
      return { seq, written }
    }

    // One in-flight append at a time, so `seq` is monotonic within this process.
    const started = chain ?? nextSeqStart()
    let resolveNext: (n: number) => void = () => {}
    chain = new Promise<number>(r => { resolveNext = r })
    try {
      const { seq, written } = await run(await started)
      resolveNext(seq)
      return written
    } catch (e) {
      // A failed append must not leave the chain holding a sequence nobody will resolve, or every
      // later append hangs. Re-resolve from the file on the next call.
      chain = null
      resolveNext(0)
      throw e
    }
  }

  async function recent(count: number) {
    const size = await fileBytes(file)
    if (size === 0) return { events: [], unreadable: 0, cursor: EMPTY_CURSOR }
    const text = await readSlice(file, 0)
    const { events, unreadable } = parseEvents(text)
    const tail = events.slice(-count)
    return {
      events: tail,
      unreadable,
      cursor: advanceCursor(size, events.length > 0 ? events[events.length - 1]!.seq : 0),
    }
  }

  async function since(cursor: EventCursor) {
    const size = await fileBytes(file)
    if (size === 0) return { events: [], unreadable: 0, cursor: EMPTY_CURSOR, rotated: false }
    const plan = planRead(cursor, size, await lastSeq(file))
    const text = await readSlice(file, plan.from)
    const { events, unreadable } = parseEvents(text)
    return {
      events,
      unreadable,
      cursor: advanceCursor(size, events.length > 0 ? events[events.length - 1]!.seq : cursor.seq),
      rotated: plan.rotated,
    }
  }

  async function info() {
    return {
      file,
      bytes: await fileBytes(file),
      previousBytes: await fileBytes(previous),
      seq: await lastSeq(file),
    }
  }

  return { append, recent, since, info }
}
