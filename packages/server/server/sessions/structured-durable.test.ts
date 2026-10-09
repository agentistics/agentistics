/**
 * structured-durable.test.ts — F2.0b: a structured session SURVIVES the server, through REAL processes.
 *
 * Each test runs the real relay (`structured-relay.ts`, detached, via `bun run`) holding a fake protocol
 * peer (`fixtures/fake-structured-agent.ts`), and a deterministic fake DRIVER that speaks to it only
 * through `StructuredSpawn.transport`. "The server restarts" is: composite A drops its relay connection
 * without touching the child (exactly what a dying process does), and composite B — a fresh process's
 * worth of state over the same directory — re-attaches. Relays are stopped by their saved PID only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  EngineChatTurn, HarnessChatDelta, StructuredDeclaration, StructuredDriver, StructuredExit,
  StructuredSession, StructuredSpawn,
} from '@agentistics/engine-api'
import { structuredRegistry } from '@agentistics/engine-api'
import { withStructured, type StructuredProvider } from './structured-backend'
import { durableStore, type DurableStore, type DurableTransport } from './structured-durable'
import { callsAt, parseJsonl, isOutRecord, writeCheck } from './structured-replay'
import { structuredIntentOf } from './structured-route'
import type { BackendSpawn, SessionBackend } from './types'

const AGENT = path.join(import.meta.dir, 'fixtures', 'fake-structured-agent.ts')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20) }
}

const DECL: StructuredDeclaration = {
  assignId: { absent: 'fake' }, resume: { via: 'fake' }, model: { absent: 'fake' }, effort: { absent: 'fake' },
  mcp: { absent: 'fake' }, instructions: { channel: 'first-message', reason: 'fake' }, live: { via: 'chunks' },
  permissions: { absent: 'fake' }, questions: { absent: 'fake' }, cancel: { absent: 'fake' },
}

/** A deterministic driver over `req.transport`: ids in order, no timers, turns stamped by the pipe's clock. */
function fakeDriver(log: string, started: StructuredSpawn[]): StructuredDriver {
  return {
    id: 'acp', status: 'ready', harnesses: ['gemini'], note: 'fake', declares: () => DECL,
    async start(req) {
      started.push(req)
      const pipe = req.transport!.launch('bun', ['run', AGENT], req.cwd, { AGENT_LOG: log })
      const now = () => pipe.now?.() ?? Date.now()
      let nextId = 1
      const pending = new Map<number, (r: unknown) => void>()
      const turns: EngineChatTurn[] = []
      let draft = ''
      let state: ReturnType<StructuredSession['activity']> = 'starting'
      let sid: string | null = null
      let disposed = false
      const subs = new Set<(d: HarnessChatDelta) => void>()
      const exits = new Set<(e: StructuredExit) => void>()
      const emit = (d: HarnessChatDelta) => { for (const f of subs) f(d) }
      const request = (method: string, extra: Record<string, unknown> = {}) => new Promise<unknown>(res => {
        const id = nextId++
        pending.set(id, res)
        pipe.write(`${JSON.stringify({ id, method, ...extra })}\n`)
      })
      void (async () => {
        let buf = ''
        for await (const c of pipe.source) {
          buf += c
          let nl: number
          while ((nl = buf.indexOf('\n')) !== -1) {
            const m = JSON.parse(buf.slice(0, nl)) as { id?: number; result?: unknown; chunk?: string }
            buf = buf.slice(nl + 1)
            if (typeof m.chunk === 'string') { draft += m.chunk; emit({ kind: 'live', text: draft }) }
            else if (typeof m.id === 'number') { pending.get(m.id)?.(m.result); pending.delete(m.id) }
          }
        }
        state = 'exited'
        for (const cb of exits) cb(disposed ? { kind: 'disposed' } : { kind: 'failed', reason: 'the agent exited' })
      })()
      const queue: string[] = []
      let running = false
      const drain = async () => {
        if (running) return
        running = true
        while (queue.length > 0) {
          const text = queue.shift()!
          state = 'working'
          const u: EngineChatTurn = { role: 'user', text, at: new Date(now()).toISOString() }
          turns.push(u); emit({ kind: 'append', turns: [u] })
          draft = ''
          await request('prompt', { text })
          const a: EngineChatTurn = { role: 'assistant', text: draft, at: new Date(now()).toISOString() }
          turns.push(a); emit({ kind: 'append', turns: [a] })
          draft = ''
          state = 'waiting'
        }
        running = false
      }
      const init = await request('init') as { sid: string }
      sid = init.sid
      state = 'waiting'
      if (req.initialPrompt) { queue.push(req.initialPrompt); void drain() }
      const session: StructuredSession = {
        id: req.id, driver: 'acp', harness: req.harness,
        conversationId: () => sid,
        activity: () => state,
        attention: () => null,
        screen: n => turns.map(t => `${t.role}: ${t.text}`).slice(-n),
        lastActivityMs: () => now(),
        prompt(t) { if (state === 'exited') return false; queue.push(t); void drain(); return true },
        answer: () => false,
        cancel() {},
        follow(max, on) {
          on({ kind: 'window', turns: turns.slice(-max), older: turns.length > max })
          on({ kind: 'state', working: state === 'working' })
          subs.add(on)
          return () => { subs.delete(on) }
        },
        onExit(cb) { exits.add(cb); return () => { exits.delete(cb) } },
        dispose() { disposed = true; pipe.kill() },
      }
      return { ok: true, session }
    },
  }
}

function fakeBase(): SessionBackend & { spawned: BackendSpawn[] } {
  const spawned: BackendSpawn[] = []
  return {
    spawned, id: 'tmux',
    unavailable: async () => undefined,
    spawn: async (r: BackendSpawn) => { spawned.push(r); return {} },
    list: async () => spawned.map(r => ({ id: r.id, createdMs: 1, attached: false, alive: true })),
    capture: async () => [], captureTerminal: async () => null,
    sendText: async () => true, sendTextRaw: async () => true, sendKey: async () => true, sendPaste: async () => true,
    kill: async () => true, attachCommand: (id: string) => ['tmux', 'attach', '-t', id], detachHint: async () => 'C-b d',
  } as unknown as SessionBackend & { spawned: BackendSpawn[] }
}

interface Rig {
  root: string
  log: string
  store: DurableStore
  started: StructuredSpawn[]
  server(o?: { flagOn?: boolean }): { b: ReturnType<typeof withStructured>; base: ReturnType<typeof fakeBase> }
}

const rigs: Rig[] = []
function rig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'f2b-'))
  const log = path.join(root, 'agent.log')
  writeFileSync(log, '')
  const store = durableStore(path.join(root, 'structured'))
  const started: StructuredSpawn[] = []
  const r: Rig = {
    root, log, store, started,
    server(o = {}) {
      const base = fakeBase()
      const reg = structuredRegistry([fakeDriver(log, started)])
      const provider: StructuredProvider = {
        structured: async () => reg, acp: async () => null, allowed: async () => [],
        flagOn: () => o.flagOn ?? true,
        durable: store,
        conversationOf: async () => 'conv-fake-1',
        async resumeSpawn(req, conv) { return { id: req.id, cwd: req.cwd, argv: ['gemini', '--resume', conv] } },
      }
      return { b: withStructured(base, provider), base }
    },
  }
  rigs.push(r)
  return r
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    for (const id of [...r.store.alive(), ...r.store.dead()]) await r.store.terminate(id, 4000)
    rmSync(r.root, { recursive: true, force: true })
  }
})

const webSpawn = (cwd: string, prompt?: string): BackendSpawn => ({
  id: 'm-1', cwd, argv: ['/usr/bin/gemini'],
  structured: structuredIntentOf({ harness: 'gemini', origin: 'web', ...(prompt ? { prompt } : {}) }, { conversationId: 'offered' }),
})

/** Follow the session's chat; collect every delta. */
function follow(b: ReturnType<typeof withStructured>, id = 'm-1') {
  const got: HarnessChatDelta[] = []
  const ch = b.chatOf!(id)!
  const off = ch.chat.follow({ harness: 'gemini', conversationId: ch.conversationId, sourceRef: 'x' }, 50, d => got.push(d))
  const appended = () => got.flatMap(d => (d.kind === 'append' ? d.turns : []))
  const window = () => (got[0]?.kind === 'window' ? got[0].turns : [])
  return { got, off, appended, window }
}

const prompts = (r: Rig) => readFileSync(r.log, 'utf8').split('\n').filter(Boolean)

describe('structured-replay (pure)', () => {
  test('writeCheck: recorded bytes are replayed, more are live, different is a divergence', () => {
    const c = writeCheck([{ t: 1, w: 'a\n' }, { t: 2, w: 'b\n' }])
    expect(c.take('a\n')).toBe('replayed')
    expect(c.complete()).toBe(false)
    expect(c.take('b\n')).toBe('replayed')
    expect(c.complete()).toBe(true)
    expect(c.take('c\n')).toBe('live')
    const d = writeCheck([{ t: 1, w: 'a\n' }])
    expect(d.take('x\n')).toBe('diverged')
    expect(d.take('a\n')).toBe('diverged')
  })
  test('callsAt keeps the order the calls were made in; parseJsonl drops a torn line', () => {
    const calls = [{ at: 2, t: 1, op: 'prompt' as const, text: 'a' }, { at: 3, t: 2, op: 'cancel' as const }, { at: 2, t: 3, op: 'prompt' as const, text: 'b' }]
    expect(callsAt(calls, 2).map(c => (c.op === 'prompt' ? c.text : c.op))).toEqual(['a', 'b'])
    expect(parseJsonl('{"t":1,"l":"x"}\n{"t":2,"l"', isOutRecord)).toEqual([{ t: 1, l: 'x' }])
  })
})

describe('a structured session survives a server restart', () => {
  test('restart while IDLE: the row stays live, the chat continues, nothing is lost or repeated', async () => {
    const r = rig()
    const A = r.server()
    await A.b.spawn(webSpawn(r.root, 'one'))
    expect(A.base.spawned).toHaveLength(0) // structured, not tmux
    expect(r.store.isAlive('m-1')).toBe(true)
    const a = follow(A.b)
    const seen = () => [...a.window(), ...a.appended()]
    await until(() => seen().length >= 2, 5000, 'first turn')
    expect(seen().map(t => t.text)).toEqual(['one', 'echo:one'])

    // The server goes away: its connection drops, the child keeps running under the relay.
    ;(r.started[0]!.transport as DurableTransport).detach()
    await sleep(100)

    const B = r.server()
    // Before the re-attach, any process lists the row as running (never `lost`).
    expect((await B.b.list()).find(s => s.id === 'm-1')?.alive).toBe(true)
    await B.b.reattach()
    expect(B.base.spawned).toHaveLength(0) // no fallback
    expect(B.b.structuredSessions().map(s => s.id)).toEqual(['m-1'])
    const b = follow(B.b)
    expect(b.window().map(t => t.text)).toEqual(['one', 'echo:one'])
    // The rebuilt turns keep their ORIGINAL timestamps (the pipe's clock), not the re-attach's.
    // (within the relay's own stamping of the line — milliseconds — never the 100+ ms later re-attach).
    const ms = (t: EngineChatTurn) => Date.parse(t.at ?? '')
    b.window().forEach((t, i) => expect(Math.abs(ms(t) - ms(seen()[i]!))).toBeLessThan(50))
    expect(await B.b.sendText('m-1', 'two')).toBe(true)
    await until(() => b.appended().length >= 2, 5000, 'second turn')
    expect(b.appended().map(t => t.text)).toEqual(['two', 'echo:two'])
    expect(prompts(r)).toEqual(['one', 'two']) // each prompt reached the agent exactly once
  }, 20000)

  test('restart MID-TURN: the reply streamed while the server was down arrives once, whole', async () => {
    const r = rig()
    const A = r.server()
    await A.b.spawn(webSpawn(r.root))
    const a = follow(A.b)
    expect(await A.b.sendText('m-1', 'slow-1')).toBe(true)
    await until(() => a.got.some(d => d.kind === 'live'), 5000, 'first chunk')
    ;(r.started[0]!.transport as DurableTransport).detach()
    await sleep(1100) // the agent finishes its turn while nobody is listening

    const B = r.server()
    await B.b.reattach()
    const b = follow(B.b)
    expect(b.window().map(t => t.text)).toEqual(['slow-1', 'c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 '])
    expect(B.b.activityOf!('m-1')).toBe('waiting')
    expect(await B.b.sendText('m-1', 'after')).toBe(true)
    await until(() => b.appended().length >= 2, 5000, 'next turn')
    expect(b.appended().map(t => t.text)).toEqual(['after', 'echo:after'])
    expect(prompts(r)).toEqual(['slow-1', 'after'])
  }, 20000)

  test('re-attach WHILE the turn is still streaming: the rest arrives live, the turn is appended once', async () => {
    const r = rig()
    const A = r.server()
    await A.b.spawn(webSpawn(r.root))
    const a = follow(A.b)
    A.b.sendText('m-1', 'slow-2')
    await until(() => a.got.some(d => d.kind === 'live'), 5000, 'first chunk')
    ;(r.started[0]!.transport as DurableTransport).detach()

    const B = r.server()
    await B.b.reattach()
    const b = follow(B.b)
    expect(b.window().map(t => t.text)).toEqual(['slow-2']) // the turn is in flight
    expect(B.b.activityOf!('m-1')).toBe('working')
    await until(() => b.appended().length >= 1, 5000, 'the turn to end')
    expect(b.appended().map(t => t.text)).toEqual(['c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 '])
    await sleep(200)
    expect(b.appended()).toHaveLength(1)
    expect(prompts(r)).toEqual(['slow-2'])
  }, 20000)

  test('the relay OUTLIVES the process that started it (SIGKILL, no cleanup), and is taken back', async () => {
    const r = rig()
    const creator = path.join(import.meta.dir, 'fixtures', 'structured-creator.ts')
    const p = Bun.spawn([process.execPath, 'run', creator, r.store.root, AGENT, r.log, r.root], { stdout: 'ignore', stderr: 'ignore' })
    const code = await p.exited
    expect(p.signalCode).toBe('SIGKILL')
    expect(code).not.toBe(0)
    expect(r.store.isAlive('m-1')).toBe(true)
    const B = r.server()
    await B.b.reattach()
    expect(B.b.structuredSessions().map(s => s.id)).toEqual(['m-1'])
    // The re-created driver's first write (init) goes past the empty record: it is live, and answered.
    await until(() => B.b.activityOf!('m-1') === 'waiting', 5000, 'the session to open')
    expect(await B.b.sendText('m-1', 'hello')).toBe(true)
    const b = follow(B.b)
    await until(() => [...b.window(), ...b.appended()].length >= 2, 5000, 'the turn')
    expect(prompts(r)).toEqual(['hello'])
  }, 20000)

  test('two restarts in a row: the record accumulates and still replays exactly', async () => {
    const r = rig()
    const A = r.server()
    await A.b.spawn(webSpawn(r.root, 'one'))
    await until(() => prompts(r).length === 1)
    await sleep(200)
    ;(r.started[0]!.transport as DurableTransport).detach()
    const B = r.server()
    await B.b.reattach()
    expect(await B.b.sendText('m-1', 'two')).toBe(true)
    await until(() => prompts(r).length === 2)
    await sleep(200)
    ;(r.started[1]!.transport as DurableTransport).detach()
    const C = r.server()
    await C.b.reattach()
    expect(C.base.spawned).toHaveLength(0)
    expect(follow(C.b).window().map(t => t.text)).toEqual(['one', 'echo:one', 'two', 'echo:two'])
    expect(prompts(r)).toEqual(['one', 'two'])
  }, 20000)

  test('a replay that does not reproduce the original falls back to the conversation-id resume', async () => {
    const r = rig()
    const A = r.server()
    await A.b.spawn(webSpawn(r.root, 'one'))
    await until(() => prompts(r).length === 1)
    await sleep(200)
    ;(r.started[0]!.transport as DurableTransport).detach()
    // Tamper with what the relay says it delivered.
    const inPath = path.join(r.store.dirOf('m-1'), 'in.jsonl')
    writeFileSync(inPath, readFileSync(inPath, 'utf8').replace('"one', '"ONE'))
    const B = r.server()
    await B.b.reattach()
    expect(B.b.structuredSessions()).toHaveLength(0)
    expect(B.base.spawned.map(s => s.argv)).toEqual([['gemini', '--resume', 'conv-fake-1']])
    expect(B.base.spawned[0]!.id).toBe('m-1')
    expect(r.store.isAlive('m-1')).toBe(false) // the child was ended before the TUI resumed it
    expect(existsSync(r.store.dirOf('m-1'))).toBe(false)
  }, 20000)
})

describe('open in terminal, kill, and the flag', () => {
  test('toTerminal ends the child, then resumes the SAME conversation as a TUI under the same id', async () => {
    const r = rig()
    const A = r.server()
    await A.b.spawn(webSpawn(r.root, 'one'))
    await until(() => prompts(r).length === 1)
    expect(await A.b.toTerminal('m-1')).toEqual({ ok: true })
    expect(r.store.isAlive('m-1')).toBe(false)
    expect(A.base.spawned).toEqual([{ id: 'm-1', cwd: r.root, argv: ['gemini', '--resume', 'conv-fake-1'] }])
    expect(A.b.structuredSessions()).toHaveLength(0)
    expect(A.b.attachCommand('m-1')).toEqual(['tmux', 'attach', '-t', 'm-1'])
    await sleep(200)
    expect(A.base.spawned).toHaveLength(1) // the ended child caused no fallback of its own
    expect(await A.b.toTerminal('m-1')).toEqual({ ok: false, why: 'not-structured' })
  }, 20000)

  test('toTerminal from ANOTHER process (one that does not drive the session) — the owner does not fall back', async () => {
    const r = rig()
    const owner = r.server()
    await owner.b.spawn(webSpawn(r.root, 'one'))
    await until(() => prompts(r).length === 1)
    const cli = r.server() // a one-shot `agentop session attach`
    expect(await cli.b.toTerminal('m-1')).toEqual({ ok: true })
    expect(cli.base.spawned.map(s => s.argv)).toEqual([['gemini', '--resume', 'conv-fake-1']])
    await sleep(300)
    expect(owner.base.spawned).toHaveLength(0)
    expect(owner.b.structuredSessions()).toHaveLength(0)
  }, 20000)

  test('kill ends the relay and its child and leaves nothing on disk — no fallback', async () => {
    const r = rig()
    const A = r.server()
    await A.b.spawn(webSpawn(r.root, 'one'))
    await until(() => prompts(r).length === 1)
    expect(await A.b.kill('m-1')).toBe(true)
    expect(r.store.isAlive('m-1')).toBe(false)
    expect(existsSync(r.store.dirOf('m-1'))).toBe(false)
    await sleep(200)
    expect(A.base.spawned).toHaveLength(0)
  }, 20000)

  test('flag OFF: the web spawn is tmux, byte for byte, and no relay is started', async () => {
    const r = rig()
    const A = r.server({ flagOn: false })
    const req = webSpawn(r.root, 'one')
    await A.b.spawn(req)
    expect(A.base.spawned).toEqual([req])
    expect(r.started).toHaveLength(0)
    expect(r.store.alive()).toEqual([])
    await A.b.reattach() // nothing to take back
    expect(A.b.structuredSessions()).toHaveLength(0)
  }, 20000)
})
