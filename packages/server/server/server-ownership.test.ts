/**
 * Who may run this data dir's `agentop server`, and when a stray outside the unit is taken back.
 * See docs/incidents/2026-10-04-server-outside-unit.md. Nothing here touches a real service
 * manager, lock or process: every fact is a value, every action a fake.
 */
import { describe, expect, test } from 'bun:test'
import { isInsideUnit, planServerStart, planStrayReclaim, serviceOwnsServer, type OwnershipFacts } from './server-ownership'
import { reclaimStrayServer, startServerUnit } from './server-ownership-io'

const UNIT_CG = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentop-server.service\n'
const TERM_CG = '0::/user.slice/user-1000.slice/user@1000.service/init.scope\n'

const facts = (o: Partial<OwnershipFacts> = {}): OwnershipFacts => ({
  platform: 'linux', unitInstalled: true, ownersStore: true, insideUnit: false, foregroundForced: false, ...o,
})

describe('planServerStart — a hand-run server goes through the unit when the unit owns the data dir', () => {
  test('unit installed, owner store, outside the unit → delegate (the 2026-10-04 launcher)', () => {
    expect(planServerStart(facts())).toEqual({ kind: 'delegate' })
  })
  test('the unit itself runs the server', () => {
    expect(planServerStart(facts({ insideUnit: true }))).toEqual({ kind: 'run' })
  })
  test('no unit, or another HOME (a preview / test server) → run here', () => {
    expect(planServerStart(facts({ unitInstalled: false }))).toEqual({ kind: 'run' })
    expect(planServerStart(facts({ ownersStore: false }))).toEqual({ kind: 'run' })
    expect(planServerStart(facts({ platform: 'darwin' }))).toEqual({ kind: 'run' })
  })
  test('AGENTISTICS_SERVER_FOREGROUND=1 keeps it in this terminal', () => {
    expect(planServerStart(facts({ foregroundForced: true }))).toEqual({ kind: 'run' })
  })
  test('serviceOwnsServer is the same rule for launchers', () => {
    expect(serviceOwnsServer(facts())).toBe(true)
    expect(serviceOwnsServer(facts({ ownersStore: false }))).toBe(false)
  })
  test('inside a unit is read off the cgroup or systemd\'s INVOCATION_ID', () => {
    expect(isInsideUnit(UNIT_CG, undefined)).toBe(true)
    expect(isInsideUnit(TERM_CG, 'abc')).toBe(true)
    expect(isInsideUnit(TERM_CG, undefined)).toBe(false)
    expect(isInsideUnit(TERM_CG, '')).toBe(false)
  })
})

describe('planStrayReclaim — only a PROVABLE stray is stopped', () => {
  const proc = (argv: string[], cgroup = TERM_CG, pid = 3204) => ({ pid, argv, cgroup })
  test('the lock holder is `agentop server` outside any unit → reclaim', () => {
    expect(planStrayReclaim({ holder: 3204, proc: proc(['/home/u/.local/bin/agentop', 'server']), selfPid: 1 }))
      .toEqual({ kind: 'reclaim', pid: 3204 })
  })
  test('nobody holds the data dir, or the holder IS the unit\'s server → nothing to do', () => {
    expect(planStrayReclaim({ holder: null, proc: null, selfPid: 1 })).toEqual({ kind: 'none' })
    expect(planStrayReclaim({ holder: 3204, proc: proc(['agentop', 'server'], UNIT_CG), selfPid: 1 })).toEqual({ kind: 'none' })
  })
  test('a holder whose argv is not `agentop server` is reported, never killed', () => {
    expect(planStrayReclaim({ holder: 3204, proc: proc(['vim', 'server.lock']), selfPid: 1 }).kind).toBe('unproven')
    expect(planStrayReclaim({ holder: 3204, proc: proc(['agentop', 'server', '--bg']), selfPid: 1 }).kind).toBe('unproven')
  })
  test('an unreadable holder, or ourselves, is never reclaimed', () => {
    expect(planStrayReclaim({ holder: 3204, proc: null, selfPid: 1 }).kind).toBe('unproven')
    expect(planStrayReclaim({ holder: 3204, proc: proc(['agentop', 'server'], TERM_CG, 999), selfPid: 1 }).kind).toBe('unproven')
    expect(planStrayReclaim({ holder: 7, proc: proc(['agentop', 'server'], TERM_CG, 7), selfPid: 7 }).kind).toBe('unproven')
  })
})

describe('reclaimStrayServer / startServerUnit (faked IO)', () => {
  test('a provable stray is stopped, and nothing else is', async () => {
    const stopped: number[] = []
    const r = await reclaimStrayServer({
      holder: async () => 3204,
      readProc: pid => ({ pid, argv: ['agentop', 'server'], cgroup: TERM_CG }),
      stop: async pid => { stopped.push(pid); return { ok: true } },
      selfPid: 1,
    })
    expect(r).toEqual({ kind: 'reclaimed', pid: 3204 })
    expect(stopped).toEqual([3204])
  })
  test('an unproven holder is not stopped', async () => {
    const stopped: number[] = []
    const r = await reclaimStrayServer({
      holder: async () => 3204,
      readProc: pid => ({ pid, argv: ['python3', 'x'], cgroup: TERM_CG }),
      stop: async pid => { stopped.push(pid); return { ok: true } },
      selfPid: 1,
    })
    expect(r.kind).toBe('unproven')
    expect(stopped).toEqual([])
  })

  const runner = (startCode = 0, stderr = '') => {
    const calls: string[][] = []
    return {
      calls,
      run: async (cmd: string[]) => { calls.push(cmd); return { code: cmd.includes('start') ? startCode : 0, stdout: '', stderr: cmd.includes('start') ? stderr : '' } },
    }
  }

  test('reclaims, clears `failed`, starts the unit, waits for it to answer', async () => {
    const r = runner()
    let ticks = 0
    const res = await startServerUnit({
      run: r.run, reclaim: async () => ({ kind: 'reclaimed', pid: 3204 }),
      answering: async () => ++ticks > 2, sleep: async () => {}, intervalMs: 10, timeoutMs: 1_000,
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain('pid 3204')
    expect(r.calls.map(c => c[2])).toEqual(['reset-failed', 'start'])
  })
  test('no user bus → `unreachable`, so a terminal launcher may still run one', async () => {
    const r = runner(1, 'Failed to connect to bus: No medium found')
    const res = await startServerUnit({ run: r.run, reclaim: async () => ({ kind: 'none' }), answering: async () => false, sleep: async () => {} })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.unreachable).toBe(true)
  })
  test('an unproven holder refuses BEFORE starting anything — its answering is not ours', async () => {
    const r = runner()
    const res = await startServerUnit({ run: r.run, reclaim: async () => ({ kind: 'unproven', pid: 42 }), answering: async () => true, sleep: async () => {} })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('pid 42')
    expect(r.calls).toEqual([])
  })
  test('started but never answering is a failure, in a sentence', async () => {
    const r = runner()
    const res = await startServerUnit({ run: r.run, reclaim: async () => ({ kind: 'none' }), answering: async () => false, sleep: async () => {}, intervalMs: 100, timeoutMs: 300 })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.unreachable).toBe(false)
    expect(res.message).toContain('did not answer')
  })
})
