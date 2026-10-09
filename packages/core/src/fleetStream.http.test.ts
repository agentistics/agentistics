import { afterAll, expect, it } from 'bun:test'
import { followFleet, type FleetWire } from './fleetStream'
const enc = new TextEncoder()
const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
const historyControllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
let historyChanged = false
let historyDeleted = false
let historyEmpty = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/api/fleet/closed') {
    if (url.searchParams.has('history')) {
      const all = (historyEmpty ? [] : historyDeleted ? ['closed:new', 'closed:recent'] : historyChanged ? ['closed:new', 'closed:recent', 'closed:older'] : ['closed:recent', 'closed:older']).map(id => ({ id }))
      const rows = all.slice(Number(url.searchParams.get('offset')))
      return Response.json({ sessions: rows, rows, total: all.length })
    }
    return Response.json({ sessions: [{ id: 'closed:older' }], rows: [{ id: 'closed:older' }], total: 2 })
  }
  const body = new ReadableStream<Uint8Array>({ start(c) {
    controllers.add(c)
    if (url.searchParams.has('history')) {
      historyControllers.add(c)
      c.enqueue(enc.encode('event: snapshot\ndata: {"seq":1,"sessions":[{"id":"a"}],"rows":[{"id":"a"}],"closed":{"sent":0,"total":2}}\n\n'))
      c.enqueue(enc.encode('event: delta\ndata: {"seq":2,"meta":{"attention":1}}\n\n'))
      req.signal.addEventListener('abort', () => { controllers.delete(c); historyControllers.delete(c); try { c.close() } catch {} }, { once: true })
      return
    }
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
it('an active-only snapshot can load history and then see a newly closed row at the front', async () => {
  const frames: FleetWire[] = []
  const stream = followFleet(`${server.url}api/fleet/events?history=1&closed=0`, f => frames.push(f))
  try {
    await until(() => frames.length === 2)
    await stream.loadClosed()
    expect(frames.at(-1)?.rows.map(r => r.id)).toEqual(['a', 'closed:recent', 'closed:older'])
    historyChanged = true
    for (const c of historyControllers) c.enqueue(enc.encode('event: delta\ndata: {"seq":3,"meta":{"closedTotal":3}}\n\n'))
    await until(() => frames.at(-1)?.seq === 3)
    await stream.loadClosed()
    expect(frames.at(-1)?.rows.map(r => r.id)).toEqual(['a', 'closed:new', 'closed:recent', 'closed:older'])
    historyDeleted = true
    for (const c of historyControllers) c.enqueue(enc.encode('event: delta\ndata: {"seq":4,"meta":{"closedTotal":2}}\n\n'))
    await until(() => frames.at(-1)?.seq === 4)
    await stream.loadClosed()
    expect(frames.at(-1)?.rows.map(r => r.id)).toEqual(['a', 'closed:new', 'closed:recent'])
    historyEmpty = true
    for (const c of historyControllers) c.enqueue(enc.encode('event: delta\ndata: {"seq":5,"meta":{"closedTotal":0}}\n\n'))
    await until(() => frames.at(-1)?.seq === 5)
    await stream.loadClosed()
    expect(frames.at(-1)?.rows.map(r => r.id)).toEqual(['a'])
  } finally { stream.close() }
})

function versionedHistory(initial: Array<{ id: string; title: string }>) {
  let rows = initial
  let version = '0000000000000001'
  let seq = 1
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined
  let hold: Promise<void> | undefined
  const offsets: number[] = []
  const paths: string[] = []
  const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url)
    paths.push(url.pathname)
    if (url.pathname === '/api/fleet/closed') {
      const offset = Number(url.searchParams.get('offset'))
      offsets.push(offset)
      const page = rows.slice(offset, offset + Number(url.searchParams.get('limit')))
      const total = rows.length
      const pending = hold; hold = undefined
      await pending
      return Response.json({ sessions: page, rows: page, total })
    }
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      ctl = c
      c.enqueue(enc.encode(`event: snapshot\ndata: ${JSON.stringify({ seq, sessions: [{ id: 'active' }], rows: [{ id: 'active' }], closedVersion: version, closed: { total: rows.length, sent: 0 } })}\n\n`))
      req.signal.addEventListener('abort', () => { try { c.close() } catch {} }, { once: true })
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  return {
    url: `${fixture.url}api/fleet/events?closed=0`, offsets, paths,
    holdNextPage(pending: Promise<void>) { hold = pending },
    publish(next: typeof rows, nextVersion = version, upsert?: { sessions: typeof rows; rows: typeof rows }) {
      const countChanged = next.length !== rows.length
      rows = next; version = nextVersion
      const meta = { closedVersion: version, ...(countChanged ? { closedTotal: rows.length } : {}) }
      ctl!.enqueue(enc.encode(`event: delta\ndata: ${JSON.stringify({ seq: ++seq, meta, ...(upsert ? { upsert } : {}) })}\n\n`))
    },
    close() { fixture.stop(true) },
  }
}

it('a meta-only closedVersion change refreshes opened history for all eight harnesses without a full fleet GET', async () => {
  const rows = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode', 'agentistics'].map(harness => ({ id: `closed:${harness}`, title: harness }))
  const fixture = versionedHistory(rows)
  const frames: FleetWire[] = []
  // Web opens history explicitly; editor/cockpit use options.history. Both paths use this consumer.
  const stream = followFleet(fixture.url, f => frames.push(f))
  try {
    await until(() => frames.length === 1)
    fixture.publish(rows, '0000000000000002')
    await until(() => frames.at(-1)?.seq === 2)
    expect(fixture.offsets).toEqual([])
    await stream.loadClosed()
    expect(fixture.offsets).toEqual([0])
    const edited = [...rows].reverse().map(row => ({ ...row, title: `${row.title} edited` }))
    fixture.publish(edited, '0000000000000003')
    await until(() => (frames.at(-1)?.rows[1] as { title?: string })?.title === 'agentistics edited')
    expect(frames.at(-1)?.rows).toEqual([{ id: 'active' }, ...edited])
    expect(frames.at(-1)?.sessions).toEqual([{ id: 'active' }, ...edited])
    expect(fixture.offsets).toEqual([0, 0])
    fixture.publish(edited)
    await until(() => frames.at(-1)?.seq === 4)
    expect(fixture.offsets).toEqual([0, 0])
    expect(fixture.paths).toEqual(['/api/fleet/events', '/api/fleet/closed', '/api/fleet/closed'])
    expect(stream.healthy()).toBe(true)
  } finally { stream.close(); fixture.close() }
})

it('history invalidation reloads only pages already opened and prunes deleted rows', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: `closed:${i}`, title: String(i) }))
  const fixture = versionedHistory(rows)
  const frames: FleetWire[] = []
  const stream = followFleet(fixture.url, f => frames.push(f), { history: true })
  try {
    await until(() => frames.at(-1)?.rows.length === 151)
    expect(fixture.offsets).toEqual([0, 100])
    const grown = [...rows, ...Array.from({ length: 150 }, (_, i) => ({ id: `closed:new-${i}`, title: `new ${i}` }))]
    fixture.publish(grown, '0000000000000002')
    await until(() => frames.at(-1)?.rows.length === 201)
    expect(fixture.offsets).toEqual([0, 100, 0, 100])
    // Opening more history is an explicit demand; the invalidation itself did not open page 3.
    await stream.loadClosed()
    expect(fixture.offsets).toEqual([0, 100, 0, 100, 200])
    fixture.publish(rows.slice(0, 2), '0000000000000003')
    await until(() => frames.at(-1)?.rows.length === 3)
    expect(frames.at(-1)?.rows).toEqual([{ id: 'active' }, ...rows.slice(0, 2)])
    expect(fixture.offsets).toEqual([0, 100, 0, 100, 200, 0])
  } finally { stream.close(); fixture.close() }
})

it('a newer closedVersion arriving during a page GET discards its stale response and refreshes again', async () => {
  const fixture = versionedHistory([{ id: 'closed:old', title: 'before' }])
  const frames: FleetWire[] = []
  const stream = followFleet(fixture.url, f => frames.push(f), { history: true })
  let release!: () => void
  try {
    await until(() => frames.at(-1)?.rows.length === 2)
    fixture.holdNextPage(new Promise<void>(resolve => { release = resolve }))
    fixture.publish([{ id: 'closed:old', title: 'stale' }], '0000000000000002')
    await until(() => fixture.offsets.length === 2)
    fixture.publish([{ id: 'closed:old', title: 'latest' }], '0000000000000003')
    await until(() => frames.at(-1)?.seq === 3)
    release()
    await until(() => (frames.at(-1)?.rows[1] as { title?: string })?.title === 'latest')
    expect(frames.some(f => (f.rows[1] as { title?: string })?.title === 'stale')).toBe(false)
    expect(fixture.offsets).toEqual([0, 0, 0])
  } finally { release?.(); stream.close(); fixture.close() }
})

it('a page refresh retains a newer SSE upsert received while its GET is pending', async () => {
  const fixture = versionedHistory([{ id: 'closed:old', title: 'before' }])
  const frames: FleetWire[] = []
  const stream = followFleet(fixture.url, f => frames.push(f), { history: true })
  let release!: () => void
  try {
    await until(() => frames.at(-1)?.rows.length === 2)
    fixture.holdNextPage(new Promise<void>(resolve => { release = resolve }))
    fixture.publish([{ id: 'closed:old', title: 'page' }], '0000000000000002')
    await until(() => fixture.offsets.length === 2)
    const upsert = [{ id: 'closed:old', title: 'newer SSE' }]
    fixture.publish(upsert, '0000000000000002', { sessions: upsert, rows: upsert })
    await until(() => frames.at(-1)?.seq === 3)
    release()
    await until(() => (frames.at(-1)?.closed as { sent?: number })?.sent === 1 && frames.at(-1)?.seq === 3 && frames.length >= 5)
    expect((frames.at(-1)?.rows[1] as { title?: string }).title).toBe('newer SSE')
    expect((frames.at(-1)?.sessions[1] as { title?: string }).title).toBe('newer SSE')
    expect(fixture.offsets).toEqual([0, 0])
  } finally { release?.(); stream.close(); fixture.close() }
})
