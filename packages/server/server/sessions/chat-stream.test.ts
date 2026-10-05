import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatStreamCount, chatStreamResponse, MAX_CHAT_STREAMS, wakeChat } from './chat-stream'
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
