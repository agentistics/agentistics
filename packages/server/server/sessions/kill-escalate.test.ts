import { describe, expect, it } from 'bun:test'
import { collectOwnPids, escalateKill, isZombie, procIO, startTimeOf, type EscalateIO, type PidRef } from './kill-escalate'

/** A fake clock + a fake process table: nothing real is signalled and nothing is waited for. */
function fake(opts: { dies: Record<number, 'on-hangup' | 'on-kill' | 'never'>; reused?: number[] }) {
  let t = 0
  const dead = new Set<number>()
  const signals: [number, string][] = []
  for (const [pid, how] of Object.entries(opts.dies)) if (how === 'on-hangup') dead.add(Number(pid))
  const io: EscalateIO = {
    alive: r => !dead.has(r.pid) && !opts.reused?.includes(r.pid),
    signal: (pid, sig) => { signals.push([pid, sig]); if (opts.dies[pid] === 'on-kill') dead.add(pid); return true },
    sleep: async ms => { t += ms },
    now: () => t,
  }
  return { io, signals, elapsed: () => t }
}
const refs = (...pids: number[]): PidRef[] => pids.map(pid => ({ pid, start: '1' }))

describe('escalateKill', () => {
  it('sends nothing when the hang-up did its job — and does not wait out the grace', async () => {
    const f = fake({ dies: { 10: 'on-hangup', 11: 'on-hangup' } })
    expect(await escalateKill(refs(10, 11), f.io)).toEqual({ killed: [], stuck: [] })
    expect(f.signals).toEqual([])
    expect(f.elapsed()).toBe(0)
  })

  it('SIGKILLs only what outlasted the grace (gemini ignores SIGHUP), after the grace', async () => {
    const f = fake({ dies: { 10: 'on-hangup', 11: 'on-kill' } })
    const out = await escalateKill(refs(10, 11), f.io, { graceMs: 1000, pollMs: 100 })
    expect(out).toEqual({ killed: [11], stuck: [] })
    expect(f.signals).toEqual([[11, 'SIGKILL']])
    expect(f.elapsed()).toBeGreaterThanOrEqual(1000)
  })

  it('reports a process that survives SIGKILL as stuck, so the caller does not call the session gone', async () => {
    const f = fake({ dies: { 12: 'never' } })
    expect(await escalateKill(refs(12), f.io, { graceMs: 200, killWaitMs: 200, pollMs: 50 })).toEqual({ killed: [], stuck: [12] })
  })

  it('never signals a pid that is no longer the same process (reused during the grace)', async () => {
    const f = fake({ dies: { 13: 'never' }, reused: [13] })
    expect(await escalateKill(refs(13), f.io, { graceMs: 200, pollMs: 50 })).toEqual({ killed: [], stuck: [] })
    expect(f.signals).toEqual([])
  })

  it('an empty list is a no-op', async () => {
    const f = fake({ dies: {} })
    expect(await escalateKill([], f.io)).toEqual({ killed: [], stuck: [] })
  })
})

describe('/proc parsing', () => {
  it('reads the start time past a command name that holds spaces and parentheses', () => {
    const stat = '4242 (my (odd) cmd) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 18446744073709551615'
    expect(startTimeOf(stat)).toBe('987654')
    expect(startTimeOf('garbage')).toBeNull()
  })
  it('spots a zombie', () => {
    expect(isZombie('4242 (x y) Z 1 4242')).toBe(true)
    expect(isZombie('4242 (x y) S 1 4242')).toBe(false)
  })
})

// A real process tree, throwaway: a shell that ignores SIGHUP and SIGTERM — the shape gemini has.
describe.skipIf(process.platform !== 'linux')('against real processes', () => {
  it('collects the tree under a pid and SIGKILLs the one that ignores the hang-up', async () => {
    const p = Bun.spawn(['sh', '-c', "trap '' HUP TERM; sleep 60 & wait"], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    try {
      let own: PidRef[] = []
      for (let i = 0; i < 40 && own.length < 2; i++) {
        await new Promise(r => setTimeout(r, 50))
        own = await collectOwnPids(p.pid)
      }
      expect(own.length).toBeGreaterThanOrEqual(2) // the shell and its sleep
      process.kill(p.pid, 'SIGHUP') // what tmux kill-session sends: ignored
      const out = await escalateKill(own, procIO(), { graceMs: 300, killWaitMs: 1500, pollMs: 25 })
      expect(out.stuck).toEqual([])
      expect(out.killed).toContain(p.pid)
      for (const r of own) expect(procIO().alive(r)).toBe(false)
    } finally {
      try { p.kill('SIGKILL') } catch { /* gone */ }
    }
  })
})
