/**
 * MAC.OPENCODE-MUDO — the macOS process sweep driven through a fake `ps`/`lsof` (no Mac here). Each test pins one
 * defect the owner's Mac hit: a blocking sweep that took the server down with it, `lsof`'s "some pid had nothing"
 * exit code dropping EVERY external session, and `~/.local/bin` read as an installation only under `/home`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { scanMacProcesses, type MacRun } from './macos-processes-io'
import { parsePsCommands } from './macos-processes'
import { installedHarnessAt, resetSharedScan, sharedScanOf } from './live-sessions'

const OPENCODE = '/Users/dev/.opencode/bin/opencode'

/** A fake `ps`/`lsof`: answers by argv shape, records every call. */
function fakeMac(o: { lsofExit?: number; extraNodes?: number } = {}) {
  const calls: string[][] = []
  const nodes = Array.from({ length: o.extraNodes ?? 0 }, (_, i) => 900 + i)
  const run: MacRun = async argv => {
    calls.push(argv)
    const a = argv.join(' ')
    if (a === 'ps -axwwo pid=,etime=,comm=') {
      return { ok: true, stdout: [`  501 01:00:00 ${OPENCODE}`, `  502 02:00 ${OPENCODE}`, '  77 05:00 /usr/sbin/cfprefsd', ...nodes.map(p => `  ${p} 10:00 node`)].join('\n') }
    }
    if (a.startsWith('ps -ww -o pid=,command= -p ')) {
      // 502 exited between the two reads: real `ps -p` prints the rest and exits 1.
      return { ok: false, stdout: [`  501 ${OPENCODE}`, ...nodes.map(p => `  ${p} node /Users/dev/mcp/server.js`)].join('\n') }
    }
    if (a.includes('-d cwd')) return { ok: (o.lsofExit ?? 1) === 0, stdout: ['p501', 'fcwd', 'n/Users/dev/ws'].join('\n') }
    if (a.includes('-d 0')) return { ok: (o.lsofExit ?? 1) === 0, stdout: ['p501', 'f0', 'n/dev/ttys003'].join('\n') }
    if (a.startsWith('lsof -a -p')) return { ok: false, stdout: '' }
    return { ok: false, stdout: '' }
  }
  return { run, calls }
}

describe('scanMacProcesses', () => {
  test('an lsof that exits 1 (one pid had no such descriptor) still yields the sessions it printed', async () => {
    const { run } = fakeMac({ lsofExit: 1 })
    const r = await scanMacProcesses(Date.now(), run)
    expect(r.procs.map(p => [p.pid, p.harness, p.cwd, p.stdinIsTty])).toEqual([[501, 'opencode', '/Users/dev/ws', true]])
    expect(r.cwdDenied).toBe(false)
  })
  test('argv is ONE ps call for every candidate, never one per process', async () => {
    const { run, calls } = fakeMac({ extraNodes: 40 })
    await scanMacProcesses(Date.now(), run)
    expect(calls.filter(c => c[0] === 'ps').length).toBe(2) // the bulk list + one argv batch
    expect(calls.filter(c => c[0] === 'lsof').length).toBeLessThanOrEqual(3)
  })
  test('the sweep never blocks: a slow lsof leaves the event loop free', async () => {
    const { run: fast } = fakeMac()
    const slow: MacRun = async (argv, t) => { if (argv[0] === 'lsof') await Bun.sleep(150); return fast(argv, t) }
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 10)
    await scanMacProcesses(Date.now(), slow)
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(5)
  })
})

describe('parsePsCommands', () => {
  test('pid → command line, junk skipped', () => {
    expect([...parsePsCommands('  501 /Users/dev/.opencode/bin/opencode -s ses_x\nps: no such pid\n  9 node a.js\n')]).toEqual([
      [501, '/Users/dev/.opencode/bin/opencode -s ses_x'], [9, 'node a.js'],
    ])
  })
})

describe('sharedScanOf', () => {
  afterEach(() => resetSharedScan())
  test('every caller while a sweep is in flight shares it, however long it runs', async () => {
    let runs = 0
    let release!: () => void
    const scan = () => { runs++; return new Promise<{ procs: []; unavailable: null }>(r => { release = () => r({ procs: [], unavailable: null }) }) }
    const t0 = Date.now()
    const a = sharedScanOf(scan, t0)
    const b = sharedScanOf(scan, t0 + 5_000) // well past the share window, still in flight
    release()
    await Promise.all([a, b])
    expect(runs).toBe(1)
    const c = sharedScanOf(async () => { runs++; return { procs: [], unavailable: null } }, t0 + 10_000)
    await c
    expect(runs).toBe(2)
  })
})

describe('installedHarnessAt on macOS homes', () => {
  test('~/.local/bin/<tool> under /Users is an installation, as it is under /home', () => {
    expect(installedHarnessAt('/Users/dev/.local/bin/opencode')).toBe('opencode')
    expect(installedHarnessAt('/home/dev/.local/bin/opencode')).toBe('opencode')
    expect(installedHarnessAt('/Users/dev/tmp/opencode')).toBeUndefined()
  })
})
