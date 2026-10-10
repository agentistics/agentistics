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
 * - a slow safety re-read (`SAFETY_MS`) covers what the file does not say (the session ending, a
 *   transcript that appears only later);
 * - a path that does not exist YET (a new session, an unlinked row) is retried on the server's fleet
 *   TICKS (`onFleetTick`, the SessionHub): that is the only moment its link can change. It used to be a
 *   1 s loop of FRESH fleet polls — 59 polls and 270 tmux calls a minute for ONE idle chat (ENGINE.MAP
 *   P-03). Without a tick source the retry backs off (`UNRESOLVED_BACKOFF_MS` doubling to `SAFETY_MS`);
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
/** First retry of an unresolved path when no fleet tick source is wired; doubles up to `SAFETY_MS`. */
export const UNRESOLVED_BACKOFF_MS = 1_000
/**
 * After a SEND to a session whose transcript is not on disk yet, re-read at these offsets: a harness
 * writes its transcript on the first message (codex's rollout ~1 s after it), and waiting for the next
 * fleet tick would put the first answer up to one tick late. A read here resolves a path — it polls no
 * fleet.
 */
export const AFTER_SEND_RETRY_MS = [700, 1_500, 3_000] as const
export const KEEPALIVE_MS = 15_000
/** PERF.SLOW: idle time after a read, per ms that read took, while the file keeps changing. */
export const READ_LOAD_FACTOR = 4
/** …and never more than this: a streaming answer still moves at least once a second. */
export const MAX_READ_GAP_MS = 1_000

/**
 * PERF.SLOW. PURE: how long a FILE change waits before this stream reads again. The first change after
 * a quiet spell reads at the debounce; under a turn that keeps writing, the next read waits until the
 * idle time since the last read ENDED is `READ_LOAD_FACTOR` × that read's duration (capped at
 * `MAX_READ_GAP_MS`). These readers parse the whole transcript, so a long turn re-read on every append
 * cost the server tens of seconds of CPU; this holds one stream's duty cycle near 20 % while a small
 * transcript (a read of a few ms) keeps its debounce-only latency.
 */
export function nextReadDelay(nowMs: number, lastEndMs: number, lastDurationMs: number): number {
  const gap = Math.min(MAX_READ_GAP_MS, READ_LOAD_FACTOR * Math.max(0, lastDurationMs))
  return Math.max(DEBOUNCE_MS, lastEndMs + gap - nowMs)
}
/** Chat streams one server keeps at once; past it the client falls back to polling. */
export const MAX_CHAT_STREAMS = 32

export interface ChatStreamDeps {
  /** One read of the chat; `fresh` asks for a fleet row that is not memoized. */
  read(fresh: boolean, onPath: (path: string) => void): Promise<ChatPayload>
  /**
   * Every completed fleet poll (the SessionHub). Subscribed ONLY while the transcript path is
   * unresolved — a link can only change on a poll — and released as soon as it resolves.
   */
  onFleetTick?: (cb: () => void) => () => void
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

/** Be woken with this session's streams — for a stream built elsewhere (`adapter-chat.ts`). */
export function onChatWake(id: string, cb: () => void): () => void {
  let set = wakers.get(id)
  if (!set) wakers.set(id, (set = new Set()))
  set.add(cb)
  return () => {
    const cur = wakers.get(id)
    cur?.delete(cb)
    if (cur && cur.size === 0) wakers.delete(id)
  }
}

export function chatStreamCount(): number { return open }

/**
 * One slot of the shared stream cap, for a chat stream built elsewhere (`adapter-chat.ts`): both kinds
 * count against `MAX_CHAT_STREAMS`. `false` = the cap is reached. Release exactly once.
 */
export function acquireChatSlot(): boolean {
  if (open >= MAX_CHAT_STREAMS) return false
  open++
  return true
}
export function releaseChatSlot(): void { open = Math.max(0, open - 1) }

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
  let lastFresh = 0
  let tickOff: (() => void) | null = null
  let backoff = UNRESOLVED_BACKOFF_MS
  let lastReadEnd = -Infinity
  let lastReadMs = 0

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
      const readStart = Date.now()
      const p = await deps.read(useFresh, x => { resolved = x })
      lastReadEnd = Date.now()
      lastReadMs = lastReadEnd - readStart
      if (closed) return
      if (resolved && resolved !== path) {
        watcher?.close()
        path = resolved
        watcher = watchFile(resolved, () => schedule(false))
        // Resolved: the fleet ticks have nothing more to tell this stream.
        tickOff?.(); tickOff = null
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
    // A person's act (a send, a fresh read) is answered at the debounce; a file change waits out the
    // duty cycle (`nextReadDelay`).
    const wait = fresh ? DEBOUNCE_MS : nextReadDelay(Date.now(), lastReadEnd, lastReadMs)
    debounce = setTimer(() => { debounce = null; const f = againFresh; againFresh = false; void pump(f) }, wait)
  }

  function armSafety() {
    if (closed) return
    if (!path && deps.onFleetTick) {
      // Unresolved, with a tick source: every fleet poll is a retry, and nothing else is.
      if (!tickOff) tickOff = deps.onFleetTick(() => { if (!path) schedule(true) })
      safety = setTimer(() => { schedule(true); armSafety() }, SAFETY_MS)
      return
    }
    const wait = path ? SAFETY_MS : backoff
    if (!path) backoff = Math.min(SAFETY_MS, backoff * 2)
    safety = setTimer(() => { schedule(true); armSafety() }, wait)
  }

  function close() {
    if (closed) return
    closed = true
    open--
    watcher?.close()
    tickOff?.(); tickOff = null
    for (const t of [debounce, safety, keepalive, ...burst]) if (t !== null) clearTimer(t)
    const set = wakers.get(id)
    set?.delete(waker)
    if (set && set.size === 0) wakers.delete(id)
    try { ctl.close() } catch { /* already */ }
  }
  let burst: unknown[] = []
  const waker = () => {
    schedule(true)
    if (path) return
    for (const t of burst) clearTimer(t)
    burst = AFTER_SEND_RETRY_MS.map(ms => setTimer(() => { if (!path) schedule(true) }, ms))
  }

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
