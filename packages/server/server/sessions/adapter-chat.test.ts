import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatSourceRef, HarnessChat, HarnessChatDelta } from '@agentistics/engine-api'
import type { ChatTurn } from '@agentistics/core'
import {
  adapterChatResponse, adapterRefused, clearAdapterRefusals, pickAdapterChat, readAdapterChat, refuseAdapter,
  rowLive, type AdapterChatRow,
} from './adapter-chat'
import type { ChatPayload } from './chat-web'

afterEach(() => clearAdapterRefusals())

/** A channel the test drives by hand. */
function fakeChat(o: { resolves?: boolean; throwsOnFollow?: boolean } = {}) {
  let emit: ((d: HarnessChatDelta) => void) | null = null
  let follows = 0, unfollows = 0, resolves = 0
  let resolvable = o.resolves ?? true
  const src: ChatSourceRef = { harness: 'codex', conversationId: 'c1', sourceRef: '/x/rollout.jsonl' }
  const chat: HarnessChat = {
    declares: { state: { from: 'markers' }, attention: { absent: 'no' }, live: { absent: 'no' }, fork: { absent: 'no' } },
    async resolve() { resolves++; return resolvable ? src : null },
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
  function open(f: ReturnType<typeof fakeChat>, o: { rowAt?: () => AdapterChatRow | null } = {}) {
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
    }, ctl.signal, failed => { closedWith = failed })
    return { res, ctl, tick: () => { for (const t of ticks) t() }, ticks, wakes, closedWith: () => closedWith }
  }

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

  test('no window in time: null, so the caller serves the legacy read', async () => {
    const out = await readAdapterChat({ conversationId: 'c1', chat: fakeChat().chat, row: row(), pending: [], max: 400, finish, timeoutMs: 20 })
    expect(out).toBeNull()
  })
})
