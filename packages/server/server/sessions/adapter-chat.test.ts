import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatSourceRef, HarnessChat, HarnessChatDelta } from '@agentistics/engine-api'
import type { ChatTurn } from '@agentistics/core'
import {
  adapterChatResponse, firstWindow, adapterRefused, clearAdapterRefusals, pickAdapterChat, readAdapterChat, refuseAdapter,
  rowLive, sameAdapterSource, sourceForeign, type AdapterChatDeps, type AdapterChatRow,
} from './adapter-chat'
import type { ChatPayload } from './chat-web'
import { onChatStreamsReset, resetChatStreams } from './chat-stream'

afterEach(() => clearAdapterRefusals())

/** A channel the test drives by hand. */
function fakeChat(o: { resolves?: boolean; throwsOnFollow?: boolean; resolveDelayMs?: number } = {}) {
  let emit: ((d: HarnessChatDelta) => void) | null = null
  let follows = 0, unfollows = 0, resolves = 0
  let resolvable = o.resolves ?? true
  const src: ChatSourceRef = { harness: 'codex', conversationId: 'c1', sourceRef: '/x/rollout.jsonl' }
  const chat: HarnessChat = {
    declares: { state: { from: 'markers' }, attention: { absent: 'no' }, live: { absent: 'no' }, fork: { absent: 'no' } },
    async resolve() {
      resolves++
      if (o.resolveDelayMs) await Bun.sleep(o.resolveDelayMs)
      return resolvable ? src : null
    },
    follow(_s, _max, on) {
      if (o.throwsOnFollow) throw new Error('broken source')
      follows++; emit = on
      return () => { unfollows++; emit = null }
    },
  }
  return {
    chat,
    emit: (d: HarnessChatDelta) => emit?.(d),
    makeResolvable: () => { resolvable = true },
    counts: () => ({ follows, unfollows, resolves }),
  }
}

const row = (extra: Partial<AdapterChatRow> = {}): AdapterChatRow =>
  ({ id: 'm1', harness: 'codex', cwd: '/w', state: 'working', conversationId: 'c1', ...extra })

const finish = async (read: { turns: ChatTurn[]; older: boolean }, live: boolean): Promise<ChatPayload> =>
  ({ turns: read.turns, live })

async function events(res: Response, until: (evs: { event: string; data: string }[]) => boolean, ms = 2000) {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const evs: { event: string; data: string }[] = []
  const deadline = Date.now() + ms
  while (!until(evs) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)])
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

describe('pickAdapterChat — who takes the engine path', () => {
  const ch = fakeChat().chat
  test('flag off: never', () => {
    expect(pickAdapterChat(row(), false, () => ch)).toBeNull()
  })
  test('no integration chat (a declared absence, or no engine): legacy', () => {
    expect(pickAdapterChat(row(), true, () => undefined)).toBeNull()
  })
  test('no exact link: legacy, which can say why', () => {
    expect(pickAdapterChat(row({ conversationId: undefined }), true, () => ch)).toBeNull()
  })
  test('a CLOSED row names its conversation in its id', () => {
    const p = pickAdapterChat(row({ id: 'closed:c9', conversationId: undefined, state: 'exited' }), true, () => ch)
    expect(p?.conversationId).toBe('c9')
  })
  test('a refused conversation goes to legacy until the refusal expires', () => {
    refuseAdapter('codex', 'c1', 1000)
    expect(pickAdapterChat(row(), true, () => ch, 2000)).toBeNull()
    expect(adapterRefused('codex', 'c1', 1000 + 5 * 60_000 + 1)).toBe(false)
  })
  test('every harness is decided the same way — nothing here names one', () => {
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'antigravity', 'opencode']) {
      expect(pickAdapterChat(row({ harness: h }), true, x => (x === h ? ch : undefined))?.chat).toBe(ch)
    }
  })
  test('rowLive mirrors the legacy reader', () => {
    expect(rowLive({ id: 'a', state: 'waiting-approval' })).toBe(true)
    expect(rowLive({ id: 'external:1', state: 'unknown' })).toBe(true)
    expect(rowLive({ id: 'a', state: 'exited' })).toBe(false)
  })
})

describe('adapterChatResponse', () => {
  function open(f: ReturnType<typeof fakeChat>, o: { rowAt?: () => AdapterChatRow | null; composing?: AdapterChatDeps['composing']; current?: AdapterChatDeps['current']; onReset?: AdapterChatDeps['onReset']; foreign?: AdapterChatDeps['foreign'] } = {}) {
    const ticks = new Set<() => void>()
    const wakes = new Set<() => void>()
    let closedWith: boolean | null = null
    const ctl = new AbortController()
    const res = adapterChatResponse({
      id: 'm1', conversationId: 'c1', chat: f.chat, max: 400,
      row: async () => (o.rowAt ? o.rowAt() : row()),
      pending: () => [],
      finish,
      onFleetTick: cb => { ticks.add(cb); return () => ticks.delete(cb) },
      onWake: cb => { wakes.add(cb); return () => wakes.delete(cb) },
      ...(o.composing ? { composing: o.composing } : {}),
      ...(o.current ? { current: o.current } : {}),
      ...(o.onReset ? { onReset: o.onReset } : {}),
      ...(o.foreign ? { foreign: o.foreign } : {}),
    }, ctl.signal, failed => { closedWith = failed })
    return { res, ctl, tick: () => { for (const t of ticks) t() }, ticks, wakes, closedWith: () => closedWith }
  }

  test('CROSSBIND: a resolved source another row owns closes the stream as a failure, unfollowed', async () => {
    const f = fakeChat() // resolves to `/x/rollout.jsonl`
    const s = open(f, { foreign: async () => new Set(['rollout']) })
    await Bun.sleep(30)
    expect(s.closedWith()).toBe(true)
    expect(f.counts().follows).toBe(0)
  })

  test('CROSSBIND: a fork into another row\'s conversation closes the stream as a failure', async () => {
    const f = fakeChat()
    const s = open(f, { foreign: async () => new Set(['other-conv']) })
    await Bun.sleep(20)
    expect(f.counts().follows).toBe(1)
    f.emit({ kind: 'fork', to: { harness: 'codex', conversationId: 'other-conv', sourceRef: '/x/other.jsonl' } })
    await Bun.sleep(20)
    expect(s.closedWith()).toBe(true)
  })

  test('CROSSBIND MED-1: a forked foreign source emits ZERO frames, even with a slow foreign check', async () => {
    const f = fakeChat()
    const s = open(f, { foreign: async () => { await Bun.sleep(60); return new Set(['other-conv']) } })
    await Bun.sleep(100)
    f.emit({ kind: 'fork', to: { harness: 'codex', conversationId: 'other-conv', sourceRef: '/x/other.jsonl' } })
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'SECRET of the other chat' }], older: false })
    f.emit({ kind: 'live', text: 'foreign live' })
    f.emit({ kind: 'state', working: true })
    const got = await events(s.res, e => e.some(x => x.event === 'chat' && x.data.includes('SECRET')) || e.some(x => x.event === 'live' && x.data.includes('foreign')), 400)
    expect(got.some(x => x.data.includes('SECRET') || x.data.includes('foreign live'))).toBe(false)
    expect(s.closedWith()).toBe(true)
  })

  test('CROSSBIND HIGH-2: overlapping forks — an older fork\'s check passing never releases a newer, foreign fork\'s frames', async () => {
    const f = fakeChat()
    let call = 0
    const s = open(f, {
      foreign: async () => {
        const n = ++call // #1 the initial resolve, #2 fork → unowned (40 ms), #3 fork → owned (200 ms)
        await Bun.sleep(n === 2 ? 40 : n === 3 ? 200 : 0)
        return new Set(['other-conv'])
      },
    })
    await Bun.sleep(20)
    f.emit({ kind: 'fork', to: { harness: 'codex', conversationId: 'unowned', sourceRef: '/x/unowned.jsonl' } })
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'fine' }], older: false })
    await Bun.sleep(5) // the debounced emission is now waiting on check #2
    f.emit({ kind: 'fork', to: { harness: 'codex', conversationId: 'other-conv', sourceRef: '/x/other.jsonl' } })
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'SECRET of the other chat' }], older: false })
    f.emit({ kind: 'live', text: 'foreign live' })
    const got = await events(s.res, e => e.some(x => x.data.includes('SECRET')), 400)
    expect(got.some(x => x.data.includes('SECRET') || x.data.includes('foreign live'))).toBe(false)
    expect(s.closedWith()).toBe(true)
  })

  test('a fork into an UNOWNED source is emitted once its check passes', async () => {
    const f = fakeChat()
    const s = open(f, { foreign: async () => { await Bun.sleep(30); return new Set(['other-conv']) } })
    await Bun.sleep(60)
    f.emit({ kind: 'fork', to: { harness: 'codex', conversationId: 'next', sourceRef: '/x/next.jsonl' } })
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'continued' }], older: false })
    const got = await events(s.res, e => e.some(x => x.event === 'chat' && x.data.includes('continued')), 400)
    expect(got.some(x => x.event === 'chat' && x.data.includes('continued'))).toBe(true)
    expect(s.closedWith()).toBeNull()
    s.ctl.abort()
  })

  test('CROSSBIND HIGH-4: a source whose owner registers AFTER it was adopted closes the stream on the next tick', async () => {
    const f = fakeChat() // resolves to `/x/rollout.jsonl`
    let owners = new Set<string>()
    const s = open(f, { foreign: async () => owners })
    await Bun.sleep(20)
    expect(f.counts().follows).toBe(1)
    owners = new Set(['rollout']) // B registered, linked to that conversation
    s.tick()
    await Bun.sleep(20)
    expect(s.closedWith()).toBe(true)
    expect(f.counts().unfollows).toBe(1)
  })

  test('window → `chat` with source adapter; append → `chat-delta`; live and state pass through', async () => {
    const f = fakeChat()
    const s = open(f)
    await Bun.sleep(20)
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'hi' }], older: false })
    const first = await events(s.res, e => e.some(x => x.event === 'chat'))
    const chat = JSON.parse(first.find(x => x.event === 'chat')!.data)
    expect(chat.source).toBe('adapter')
    expect(chat.turns).toEqual([{ role: 'user', text: 'hi' }])
    expect(chat.live).toBe(true)
    f.emit({ kind: 'live', text: 'thinking…' })
    f.emit({ kind: 'state', working: true })
    f.emit({ kind: 'append', turns: [{ role: 'assistant', text: 'hello' }] })
    const next = await events(s.res, e => e.some(x => x.event === 'chat-delta'))
    expect(JSON.parse(next.find(x => x.event === 'live')!.data)).toEqual({ text: 'thinking…' })
    expect(JSON.parse(next.find(x => x.event === 'state')!.data)).toEqual({ working: true })
    const d = JSON.parse(next.find(x => x.event === 'chat-delta')!.data)
    expect(d.append).toEqual([{ role: 'assistant', text: 'hello' }])
    expect(d.meta.source).toBe('adapter')
    s.ctl.abort()
    expect(f.counts().unfollows).toBe(1)
    expect(s.closedWith()).toBe(false)
  })

  test('ADAPTER.ESSENTIALS-B item 6: `composing` is sent as it is now, then on every change, and stops with the stream', async () => {
    const f = fakeChat()
    let now: 'question' | null = 'question'
    const cbs = new Set<(c: 'question' | null) => void>()
    const s = open(f, { composing: { now: () => now, on: cb => { cbs.add(cb); return () => cbs.delete(cb) } } })
    const first = await events(s.res, e => e.some(x => x.event === 'composing'))
    expect(JSON.parse(first.find(x => x.event === 'composing')!.data)).toEqual({ what: 'question' })
    now = null
    for (const cb of cbs) cb(null)
    f.emit({ kind: 'window', turns: [], older: false })
    const next = await events(s.res, e => e.some(x => x.event === 'composing'))
    expect(JSON.parse(next.find(x => x.event === 'composing')!.data)).toEqual({ what: null })
    s.ctl.abort()
    expect(cbs.size).toBe(0)
  })

  test('a source that cannot say what is being formulated sends no `composing` at all', async () => {
    const f = fakeChat()
    const s = open(f)
    await Bun.sleep(20)
    f.emit({ kind: 'window', turns: [], older: false })
    const got = await events(s.res, e => e.some(x => x.event === 'chat'))
    expect(got.some(x => x.event === 'composing')).toBe(false)
    s.ctl.abort()
  })

  test('a source not written yet: an empty first frame, retried on fleet ticks only', async () => {
    const f = fakeChat({ resolves: false })
    const s = open(f)
    const first = await events(s.res, e => e.some(x => x.event === 'chat'))
    expect(JSON.parse(first[0]!.data).turns).toEqual([])
    const before = f.counts().resolves
    await Bun.sleep(1200) // no timer of its own retries the resolve
    expect(f.counts().resolves).toBe(before)
    f.makeResolvable()
    s.tick()
    await Bun.sleep(30)
    expect(f.counts().follows).toBe(1)
    s.ctl.abort()
  })

  test('a STOPPED row with no resolvable source closes the stream as FAILED (legacy diagnosis)', async () => {
    const f = fakeChat({ resolves: false })
    const s = open(f, { rowAt: () => row({ state: 'exited' }) })
    await events(s.res, () => false, 200)
    expect(s.closedWith()).toBe(true)
  })

  test('MED-2: a STOPPED row whose resolve is SLOWER than the debounce sends no frame before handing over', async () => {
    // Startup used to find the tick's resolve in flight, return at once and schedule the first frame:
    // an empty SUCCESSFUL `chat` went out before the null arrived and the stream closed as failed.
    const f = fakeChat({ resolves: false, resolveDelayMs: 120 })
    const s = open(f, { rowAt: () => row({ state: 'exited' }) })
    const got = await events(s.res, () => false, 400)
    expect(got.filter(x => x.event === 'chat' || x.event === 'chat-delta')).toEqual([])
    expect(s.closedWith()).toBe(true)
    expect(f.counts().resolves).toBe(1)
  })

  test('MED-2: a STOPPED row woken while its slow resolve is in flight still sends nothing', async () => {
    const f = fakeChat({ resolves: false, resolveDelayMs: 120 })
    const s = open(f, { rowAt: () => row({ state: 'exited' }) })
    await Bun.sleep(10)
    for (const w of s.wakes) w()
    const got = await events(s.res, () => false, 400)
    expect(got.filter(x => x.event === 'chat' || x.event === 'chat-delta')).toEqual([])
    expect(s.closedWith()).toBe(true)
  })

  test('MED-2: a LIVE row with a slow, empty resolve still gets its empty first frame', async () => {
    const f = fakeChat({ resolves: false, resolveDelayMs: 60 })
    const s = open(f)
    const got = await events(s.res, e => e.some(x => x.event === 'chat'))
    expect(JSON.parse(got.find(x => x.event === 'chat')!.data).turns).toEqual([])
    expect(s.closedWith()).toBeNull()
    s.ctl.abort()
  })

  test('the chat-source switch moving (onReset) closes the stream, NOT as failed', async () => {
    const f = fakeChat()
    const resets = new Set<() => void>()
    const s = open(f, { onReset: cb => { resets.add(cb); return () => resets.delete(cb) } })
    await Bun.sleep(20)
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'hi' }], older: false })
    await events(s.res, e => e.some(x => x.event === 'chat'))
    expect(resets.size).toBe(1)
    for (const r of [...resets]) r()
    expect(s.closedWith()).toBe(false)
    expect(resets.size).toBe(0)
    expect(f.counts().unfollows).toBe(1)
  })

  test('resetChatStreams (the experimental switch) closes an open adapter stream, NOT as failed', async () => {
    const f = fakeChat()
    const s = open(f, { onReset: onChatStreamsReset })
    await Bun.sleep(20)
    resetChatStreams()
    expect(s.closedWith()).toBe(false)
    expect(f.counts().unfollows).toBe(1)
    resetChatStreams() // already closed and unregistered: nothing happens twice
    expect(s.closedWith()).toBe(false)
  })

  test('an engine error closes the stream as FAILED', async () => {
    const f = fakeChat({ throwsOnFollow: true })
    const s = open(f)
    await events(s.res, () => false, 200)
    expect(s.closedWith()).toBe(true)
  })

  test('a row that left the fleet closes the stream (the legacy stream says why)', async () => {
    const f = fakeChat()
    let gone = false
    const s = open(f, { rowAt: () => (gone ? null : row()) })
    await Bun.sleep(20)
    gone = true
    s.tick()
    await Bun.sleep(20)
    expect(s.closedWith()).toBe(false)
    expect(s.ticks.size).toBe(0)
  })

  test('AGY.CHAT.REPLIES: a source the row no longer reads from (structured → TUI) closes the stream, not FAILED', async () => {
    // Measured 2026-10-10 on a3e4c77936: a structured agy session was turned into a TUI (`attach` =
    // open in terminal); the stream kept following the dead structured channel, so the chat froze on
    // the person's own message while the TUI answered. Closing lets the client reconnect to the
    // source the row reads from NOW.
    const f = fakeChat()
    let still = true
    const s = open(f, { current: async () => still })
    await Bun.sleep(20)
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'salve' }], older: false })
    await events(s.res, e => e.some(x => x.event === 'chat'))
    s.tick()
    await Bun.sleep(20)
    expect(s.closedWith()).toBeNull()
    still = false
    s.tick()
    await Bun.sleep(20)
    expect(s.closedWith()).toBe(false)
    expect(f.counts().unfollows).toBe(1)
  })

  test('the row going idle re-emits `live: false`', async () => {
    const f = fakeChat()
    let state = 'working'
    const s = open(f, { rowAt: () => row({ state }) })
    await Bun.sleep(20)
    f.emit({ kind: 'window', turns: [{ role: 'user', text: 'hi' }], older: false })
    await events(s.res, e => e.some(x => x.event === 'chat'))
    state = 'exited'
    s.tick()
    const next = await events(s.res, e => e.some(x => x.event === 'chat-delta'))
    expect(JSON.parse(next.find(x => x.event === 'chat-delta')!.data).meta.live).toBe(false)
    s.ctl.abort()
  })
})

describe('readAdapterChat — the one-shot GET', () => {
  test('waits for the first window, then stops following', async () => {
    const f = fakeChat()
    const p = readAdapterChat({ conversationId: 'c1', chat: f.chat, row: row(), pending: [], max: 400, finish })
    await Bun.sleep(5)
    f.emit({ kind: 'window', turns: [{ role: 'assistant', text: 'x' }], older: true })
    const out = await p
    expect(out?.source).toBe('adapter')
    expect(out?.turns).toEqual([{ role: 'assistant', text: 'x' }])
    await Bun.sleep(1)
    expect(f.counts().unfollows).toBe(1)
  })

  test('no source yet: an empty conversation, not a failure', async () => {
    const out = await readAdapterChat({ conversationId: 'c1', chat: fakeChat({ resolves: false }).chat, row: row(), pending: [], max: 400, finish })
    expect(out).toEqual({ turns: [], live: true, source: 'adapter' })
  })

  test('a STOPPED row with no resolvable source: null, so the legacy reader gives its diagnosis', async () => {
    const out = await readAdapterChat({ conversationId: 'c1', chat: fakeChat({ resolves: false }).chat, row: row({ state: 'lost' }), pending: [], max: 400, finish })
    expect(out).toBeNull()
  })

  test('no window in time: null, so the caller serves the legacy read', async () => {
    const out = await readAdapterChat({ conversationId: 'c1', chat: fakeChat().chat, row: row(), pending: [], max: 400, finish, timeoutMs: 20 })
    expect(out).toBeNull()
  })
})

describe('sameAdapterSource — is the opened channel still the row\'s (AGY.CHAT.REPLIES)', () => {
  test('structured → TUI (file channel): no longer current', () => {
    expect(sameAdapterSource({ structured: true }, { structured: false, conversationId: 'c1' })).toBe(false)
  })
  test('structured stays structured even when the harness states its own conversation id', () => {
    expect(sameAdapterSource({ structured: true }, { structured: true })).toBe(true)
  })
  test('a file channel: current for the same conversation, not for another, not when the row went legacy', () => {
    expect(sameAdapterSource({ structured: false, conversationId: 'c1' }, { structured: false, conversationId: 'c1' })).toBe(true)
    expect(sameAdapterSource({ structured: false, conversationId: 'c1' }, { structured: false, conversationId: 'c2' })).toBe(false)
    expect(sameAdapterSource({ structured: false, conversationId: 'c1' }, null)).toBe(false)
    expect(sameAdapterSource({ structured: false, conversationId: 'c1' }, { structured: true })).toBe(false)
  })
})

describe('firstWindow — one read, then stop following', () => {
  const src = { sourceRef: 's1' } as unknown as ChatSourceRef
  const synchronous = (calls: { n: number }): HarnessChat => ({
    follow: (_s: ChatSourceRef, _max: number, on: (d: HarnessChatDelta) => void) => {
      on({ kind: 'window', turns: [{ role: 'assistant', text: 'hi' }], older: false } as HarnessChatDelta)
      return () => { calls.n++ }
    },
  }) as unknown as HarnessChat

  test('a window delivered synchronously unsubscribes exactly once', async () => {
    const calls = { n: 0 }
    const w = await firstWindow(synchronous(calls), src, 6, 50)
    await new Promise(r => setTimeout(r, 0))
    expect(w?.turns.map(t => t.text)).toEqual(['hi'])
    expect(calls.n).toBe(1)
  })

  test('a window delivered later unsubscribes exactly once', async () => {
    const calls = { n: 0 }
    const chat = {
      follow: (_s: ChatSourceRef, _max: number, on: (d: HarnessChatDelta) => void) => {
        setTimeout(() => on({ kind: 'window', turns: [], older: false } as HarnessChatDelta), 1)
        return () => { calls.n++ }
      },
    } as unknown as HarnessChat
    await firstWindow(chat, src, 6, 50)
    await new Promise(r => setTimeout(r, 5))
    expect(calls.n).toBe(1)
  })
})

/**
 * CROSSBIND — two sessions in one folder showed each other's chat. The engine's fork-follow judges a
 * sibling transcript by its content; the host refuses any source another row is linked to, and the
 * legacy reader (which never follows into one) serves instead.
 */
describe('a source owned by ANOTHER row is refused (CROSSBIND)', () => {
  const A = '733fde78-b310-4e23-8794-69e4243890ff'
  const B = '606e75fb-d5e6-40ef-bb47-52f9f98364e8'
  const toB: ChatSourceRef = { harness: 'claude', conversationId: B, sourceRef: `/p/-w/${B}.jsonl`, continuesFrom: `/p/-w/${A}.jsonl` }

  test('sourceForeign reads the stated id and the file name; its own conversation is never foreign', () => {
    expect(sourceForeign(toB, A, new Set([B]))).toBe(true)
    expect(sourceForeign({ ...toB, conversationId: A }, A, new Set([B]))).toBe(true) // the FILE is B's
    expect(sourceForeign({ harness: 'claude', conversationId: A, sourceRef: `/p/-w/${A}.jsonl` }, A, new Set([B]))).toBe(false)
    expect(sourceForeign(toB, B, new Set([B]))).toBe(false)
    expect(sourceForeign(toB, A, new Set())).toBe(false)
  })

  test('MED-1 readAdapterChat: a fork to another row\'s source before the first window answers null', async () => {
    const own: ChatSourceRef = { harness: 'claude', conversationId: A, sourceRef: `/p/-w/${A}.jsonl` }
    const chat: HarnessChat = {
      declares: { state: { from: 'markers' }, attention: { absent: 'no' }, live: { absent: 'no' }, fork: { from: 'file' } } as never,
      resolve: async () => own,
      follow(_s, _m, on) {
        on({ kind: 'fork', to: toB })
        on({ kind: 'window', turns: [{ role: 'user', text: 'SECRET of B' }], older: false })
        return () => {}
      },
    }
    const out = await readAdapterChat({
      conversationId: A, chat, row: row({ harness: 'claude', conversationId: A, state: 'exited' }),
      pending: [], max: 400, finish, foreign: async () => new Set([B]),
    })
    expect(out).toBeNull()
  })

  test('readAdapterChat: a fork to an unowned source is read', async () => {
    const own: ChatSourceRef = { harness: 'claude', conversationId: A, sourceRef: `/p/-w/${A}.jsonl` }
    const chat: HarnessChat = {
      declares: { state: { from: 'markers' }, attention: { absent: 'no' }, live: { absent: 'no' }, fork: { from: 'file' } } as never,
      resolve: async () => own,
      follow(_s, _m, on) {
        on({ kind: 'fork', to: toB })
        on({ kind: 'window', turns: [{ role: 'user', text: 'continued' }], older: false })
        return () => {}
      },
    }
    const out = await readAdapterChat({
      conversationId: A, chat, row: row({ harness: 'claude', conversationId: A, state: 'exited' }),
      pending: [], max: 400, finish, foreign: async () => new Set(),
    })
    expect(out?.turns).toEqual([{ role: 'user', text: 'continued' }])
  })

  test('readAdapterChat: resolving into another row\'s file answers null and never follows it', async () => {
    let follows = 0
    const chat: HarnessChat = {
      declares: { state: { from: 'markers' }, attention: { absent: 'no' }, live: { absent: 'no' }, fork: { from: 'file' } } as never,
      resolve: async () => toB,
      follow() { follows++; return () => {} },
    }
    const out = await readAdapterChat({
      conversationId: A, chat, row: row({ harness: 'claude', conversationId: A, state: 'exited' }),
      pending: [], max: 400, finish, foreign: async () => new Set([B]),
    })
    expect(out).toBeNull()
    expect(follows).toBe(0)
  })
})
