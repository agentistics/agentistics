/**
 * event-line.ts — PURE. One event, one line, and how to read a line somebody else wrote.
 *
 * The inbox is append-only JSONL because that is the format a later reader can start reading in the
 * middle of. Two properties matter and both are tested:
 *
 *  - **A line is exactly one line.** Everything written goes through `serializeEvent`, which strips
 *    newlines out of the free text it carries. A screen tail with a newline in it would otherwise
 *    split one event into two half-lines, and the reader would drop both.
 *  - **An unreadable line is skipped, never fatal.** The file survives upgrades, crashes mid-write
 *    and a version of agentop that wrote fields this one has never heard of. `parseEvents` returns
 *    what it could read and COUNTS what it could not, so `agentop events status` can say "4 lines
 *    in this file are not readable by this version" instead of the file silently reading as empty.
 *
 * Unknown fields are preserved on read (the object is passed through), so a newer producer's extra
 * fields survive a round trip through an older reader that only re-serializes what it parsed.
 */

import { EVENT_KINDS, EVENT_VERSION, type SessionEvent } from './event-types'

/** How much of a screen tail one event may carry. A tail is context, not a transcript. */
export const MAX_LINE_CHARS = 400
export const MAX_TAIL_LINES = 8

// U+2028 / U+2029 are line terminators to a JS parser but not to `split('\n')`, so they would
// survive here and split one event in two on the way back out through some other reader.
const oneLine = (s: string): string =>
  s.replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, MAX_LINE_CHARS)

/**
 * The bytes of one event, newline included.
 *
 * The tail is clamped here rather than at the producer so that EVERY writer — the poller, the hook,
 * a future one — is bounded by the same rule. An inbox is a file that grows; the cheapest place to
 * stop it growing per-line is the one place every line goes through.
 */
export function serializeEvent(e: SessionEvent): string {
  const clean: SessionEvent = {
    ...e,
    cwd: oneLine(e.cwd),
    ...(e.task ? { task: oneLine(e.task) } : {}),
    ...(e.label ? { label: oneLine(e.label) } : {}),
    ...(e.lines ? { lines: e.lines.slice(-MAX_TAIL_LINES).map(oneLine) } : {}),
  }
  return `${JSON.stringify(clean)}\n`
}

/** One line back into an event, or null when this version cannot make sense of it. */
export function parseEvent(line: string): SessionEvent | null {
  const text = line.trim()
  if (text === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  // A line from the FUTURE is not readable by this version, and guessing at it is how a reader
  // reports a half-understood event as a whole one. It is counted as unreadable, not silently kept.
  if (typeof o.v !== 'number' || o.v > EVENT_VERSION) return null
  if (typeof o.at !== 'string' || o.at === '') return null
  if (typeof o.id !== 'string' || o.id === '') return null
  if (typeof o.cwd !== 'string') return null
  if (o.source !== 'poll' && o.source !== 'hook' && o.source !== 'native') return null
  if (typeof o.kind !== 'string' || !EVENT_KINDS.includes(o.kind as never)) return null

  return {
    ...o,
    v: o.v,
    seq: typeof o.seq === 'number' ? o.seq : 0,
    at: o.at,
    source: o.source,
    kind: o.kind as SessionEvent['kind'],
    id: o.id,
    cwd: o.cwd,
    ...(Array.isArray(o.lines) ? { lines: (o.lines as unknown[]).filter((l): l is string => typeof l === 'string') } : {}),
  } as SessionEvent
}

export interface ParsedEvents {
  events: SessionEvent[]
  /** Lines this version could not read. Reported, never hidden — see the header. */
  unreadable: number
}

export function parseEvents(text: string): ParsedEvents {
  const events: SessionEvent[] = []
  let unreadable = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const e = parseEvent(line)
    if (e) events.push(e)
    else unreadable++
  }
  return { events, unreadable }
}
