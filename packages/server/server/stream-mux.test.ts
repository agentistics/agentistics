import { describe, expect, test } from 'bun:test'
import { closeMux, createMuxState, createSseParser, muxPathAllowed, onMuxMessage, parseMuxMessage, type MuxServerMessage, type SseFrame } from './stream-mux'

describe('muxPathAllowed — the socket is a transport for push streams, never a general proxy', () => {
  test('the push routes are allowed, with their query strings', () => {
    for (const u of ['/api/events', '/api/data-stream', '/api/fleet/chat-stream?id=a&lang=en', '/api/fleet/stream?id=x&cols=80&rows=24', '/api/shell/stream?id=s', '/api/runtime/sessions/ses_ab/stream?from=3']) expect(muxPathAllowed(u)).toBe(true)
  })
  test('anything else is refused', () => {
    for (const u of ['/api/data', '/api/fleet/new', '/api/health', 'http://evil/api/events', '//evil/api/events', '/api/fleet/../events', '/api/runtime/sessions/a/b/stream', '', '/api/eventsX']) expect(muxPathAllowed(u)).toBe(false)
  })
})

describe('parseMuxMessage', () => {
  test('sub / unsub', () => {
    expect(parseMuxMessage('{"op":"sub","sid":1,"url":"/api/events"}')).toEqual({ op: 'sub', sid: 1, url: '/api/events' })
    expect(parseMuxMessage('{"op":"sub","sid":2,"url":"/api/events","lastEventId":"7"}')).toEqual({ op: 'sub', sid: 2, url: '/api/events', lastEventId: '7' })
    expect(parseMuxMessage('{"op":"unsub","sid":3}')).toEqual({ op: 'unsub', sid: 3 })
  })
  test('junk is null; a header-injecting last-event-id is dropped', () => {
    expect(parseMuxMessage('nope')).toBeNull()
    expect(parseMuxMessage('{"op":"sub","sid":-1,"url":"/api/events"}')).toBeNull()
    expect(parseMuxMessage('{"op":"sub","sid":1,"url":"/api/data"}')).toBeNull()
    expect(parseMuxMessage('{"op":"sub","sid":1,"url":"/api/events","lastEventId":"a\\r\\nx: y"}')).toEqual({ op: 'sub', sid: 1, url: '/api/events' })
  })
})

describe('createSseParser', () => {
  test('frames survive arbitrary chunk boundaries, CRLF and multi-line data', () => {
    const text = 'event: connected\ndata: {}\n\n: comment\r\nevent: chat\r\ndata: a\r\ndata: b\r\nid: 9\r\n\r\ndata: plain\n\nevent: nodata\n\n'
    for (let cut = 1; cut < text.length; cut++) {
      const got: SseFrame[] = []
      const feed = createSseParser(f => got.push(f))
      feed(text.slice(0, cut)); feed(text.slice(cut))
      expect(got).toEqual([
        { event: 'connected', data: '{}' },
        { event: 'chat', data: 'a\nb', id: '9' },
        { event: 'message', data: 'plain', id: '9' },
      ])
    }
  })
})

function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close() } })
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}
const tick = () => new Promise(r => setTimeout(r, 5))

describe('a subscription is replayed through the REAL route with the upgrade request headers', () => {
  test('headers carried, hop headers dropped, frames forwarded, end reported', async () => {
    const seen: Request[] = []
    const upgrade = new Request('http://127.0.0.1:1/api/stream-mux', { headers: { cookie: 'c=1', host: '127.0.0.1:1', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'k' } })
    const st = createMuxState(upgrade, async r => { seen.push(r); return sseResponse(['event: connected\ndata: {}\n\nevent: change\nda', 'ta: {"x":1}\n\n']) })
    const out: MuxServerMessage[] = []
    onMuxMessage(st, { send: s => out.push(JSON.parse(s)) }, JSON.stringify({ op: 'sub', sid: 4, url: '/api/events', lastEventId: '3' }))
    await tick(); await tick()
    expect(seen[0]!.url).toBe('http://127.0.0.1:1/api/events')
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.headers.get('cookie')).toBe('c=1')
    expect(seen[0]!.headers.get('last-event-id')).toBe('3')
    expect(seen[0]!.headers.get('upgrade')).toBeNull()
    expect(seen[0]!.headers.get('sec-websocket-key')).toBeNull()
    expect(out).toEqual([
      { sid: 4, t: 'open' },
      { sid: 4, t: 'ev', e: 'connected', d: '{}' },
      { sid: 4, t: 'ev', e: 'change', d: '{"x":1}' },
      { sid: 4, t: 'end' },
    ])
  })
  test('a refusal by the route (auth, capability, host gate) is a final fail with its status', async () => {
    const st = createMuxState(new Request('http://h/api/stream-mux'), async () => new Response('{"error":"auth required"}', { status: 401, headers: { 'Content-Type': 'application/json' } }))
    const out: MuxServerMessage[] = []
    onMuxMessage(st, { send: s => out.push(JSON.parse(s)) }, JSON.stringify({ op: 'sub', sid: 1, url: '/api/events' }))
    await tick()
    expect(out).toEqual([{ sid: 1, t: 'fail', status: 401 }])
  })
  test('unsub and socket close abort the route (its req.signal fires)', async () => {
    const aborted: number[] = []
    const st = createMuxState(new Request('http://h/api/stream-mux'), async r => {
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('event: connected\ndata: {}\n\n')) } })
      r.signal.addEventListener('abort', () => aborted.push(1))
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const sink = { send: () => {} }
    onMuxMessage(st, sink, JSON.stringify({ op: 'sub', sid: 1, url: '/api/events' }))
    onMuxMessage(st, sink, JSON.stringify({ op: 'sub', sid: 2, url: '/api/events' }))
    await tick()
    onMuxMessage(st, sink, JSON.stringify({ op: 'unsub', sid: 1 }))
    expect(aborted.length).toBe(1)
    closeMux(st)
    expect(aborted.length).toBe(2)
    expect(st.subs.size).toBe(0)
  })
})
