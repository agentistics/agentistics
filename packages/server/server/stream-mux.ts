/**
 * stream-mux.ts — the browser's long-lived SSE streams, carried over ONE WebSocket per tab.
 *
 * WHY: a browser allows ~6 HTTP/1.1 connections per ORIGIN, shared by every tab and window of the
 * profile. The dashboard keeps several EventSources open for as long as a page is up — `/api/events`,
 * `/api/data-stream`, one `/api/fleet/chat-stream` per watched session, the terminal and native
 * session streams — so two tabs were measured holding all six, and from then on `/api/health` and
 * every `fetch` QUEUED behind them: the second tab never loaded and the Calls page said "the server
 * is not answering" while the server was fine. A WebSocket is not counted against that pool, so the
 * streams ride one socket per tab and the six slots are left to the fetches.
 *
 * HOW, and why it cannot weaken anything: a subscription is NOT a second implementation of any
 * stream. The server replays the subscription as an ordinary `GET` through the very request handler
 * the EventSource would have hit — same URL, the upgrade request's own headers (cookie, Host,
 * Origin), the caller's own IP — so the rate limit, the capability guard, the DNS-rebinding gate,
 * the auth gate and every per-route rule run exactly as they do for the SSE route. The SSE body that
 * comes back is parsed into frames and forwarded verbatim; the payloads are the SSE route's own.
 *
 * Only the push routes are reachable this way (`MUX_EXACT` + `MUX_NATIVE`): the socket is a transport for streams,
 * never a general proxy for the API.
 *
 * The pure half (message validation, the SSE parser, the path allowlist) is exported for tests; the
 * IO half (`createMuxState` / `onMuxMessage` / `closeMux`) takes the dispatch function injected, so
 * it never imports `index.ts`.
 */

/** The streaming routes a subscription may name. Exact path match; query strings pass through. */
const MUX_EXACT = new Set(['/api/events', '/api/data-stream', '/api/fleet/chat-stream', '/api/fleet/stream', '/api/shell/stream'])
const MUX_NATIVE = /^\/api\/runtime\/sessions\/[^/]+\/stream$/

/** Most subscriptions one socket may hold. A page holds a handful; the ceiling bounds a misbehaving one. */
export const MUX_MAX_SUBS = 64

/** PURE: may a subscription name this path (`/api/...?query`)? */
export function muxPathAllowed(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith('/api/') || url.length > 4096) return false
  const path = url.split('?', 1)[0]!
  if (path.includes('..') || path.includes('//')) return false
  return MUX_EXACT.has(path) || MUX_NATIVE.test(path)
}

export type MuxClientMessage =
  | { op: 'sub'; sid: number; url: string; lastEventId?: string }
  | { op: 'unsub'; sid: number }

/** PURE: one client message, validated — or null. */
export function parseMuxMessage(raw: string): MuxClientMessage | null {
  let m: unknown
  try { m = JSON.parse(raw) } catch { return null }
  if (typeof m !== 'object' || m === null) return null
  const o = m as Record<string, unknown>
  if (typeof o.sid !== 'number' || !Number.isSafeInteger(o.sid) || o.sid < 0) return null
  if (o.op === 'unsub') return { op: 'unsub', sid: o.sid }
  if (o.op !== 'sub' || typeof o.url !== 'string' || !muxPathAllowed(o.url)) return null
  const lastEventId = typeof o.lastEventId === 'string' && o.lastEventId.length <= 256 && !/[\r\n\0]/.test(o.lastEventId) ? o.lastEventId : undefined
  return { op: 'sub', sid: o.sid, url: o.url, ...(lastEventId ? { lastEventId } : {}) }
}

export interface SseFrame { event: string; data: string; id?: string; retry?: number }

/**
 * PURE + incremental: the text/event-stream parser (WHATWG §9.2), fed decoded text in arbitrary
 * chunks. A frame is dispatched on a blank line; a frame with no `data` line is dropped (the spec's
 * rule); comments (`:`) are ignored. `id` persists across frames exactly like EventSource's
 * last-event-id buffer.
 */
export function createSseParser(onFrame: (f: SseFrame) => void): (chunk: string) => void {
  let buf = ''
  let event = ''
  let data: string[] = []
  let hasData = false
  let id: string | undefined
  let retry: number | undefined
  const line = (l: string) => {
    if (l === '') {
      if (hasData) onFrame({ event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}), ...(retry !== undefined ? { retry } : {}) })
      event = ''; data = []; hasData = false; retry = undefined
      return
    }
    if (l.startsWith(':')) return
    const c = l.indexOf(':')
    const field = c === -1 ? l : l.slice(0, c)
    let value = c === -1 ? '' : l.slice(c + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') { data.push(value); hasData = true }
    else if (field === 'id') { if (!value.includes('\0')) id = value }
    else if (field === 'retry') { if (/^\d+$/.test(value)) retry = Number(value) }
  }
  return (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.search(/\r\n|\r|\n/)) !== -1) {
      // a lone `\r` at the very end may be the first half of `\r\n` — wait for the next chunk
      if (buf[i] === '\r' && i === buf.length - 1) break
      const nl = buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1
      line(buf.slice(0, i))
      buf = buf.slice(i + nl)
    }
  }
}

/** What the server sends. `t`: open | ev | end (stream ended, may reconnect) | fail (HTTP error, final). */
export type MuxServerMessage =
  | { sid: number; t: 'open' }
  | { sid: number; t: 'ev'; e: string; d: string; id?: string; retry?: number }
  | { sid: number; t: 'end' }
  | { sid: number; t: 'fail'; status: number }

/** The one per-socket state: the upgrade request's identity and the live subscriptions. */
export interface MuxState {
  origin: string
  headers: Headers
  dispatch: (req: Request) => Promise<Response | undefined>
  subs: Map<number, AbortController>
  closed: boolean
}

/** Headers that belong to the upgrade itself and must not be replayed onto a plain GET. */
const HOP = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'content-length', 'accept-encoding']

export function createMuxState(upgrade: Request, dispatch: MuxState['dispatch']): MuxState {
  const headers = new Headers(upgrade.headers)
  for (const h of HOP) headers.delete(h)
  headers.set('accept', 'text/event-stream')
  return { origin: new URL(upgrade.url).origin, headers, dispatch, subs: new Map(), closed: false }
}

interface Sink { send(data: string): unknown }

function emit(ws: Sink, m: MuxServerMessage) { try { ws.send(JSON.stringify(m)) } catch { /* socket gone */ } }

async function runSub(st: MuxState, ws: Sink, sid: number, url: string, lastEventId: string | undefined, ac: AbortController) {
  const headers = new Headers(st.headers)
  if (lastEventId) headers.set('last-event-id', lastEventId)
  let res: Response | undefined
  try {
    res = await st.dispatch(new Request(st.origin + url, { method: 'GET', headers, signal: ac.signal }))
  } catch {
    res = undefined
  }
  if (ac.signal.aborted) { void res?.body?.cancel().catch(() => {}); return }
  const type = res?.headers.get('content-type') ?? ''
  if (!res || res.status !== 200 || !type.startsWith('text/event-stream') || !res.body) {
    void res?.body?.cancel().catch(() => {})
    st.subs.delete(sid)
    emit(ws, { sid, t: 'fail', status: res?.status ?? 0 })
    return
  }
  emit(ws, { sid, t: 'open' })
  const reader = res.body.getReader()
  ac.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) }, { once: true })
  const dec = new TextDecoder()
  const feed = createSseParser(f => emit(ws, { sid, t: 'ev', e: f.event, d: f.data, ...(f.id !== undefined ? { id: f.id } : {}), ...(f.retry !== undefined ? { retry: f.retry } : {}) }))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      feed(dec.decode(value, { stream: true }))
    }
  } catch { /* cancelled or the route threw — either way the stream is over */ }
  if (ac.signal.aborted) return
  st.subs.delete(sid)
  emit(ws, { sid, t: 'end' })
}

export function onMuxMessage(st: MuxState, ws: Sink, raw: string | Buffer): void {
  if (st.closed) return
  const m = parseMuxMessage(typeof raw === 'string' ? raw : raw.toString('utf8'))
  if (!m) return
  if (m.op === 'unsub') {
    st.subs.get(m.sid)?.abort()
    st.subs.delete(m.sid)
    return
  }
  st.subs.get(m.sid)?.abort()
  if (st.subs.size >= MUX_MAX_SUBS) { emit(ws, { sid: m.sid, t: 'fail', status: 503 }); return }
  const ac = new AbortController()
  st.subs.set(m.sid, ac)
  void runSub(st, ws, m.sid, m.url, m.lastEventId, ac)
}

export function closeMux(st: MuxState): void {
  st.closed = true
  for (const ac of st.subs.values()) ac.abort()
  st.subs.clear()
}
