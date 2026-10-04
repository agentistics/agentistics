import { describe, expect, test } from 'bun:test'
import { buildInventory, classifyProcess, type ProcEntry } from './inventory'
import { killAllowed, planGovernor, type HelperState } from './governor'
import { parseHelperRegistration, pruneHelpers } from './helpers'
import { heavyLockPath, heavyReserveBytes, heavySlots, queuePosition, HEAVY_JOB_BYTES } from './heavy'
import { parseStat, pickEnv } from './proc-read'

const MB = 1024 * 1024
const GB = 1024 * MB
const HOME = '/home/u'

const entry = (o: Partial<ProcEntry> & { pid: number; argv: string[] }): ProcEntry => ({
  ppid: 100, exe: '/home/u/.local/bin/agentop', rssBytes: 50 * MB, swapBytes: 0, cpuPercent: 0, ageSec: 60,
  env: { HOME }, ...o,
})

const alive = (dead: number[] = []) => (pid: number) => !dead.includes(pid)
const inv = (entries: ProcEntry[], dead: number[] = [], helpers = new Map()) =>
  buildInventory(entries, { selfPid: 1, home: HOME, alive: alive(dead), helpers })

describe('classifyProcess', () => {
  const none = new Map<number, string>()
  test('agentop subcommands, by argv or by the source entry', () => {
    expect(classifyProcess(entry({ pid: 2, argv: ['/x/agentop', 'mcp'] }), none)?.kind).toBe('mcp')
    expect(classifyProcess(entry({ pid: 2, argv: ['/x/agentop', 'server'] }), none)?.kind).toBe('server')
    expect(classifyProcess(entry({ pid: 2, argv: ['/x/agentop'] }), none)?.kind).toBe('cockpit')
    expect(classifyProcess(entry({ pid: 2, argv: ['/x/agentop', 'tui'] }), none)?.kind).toBe('cockpit')
    expect(classifyProcess(entry({ pid: 2, argv: ['/v/bun', 'packages/server/bin/cli.ts', 'server'], exe: '/v/bun' }), none)?.kind).toBe('server')
    expect(classifyProcess(entry({ pid: 2, argv: ['/x/agentop', 'session', 'ls'] }), none)?.kind).toBe('cli')
  })
  test('a deleted agentop.bak is still agentop; an unrelated process is not', () => {
    expect(classifyProcess(entry({ pid: 2, argv: ['agentop', 'mcp'], exe: '/u/agentop.bak (deleted)' }), none)?.kind).toBe('mcp')
    expect(classifyProcess(entry({ pid: 2, argv: ['/usr/bin/vim'], exe: '/usr/bin/vim' }), none)).toBeNull()
  })
  test('a registered pid is a helper whatever its argv; its children inherit the id', () => {
    expect(classifyProcess(entry({ pid: 7, argv: ['searxng'], exe: '/usr/bin/python3' }), new Map([[7, 'h-1']]))).toMatchObject({ kind: 'helper', helperId: 'h-1' })
    expect(classifyProcess(entry({ pid: 8, argv: ['uwsgi'], exe: '/usr/bin/uwsgi', env: { AGENTISTICS_HELPER_ID: 'h-1' } }), none)?.kind).toBe('helper')
  })
})

describe('planGovernor — kills', () => {
  test('the incident: an orphaned mcp on an old binary is killed', () => {
    const i = inv([entry({ pid: 15667, ppid: 1, argv: ['agentop', 'mcp'], exe: '/u/agentop.bak (deleted)', cpuPercent: 111 })])
    expect(planGovernor({ inventory: i, helpers: [], nowMs: 0 }).kills).toEqual([
      { pid: 15667, label: 'agentop mcp', reason: 'orphan-mcp', usedBytes: 50 * MB },
    ])
  })
  test("an mcp whose parent (its client) is alive is never killed, even on an old binary", () => {
    const i = inv([entry({ pid: 9, ppid: 500, argv: ['agentop', 'mcp'], exe: '/u/agentop.bak (deleted)' })])
    const plan = planGovernor({ inventory: i, helpers: [], nowMs: 0 })
    expect(plan.kills).toEqual([])
    expect(plan.alerts[0]).toMatchObject({ reason: 'stale-binary', fix: { action: 'reconnect-session' } })
  })
  test('a test leftover is killed ONLY when its recorded owner is gone; the main HOME never is', () => {
    const iso = { HOME: '/tmp/tuicheck.x', CLAUDE_PID: '700' }
    const i = inv([
      // ownerless + orphaned + old: NOT killed any more — no evidence anybody abandoned it
      entry({ pid: 20, ppid: 1, argv: ['agentop'], env: { HOME: '/tmp/tuicheck.a' }, rssBytes: 350 * MB, ageSec: 3 * 3600 }),
      // owner recorded (CLAUDE_PID 700) and dead: killed
      entry({ pid: 21, ppid: 40, argv: ['agentop', 'server'], env: iso }),
      entry({ pid: 22, ppid: 1, argv: ['agentop'], env: { HOME } }),
      entry({ pid: 23, ppid: 1, argv: ['agentop', 'server'], env: {} }),
      entry({ pid: 24, ppid: 1, argv: ['agentop'], env: { HOME: '/tmp/tuicheck.b' }, ageSec: 600 }),
    ], [700])
    const kills = planGovernor({ inventory: i, helpers: [], nowMs: 0 }).kills.map(k => [k.pid, k.reason])
    expect(kills).toEqual([[21, 'test-leftover']])
  })
  test('an isolated instance whose owner is ALIVE is left alone, even orphaned and old', () => {
    const i = inv([entry({ pid: 21, ppid: 1, ageSec: 99_999, argv: ['agentop', 'server'], env: { HOME: '/tmp/p', CLAUDE_PID: '700' } })])
    expect(planGovernor({ inventory: i, helpers: [], nowMs: 0 }).kills).toEqual([])
  })
  test('helpers: stopped when idle past their own timeout or when their owner ended', () => {
    const helpers: HelperState[] = [
      { id: 'a', pid: 30, registeredMs: 0, lastUsedMs: 1000, idleTimeoutSec: 60, budgetBytes: GB },
      { id: 'b', pid: 31, registeredMs: 0, lastUsedMs: 100_000, idleTimeoutSec: 600, budgetBytes: GB },
      { id: 'c', pid: 32, registeredMs: 0, lastUsedMs: 100_000, idleTimeoutSec: 600, budgetBytes: GB },
    ]
    const i = inv(
      [30, 31, 32].map(pid => entry({ pid, argv: ['searxng'], exe: '/usr/bin/python3' })),
      [900],
      new Map([[30, { id: 'a' }], [31, { id: 'b' }], [32, { id: 'c', ownerPid: 900 }]]),
    )
    const kills = planGovernor({ inventory: i, helpers, nowMs: 120_000 }).kills.map(k => [k.pid, k.reason])
    expect(kills.sort()).toEqual([[30, 'helper-idle'], [32, 'helper-owner-ended']])
  })
  test('the server and the governor itself are never killed', () => {
    const i = buildInventory([
      entry({ pid: 1, ppid: 1, argv: ['agentop', 'mcp'] }),
      entry({ pid: 2, ppid: 1, argv: ['agentop', 'server'], env: { HOME: '/tmp/x' }, rssBytes: 9 * GB, ageSec: 3 * 3600 }),
    ], { selfPid: 1, home: HOME, alive: () => true, helpers: new Map() })
    const plan = planGovernor({ inventory: i, helpers: [], nowMs: 0 })
    expect(plan.kills).toEqual([]) // self (1) never; an ownerless isolated server is not evidence of a leftover
    expect(killAllowed(i, 1)).toBe(false)
    expect(killAllowed(i, 2)).toBe(false)
  })
})

describe('planGovernor — alerts', () => {
  test('over budget counts swap (RSS alone hid the incident) and names the fix', () => {
    const i = inv([entry({ pid: 40, ppid: 300, argv: ['agentop'], rssBytes: 1700 * MB, swapBytes: 6500 * MB })])
    expect(planGovernor({ inventory: i, helpers: [], nowMs: 0 }).alerts).toEqual([
      { pid: 40, label: 'agentop', reason: 'over-budget', usedBytes: 8200 * MB, budgetBytes: 768 * MB, fix: { action: 'reopen-cockpit', pid: 40 } },
    ])
  })
  test('a spinning process with no live owner is flagged', () => {
    const i = inv([entry({ pid: 41, ppid: 300, argv: ['agentop', 'session', 'ls'], cpuPercent: 140, env: { HOME, CLAUDE_PID: '5' } })], [5])
    expect(planGovernor({ inventory: i, helpers: [], nowMs: 0 }).alerts.map(a => a.reason)).toEqual(['spinning'])
  })
})

describe('helpers', () => {
  test('registration validates and fills defaults', () => {
    expect(parseHelperRegistration({ pid: 4242, name: 'searxng' })).toMatchObject({ ok: true, value: { pid: 4242, budgetBytes: 512 * MB, idleTimeoutSec: 900 } })
    expect(parseHelperRegistration({ pid: 1, name: 'x' })).toEqual({ ok: false, code: 'bad_pid' })
    expect(parseHelperRegistration({ pid: 4242, name: '' })).toEqual({ ok: false, code: 'bad_name' })
    expect(parseHelperRegistration({ pid: 4242, name: 'x', budgetMb: 99999 })).toEqual({ ok: false, code: 'bad_budget' })
    expect(parseHelperRegistration({ pid: 4242, name: 'x', idleTimeoutSec: 5 })).toEqual({ ok: false, code: 'bad_idle' })
    expect(parseHelperRegistration({ pid: 4242, name: 'x', ownerPid: 'me' })).toEqual({ ok: false, code: 'bad_owner' })
  })
  test('dead helpers are pruned', () => {
    const r = (pid: number) => ({ id: `h${pid}`, pid, name: 'x', registeredMs: 0, lastUsedMs: null, idleTimeoutSec: 60, budgetBytes: MB })
    expect(pruneHelpers([r(2), r(3)], pid => pid === 3).map(h => h.pid)).toEqual([3])
  })
})

describe('heavy slot', () => {
  test('slot 0 is the lock sessions already take by hand', () => {
    expect(heavyLockPath(0)).toBe('/tmp/agentistics-heavy.lock')
    expect(heavyLockPath(2)).toBe('/tmp/agentistics-heavy.2.lock')
  })
  test('slots follow MemAvailable, at least 1, at most 4; running jobs are part of the envelope', () => {
    expect(heavySlots(1.4 * GB)).toBe(1) // the incident: 1.4 GB available
    expect(heavySlots(6 * GB)).toBe(2)
    expect(heavySlots(64 * GB)).toBe(4)
    expect(heavySlots(2.5 * GB, 1.7 * GB)).toBe(1)
    expect(heavySlots(4.4 * GB, 1.7 * GB)).toBe(2)
  })
  test('admission keeps room for one heavy job, minus what running ones hold', () => {
    expect(heavyReserveBytes(0)).toBe(HEAVY_JOB_BYTES)
    expect(heavyReserveBytes(3 * GB)).toBe(0)
  })
  test('queue position counts only live waiters, in arrival order', () => {
    const w = [{ pid: 3, sinceMs: 30, command: 'c' }, { pid: 1, sinceMs: 10, command: 'a' }, { pid: 2, sinceMs: 20, command: 'b' }]
    expect(queuePosition(w, 3, () => true)).toEqual({ position: 3, of: 3 })
    expect(queuePosition(w, 3, pid => pid !== 1)).toEqual({ position: 2, of: 2 })
    expect(queuePosition(w, 9, () => true)).toEqual({ position: 0, of: 3 })
  })
})

describe('proc readers', () => {
  test('parseStat survives a comm with spaces and parentheses', () => {
    const line = '123 (agentop (x) y) S 1 123 123 0 -1 4194560 1 0 0 0 250 50 0 0 20 0 9 0 777 0 0'
    expect(parseStat(line)).toEqual({ ppid: 1, utime: 250, stime: 50, starttime: 777 })
  })
  test('pickEnv keeps only what the owner rule reads', () => {
    expect(pickEnv('PATH=/bin\0CLAUDE_PID=42\0HOME=/tmp/h\0SECRET=x\0')).toEqual({ CLAUDE_PID: '42', HOME: '/tmp/h' })
  })
})

describe('manual flock jobs', () => {
  test('flockHolders reads /proc/locks by inode and skips blocked waiters', async () => {
    const { flockHolders } = await import('./heavy')
    const locks = [
      '1: POSIX  ADVISORY  WRITE 2261071 08:20:3296821 1073741824 1073742335',
      '12: FLOCK  ADVISORY  WRITE 2233903 08:20:124234 0 EOF',
      '12: -> FLOCK  ADVISORY  WRITE 2246780 08:20:124234 0 EOF',
      '13: FLOCK  ADVISORY  WRITE 4074682 08:20:471070 0 EOF',
    ].join('\n')
    expect(flockHolders(locks, 124234)).toEqual([2233903])
    expect(flockHolders(locks, 999)).toEqual([])
  })
  test('parseFlockArgv finds the lock and the command past the options', async () => {
    const { parseFlockArgv } = await import('./heavy')
    expect(parseFlockArgv(['flock', '/tmp/agentistics-heavy.lock', 'bun', 'tsc', '-b'])).toEqual({ lock: '/tmp/agentistics-heavy.lock', command: 'bun tsc -b' })
    expect(parseFlockArgv(['flock', '-n', '-E', '254', '/tmp/agentistics-heavy.lock', 'git', 'commit', '-m', 'a\nb'])).toEqual({ lock: '/tmp/agentistics-heavy.lock', command: 'git commit -m a' })
    expect(parseFlockArgv(['flock'])).toBeNull()
  })
})

describe('a throwaway HOME is one under a temp root, never just "another HOME"', () => {
  test('isThrowawayHome', async () => {
    const { isThrowawayHome } = await import('./inventory')
    expect(isThrowawayHome('/tmp/rel/home', '/home/u')).toBe(true)
    expect(isThrowawayHome('/home/u', '/tmp/rel/home')).toBe(false)   // the real HOME, seen from a preview
    expect(isThrowawayHome('/home/u', '/home/u')).toBe(false)
    expect(isThrowawayHome(undefined, '/home/u')).toBe(false)
    expect(isThrowawayHome('/tmpx/home', '/home/u')).toBe(false)
    expect(isThrowawayHome('/scratch/h', '/home/u', ['/scratch/'])).toBe(true)
  })
  test('a PREVIEW governor never takes the real orphaned main server for a test leftover', () => {
    const i = buildInventory([
      entry({ pid: 50, ppid: 1, argv: ['agentop', 'server'], env: { HOME: '/home/u' }, ageSec: 99_999 }),
    ], { selfPid: 1, home: '/tmp/rel/home', alive: () => true, helpers: new Map() })
    expect(i[0]!.isolatedHome).toBe(false)
    expect(planGovernor({ inventory: i, helpers: [], nowMs: 0 }).kills).toEqual([])
  })
})
