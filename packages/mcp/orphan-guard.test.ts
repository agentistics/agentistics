/**
 * orphan-guard.test.ts — an `agentop mcp` whose client died MUST exit. Six orphans spun at ~140 % CPU each
 * (load average 19) because nothing ended the process once the assistant that launched it was gone.
 * Unit: every way a client disappears. Integration: a REAL child, parent killed, exit within 2 s, idle CPU.
 */
import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installOrphanGuard } from './orphan-guard'

function rig(initialPpid = 100) {
  const stdin = new EventEmitter(); const stdout = new EventEmitter(); const proc = new EventEmitter()
  let ppid = initialPpid
  const exits: number[] = []
  let tick: (() => void) | null = null
  let cleared = false
  const dispose = installOrphanGuard({
    stdin, stdout, proc, getPpid: () => ppid, exit: c => { exits.push(c) },
    setInterval: (f: () => void) => { tick = f; return 1 }, clearInterval: () => { cleared = true },
  })
  return { stdin, stdout, proc, setPpid: (p: number) => { ppid = p }, tick: () => tick?.(), exits, dispose, cleared: () => cleared }
}

describe('every way the client disappears ends the process', () => {
  for (const ev of ['end', 'close', 'error']) {
    test(`stdin ${ev}`, () => { const r = rig(); r.stdin.emit(ev, ev === 'error' ? new Error('EIO') : undefined); expect(r.exits).toEqual([0]) })
  }
  test('stdout error (EPIPE: nobody reads our answers any more)', () => { const r = rig(); r.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); expect(r.exits).toEqual([0]) })
  test('SIGHUP and SIGPIPE', () => { for (const s of ['SIGHUP', 'SIGPIPE']) { const r = rig(); r.proc.emit(s); expect(r.exits).toEqual([0]) } })
  test('parent death: the watchdog sees ppid change (reparented to init), and only then', () => {
    const r = rig(4242)
    r.tick(); expect(r.exits).toEqual([])
    r.setPpid(1); r.tick(); expect(r.exits).toEqual([0])
  })
  test('exits ONCE, however many things fire; dispose stops the watchdog', () => {
    const r = rig(); r.stdin.emit('end'); r.stdin.emit('close'); r.proc.emit('SIGHUP'); expect(r.exits).toEqual([0])
    r.dispose(); expect(r.cleared()).toBe(true)
  })
})

const CLI = join(import.meta.dir, '../server/bin/cli.ts')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const cpuTicks = (pid: number): number => { try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' '); return Number(f[11]) + Number(f[12]) } catch { return 0 } }
const waitDead = async (pid: number, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (!alive(pid)) return true; await Bun.sleep(50) } return !alive(pid) }
const linux = process.platform === 'linux'

describe.skipIf(!linux)('a real `agentop mcp` child (throwaway process, temp data dir)', () => {
  const env = { ...process.env, AGENTISTICS_DIR: `/tmp/mcp-orphan-${process.pid}` }

  test('stdin EOF: the child exits within 2 s', async () => {
    const child = spawn('bun', [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    await Bun.sleep(1500)
    expect(alive(child.pid!)).toBe(true)
    child.stdin!.end()
    expect(await waitDead(child.pid!, 2000)).toBe(true)
  })

  test('parent killed while something ELSE still holds stdin open: exits within 2 s and the CPU stays idle', async () => {
    // parent (bash) -> `sleep 600 | bun cli mcp`: the pipe's writer is `sleep`, so stdin never reaches EOF.
    const parent = spawn('bash', ['-c', `sleep 600 | exec bun ${CLI} mcp`], { env, stdio: 'ignore', detached: true })
    await Bun.sleep(2000)
    const kids = spawnSync('pgrep', ['-f', `${CLI} mcp`], { encoding: 'utf8' }).stdout.trim().split('\n').map(Number).filter(n => n && n !== process.pid)
    expect(kids.length).toBeGreaterThan(0)
    const pid = kids[0]!
    const before = cpuTicks(pid)
    process.kill(parent.pid!, 'SIGKILL')           // the assistant is gone
    const t0 = Date.now()
    const dead = await waitDead(pid, 2500)
    const took = Date.now() - t0
    spawnSync('pkill', ['-f', 'sleep 600'])
    expect(dead).toBe(true)
    expect(took).toBeLessThan(2000)
    // idle meanwhile: a spinning process burns ~100 ticks/s; allow startup noise only
    expect(cpuTicks(pid) - before).toBeLessThan(60)
  }, 15000)
})
