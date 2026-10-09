/**
 * fleet-events.ts — the session list PUSHED: `GET /api/fleet/events` (ENGINE.MAP 09 §6, P-02, P-13).
 *
 * Every client used to pull `/api/fleet` every five seconds — and every pull was a fleet poll (P-02)
 * shipping ~620 KB, most of it hundreds of `closed:` rows that had not changed in days (P-13). Now the
 * server's ONE poller (`session-hub.ts`) ticks, and each tick is pushed as what CHANGED:
 *
 * ```
 * retry: 2000
 * event: snapshot   {seq, sessions, rows, attention, tasks, finishedTasks, unavailable?, fell?, baseline?,
 *                    view?, closed: {total, sent}}
 * event: delta      {seq, upsert?: {sessions, rows}, remove?: [id], meta?: {<changed top-level field>: value | null},
 *                    order?: [id]}
 * event: ping       <ms>
 * ```
 *
 * - **The WINDOW.** `sessions`/`rows` hold every row that is not a `closed:` conversation, plus the
 *   `closed` most recent closed ones (`closedLimit`, default `DEFAULT_CLOSED_LIMIT`). Older closed rows
 *   are PAGED on demand (`GET /api/fleet/closed`), never re-sent on a timer.
 * - **`upsert`** carries a window row whose content changed, both shapes (`FleetRow` + `ControlSession`)
 *   so a client keeps the pair the `/api/fleet` payload always gave it. **`remove`** names a row that
 *   was SENT and is no longer in the fleet at all — never a row that merely slid out of the closed window
 *   (it still exists; the client keeps it). **`order`** is the window's ids in the server's order, sent
 *   only when that order changed.
 * - **`meta`** carries a top-level field only when it changed; `null` means it is gone (an `unavailable`
 *   cleared, a `fell` dismissed). `view` (opt-in, the same `view=1` parameters as `/api/fleet`) travels
 *   COMPACT: its groups name row ids (`ids`), never a second copy of every row.
 * - **One computation per tick, not per client.** The frame for one (language, view) is built once per
 *   hub snapshot (`FleetFrameSource`) and every stream diffs against its own last-sent copy.
 *
 * The planner (`planFleetDelta`, `windowOf`, `compactView`, `metaDelta`) is PURE and tested; the stream
 * takes its clock, timers and source as dependencies.
 */
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { FleetRow } from './fleet-row'
import type { FleetArrangement } from './fleet-arrange'
import { CLOSED_ROW_PREFIX } from './row-conversation'

export const DEFAULT_CLOSED_LIMIT = 20
export const MAX_CLOSED_LIMIT = 200
export const FLEET_EVENTS_KEEPALIVE_MS = 15_000
/** Fleet streams one server keeps at once; past it the client keeps polling `/api/fleet`. */
export const MAX_FLEET_STREAMS = 32

/** The `/api/fleet` payload, as far as the stream reads it (`fleet-web.ts` `FleetPayload`). */
export interface FleetFramePayload {
  sessions: FleetRow[]
  rows: ControlSession[]
  attention: number
  unavailable?: string
  tasks: string[]
  finishedTasks: string[]
  fell?: { count: number; atMs: number }
  view?: FleetArrangement
  baseline?: unknown
}

/** A view's groups by id: what a client needs to arrange rows it already holds. */
export interface CompactArrangement extends Omit<FleetArrangement, 'groups'> {
  groups: Array<{ key: string; label: string; done?: boolean; ids: string[] }>
}

/** One frame, computed ONCE per (language, view, hub snapshot) and shared by every stream. */
export interface FleetFrame {
  /** Window rows in server order, each with its two shapes and their serialization. */
  window: Array<{ id: string; session: FleetRow; row: ControlSession; json: string }>
  /** Every row id in the whole fleet (window or not) — what `remove` is judged against. */
  allIds: Set<string>
  closedTotal: number
  /** Top-level fields, each already serialized — what `meta` is diffed on. */
  meta: Record<string, string>
  /** The same fields, as values. */
  metaValues: Record<string, unknown>
}

export const isClosedRow = (id: string): boolean => id.startsWith(CLOSED_ROW_PREFIX)

/** A closed row's recency: when it ended, else when the person last wrote, else when it began. */
function recency(r: ControlSession): number {
  return r.endedAt ?? r.lastUserMessageAt ?? r.startedAt ?? 0
}

/**
 * PURE. Which rows a stream carries: every non-closed row in server order, then the `closedLimit` most
 * recent closed ones in server order. Returns the indexes into `rows`.
 */
export function windowOf(rows: readonly ControlSession[], closedLimit: number): { indexes: number[]; closedTotal: number } {
  const closed = rows.map((r, i) => ({ r, i })).filter(x => isClosedRow(x.r.id))
  const keep = new Set(
    [...closed].sort((a, b) => recency(b.r) - recency(a.r) || a.i - b.i).slice(0, Math.max(0, closedLimit)).map(x => x.i),
  )
  const indexes = rows.map((_, i) => i).filter(i => !isClosedRow(rows[i]!.id) || keep.has(i))
  return { indexes, closedTotal: closed.length }
}

/** PURE. The view with row ids in place of rows. */
export function compactView(view: FleetArrangement): CompactArrangement {
  return { ...view, groups: view.groups.map(g => ({ key: g.key, label: g.label, ...(g.done ? { done: true } : {}), ids: g.rows.map(r => r.id) })) }
}

/** PURE. Build the shared frame from one `/api/fleet` payload. */
export function buildFleetFrame(p: FleetFramePayload, closedLimit: number): FleetFrame {
  // `sessions[i]` is `fleetRow(rows[i])` for the managed half and the same object order throughout
  // (`fleet-web.ts`), so pairing by id is exact and survives any reordering a later change might add.
  const byId = new Map(p.sessions.map(s => [s.id, s]))
  const { indexes, closedTotal } = windowOf(p.rows, closedLimit)
  const window: FleetFrame['window'] = []
  for (const i of indexes) {
    const row = p.rows[i]!
    const session = byId.get(row.id)
    if (!session) continue
    window.push({ id: row.id, session, row, json: JSON.stringify([session, row]) })
  }
  const metaValues: Record<string, unknown> = {
    attention: p.attention,
    tasks: p.tasks,
    finishedTasks: p.finishedTasks,
    closedTotal,
    ...(p.unavailable !== undefined ? { unavailable: p.unavailable } : {}),
    ...(p.fell ? { fell: p.fell } : {}),
    ...(p.baseline !== undefined ? { baseline: p.baseline } : {}),
    ...(p.view ? { view: compactView(p.view) } : {}),
  }
  const meta: Record<string, string> = {}
  for (const [k, v] of Object.entries(metaValues)) meta[k] = JSON.stringify(v)
  return { window, allIds: new Set(p.rows.map(r => r.id)), closedTotal, meta, metaValues }
}

/** What one stream remembers having sent. */
export interface SentState {
  rows: Map<string, string>
  order: string[]
  meta: Record<string, string>
}

export interface FleetDelta {
  upsert: string[]
  remove: string[]
  /** Changed top-level fields; `null` = the field is gone. */
  meta: Record<string, unknown>
  order?: string[]
}

/**
 * PURE. What one stream must send to go from `sent` to `frame`, and what it will have sent afterwards.
 *
 * `upsert`: window rows that are new or whose content changed. `remove`: rows sent before that are no
 * longer in the FLEET (a row that slid out of the closed window still exists and is simply no longer
 * tracked). An empty delta (nothing in any field) means: send nothing.
 */
export function planFleetDelta(sent: SentState, frame: FleetFrame): { delta: FleetDelta; next: SentState; empty: boolean } {
  const upsert: string[] = []
  const nextRows = new Map<string, string>()
  for (const w of frame.window) {
    if (sent.rows.get(w.id) !== w.json) upsert.push(w.id)
    nextRows.set(w.id, w.json)
  }
  const remove = [...sent.rows.keys()].filter(id => !frame.allIds.has(id))
  const meta: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(frame.meta)) if (sent.meta[k] !== v) meta[k] = frame.metaValues[k]
  for (const k of Object.keys(sent.meta)) if (!(k in frame.meta)) meta[k] = null
  const order = frame.window.map(w => w.id)
  const orderChanged = order.length !== sent.order.length || order.some((id, i) => sent.order[i] !== id)
  const delta: FleetDelta = { upsert, remove, meta, ...(orderChanged ? { order } : {}) }
  const empty = upsert.length === 0 && remove.length === 0 && Object.keys(meta).length === 0 && !orderChanged
  return { delta, next: { rows: nextRows, order, meta: { ...frame.meta } }, empty }
}

export const EMPTY_SENT: SentState = { rows: new Map(), order: [], meta: {} }

/** PURE. The `snapshot` event body for a frame. */
export function snapshotBody(seq: number, frame: FleetFrame): Record<string, unknown> {
  const { closedTotal, ...rest } = frame.metaValues
  return {
    seq,
    sessions: frame.window.map(w => w.session),
    rows: frame.window.map(w => w.row),
    ...rest,
    closed: { total: closedTotal, sent: frame.window.filter(w => isClosedRow(w.id)).length },
  }
}

/** PURE. The `delta` event body. */
export function deltaBody(seq: number, frame: FleetFrame, d: FleetDelta): Record<string, unknown> {
  const pick = new Set(d.upsert)
  const up = frame.window.filter(w => pick.has(w.id))
  return {
    seq,
    ...(up.length > 0 ? { upsert: { sessions: up.map(w => w.session), rows: up.map(w => w.row) } } : {}),
    ...(d.remove.length > 0 ? { remove: d.remove } : {}),
    ...(Object.keys(d.meta).length > 0 ? { meta: d.meta } : {}),
    ...(d.order ? { order: d.order } : {}),
  }
}

/**
 * PURE. One page of the CLOSED rows, most recent first — what `GET /api/fleet/closed` answers so a
 * client can show history beyond the stream's window without the stream re-sending it.
 */
export function closedPage(
  p: Pick<FleetFramePayload, 'sessions' | 'rows'>,
  offset: number,
  limit: number,
): { sessions: FleetRow[]; rows: ControlSession[]; total: number } {
  const byId = new Map(p.sessions.map(s => [s.id, s]))
  const closed = p.rows.map((r, i) => ({ r, i })).filter(x => isClosedRow(x.r.id))
    .sort((a, b) => recency(b.r) - recency(a.r) || a.i - b.i)
  const page = closed.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
    .filter(x => byId.has(x.r.id))
  return { sessions: page.map(x => byId.get(x.r.id)!), rows: page.map(x => x.r), total: closed.length }
}

/** `closed=` from a query string: a number in [0, MAX_CLOSED_LIMIT], else the default. */
export function readClosedLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_CLOSED_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CLOSED_LIMIT
  return Math.min(MAX_CLOSED_LIMIT, Math.floor(n))
}

// ---------------------------------------------------------------------------------------------------
// The stream

export interface FleetEventsDeps {
  /** The frame for the CURRENT hub snapshot (shared across streams by the caller). */
  frame(): Promise<FleetFrame>
  /** Called after every hub poll; returns the unsubscribe. Holding it keeps the hub ticking. */
  onTick(cb: () => void): () => void
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

let openStreams = 0
export function fleetStreamCount(): number { return openStreams }

export function fleetEventsResponse(deps: FleetEventsDeps, signal: AbortSignal): Response | null {
  if (openStreams >= MAX_FLEET_STREAMS) return null
  openStreams++
  const setTimer = deps.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = deps.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  const enc = new TextEncoder()
  let closed = false
  let sent: SentState | null = null
  let seq = 0
  let running = false
  let again = false
  let keepalive: unknown = null
  let off: (() => void) | null = null
  let ctl!: ReadableStreamDefaultController<Uint8Array>

  const send = (event: string, data: string) => {
    if (closed) return
    try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)) } catch { close() }
  }

  async function pump(): Promise<void> {
    if (closed) return
    if (running) { again = true; return }
    running = true
    try {
      const frame = await deps.frame()
      if (closed) return
      if (sent === null) {
        send('snapshot', JSON.stringify(snapshotBody(++seq, frame)))
        sent = planFleetDelta(EMPTY_SENT, frame).next
        return
      }
      const plan = planFleetDelta(sent, frame)
      sent = plan.next
      if (!plan.empty) send('delta', JSON.stringify(deltaBody(++seq, frame, plan.delta)))
    } catch { /* a failed frame keeps what the client has; the next tick tries again */ } finally {
      running = false
      if (again && !closed) { again = false; void pump() }
    }
  }

  function close() {
    if (closed) return
    closed = true
    openStreams--
    off?.()
    if (keepalive !== null) clearTimer(keepalive)
    try { ctl.close() } catch { /* already */ }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      ctl.enqueue(enc.encode('retry: 2000\n\n'))
      const ping = () => { send('ping', String(Date.now())); keepalive = setTimer(ping, FLEET_EVENTS_KEEPALIVE_MS) }
      keepalive = setTimer(ping, FLEET_EVENTS_KEEPALIVE_MS)
      off = deps.onTick(() => { void pump() })
      void pump()
    },
    cancel() { close() },
  })
  signal.addEventListener('abort', close, { once: true })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  })
}
