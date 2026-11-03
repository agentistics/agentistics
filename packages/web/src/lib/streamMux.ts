/**
 * streamMux.ts — every long-lived push stream of the tab, over ONE WebSocket.
 *
 * A browser allows ~6 HTTP/1.1 connections per ORIGIN, shared by every tab and window of the
 * profile. Each `EventSource` holds one for as long as it is open — `/api/events`,
 * `/api/data-stream`, one `/api/fleet/chat-stream` per watched session, the terminal and native
 * session streams — so two tabs were measured holding all six, and from then on `/api/health` and
 * every `fetch` queued behind them: the second tab never booted, a route chunk never arrived, and
 * the strip said "the server is not answering" over a server that was fine. A WebSocket is NOT
 * counted against that pool, so the streams ride `/api/stream-mux` (server: `stream-mux.ts`) and
 * the six slots are left to the fetches, however many tabs are open.
 *
 * `openEventStream(url)` is a drop-in for `new EventSource(url)`: it returns an object with the
 * EventSource surface the app uses (`addEventListener`, `onmessage`/`onerror`/`onopen`,
 * `readyState`, `close`), and the payloads are the SSE route's own — the server replays each
 * subscription through the very route an EventSource would have hit. Semantics kept:
 *   - an HTTP error answer (401, 403, 404, 503…) closes the stream for good (readyState 2 + error),
 *     as EventSource does;
 *   - a stream the server ENDS, or a dropped socket, reports `error` with readyState 0 and
 *     re-subscribes on its own, carrying the last event id — EventSource's auto-reconnect.
 * FALLBACK: when the socket cannot be opened at all (no WebSocket, a proxy that refuses the
 * upgrade, an older server answering 404), each stream becomes a real EventSource — the old path,
 * byte for byte. Once the socket has opened, later drops are retried as a socket (a restarting
 * server), never downgraded.
 */

type Listener = (e: Event) => void

const RETRY_MS = 3000
const SOCKET_BACKOFF_MS = [500, 1000, 2000, 4000]
/** Consecutive failed opens, with no success ever, after which the socket is given up for the page. */
const GIVE_UP_AFTER = 2

interface ServerMsg { sid: number; t: 'open' | 'ev' | 'end' | 'fail'; e?: string; d?: string; id?: string; retry?: number; status?: number }

/** The EventSource surface the app relies on. */
export interface EventStreamLike {
  readonly url: string
  readonly readyState: number
  onopen: ((e: Event) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: Event) => void) | null
  addEventListener(type: string, fn: (e: MessageEvent) => void): void
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void
  close(): void
}

class MuxSource implements EventStreamLike {
  readonly url: string
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  sid = 0
  lastEventId = ''
  retryMs = RETRY_MS
  retryTimer: ReturnType<typeof setTimeout> | null = null
  /** set when this stream fell back to a real EventSource */
  native: EventSource | null = null
  private listeners = new Map<string, Set<Listener>>()
  private nativeBound = new Map<string, Listener>()
  constructor(url: string, private mux: Mux) { this.url = url }

  addEventListener(type: string, handler: (e: MessageEvent) => void): void {
    const fn = handler as Listener
    let set = this.listeners.get(type)
    if (!set) { set = new Set(); this.listeners.set(type, set) }
    set.add(fn)
    if (this.native) this.bindNative(type)
  }
  removeEventListener(type: string, handler: (e: MessageEvent) => void): void { this.listeners.get(type)?.delete(handler as Listener) }

  dispatch(type: string, ev: Event): void {
    if (type === 'message') this.onmessage?.(ev as MessageEvent)
    else if (type === 'error') this.onerror?.(ev)
    else if (type === 'open' && !(ev instanceof MessageEvent)) this.onopen?.(ev)
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      try { fn(ev) } catch (err) { setTimeout(() => { throw err }) }
    }
  }

  close(): void {
    if (this.readyState === 2) return
    this.readyState = 2
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    if (this.native) { this.native.close(); this.native = null; return }
    this.mux.release(this)
  }

  /** Become a real EventSource — the fallback when the socket cannot be had. */
  goNative(): void {
    if (this.readyState === 2 || this.native) return
    const es = new EventSource(this.url)
    this.native = es
    es.onopen = () => { this.readyState = 1; this.dispatch('open', new Event('open')) }
    es.onerror = () => { this.readyState = es.readyState; this.dispatch('error', new Event('error')) }
    es.onmessage = (e) => { this.dispatch('message', e) }
    for (const type of this.listeners.keys()) this.bindNative(type)
  }
  private bindNative(type: string): void {
    if (!this.native || type === 'message' || type === 'error' || this.nativeBound.has(type)) return
    const fwd: Listener = (e) => {
      // the native connection-open Event also arrives under 'open'; onopen already handles it
      if (type === 'open' && !(e instanceof MessageEvent)) return
      this.dispatch(type, e)
    }
    this.nativeBound.set(type, fwd)
    this.native.addEventListener(type, fwd)
  }
}

class Mux {
  private ws: WebSocket | null = null
  private wsOpen = false
  private everOpened = false
  private failures = 0
  private broken = false
  private nextSid = 1
  private sources = new Map<number, MuxSource>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  constructor(private makeWs: () => WebSocket | null) {}

  open(url: string): EventStreamLike {
    const src = new MuxSource(url, this)
    if (this.broken) { src.goNative(); return src }
    src.sid = this.nextSid++
    this.sources.set(src.sid, src)
    if (this.wsOpen) this.sub(src)
    else this.connect()
    return src
  }

  release(src: MuxSource): void {
    if (!this.sources.delete(src.sid)) return
    if (this.wsOpen) this.send({ op: 'unsub', sid: src.sid })
  }

  private send(m: unknown): void { try { this.ws?.send(JSON.stringify(m)) } catch { /* reconnect handles it */ } }

  private sub(src: MuxSource): void {
    this.send({ op: 'sub', sid: src.sid, url: src.url, ...(src.lastEventId ? { lastEventId: src.lastEventId } : {}) })
  }

  private connect(): void {
    if (this.ws || this.reconnectTimer) return
    let ws: WebSocket | null = null
    try { ws = this.makeWs() } catch { ws = null }
    if (!ws) { this.giveUp(); return }
    this.ws = ws
    // A socket that dies before (or after) opening fires `error` and then `close`. Both are the
    // same event for us; the guard makes whichever arrives first the only one handled.
    let down = false
    const fail = () => {
      if (down || this.ws !== ws) return
      down = true
      const wasOpen = this.wsOpen
      this.ws = null
      this.wsOpen = false
      if (!wasOpen && !this.everOpened && ++this.failures >= GIVE_UP_AFTER) { this.giveUp(); return }
      // every live stream drops the way an EventSource does on a network loss: error, reconnecting
      for (const src of this.sources.values()) {
        if (src.retryTimer) { clearTimeout(src.retryTimer); src.retryTimer = null }
        if (src.readyState !== 0 || wasOpen) { src.readyState = 0; src.dispatch('error', new Event('error')) }
      }
      if (this.sources.size === 0) return
      const delay = SOCKET_BACKOFF_MS[Math.min(this.failures, SOCKET_BACKOFF_MS.length - 1)]!
      if (wasOpen) this.failures = 1
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this.sources.size) this.connect() }, delay)
    }
    ws.onopen = () => {
      this.wsOpen = true
      this.everOpened = true
      this.failures = 0
      for (const src of this.sources.values()) if (!src.retryTimer) this.sub(src)
    }
    ws.onmessage = (e) => this.onMessage(String(e.data))
    // Never leave a failed open as an unhandled error: on some runtimes (Bun's `ws` shim under
    // happy-dom) an `error` with no listener is rethrown and aborts the caller — a mounted hook or
    // an unrelated test. The listener routes it to the same fallback as a close.
    ws.onerror = () => fail()
    ws.onclose = () => fail()
  }

  private giveUp(): void {
    this.broken = true
    const pending = [...this.sources.values()]
    this.sources.clear()
    for (const src of pending) src.goNative()
  }

  private onMessage(raw: string): void {
    let m: ServerMsg
    try { m = JSON.parse(raw) as ServerMsg } catch { return }
    const src = this.sources.get(m.sid)
    if (!src || src.readyState === 2) return
    if (m.t === 'open') {
      src.readyState = 1
      src.dispatch('open', new Event('open'))
    } else if (m.t === 'ev') {
      if (m.id !== undefined) src.lastEventId = m.id
      if (typeof m.retry === 'number') src.retryMs = m.retry
      src.dispatch(m.e || 'message', new MessageEvent(m.e || 'message', { data: m.d ?? '', lastEventId: src.lastEventId }))
    } else if (m.t === 'fail') {
      this.sources.delete(src.sid)
      src.readyState = 2
      src.dispatch('error', new Event('error'))
    } else if (m.t === 'end') {
      src.readyState = 0
      src.dispatch('error', new Event('error'))
      if (src.readyState === 2) return // the handler closed it
      src.retryTimer = setTimeout(() => {
        src.retryTimer = null
        if (src.readyState === 2 || !this.sources.has(src.sid)) return
        if (this.wsOpen) this.sub(src)
        else this.connect()
      }, src.retryMs)
    }
  }
}

function defaultSocket(): WebSocket | null {
  if (typeof WebSocket === 'undefined' || typeof location === 'undefined') return null
  // A headless DOM (happy-dom, as every DOM test registers) is not a page talking to a server:
  // there is no `/api/stream-mux` to upgrade to, and under Bun its `ws` shim throws an error that
  // no listener on the WebSocket can catch, aborting the mount. Take the EventSource path at once,
  // which is both correct for a test that stubs EventSource and what a real page does when the
  // socket cannot be had.
  if (typeof (globalThis as { happyDOM?: unknown }).happyDOM !== 'undefined') return null
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${proto}//${location.host}/api/stream-mux`)
}

/** PURE factory for tests: a mux over an injected socket maker. */
export function createStreamMux(makeWs: () => WebSocket | null): { open(url: string): EventStreamLike } {
  return new Mux(makeWs)
}

// Anchored on globalThis for the same reason as `eventStream.ts`: a code-split bundle duplicates
// this module into several chunks, and a per-copy singleton would open one socket per chunk.
const GLOBAL_KEY = '__agentisticsStreamMux__'
type Holder = { [GLOBAL_KEY]?: { open(url: string): EventStreamLike } }

/** Drop-in for `new EventSource(url)` on a same-origin push route. */
export function openEventStream(url: string): EventSource {
  const holder = globalThis as unknown as Holder
  const mux = (holder[GLOBAL_KEY] ??= createStreamMux(defaultSocket))
  return mux.open(url) as unknown as EventSource
}
