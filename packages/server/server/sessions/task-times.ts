/**
 * task-times.ts — PURE. When a piece of work started, when it finished and how long it was ACTIVE,
 * read from the SESSIONS that did it rather than from the moment somebody moved a status.
 *
 * Rules (owner, 2026-10-02):
 *  1. With at least one linked session: start = the earliest session start; completed = the latest
 *     session end, and ONLY when the piece is done. The status stamps (`startedAt`/`deliveredAt`)
 *     are the answer only when no session is linked.
 *  2. A session linked later wins retroactively — there is nothing stored here, it is recomputed.
 *  3. Never stretch time with fake data: ACTIVE time is the union of the sessions' active time, so
 *     the idle gap between a close and a reopen is not counted.
 *  4. Duration = completed − start (wall clock); `activeMinutes` is the second figure.
 *
 * STATED LIMIT on rule 3: a session records its TOTAL active minutes (`active_minutes`), not the
 * individual intervals. So where two sessions overlap in wall time, each one's active minutes are
 * scaled by the share of its span not already covered by an earlier session — exact for sessions
 * that do not overlap (the sum), and never more than the wall time the union covers.
 * A conversation reopened N times is ONE meta (callers dedupe), so its own idle gaps are already
 * out of `active_minutes`.
 */

export interface SessionSpan {
  startMs: number
  endMs: number
  /** Null when the session could not measure it (no transcript read). */
  activeMin: number | null
}

export interface PieceTimes {
  startedAt: string | null
  /** Null while the piece is not done, whatever the sessions say. */
  completedAt: string | null
  /** completedAt − startedAt, wall clock; null unless both exist and are ordered. */
  durationMs: number | null
  /** The union of active time across the sessions; null when no session measured any. */
  activeMinutes: number | null
  source: 'sessions' | 'status' | null
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Active minutes of the union of spans (see the module's stated limit). */
export function unionActiveMinutes(spans: readonly SessionSpan[]): number | null {
  const measured = spans.filter(s => s.activeMin !== null && Number.isFinite(s.activeMin))
  if (measured.length === 0) return null
  const ordered = [...measured].sort((a, b) => a.startMs - b.startMs)
  let covered: Array<[number, number]> = []
  let total = 0
  for (const s of ordered) {
    const len = Math.max(0, s.endMs - s.startMs)
    let fresh = len
    for (const [a, b] of covered) {
      const overlap = Math.min(b, s.endMs) - Math.max(a, s.startMs)
      if (overlap > 0) fresh -= overlap
    }
    fresh = Math.max(0, fresh)
    // A zero-length span has nothing to overlap: its minutes stand as measured.
    total += len === 0 ? s.activeMin! : s.activeMin! * (fresh / len)
    covered = mergeInto(covered, [s.startMs, s.endMs])
  }
  return Math.round(total * 10) / 10
}

function mergeInto(list: Array<[number, number]>, next: [number, number]): Array<[number, number]> {
  const all = [...list, next].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const iv of all) {
    const last = out[out.length - 1]
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else out.push([iv[0], iv[1]])
  }
  return out
}

export function pieceTimes(o: {
  spans: readonly SessionSpan[]
  done: boolean
  statusStartedAt?: string
  statusDeliveredAt?: string
}): PieceTimes {
  const spans = o.spans.filter(s => Number.isFinite(s.startMs) && Number.isFinite(s.endMs))
  if (spans.length > 0) {
    const start = Math.min(...spans.map(s => s.startMs))
    const end = Math.max(...spans.map(s => Math.max(s.endMs, s.startMs)))
    return {
      startedAt: iso(start),
      completedAt: o.done ? iso(end) : null,
      durationMs: o.done && end >= start ? end - start : null,
      activeMinutes: unionActiveMinutes(spans),
      source: 'sessions',
    }
  }
  const s = o.statusStartedAt ? Date.parse(o.statusStartedAt) : NaN
  const d = o.done && o.statusDeliveredAt ? Date.parse(o.statusDeliveredAt) : NaN
  const hasS = Number.isFinite(s)
  const hasD = Number.isFinite(d)
  return {
    startedAt: hasS ? o.statusStartedAt! : null,
    completedAt: hasD ? o.statusDeliveredAt! : null,
    durationMs: hasS && hasD && d >= s ? d - s : null,
    activeMinutes: null,
    source: hasS || hasD ? 'status' : null,
  }
}

/** A session's span from its meta (preferred) or its registry row. */
export function spanOf(o: {
  metaStart?: string; metaEnd?: string; activeMin?: number
  rowCreatedAt?: string; rowEndedAt?: string
}): SessionSpan | null {
  const startRaw = o.metaStart || o.rowCreatedAt
  const start = startRaw ? Date.parse(startRaw) : NaN
  if (!Number.isFinite(start)) return null
  const endRaw = o.metaEnd || o.rowEndedAt || startRaw
  let end = endRaw ? Date.parse(endRaw!) : start
  if (!Number.isFinite(end) || end < start) end = start
  return { startMs: start, endMs: end, activeMin: typeof o.activeMin === 'number' ? o.activeMin : null }
}
