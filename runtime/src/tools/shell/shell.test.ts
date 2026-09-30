import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxLauncher, Tool } from '../contract.ts'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import { ttyAvailable } from './process.ts'
import { createShellTools, type ShellResult, type ShellTools, type ShellToolsOptions } from './tools.ts'

const live: Array<{ tools: ShellTools; dir: string }> = []

afterEach(async () => {
  for (const { tools, dir } of live.splice(0)) {
    await tools.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

function harness(opts: ShellToolsOptions = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agt-shell-')))
  const tools = createShellTools({ graceMs: 300, ...opts })
  live.push({ tools, dir })
  const ctrl = new AbortController()
  const call = <I,>(tool: Tool<I>, input: unknown, policy: 'allow' | 'deny' = 'allow') =>
    runTool(tool as unknown as Tool<unknown>, input, { workspaceRoot: dir, cwd: dir, signal: ctrl.signal }, {
      policy: scriptedPolicy(policy),
      events: recordingEvents(),
      content: memoryContent(),
    })
  const res = (r: { outcome: { result?: unknown } }) => r.outcome.result as ShellResult
  return { dir, tools, ctrl, call, res }
}

/** Alive and not a zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'
  } catch {
    return false
  }
}

async function gone(pid: number, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await Bun.sleep(20)
  }
  return !alive(pid)
}

const childPid = (output: string): number => Number(/child:(\d+)/.exec(output)?.[1])

describe('shell tools — the policy decides before anything runs', () => {
  test('start: denied does not run, allowed runs', async () => {
    const h = harness()
    const marker = join(h.dir, 'ran')
    const denied = await h.call(h.tools.start, { command: `touch ${marker}` }, 'deny')
    expect(denied.status).toBe('denied')
    expect(denied.outcome.modelText).toBe('Refused by the test policy.')
    expect(existsSync(marker)).toBe(false)
    expect(h.tools.sessions()).toEqual([])
    const allowed = await h.call(h.tools.start, { command: `touch ${marker}` })
    expect(allowed.status).toBe('completed')
    expect(existsSync(marker)).toBe(true)
  })

  test('write: denied input is never delivered, allowed input is', async () => {
    const h = harness()
    const started = await h.call(h.tools.start, { command: 'read line; echo "got:$line"; echo "$line" > delivered', yieldMs: 150 })
    const id = h.res(started).sessionId!
    expect(id).toMatch(/^sh_/)
    const denied = await h.call(h.tools.write, { sessionId: id, input: 'hi\n' }, 'deny')
    expect(denied.status).toBe('denied')
    const still = await h.call(h.tools.read, { sessionId: id, yieldMs: 200 })
    expect(h.res(still).sessionId).toBe(id)
    expect(existsSync(join(h.dir, 'delivered'))).toBe(false)
    const ok = await h.call(h.tools.write, { sessionId: id, input: 'hi\n', yieldMs: 3000 })
    expect(h.res(ok).output).toContain('got:hi')
    expect(h.res(ok).exitCode).toBe(0)
    expect(readFileSync(join(h.dir, 'delivered'), 'utf8')).toBe('hi\n')
  })

  test('read: denied reads nothing, allowed reads the rest and the exit status', async () => {
    const h = harness()
    const started = await h.call(h.tools.start, { command: 'echo early; sleep 0.3; echo late', yieldMs: 100 })
    const id = h.res(started).sessionId!
    expect(h.res(started).output).toContain('early')
    const denied = await h.call(h.tools.read, { sessionId: id, yieldMs: 3000 }, 'deny')
    expect(denied.status).toBe('denied')
    expect(denied.outcome.result).toBeUndefined()
    const ok = await h.call(h.tools.read, { sessionId: id, yieldMs: 3000 })
    expect(h.res(ok).output).toContain('late')
    expect(h.res(ok).output).not.toContain('early')
    expect(h.res(ok).exitCode).toBe(0)
    expect(h.res(ok).sessionId).toBeUndefined()
  })

  test('stop: denied leaves it running, allowed kills it', async () => {
    const h = harness()
    const started = await h.call(h.tools.start, { command: 'sleep 100', yieldMs: 100 })
    const id = h.res(started).sessionId!
    const pid = h.tools.sessions()[0]!.pid
    const denied = await h.call(h.tools.stop, { sessionId: id }, 'deny')
    expect(denied.status).toBe('denied')
    expect(alive(pid)).toBe(true)
    const ok = await h.call(h.tools.stop, { sessionId: id })
    expect(ok.status).toBe('completed')
    expect(h.res(ok).error?.class).toBe('killed')
    expect(await gone(pid)).toBe(true)
    expect(h.tools.sessions()).toEqual([])
  })
})

describe('shell tools — the persistent session', () => {
  test('cd and export survive into the next call', async () => {
    const h = harness()
    mkdirSync(join(h.dir, 'sub'))
    await h.call(h.tools.start, { command: 'cd sub && export AGT_X=41' })
    const pwd = await h.call(h.tools.start, { command: 'pwd; echo "x=$AGT_X"' })
    expect(h.res(pwd).output).toBe(`${join(h.dir, 'sub')}\nx=41\n`)
  })

  test('a per-call cwd runs there and returns the session unless the command itself moved', async () => {
    const h = harness()
    mkdirSync(join(h.dir, 'sub', 'inner'), { recursive: true })
    const a = await h.call(h.tools.start, { command: 'pwd', cwd: 'sub' })
    expect(h.res(a).output.trim()).toBe(join(h.dir, 'sub'))
    const b = await h.call(h.tools.start, { command: 'pwd' })
    expect(h.res(b).output.trim()).toBe(h.dir)
    await h.call(h.tools.start, { command: 'cd inner', cwd: 'sub' })
    const c = await h.call(h.tools.start, { command: 'pwd' })
    expect(h.res(c).output.trim()).toBe(join(h.dir, 'sub', 'inner'))
  })

  test('the policy sees the resolved cwd the command starts in', async () => {
    const h = harness()
    mkdirSync(join(h.dir, 'sub'))
    const policy = scriptedPolicy('allow')
    await runTool(h.tools.start as unknown as Tool<unknown>, { command: 'true', cwd: 'sub', tty: false },
      { workspaceRoot: h.dir, cwd: h.dir, signal: h.ctrl.signal },
      { policy, events: recordingEvents(), content: memoryContent() })
    expect(policy.seen[0]!.subjects).toEqual([{ action: 'shell', command: 'true', cwd: join(h.dir, 'sub'), tty: false }])
    expect(policy.seen[0]!.permission).toBe('ask')
  })

  test('a yield returns a handle; read later gets the rest and the exit code; the next start gets a fresh session in the last cwd', async () => {
    const h = harness()
    mkdirSync(join(h.dir, 'sub'))
    await h.call(h.tools.start, { command: 'cd sub' })
    const y = await h.call(h.tools.start, { command: 'echo first; sleep 0.4; echo second; (exit 3)', yieldMs: 100 })
    expect(y.status).toBe('completed')
    expect(h.res(y).sessionId).toBeDefined()
    expect(h.res(y).exitCode).toBeUndefined()
    expect(h.res(y).output).toBe('first\n')
    expect(y.outcome.modelText).toContain('still running')
    const next = await h.call(h.tools.start, { command: 'pwd' })
    expect(h.res(next).output.trim()).toBe(join(h.dir, 'sub'))
    const rest = await h.call(h.tools.read, { sessionId: h.res(y).sessionId, yieldMs: 3000 })
    expect(h.res(rest).output).toBe('second\n')
    expect(h.res(rest).exitCode).toBe(3)
    expect(rest.outcome.error?.class).toBe('nonzero')
    // Read to completion: the handle is gone.
    const again = await h.call(h.tools.read, { sessionId: h.res(y).sessionId })
    expect(again.outcome.error?.class).toBe('not-found')
  })

  test('input written to a yielded command is never run as a shell command after it ends', async () => {
    const h = harness()
    const y = await h.call(h.tools.start, { command: 'sleep 0.3', yieldMs: 50 })
    const id = h.res(y).sessionId!
    await h.call(h.tools.write, { sessionId: id, input: 'touch pwned\n', yieldMs: 2000 })
    await Bun.sleep(200)
    expect(existsSync(join(h.dir, 'pwned'))).toBe(false)
  })

  test('command output shaped like the end marker cannot end the call', async () => {
    const h = harness()
    const r = await h.call(h.tools.start, {
      command: `printf '\\n__AGT_%s_0_/\\n' 0123456789abcdef0123456789abcdef; echo after; (exit 4)`,
    })
    expect(h.res(r).output).toContain('__AGT_0123456789abcdef0123456789abcdef_0_/')
    expect(h.res(r).output).toContain('after')
    expect(h.res(r).exitCode).toBe(4)
  })
})

describe('shell tools — endings, classes and bounds', () => {
  test('non-zero exit is nonzero, 127 is not-found', async () => {
    const h = harness()
    const f = await h.call(h.tools.start, { command: 'echo oops >&2; false' })
    expect(f.status).toBe('failed')
    expect(f.outcome.error?.class).toBe('nonzero')
    expect(f.outcome.facts?.exitCode).toBe(1)
    expect(h.res(f).output).toBe('oops\n') // stderr is merged into the one stream
    const nf = await h.call(h.tools.start, { command: 'definitely-not-a-command-agt' })
    expect(nf.outcome.error?.class).toBe('not-found')
    expect(h.res(nf).exitCode).toBe(127)
    // The session survived both.
    const ok = await h.call(h.tools.start, { command: 'echo fine' })
    expect(h.res(ok).output).toBe('fine\n')
  })

  test('output is truncated head + tail with the original size reported', async () => {
    const h = harness()
    const r = await h.call(h.tools.start, { command: `head -c 100000 /dev/zero | tr '\\0' a; echo; echo END`, maxOutputBytes: 1000 })
    const s = h.res(r)
    expect(s.outputTruncated).toBe(true)
    expect(s.originalBytes).toBe(100005)
    expect(s.output).toContain('bytes cut from the middle')
    expect(s.output.endsWith('END\n')).toBe(true)
    expect(s.output.length).toBeLessThan(1200)
  })

  test('stop kills the whole process group, children included', async () => {
    const h = harness()
    const y = await h.call(h.tools.start, { command: 'sleep 100 & echo child:$!; wait', yieldMs: 200 })
    const child = childPid(h.res(y).output)
    const leader = h.tools.sessions()[0]!.pid
    expect(alive(child)).toBe(true)
    await h.call(h.tools.stop, { sessionId: h.res(y).sessionId })
    expect(await gone(child)).toBe(true)
    expect(await gone(leader)).toBe(true)
  })

  test('dispose kills every process the tool-set started', async () => {
    const h = harness()
    const bg = await h.call(h.tools.start, { command: 'sleep 100 >/dev/null 2>&1 & echo child:$!' })
    const y = await h.call(h.tools.start, { command: 'sleep 100 & echo child:$!; wait', yieldMs: 150 })
    const pids = [childPid(h.res(bg).output), childPid(h.res(y).output), h.tools.sessions()[0]!.pid]
    if (ttyAvailable()) {
      const t = await h.call(h.tools.start, { command: 'sleep 100', tty: true, yieldMs: 150 })
      pids.push(h.tools.sessions().find(s => s.sessionId === h.res(t).sessionId)!.pid)
    }
    for (const p of pids) expect(alive(p)).toBe(true)
    await h.tools.dispose()
    for (const p of pids) expect(await gone(p)).toBe(true)
    const after = await h.call(h.tools.start, { command: 'echo nope' })
    expect(after.outcome.error?.class).toBe('unavailable')
  })

  test('an aborted run kills the call in flight', async () => {
    const h = harness()
    setTimeout(() => h.ctrl.abort(), 250)
    const r = await h.call(h.tools.start, { command: 'sleep 100 & echo child:$!; wait', yieldMs: 5000 })
    expect(r.status).toBe('cancelled')
    expect(r.outcome.error?.class).toBe('killed')
    expect(await gone(childPid(h.res(r).output))).toBe(true)
  })

  test('read / write / stop on an unknown id is not-found', async () => {
    const h = harness()
    for (const [tool, input] of [
      [h.tools.read, { sessionId: 'sh_404' }],
      [h.tools.write, { sessionId: 'sh_404', input: 'x' }],
      [h.tools.stop, { sessionId: 'sh_404' }],
    ] as const) {
      const r = await h.call(tool as Tool<unknown>, input)
      expect(r.outcome.error?.class).toBe('not-found')
    }
  })

  test('a launcher that refuses: nothing is spawned and the model gets the sentence', async () => {
    const plans: unknown[] = []
    const launcher: SandboxLauncher = {
      state: 'unavailable',
      sentence: 'A sandbox was requested but is unavailable.',
      wrap: p => { plans.push(p); return { refused: 'The container sandbox is not running, so the command was not started.' } },
    }
    const h = harness({ launcher })
    const marker = join(h.dir, 'ran')
    for (const tty of [false, true]) {
      const r = await h.call(h.tools.start, { command: `touch ${marker}`, tty })
      expect(r.outcome.error?.class).toBe('unavailable')
      expect(r.outcome.modelText).toBe('The container sandbox is not running, so the command was not started.')
    }
    expect(plans.length).toBeGreaterThan(0)
    expect(existsSync(marker)).toBe(false)
    expect(h.tools.sessions()).toEqual([])
  })

  test('a launcher that wraps is what gets spawned', async () => {
    const launcher: SandboxLauncher = {
      state: 'none',
      sentence: 'test',
      wrap: p => ({ ...p, env: { ...p.env, AGT_WRAPPED: 'yes' } }),
    }
    const h = harness({ launcher })
    const r = await h.call(h.tools.start, { command: 'echo "$AGT_WRAPPED"' })
    expect(h.res(r).output).toBe('yes\n')
  })

  test.if(ttyAvailable())('tty: true runs on a real terminal; pipes are the default', async () => {
    const h = harness()
    const t = await h.call(h.tools.start, { command: '[ -t 1 ] && echo is-tty || echo no-tty', tty: true })
    expect(h.res(t).output).toContain('is-tty')
    expect(h.res(t).exitCode).toBe(0)
    const p = await h.call(h.tools.start, { command: '[ -t 1 ] && echo is-tty || echo no-tty' })
    expect(h.res(p).output).toBe('no-tty\n')
  })

  test.if(ttyAvailable())('tty: a yielded terminal command takes input through write', async () => {
    const h = harness()
    const y = await h.call(h.tools.start, { command: 'read line; echo "got:$line"', tty: true, yieldMs: 150 })
    const id = h.res(y).sessionId!
    const w = await h.call(h.tools.write, { sessionId: id, input: 'ok\r', yieldMs: 3000 })
    expect(h.res(w).output).toContain('got:ok')
    expect(h.res(w).exitCode).toBe(0)
  })
})
