import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatStreamCount, chatStreamResponse, DEBOUNCE_MS, MAX_CHAT_STREAMS, nextReadDelay, wakeChat } from './chat-stream'
import type { ChatPayload } from './chat-web'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function events(res: Response, until: (evs: { event: string; data: string }[]) => boolean, ms = 3000) {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const evs: { event: string; data: string }[] = []
  const deadline = Date.now() + ms
  while (!until(evs) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)])
    if (!r || r.done) break
    buf += dec.decode(r.value)
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      const ev = block.match(/^event: (.+)$/m)?.[1]; const data = block.match(/^data: (.*)$/m)?.[1]
      if (ev && data !== undefined) evs.push({ event: ev, data })
    }
  }
  reader.releaseLock()
  return evs
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-stream-')); dirs.push(dir)
  const file = join(dir, 't.jsonl'); writeFileSync(file, '')
  let turns: ChatPayload['turns'] = [{ role: 'user', text: 'hi' }]
  let pending: string[] = []
  let reads = 0, freshReads = 0
  const deps = {
    async read(fresh: boolean, onPath: (p: string) => void): Promise<ChatPayload> {
      reads++; if (fresh) freshReads++
      onPath(file)
      return { turns: [...turns], live: true, ...(pending.length ? { pending: pending.map(text => ({ text, at: 1 })) as never } : {}) }
    },
  }
  return { file, deps, setTurns: (t: ChatPayload['turns']) => { turns = t }, setPending: (p: string[]) => { pending = p }, counts: () => ({ reads, freshReads }) }
}

describe('chat stream (PERF.1 step 2)', () => {
  test('the first frame is whole; a transcript append pushes only the new turn, fast', async () => {
    const s = setup()
    const ctl = new AbortController()
    const res = chatStreamResponse('s1', s.deps, ctl.signal)!
    const first = await events(res, e => e.length >= 1)
    expect(first[0]!.event).toBe('chat')
    expect(JSON.parse(first[0]!.data).turns).toEqual([{ role: 'user', text: 'hi' }])
    s.setTurns([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }])
    const t = performance.now()
    appendFileSync(s.file, '{"x":1}\n')
    const next = await events(res, e => e.some(x => x.event === 'chat-delta'))
    const took = performance.now() - t
    const d = JSON.parse(next.find(x => x.event === 'chat-delta')!.data)
    expect(d).toMatchObject({ drop: 0, keep: 1, append: [{ role: 'assistant', text: 'hello' }] })
    expect(took).toBeLessThan(300)
    ctl.abort()
  })

  test('a send wakes it (the pending echo), with a fresh fleet row', async () => {
    const s = setup()
    const ctl = new AbortController()
    const res = chatStreamResponse('s2', s.deps, ctl.signal)!
    await events(res, e => e.length >= 1)
    const before = s.counts().freshReads
    s.setPending(['queued msg'])
    wakeChat('s2')
    const next = await events(res, e => e.some(x => x.event === 'chat-delta'))
    expect(JSON.parse(next.find(x => x.event === 'chat-delta')!.data).meta.pending[0].text).toBe('queued msg')
    expect(s.counts().freshReads).toBeGreaterThan(before)
    ctl.abort()
  })

  test('nothing changed: nothing is sent', async () => {
    const s = setup()
    const ctl = new AbortController()
    const res = chatStreamResponse('s3', s.deps, ctl.signal)!
    await events(res, e => e.length >= 1)
    wakeChat('s3')
    const next = await events(res, e => e.some(x => x.event !== 'ping'), 400)
    expect(next.filter(x => x.event !== 'ping')).toEqual([])
    ctl.abort()
  })

  test('closing frees the slot; past the cap a stream is refused (the client polls instead)', async () => {
    const s = setup()
    const before = chatStreamCount()
    const ctls = Array.from({ length: MAX_CHAT_STREAMS - before }, () => new AbortController())
    for (const c of ctls) expect(chatStreamResponse('cap', s.deps, c.signal)).not.toBeNull()
    expect(chatStreamResponse('cap', s.deps, new AbortController().signal)).toBeNull()
    for (const c of ctls) c.abort()
    expect(chatStreamCount()).toBe(before)
  })
})

describe('chat stream — an unresolved path (ENGINE.MAP P-03)', () => {
  test('with a fleet tick source, it re-reads ONLY on ticks — no 1 s loop', async () => {
    let reads = 0
    let path: string | null = null
    let tick: (() => void) | null = null
    let subscribed = 0, unsubscribed = 0
    const timers: Array<{ f: () => void; ms: number }> = []
    const ctl = new AbortController()
    const res = chatStreamResponse('u1', {
      async read(_fresh, onPath) { reads++; if (path) onPath(path); return { turns: [], live: true } },
      onFleetTick: cb => { subscribed++; tick = cb; return () => { unsubscribed++ } },
      watchFile: () => ({ close() {} }),
      // The debounce fires at once; every other timer is only recorded.
      setTimer: (f, ms) => { timers.push({ f, ms }); if (ms === 25) queueMicrotask(f); return timers.length },
      clearTimer: () => {},
    }, ctl.signal)!
    await events(res, e => e.length >= 1, 300)
    expect(reads).toBe(1)
    // The only retry timer is the slow safety read — never the old 1 s unresolved loop.
    expect(timers.some(t => t.ms === 1_000)).toBe(false)
    expect(subscribed).toBe(1)
    tick!()
    await Bun.sleep(60)
    expect(reads).toBe(2)
    path = '/tmp/does-not-matter.jsonl'
    tick!()
    await Bun.sleep(60)
    expect(reads).toBe(3)
    expect(unsubscribed).toBe(1) // resolved: the ticks are released
    ctl.abort()
  })

  test('without a tick source, the unresolved retry backs off instead of looping at 1 s', async () => {
    const waits: number[] = []
    const ctl = new AbortController()
    const res = chatStreamResponse('u2', {
      async read() { return { turns: [], live: true } },
      setTimer: (f, ms) => { if (ms !== 15_000 && ms !== 25) { waits.push(ms); if (waits.length < 6) queueMicrotask(f) } else if (ms === 25) queueMicrotask(f); return 0 },
      clearTimer: () => {},
    }, ctl.signal)!
    await events(res, e => e.length >= 1, 300)
    await Bun.sleep(50)
    expect(waits.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000])
    ctl.abort()
  })
})

describe('chat stream — the first send to a session with no transcript yet', () => {
  test('a send re-reads at short offsets until the path resolves, then stops', async () => {
    let reads = 0
    let path: string | null = null
    const timers: Array<{ f: () => void; ms: number }> = []
    const ctl = new AbortController()
    const res = chatStreamResponse('u3', {
      async read(_fresh, onPath) { reads++; if (path) onPath(path); return { turns: [], live: true } },
      onFleetTick: () => () => {},
      watchFile: () => ({ close() {} }),
      setTimer: (f, ms) => { timers.push({ f, ms }); if (ms === 25) queueMicrotask(f); return timers.length },
      clearTimer: () => {},
    }, ctl.signal)!
    await events(res, e => e.length >= 1, 300)
    wakeChat('u3')
    await Bun.sleep(30)
    const burst = timers.filter(t => t.ms === 700 || t.ms === 1_500 || t.ms === 3_000)
    expect(burst.map(t => t.ms)).toEqual([700, 1_500, 3_000])
    const before = reads
    path = '/tmp/x.jsonl' // the harness wrote it
    burst[0]!.f()
    await Bun.sleep(30)
    expect(reads).toBe(before + 1)
    burst[1]!.f() // resolved: the rest of the burst does nothing
    await Bun.sleep(30)
    expect(reads).toBe(before + 1)
    ctl.abort()
  })
})

describe('nextReadDelay — the per-stream duty cycle (PERF.SLOW)', () => {
  test('a quiet spell or a fast read: the debounce', () => {
    expect(nextReadDelay(10_000, -Infinity, 0)).toBe(DEBOUNCE_MS)
    expect(nextReadDelay(10_000, 9_990, 2)).toBe(DEBOUNCE_MS)
  })
  test('a slow read under a writing turn: idle for 4x its duration after it ended', () => {
    expect(nextReadDelay(10_000, 10_000, 100)).toBe(400)
    expect(nextReadDelay(10_300, 10_000, 100)).toBe(100)
  })
  test('never longer than a second', () => {
    expect(nextReadDelay(10_000, 10_000, 5_000)).toBe(1_000)
  })
})
