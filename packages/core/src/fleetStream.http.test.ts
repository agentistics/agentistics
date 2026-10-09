import { afterAll, expect, it } from 'bun:test'
import { followFleet, type FleetWire } from './fleetStream'
const enc = new TextEncoder()
const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/api/fleet/closed') return Response.json({ sessions: [{ id: 'closed:older' }], rows: [{ id: 'closed:older' }], total: 2 })
  const body = new ReadableStream<Uint8Array>({ start(c) {
    controllers.add(c)
    c.enqueue(enc.encode('event: snapshot\r'))
    c.enqueue(enc.encode('\ndata: {"seq":1,"sessions":[{"id":"a"},{"id":"closed:recent"}],"rows":[{"id":"a"},{"id":"closed:recent"}],"closed":{"sent":1,"total":2}}\r\n\r\n'))
    if (url.searchParams.has('gap')) c.enqueue(enc.encode('event: delta\ndata: {"seq":3}\n\n'))
    else c.enqueue(enc.encode('event: delta\ndata: {"seq":2,"meta":{"attention":1}}\n\n'))
    req.signal.addEventListener('abort', () => { controllers.delete(c); try { c.close() } catch {} }, { once: true })
  }, cancel() {} })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
} })
afterAll(() => { for (const c of controllers) try { c.close() } catch {}; server.stop(true) })
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(10) }
  throw new Error('stream did not settle')
}
it('handles fragmented CRLF, deltas, paged history and aborting the subscription', async () => {
  const frames: FleetWire[] = []
  const stream = followFleet(`${server.url}api/fleet/events`, f => frames.push(f))
  try {
    await until(() => frames.length === 2)
    expect(stream.healthy()).toBe(true)
    expect(frames[1]?.attention).toBe(1)
    await stream.loadClosed()
    expect(frames.at(-1)?.rows.map(r => r.id)).toEqual(['a', 'closed:recent', 'closed:older'])
  } finally { stream.close() }
  expect(stream.healthy()).toBe(false)
  expect(stream.retryable()).toBe(true)
})
it('a lost delta closes the connection so the client can poll and resubscribe', async () => {
  const frames: FleetWire[] = []
  const stream = followFleet(`${server.url}api/fleet/events?gap=1`, f => frames.push(f))
  try {
    await until(() => stream.retryable())
    expect(frames.length).toBe(1)
    expect(stream.healthy()).toBe(false)
  } finally { stream.close() }
})
