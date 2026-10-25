/**
 * structured-multichild.test.ts — AGY.MULTICHILD: a driver that ENDS its child and starts another on the
 * same durable transport (Antigravity has no interrupt: a cancel ends the child, the next prompt resumes
 * the conversation in a new one). Each `launch()` is a generation with its own relay and record; these
 * tests run the REAL relay (`structured-relay.ts`, detached) over the fake protocol peer, with a
 * deterministic fake driver shaped like the agy driver: kill on cancel, relaunch on the next prompt.
 *
 * "The server restarts" is: the transport drops its relay connections without touching any child, and
 * `replay()` re-attaches a fresh driver over the same directory. Processes are stopped by saved PID only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  EngineChatTurn, HarnessChatDelta, StructuredDeclaration, StructuredDriver, StructuredExit, StructuredSession, StructuredSpawn,
} from '@agentistics/engine-api'
import { durableStore, type DurableStore, type DurableTransport, type SavedSpawn } from './structured-durable'

const AGENT = path.join(import.meta.dir, 'fixtures', 'fake-structured-agent.ts')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20) }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const DECL: StructuredDeclaration = {
  assignId: { absent: 'fake' }, resume: { via: 'fake' }, model: { absent: 'fake' }, effort: { absent: 'fake' },
  mcp: { absent: 'fake' }, instructions: { channel: 'first-message', reason: 'fake' }, live: { via: 'chunks' },
  permissions: { absent: 'fake' }, questions: { absent: 'fake' }, cancel: { via: 'ending the child; the next prompt starts another' },
}

interface Variant {
  /** The argv of the n-th child (default: the same peer, `--resume` from the second one on). */
  argsOf?: (n: number) => string[]
  /** A cancel that does NOT end the child (to prove the replay checks the kills). */
  cancelWithoutKill?: boolean
}

/**
 * Like the agy driver over its pipe: one child at a time, request ids in order across children, a
 * cancel ends the child and the next prompt launches the next one. Turns are stamped by the pipe clock.
 */
function swappingDriver(log: string, v: Variant = {}): StructuredDriver {
  return {
    id: 'acp', status: 'ready', harnesses: ['antigravity'], note: 'fake', declares: () => DECL,
    async start(req) {
      const turns: EngineChatTurn[] = []
      const subs = new Set<(d: HarnessChatDelta) => void>()
      const exits = new Set<(e: StructuredExit) => void>()
      const emit = (d: HarnessChatDelta) => { for (const f of subs) f(d) }
      let pipe: ReturnType<NonNullable<StructuredSpawn['transport']>['launch']> | null = null
      let gen = 0
      let launches = 0
      let nextId = 1
      let pendingId: number | null = null
      let draft = ''
      let needsRestart = false
      let exited = false
      const now = () => pipe?.now?.() ?? Date.now()
      const at = () => new Date(now()).toISOString()
      const seal = (text: string) => { const a: EngineChatTurn = { role: 'assistant', text, at: at() }; turns.push(a); emit({ kind: 'append', turns: [a] }) }
      const send = (m: Record<string, unknown>) => { const id = nextId++; pipe?.write(`${JSON.stringify({ id, ...m })}\n`); return id }
      const launchChild = () => {
        const my = ++gen
        const n = launches++
        const args = v.argsOf?.(n) ?? ['run', AGENT, ...(n > 0 ? ['--resume'] : [])]
        const p = req.transport!.launch('bun', args, req.cwd, { AGENT_LOG: log })
        pipe = p
        void (async () => {
          let buf = ''
          for await (const c of p.source) {
            if (my !== gen) return
            buf += c
            let nl: number
            while ((nl = buf.indexOf('\n')) !== -1) {
              const m = JSON.parse(buf.slice(0, nl)) as { id?: number; result?: unknown; chunk?: string }
              buf = buf.slice(nl + 1)
              if (typeof m.chunk === 'string') draft += m.chunk
              else if (m.id === pendingId && m.result === 'end_turn') { pendingId = null; seal(draft); draft = '' }
            }
          }
        })()
        void p.exited.then(() => {
          if (my !== gen || exited) return
          exited = true
          for (const cb of exits) cb({ kind: 'failed', reason: 'the agent exited' })
        })
        send({ method: 'init' })
      }
      launchChild()
      const session: StructuredSession = {
        id: req.id, driver: 'acp', harness: req.harness,
        conversationId: () => 'conv-fake-1',
        activity: () => (exited ? 'exited' : pendingId !== null ? 'working' : 'waiting'),
        attention: () => null,
        screen: () => [],
        lastActivityMs: () => now(),
        prompt(text) {
          if (exited || pendingId !== null) return false
          if (needsRestart) { needsRestart = false; launchChild() }
          const u: EngineChatTurn = { role: 'user', text, at: at() }
          turns.push(u); emit({ kind: 'append', turns: [u] })
          pendingId = send({ method: 'prompt', text })
          return true
        },
        answer: () => false,
        cancel() {
          if (exited || pendingId === null || !pipe) return
          const p = pipe
          gen += 1
          pendingId = null
          needsRestart = true
          if (!v.cancelWithoutKill) p.kill()
          seal(`${draft}(stopped)`); draft = ''
        },
        follow(max, on) {
          on({ kind: 'window', turns: turns.slice(-max), older: turns.length > max })
          subs.add(on)
          return () => { subs.delete(on) }
        },
        onExit(cb) { exits.add(cb); return () => { exits.delete(cb) } },
        dispose() { exited = true; gen += 1; pipe?.kill() },
      }
      return { ok: true, session }
    },
  }
}

const windowOf = (s: StructuredSession): EngineChatTurn[] => { let w: EngineChatTurn[] = []; s.follow(200, d => { if (d.kind === 'window') w = d.turns })(); return w }
const texts = (s: StructuredSession) => windowOf(s).map(t => `${t.role}:${t.text}`)
// The live pipe stamps by the clock, the replay by the recorded arrival: they may differ by a millisecond.

/** What the host's `recordingSession` does: the call, then its record. */
const recorded = (s: StructuredSession, t: DurableTransport) => ({
  prompt(text: string) { const ok = s.prompt(text); if (ok) t.record({ op: 'prompt', text }); return ok },
  cancel() { s.cancel(); t.record({ op: 'cancel' }) },
})

const roots: string[] = []
const stores: Array<{ store: DurableStore; id: string }> = []
afterEach(async () => {
  for (const { store, id } of stores.splice(0)) {
    // Every child any generation recorded, by its saved pid, then every relay.
    for (const g of ['', 'g1', 'g2', 'g3']) {
      try { const p = JSON.parse(readFileSync(path.join(store.dirOf(id), g, 'relay.pid'), 'utf8')) as { child?: number }; if (p.child) process.kill(p.child, 'SIGKILL') } catch { /* none */ }
    }
    await store.terminate(id, 3000).catch(() => false)
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

let seq = 0
async function rig(v: Variant = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'structured-mc-'))
  roots.push(root)
  const store = durableStore(path.join(root, 'structured'))
  const id = `mc-${++seq}`
  stores.push({ store, id })
  const log = path.join(root, 'agent.log')
  const req: StructuredSpawn = { id, harness: 'antigravity', cwd: root }
  const saved: SavedSpawn = { v: 1, harness: 'antigravity', spawn: req, backend: { id, cwd: root } }
  const t = store.create(id, saved)
  const st = await swappingDriver(log, v).start({ ...req, transport: t })
  if (!st.ok) throw new Error(st.reason)
  const s = st.session
  const rec = recorded(s, t)
  const prompts = () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  const dir = (g = 0) => (g === 0 ? store.dirOf(id) : path.join(store.dirOf(id), `g${g}`))
  const childPid = (g = 0): number | null => { try { return (JSON.parse(readFileSync(path.join(dir(g), 'relay.pid'), 'utf8')) as { child?: number }).child ?? null } catch { return null } }
  const relayPid = (g = 0): number | null => { try { return (JSON.parse(readFileSync(path.join(dir(g), 'relay.pid'), 'utf8')) as { relay?: number }).relay ?? null } catch { return null } }
  const answered = (text: string) => until(() => texts(s).includes(`assistant:echo:${text}`), 5000, `echo:${text}`)
  /** A turn that streams, then a cancel: the first child is ended by the driver. */
  const cancelSlow = async () => {
    rec.prompt('slow turn')
    await until(() => prompts().includes('slow turn'), 5000, 'the slow prompt')
    rec.cancel()
  }
  const childGone = (g = 0) => until(() => existsSync(path.join(dir(g), 'exit.json')), 6000, `child ${g + 1} exit`)
  /** A fresh server re-attaching: the old transport drops its connections, a new driver replays. */
  const restart = async (variant: Variant = v) => {
    t.detach()
    const rt = store.replay(id)
    if (!rt) return { rt, outcome: { ok: false as const, why: 'no replay' }, session: null }
    const r = await swappingDriver(log, variant).start({ ...saved.spawn, transport: rt })
    if (!r.ok) throw new Error(r.reason)
    rt.bind(r.session)
    const outcome = await Promise.race([rt.done, sleep(10_000).then(() => ({ ok: false as const, why: 'timed out' }))])
    return { rt, outcome, session: r.session }
  }
  return { store, id, t, s, rec, prompts, dir, childPid, relayPid, answered, cancelSlow, childGone, restart }
}

describe('AGY.MULTICHILD — generations on the durable transport (real relay)', () => {
  test('1. live swap: the second child answers in the window once, and the first child\'s lines are not read again', async () => {
    const r = await rig()
    r.rec.prompt('a')
    await r.answered('a')
    await r.cancelSlow()
    await r.childGone(0)
    r.rec.prompt('b')
    await r.answered('b')
    await sleep(200)
    expect(texts(r.s).filter(x => x === 'assistant:echo:a')).toHaveLength(1)
    expect(texts(r.s).at(-1)).toBe('assistant:echo:b')
    expect(existsSync(path.join(r.dir(1), 'launch.json'))).toBe(true)
    expect(r.childPid(1)).not.toBe(r.childPid(0))
  }, 30_000)

  test('2+3. the session is ALIVE between children and on its second child; a booting server sees no end', async () => {
    const r = await rig()
    await r.cancelSlow()
    await r.childGone(0)
    // Between children: no process, a live session all the same.
    expect(r.store.isAlive(r.id)).toBe(true)
    expect(r.store.alive()).toContain(r.id)
    expect(r.store.dead()).not.toContain(r.id)
    expect(r.store.endedAt?.(r.id)).toBeNull()
    r.rec.prompt('b')
    await r.answered('b')
    expect(r.store.isAlive(r.id)).toBe(true)
    expect(r.store.dead()).not.toContain(r.id)
    expect(r.store.endedAt?.(r.id)).toBeNull()
    // The host ending it is an end again.
    r.store.markEnding(r.id, 'killed')
    await r.store.terminate(r.id)
    expect(r.store.isAlive(r.id)).toBe(false)
    expect(r.store.endedAt?.(r.id)).not.toBeNull()
  }, 30_000)

  test('4. a restart after the swap re-attaches faithfully and continues on the SAME second child', async () => {
    const r = await rig()
    r.rec.prompt('a')
    await r.answered('a')
    await r.cancelSlow()
    await r.childGone(0)
    r.rec.prompt('b')
    await r.answered('b')
    const before = texts(r.s)
    const second = r.childPid(1)
    const { outcome, session, rt } = await r.restart()
    expect(outcome).toEqual({ ok: true })
    expect(texts(session!)).toEqual(before)
    recorded(session!, rt!).prompt('c')
    await until(() => texts(session!).includes('assistant:echo:c'), 5000, 'echo:c')
    expect(r.childPid(1)).toBe(second)
    expect(pidAlive(second!)).toBe(true)
    expect(existsSync(path.join(r.dir(2), 'launch.json'))).toBe(false)
    expect(r.prompts().filter(p => p === 'c')).toHaveLength(1)
    expect(r.prompts().filter(p => p === 'b')).toHaveLength(1)
  }, 30_000)

  test('5. a restart BETWEEN children re-attaches, and the next prompt starts the next child live', async () => {
    const r = await rig()
    r.rec.prompt('a')
    await r.answered('a')
    await r.cancelSlow()
    await r.childGone(0)
    const before = texts(r.s)
    const { outcome, session, rt } = await r.restart()
    expect(outcome).toEqual({ ok: true })
    expect(texts(session!)).toEqual(before)
    recorded(session!, rt!).prompt('b')
    await until(() => texts(session!).includes('assistant:echo:b'), 6000, 'echo:b')
    expect(existsSync(path.join(r.dir(1), 'launch.json'))).toBe(true)
    expect(r.store.isAlive(r.id)).toBe(true)
    expect(r.prompts().filter(p => p === 'b')).toHaveLength(1)
  }, 30_000)

  test('6. a replay is checked per child: a different command for child 2, or a child the driver no longer ends, fails it', async () => {
    const a = await rig()
    await a.cancelSlow()
    await a.childGone(0)
    a.rec.prompt('b')
    await a.answered('b')
    const diff = await a.restart({ argsOf: n => ['run', AGENT, ...(n > 0 ? ['--other'] : [])] })
    expect(diff.outcome).toEqual({ ok: false, why: 'the re-created driver launched a different command for child 2' })
    diff.session?.dispose()

    const b = await rig()
    await b.cancelSlow()
    await b.childGone(0)
    b.rec.prompt('b')
    await b.answered('b')
    const noKill = await b.restart({ cancelWithoutKill: true })
    expect(noKill.outcome).toEqual({ ok: false, why: 'the re-created driver did not end child 1 unlike the original' })
    noKill.session?.dispose()
  }, 40_000)

  test('7. a last child that exits WITHOUT the driver ending it is the session\'s end, exactly as before', async () => {
    const r = await rig()
    await r.cancelSlow()
    await r.childGone(0)
    r.rec.prompt('b')
    await r.answered('b')
    process.kill(r.childPid(1)!, 'SIGKILL') // a crash: the saved pid of the second child
    await r.childGone(1)
    await until(() => !r.store.isAlive(r.id), 3000, 'not alive')
    expect(r.store.dead()).toContain(r.id)
    expect(r.store.endedAt?.(r.id)).not.toBeNull()
    expect(r.store.replay(r.id)).toBeNull()
  }, 30_000)

  test('8. a directory written before generations (root files only, calls without g) re-attaches as generation 0', async () => {
    const r = await rig()
    r.rec.prompt('a')
    await r.answered('a')
    const before = texts(r.s)
    const calls = path.join(r.store.dirOf(r.id), 'calls.jsonl')
    writeFileSync(calls, readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => { const { g: _g, ...rest } = JSON.parse(l) as Record<string, unknown>; return JSON.stringify(rest) }).join('\n') + '\n')
    expect(readFileSync(calls, 'utf8')).not.toContain('"g"')
    const { outcome, session, rt } = await r.restart()
    expect(outcome).toEqual({ ok: true })
    expect(texts(session!)).toEqual(before)
    recorded(session!, rt!).prompt('c')
    await until(() => texts(session!).includes('assistant:echo:c'), 5000, 'echo:c')
    expect(existsSync(r.dir(1))).toBe(false)
  }, 30_000)

  test('9. a prompt right after a cancel waits for the old child to exit, then reaches the new one; a launch without a kill throws', async () => {
    const r = await rig()
    await r.cancelSlow()
    r.rec.prompt('b') // same tick as the cancel: the first child is still running
    await r.answered('b')
    const exit = JSON.parse(readFileSync(path.join(r.dir(0), 'exit.json'), 'utf8')) as { at: number }
    // The second child said its first line only after the first one's exit was recorded (both stamped by
    // Date.now() in the relays; a file mtime would not do: it runs on the kernel's coarse clock).
    const firstOfSecond = JSON.parse(readFileSync(path.join(r.dir(1), 'out.jsonl'), 'utf8').split('\n')[0]!) as { t: number }
    expect(firstOfSecond.t).toBeGreaterThanOrEqual(exit.at)
    expect(r.prompts().filter(p => p === 'b')).toHaveLength(1)

    const root = mkdtempSync(path.join(tmpdir(), 'structured-mc-'))
    roots.push(root)
    const store = durableStore(path.join(root, 'structured'))
    stores.push({ store, id: 'twice' })
    const t = store.create('twice', { v: 1, harness: 'antigravity', spawn: { id: 'twice', harness: 'antigravity', cwd: root }, backend: { id: 'twice', cwd: root } })
    t.launch('bun', ['run', AGENT], root)
    expect(() => t.launch('bun', ['run', AGENT], root)).toThrow('kill() it first')
  }, 30_000)

  test('10. terminate leaves no relay and no child behind — between children and on the second child', async () => {
    const between = await rig()
    await between.cancelSlow()
    await between.childGone(0)
    const firstRelay = between.relayPid(0)!
    expect(await between.store.terminate(between.id)).toBe(true)
    expect(pidAlive(firstRelay)).toBe(false)
    expect(pidAlive(between.childPid(0)!)).toBe(false)

    const second = await rig()
    await second.cancelSlow()
    await second.childGone(0)
    second.rec.prompt('b')
    await second.answered('b')
    const relays = [second.relayPid(0)!, second.relayPid(1)!]
    const children = [second.childPid(0)!, second.childPid(1)!]
    second.store.markEnding(second.id, 'killed')
    expect(await second.store.terminate(second.id)).toBe(true)
    await until(() => [...relays, ...children].every(p => !pidAlive(p)), 5000, 'every process gone')
  }, 40_000)

  test('11. a generation\'s socket stays inside the unix socket path limit', () => {
    // sun_path is 108 bytes on Linux (104 on macOS); `g<k>/` adds at most a few bytes to the session's own.
    const store = durableStore('/home/a-long-user-name/.agentistics/structured')
    const first = path.join(store.dirOf('0a0ce5a137'), 'relay.sock')
    const later = path.join(store.dirOf('0a0ce5a137'), 'g99', 'relay.sock')
    expect(Buffer.byteLength(later) - Buffer.byteLength(first)).toBe(4)
    expect(Buffer.byteLength(later)).toBeLessThan(104)
  })
})
