/**
 * chat-stream.ts — a session's conversation PUSHED (PERF.1 step 2): `GET /api/fleet/chat-stream?id=`.
 *
 * The chat used to be polled: every 3 s the web asked `/api/fleet/chat`, which walked the whole fleet
 * and re-read the whole transcript whether or not anything had changed, and a new answer waited for
 * the next tick (1.6 s at the median, 3 s at worst). Now:
 *
 * - the stream sends the payload once (`chat`), then watches the TRANSCRIPT FILE itself (`fs.watch`):
 *   the harness appending a line wakes it within milliseconds, and it re-reads and sends only what
 *   changed (`chat-delta`, core's `chatDelta`): a turn appended, the last turn grown, the window slid;
 * - a send wakes it too (`wakeChat`, from the prompt route), so the server's `pending` echo shows at once;
 * - the fleet row (state, cwd, conversation) is reused for `ROW_TTL_MS` rather than re-walked per change;
 * - WHILE A TURN IS IN FLIGHT (the person's message is not answered yet, or a pending echo is showing)
 *   the transcript is re-read every `INFLIGHT_POLL_MS` whether or not the watcher fires — `fs.watch`
 *   does not fire on every runner, filesystem or Windows path, and then the finished turn waited for the
 *   10 s safety read (a CI browser saw it at ~5.5 s, or not within 8 s). It stops the moment the turn is
 *   committed, and never runs longer than `INFLIGHT_MAX_MS` after it started;
 * - a slow safety re-read (`SAFETY_MS`) covers what the file does not say (the session ending, a
 *   transcript that appears only later), and resolves a path that did not exist yet;
 * - `ping` every `KEEPALIVE_MS`, so the client knows the stream is healthy and only then stops polling.
 *
 * Wakes are coalesced (`DEBOUNCE_MS`) and single-flight: a burst of appends is one read.
 */
import { watch, type FSWatcher } from 'node:fs'
import { chatDelta } from '@agentistics/core'
import type { ChatPayload } from './chat-web'

export const DEBOUNCE_MS = 25
export const ROW_TTL_MS = 5_000
export const SAFETY_MS = 10_000
export const UNRESOLVED_RETRY_MS = 1_000
export const KEEPALIVE_MS = 15_000
/** The re-read cadence while a turn is in flight, watcher or no watcher. */
export const INFLIGHT_POLL_MS = 1_000
/** A turn that stays unanswered longer than this stops being polled fast (the safety read remains). */
export const INFLIGHT_MAX_MS = 5 * 60_000

/** Is a turn in flight: the last thing said is the person's, or a sent message is still pending? */
export function turnInFlight(p: Pick<ChatPayload, 'turns'> & { live?: boolean; pending?: unknown[] }): boolean {
  if (p.live === false) return false
  if (p.pending && p.pending.length > 0) return true
  return p.turns.length > 0 && p.turns[p.turns.length - 1]!.role === 'user'
}
/** Chat streams one server keeps at once; past it the client falls back to polling. */
export const MAX_CHAT_STREAMS = 32

export interface ChatStreamDeps {
  /** One read of the chat; `fresh` asks for a fleet row that is not memoized. */
  read(fresh: boolean, onPath: (path: string) => void): Promise<ChatPayload>
  watchFile?: (path: string, onChange: () => void) => { close(): void }
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

const wakers = new Map<string, Set<() => void>>()
let open = 0

/** Wake every stream of this session now (a prompt was sent, an answer was given). */
export function wakeChat(id: string): void {
  for (const w of wakers.get(id) ?? []) w()
}

export function chatStreamCount(): number { return open }

function defaultWatch(path: string, onChange: () => void): { close(): void } {
  let w: FSWatcher | null = null
  try { w = watch(path, { persistent: false }, () => onChange()) } catch { /* gone: the safety read re-resolves */ }
  return { close: () => w?.close() }
}

export function chatStreamResponse(id: string, deps: ChatStreamDeps, signal: AbortSignal): Response | null {
  if (open >= MAX_CHAT_STREAMS) return null
  open++
  const setTimer = deps.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = deps.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  const watchFile = deps.watchFile ?? defaultWatch
  const enc = new TextEncoder()
  let closed = false
  let sentTurns: string[] | null = null
  let sentMeta = ''
  let path: string | null = null
  let watcher: { close(): void } | null = null
  let running = false
  let again = false
  let againFresh = false
  let debounce: unknown = null
  let safety: unknown = null
  let keepalive: unknown = null
  let fast: unknown = null
  let inflightSince = 0
  let lastFresh = 0

  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const send = (event: string, data: string) => { if (!closed) try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)) } catch { close() } }

  async function pump(fresh: boolean): Promise<void> {
    if (closed) return
    if (running) { again = true; againFresh ||= fresh; return }
    running = true
    try {
      const useFresh = fresh || Date.now() - lastFresh >= ROW_TTL_MS
      if (useFresh) lastFresh = Date.now()
      let resolved: string | null = null
      const p = await deps.read(useFresh, x => { resolved = x })
      if (closed) return
      if (resolved && resolved !== path) {
        watcher?.close()
        path = resolved
        watcher = watchFile(resolved, () => schedule(false))
      }
      // In flight: keep re-reading on a timer of our own (see the header). Armed once, re-armed by each read.
      if (turnInFlight(p)) {
        if (inflightSince === 0) inflightSince = Date.now()
        if (fast === null && Date.now() - inflightSince < INFLIGHT_MAX_MS) fast = setTimer(() => { fast = null; schedule(false) }, INFLIGHT_POLL_MS)
      } else {
        inflightSince = 0
      }
      const { turns, ...meta } = p
      const metaJson = JSON.stringify(meta)
      const d = chatDelta(sentTurns, turns)
      if (d.kind === 'same' && metaJson === sentMeta) return
      if (d.kind === 'full') send('chat', JSON.stringify(p))
      else send('chat-delta', JSON.stringify({ ...(d.kind === 'delta' ? { drop: d.drop, keep: d.keep, append: d.append } : { drop: 0, keep: turns.length, append: [] }), meta }))
      sentTurns = turns.map(t => JSON.stringify(t))
      sentMeta = metaJson
    } catch { /* a failed read keeps the last frame; the safety read tries again */ } finally {
      running = false
      if (again && !closed) { const f = againFresh; again = false; againFresh = false; void pump(f) }
    }
  }

  function schedule(fresh: boolean) {
    if (closed) return
    if (fresh) againFresh = true
    if (debounce !== null) return
    debounce = setTimer(() => { debounce = null; const f = againFresh; againFresh = false; void pump(f) }, DEBOUNCE_MS)
  }

  function armSafety() {
    if (closed) return
    safety = setTimer(() => { schedule(true); armSafety() }, path ? SAFETY_MS : UNRESOLVED_RETRY_MS)
  }

  function close() {
    if (closed) return
    closed = true
    open--
    watcher?.close()
    for (const t of [debounce, safety, keepalive, fast]) if (t !== null) clearTimer(t)
    const set = wakers.get(id)
    set?.delete(waker)
    if (set && set.size === 0) wakers.delete(id)
    try { ctl.close() } catch { /* already */ }
  }
  const waker = () => schedule(true)

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      let set = wakers.get(id)
      if (!set) wakers.set(id, (set = new Set()))
      set.add(waker)
      ctl.enqueue(enc.encode(`retry: 2000\n\n`))
      const ping = () => { send('ping', String(Date.now())); keepalive = setTimer(ping, KEEPALIVE_MS) }
      keepalive = setTimer(ping, KEEPALIVE_MS)
      void pump(true).then(armSafety)
    },
    cancel() { close() },
  })
  signal.addEventListener('abort', close, { once: true })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } })
}
