import { describe, expect, test } from 'bun:test'
import { createStreamMux } from './streamMux'

class FakeWs {
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send(s: string) { this.sent.push(JSON.parse(s)) }
  open() { this.onopen?.() }
  push(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
  drop() { this.onclose?.() }
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('streamMux — every push stream of a tab over one socket', () => {
  test('N streams share ONE socket and arrive as EventSource events', () => {
    const sockets: FakeWs[] = []
    const mux = createStreamMux(() => { const w = new FakeWs(); sockets.push(w); return w as unknown as WebSocket })
    const a = mux.open('/api/events')
    const b = mux.open('/api/fleet/chat-stream?id=x&lang=en')
    const c = mux.open('/api/data-stream')
    expect(sockets.length).toBe(1)
    sockets[0]!.open()
    expect(sockets[0]!.sent).toEqual([
      { op: 'sub', sid: 1, url: '/api/events' },
      { op: 'sub', sid: 2, url: '/api/fleet/chat-stream?id=x&lang=en' },
      { op: 'sub', sid: 3, url: '/api/data-stream' },
    ])
    const got: string[] = []
    let opened = 0
    a.onopen = () => { opened++ }
    a.addEventListener('change', (e: MessageEvent) => got.push(`a:${e.data}`))
    b.addEventListener('chat', (e: MessageEvent) => got.push(`b:${e.data}`))
    c.onmessage = (e) => got.push(`c:${e.data}`)
    sockets[0]!.push({ sid: 1, t: 'open' })
    sockets[0]!.push({ sid: 1, t: 'ev', e: 'change', d: '{}' })
    sockets[0]!.push({ sid: 2, t: 'ev', e: 'chat', d: 'hi', id: '5' })
    sockets[0]!.push({ sid: 3, t: 'ev', e: 'message', d: 'm' })
    expect(opened).toBe(1)
    expect(a.readyState).toBe(1)
    expect(got).toEqual(['a:{}', 'b:hi', 'c:m'])
    a.close()
    expect(sockets[0]!.sent.at(-1)).toEqual({ op: 'unsub', sid: 1 })
  })

  test('a named server event "open" is a MessageEvent with data, not the connection open', () => {
    const w = new FakeWs()
    const s = createStreamMux(() => w as unknown as WebSocket).open('/api/fleet/stream?id=q')
    w.open()
    let conn = 0
    const named: string[] = []
    s.onopen = () => { conn++ }
    s.addEventListener('open', (e: MessageEvent) => { if (e.data) named.push(e.data) })
    w.push({ sid: 1, t: 'open' })
    w.push({ sid: 1, t: 'ev', e: 'open', d: '{"cols":80}' })
    expect(conn).toBe(1)
    expect(named).toEqual(['{"cols":80}'])
  })

  test('an HTTP refusal closes for good, like EventSource', () => {
    const w = new FakeWs()
    const s = createStreamMux(() => w as unknown as WebSocket).open('/api/events')
    w.open()
    let errs = 0
    s.onerror = () => { errs++ }
    w.push({ sid: 1, t: 'fail', status: 401 })
    expect(errs).toBe(1)
    expect(s.readyState).toBe(2)
  })

  test('a stream the server ends reconnects with its last event id', async () => {
    const w = new FakeWs()
    const s = createStreamMux(() => w as unknown as WebSocket).open('/api/events')
    w.open()
    w.push({ sid: 1, t: 'open' })
    w.push({ sid: 1, t: 'ev', e: 'x', d: '1', id: '42', retry: 10 })
    let errs = 0
    s.onerror = () => { errs++ }
    w.push({ sid: 1, t: 'end' })
    expect(errs).toBe(1)
    expect(s.readyState).toBe(0)
    await wait(30)
    expect(w.sent.at(-1)).toEqual({ op: 'sub', sid: 1, url: '/api/events', lastEventId: '42' })
  })

  test('a dropped socket errors every stream and comes back as a socket', async () => {
    const sockets: FakeWs[] = []
    const mux = createStreamMux(() => { const w = new FakeWs(); sockets.push(w); return w as unknown as WebSocket })
    const s = mux.open('/api/events')
    sockets[0]!.open(); sockets[0]!.push({ sid: 1, t: 'open' })
    let errs = 0
    s.onerror = () => { errs++ }
    sockets[0]!.drop()
    expect(errs).toBe(1)
    expect(s.readyState).toBe(0)
    await wait(1100)
    expect(sockets.length).toBe(2)
    sockets[1]!.open()
    expect(sockets[1]!.sent).toEqual([{ op: 'sub', sid: 1, url: '/api/events' }])
  })

  test('a socket that can never open falls back to a real EventSource', () => {
    const made: string[] = []
    const prev = (globalThis as { EventSource?: unknown }).EventSource
    ;(globalThis as { EventSource?: unknown }).EventSource = class { onopen = null; onerror = null; onmessage = null; readyState = 0; constructor(u: string) { made.push(u) } addEventListener() {} close() {} }
    try {
      const mux = createStreamMux(() => null)
      mux.open('/api/events')
      mux.open('/api/data-stream')
      expect(made).toEqual(['/api/events', '/api/data-stream'])
    } finally { (globalThis as { EventSource?: unknown }).EventSource = prev }
  })
})

describe('no push stream bypasses the mux', () => {
  test('`new EventSource(` appears only inside streamMux.ts (the fallback)', async () => {
    const { Glob } = await import('bun')
    const root = new URL('../', import.meta.url).pathname
    const offenders: string[] = []
    for await (const f of new Glob('**/*.{ts,tsx}').scan({ cwd: root })) {
      if (f.endsWith('.test.ts') || f.endsWith('.test.tsx') || f === 'lib/streamMux.ts') continue
      const src = await Bun.file(root + f).text()
      if (/new EventSource\(/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) offenders.push(f)
    }
    // A raw EventSource holds one of the ~6 HTTP/1.1 connections the browser allows per origin across
    // ALL tabs; use `openEventStream(url)` (lib/streamMux.ts) instead.
    expect(offenders).toEqual([])
  })
})
