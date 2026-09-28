/**
 * m1-e2e.test.ts — MILESTONE M1, offline (B4): a native session belongs to the RUNTIME, not to a
 * process. In real OS processes, with only the model scripted:
 *
 *   1. `agentop code "<prompt>"` starts a session; the model reads a file, then asks for a patch —
 *      the policy ASKS, the person (this test, on the child's stdin) approves, and the file changes;
 *   2. the model then starts a long shell command, the person approves it, and the process is
 *      KILLED (SIGKILL) while that command runs — no cleanup code gets to run;
 *   3. a SECOND process resumes the session BY ID: the lease of the dead process is free at once,
 *      the interrupted call is resolved to a terminal event (never left dangling), the run is ended
 *      `lost`, and the model's next request carries a tool_result saying what happened;
 *   4. a SECOND WATCHER on that session sees exactly the event stream the journal received.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'

const CHILD = join(import.meta.dir, 'm1-e2e.child.ts')

let root: string
let ws: string
let state: string

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agt-m1-')))
  ws = join(root, 'repo')
  state = join(root, 'state')
  await mkdir(ws); await mkdir(state)
  await writeFile(join(ws, 'hello.ts'), "export const greeting = 'hello'\n")
  const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, env: gitTestEnv() })
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init')
})

afterAll(async () => { await rm(root, { recursive: true, force: true }) })

interface Child { proc: ReturnType<typeof Bun.spawn>; out: () => string; send: (line: string) => void; end: () => void }

function start(phase: '1' | '2', args: string[]): Child {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(gitTestEnv())) if (v !== undefined) env[k] = v
  env.AGT_M1_DIR = state
  env.AGT_M1_PHASE = phase
  env.AGENTISTICS_DIR = join(root, 'agentistics-home')
  env.AGENTISTICS_PROVIDER = '1' // the BETA flag, exactly as the owner turns it on
  const proc = Bun.spawn([process.execPath, CHILD, ...args], { cwd: ws, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  let buf = ''
  const dec = new TextDecoder()
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader()
    for (;;) { const { done, value } = await r.read(); if (done) return; buf += dec.decode(value, { stream: true }) }
  }
  void drain(proc.stdout as ReadableStream<Uint8Array>)
  void drain(proc.stderr as ReadableStream<Uint8Array>)
  const stdin = proc.stdin as import('bun').FileSink
  return { proc, out: () => buf, send: (l) => { stdin.write(`${l}\n`); stdin.flush() }, end: () => { stdin.end() } }
}

async function until(what: string, cond: () => boolean, out: () => string, ms = 20_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; the process said:\n${out()}`)
    await Bun.sleep(25)
  }
}

const count = (s: string, sub: string) => s.split(sub).length - 1
const journal = () => existsSync(join(state, 'journal.jsonl'))
  ? readFileSync(join(state, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; eventId: string; sessionId?: string; data: Record<string, unknown> })
  : []

describe('M1 — a native session outlives the process that drove it', () => {
  test('start → approved tool → SIGKILL mid-tool → resume by id in a new process → second watcher', async () => {
    // ── process 1 ──────────────────────────────────────────────────────────────────────────────
    const p1 = start('1', ['--model', 'claude-test', 'greet the world'])
    await until('the session id', () => /session (ses_[0-9a-f]+)/.test(p1.out()), p1.out)
    const sessionId = /session (ses_[0-9a-f]+)/.exec(p1.out())![1]!
    expect(p1.out()).toContain('no sandbox: tools run as you')

    await until('the patch ask', () => count(p1.out(), '1. Allow once') >= 1 && p1.out().endsWith('> '), p1.out)
    p1.send('1') // the person approves the patch
    await until('the shell ask', () => count(p1.out(), '1. Allow once') >= 2 && p1.out().endsWith('> '), p1.out)
    expect(readFileSync(join(ws, 'hello.ts'), 'utf8')).toBe("export const greeting = 'hello, world'\n")
    p1.send('1') // the person approves `cat hello.ts && sleep 120`
    await until('the shell command to be running', () =>
      journal().filter(e => e.type === 'tool.approved' && e.data.by === 'user').length >= 2, p1.out)
    await Bun.sleep(300)
    p1.proc.kill('SIGKILL')
    await p1.proc.exited
    const before = journal()
    expect(before.some(e => e.type === 'run.ended')).toBe(false) // nothing got to clean up

    // ── process 2 ──────────────────────────────────────────────────────────────────────────────
    const p2 = start('2', ['--resume', sessionId, 'continue'])
    await until('the resumed answer', () => p2.out().includes('resumed and done'), p2.out)
    p2.end()
    const code = await p2.proc.exited
    expect({ code, out: code === 0 ? '' : p2.out() }).toEqual({ code: 0, out: '' })

    const after = journal().slice(before.length)
    // The interrupted call is resolved to ONE terminal event, and the dead run is ended `lost`.
    const shellCall = before.filter(e => e.type === 'tool.approved').at(-1)!.data.toolExecutionId
    const terminal = journal().filter(e => (e.type === 'tool.failed' || e.type === 'tool.completed')
      && e.data.toolExecutionId === shellCall)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]!.data).toMatchObject({ status: 'cancelled', errorClass: 'killed' })
    expect(after.find(e => e.type === 'run.ended')?.data).toEqual({ status: 'lost' })

    // The model is told what happened, and never sees a tool_use without its tool_result.
    const req = JSON.parse(readFileSync(join(state, 'requests-2.jsonl'), 'utf8').trim().split('\n')[0]!) as {
      messages: { role: string; content: string | { type: string; id?: string; toolUseId?: string; content?: string }[] }[]
    }
    const parts = req.messages.flatMap(m => typeof m.content === 'string' ? [] : m.content)
    const uses = parts.filter(p => p.type === 'tool_use').map(p => p.id)
    const results = new Map(parts.filter(p => p.type === 'tool_result').map(p => [p.toolUseId, p.content]))
    for (const id of uses) expect(results.has(id)).toBe(true)
    expect(results.get('t3')).toContain('interrupted')

    // A second surface watching the resumed session saw the same event stream the journal got.
    const frames = readFileSync(join(state, 'watcher2.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { kind: string; event?: { eventId: string } })
    const seen = frames.filter(f => f.kind === 'event').map(f => f.event!.eventId)
    const journaled = after.filter(e => e.sessionId === sessionId).map(e => e.eventId)
    expect(seen).toEqual(journaled)
    expect(seen.length).toBeGreaterThan(3)
  }, 60_000)
})
