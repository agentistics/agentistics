/**
 * MAC.OPENCODE-MUDO — the macOS process sweep driven through a fake `ps`/`lsof` (no Mac here). Each test pins one
 * defect the owner's Mac hit: a blocking sweep that took the server down with it, `lsof`'s "some pid had nothing"
 * exit code dropping EVERY external session, and `~/.local/bin` read as an installation only under `/home`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { resetMacNotHarnessMemo, scanMacProcesses, type MacRun } from './macos-processes-io'
import { parsePsCommands } from './macos-processes'
import { installedHarnessAt, resetSharedScan, SCAN_SHARE_MAX_MS, scanShareWindowMs, scanSummaryLine, sharedScanOf } from './live-sessions'

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
  afterEach(() => resetMacNotHarnessMemo())
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
  test('PERF.SERVIDOR-OCIOSO: 600 processes, 60 node and no harness — the warm sweep is ONE ps, lsof never runs', async () => {
    const memo = new Map() as import('./macos-processes-io').MacNotHarnessMemo
    let ps = 0
    const calls: string[][] = []
    const table = (extra: string[] = []) => [
      ...Array.from({ length: 540 }, (_, i) => `  ${100 + i} 01:00:00 /usr/libexec/d${i}`),
      ...Array.from({ length: 60 }, (_, i) => `  ${1000 + i} 02:00:00 /opt/homebrew/bin/node`),
      ...extra,
    ].join('\n')
    let extra: string[] = []
    const run: MacRun = async argv => {
      calls.push(argv)
      if (argv[1] === '-axwwo') { ps++; return { ok: true, stdout: table(extra) } }
      if (argv[0] === 'ps') {
        const pids = argv[argv.length - 1]!.split(',')
        return { ok: true, stdout: pids.map(p => p === '2000' ? `  ${p} ${OPENCODE}` : `  ${p} node /Applications/Code.app/helper.js`).join('\n') }
      }
      if (argv.includes('cwd')) return { ok: true, stdout: 'p2000\nfcwd\nn/Users/dev/ws' }
      if (argv.includes('0')) return { ok: true, stdout: 'p2000\nf0\nn/dev/ttys001' }
      return { ok: true, stdout: '' }
    }
    const now = Date.now()
    await scanMacProcesses(now, run, memo)
    const first = calls.length
    expect(first).toBe(2) // bulk + one argv batch; no lsof for 60 non-harness nodes
    expect(calls.some(c => c[0] === 'lsof')).toBe(false)
    calls.length = 0
    await scanMacProcesses(now, run, memo)
    expect(calls).toEqual([['ps', '-axwwo', 'pid=,etime=,comm=']]) // warm: one ps
    // a NEW node that IS a harness: one argv read for it alone, lsof for it alone
    calls.length = 0
    extra = [`  2000 00:05 ${OPENCODE}`]
    const r = await scanMacProcesses(now, run, memo)
    expect(r.procs.map(p => [p.pid, p.harness, p.cwd])).toEqual([[2000, 'opencode', '/Users/dev/ws']])
    expect(calls.filter(c => c[0] === 'ps' && c[1] === '-ww').map(c => c[c.length - 1])).toEqual(['2000'])
    expect(calls.filter(c => c[0] === 'lsof').every(c => c[c.indexOf('-p') + 1] === '2000')).toBe(true)
    // a recycled pid (another start) is asked again
    calls.length = 0
    extra = []
    const recycled = table().replace('  1000 02:00:00 /opt/homebrew/bin/node', '  1000 00:03 /opt/homebrew/bin/node')
    const run2: MacRun = async (argv, t) => (argv[1] === '-axwwo' ? { ok: true, stdout: recycled } : run(argv, t))
    await scanMacProcesses(now, run2, memo)
    expect(calls.filter(c => c[0] === 'ps' && c[1] === '-ww').map(c => c[c.length - 1])).toEqual(['1000'])
    expect(ps).toBe(3)
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
  test('PERF.SERVIDOR-OCIOSO: a slow sweep keeps answering for twice its length after it ends (1 s floor, 15 s ceiling)', () => {
    expect(scanShareWindowMs(25)).toBe(1_000) // Linux: unchanged
    expect(scanShareWindowMs(6_000)).toBe(12_000) // a 6 s lsof sweep is not started again for 12 s
    expect(scanShareWindowMs(39_000)).toBe(SCAN_SHARE_MAX_MS)
    expect(scanShareWindowMs(-5)).toBe(1_000)
  })
  test('a fast finished sweep is reused inside 1 s and redone after it; reasons are counted', async () => {
    let runs = 0
    const scan = async () => { runs++; return { procs: [], unavailable: null } }
    const t0 = Date.now()
    await sharedScanOf(scan, t0, 'fleet')
    await sharedScanOf(scan, t0 + 500, 'data')
    expect(runs).toBe(1)
    await sharedScanOf(scan, t0 + 1_500, 'memory')
    expect(runs).toBe(2)
  })
  test('the summary line names count, time, processes, harnesses, children and who asked; silent when nothing ran', () => {
    const s = { sinceMs: 0, scans: 4, shared: 9, totalMs: 8_000, maxMs: 6_000, procs: 612, harness: 0, children: 16, byReason: { fleet: 3, data: 1 } }
    expect(scanSummaryLine(s, 10 * 60_000)).toBe('[live-sessions] process sweeps in 10 min: 4 run (9 shared), avg 2000 ms, max 6000 ms, last 612 processes / 0 harness, 16 child processes; asked by fleet=3 data=1')
    expect(scanSummaryLine({ ...s, scans: 0 }, 60_000)).toBeNull()
  })
})

describe('installedHarnessAt on macOS homes', () => {
  test('~/.local/bin/<tool> under /Users is an installation, as it is under /home', () => {
    expect(installedHarnessAt('/Users/dev/.local/bin/opencode')).toBe('opencode')
    expect(installedHarnessAt('/home/dev/.local/bin/opencode')).toBe('opencode')
    expect(installedHarnessAt('/Users/dev/tmp/opencode')).toBeUndefined()
  })
})

/**
 * MAC.OPENCODE r2 — the owner's report (2026-11-06, agentop 2.200.5, opencode 2.2.5 from Homebrew): "OpenCode
 * sessions open in a terminal do not appear in the session list". macOS `ps -o comm=` prints argv[0] as the shell
 * started it — the bare word `opencode` — so no install layout could be matched and every such TUI was dropped at the
 * very first step. The fakes below answer in the real formats: `ps -axwwo pid=,etime=,comm=` and `lsof -F` field
 * output (lsof always adds the `f` lines), with Homebrew's layout from homebrew-core `opencode.rb` 2.2.5.
 */
describe('scanMacProcesses — an opencode TUI typed by name (Homebrew)', () => {
  const CELLAR = '/opt/homebrew/Cellar/opencode/2.2.5/bin/opencode'
  function homebrewMac(txtOk = true) {
    const calls: string[] = []
    const run: MacRun = async argv => {
      const a = argv.join(' ')
      calls.push(a)
      if (a === 'ps -axwwo pid=,etime=,comm=') {
        return { ok: true, stdout: ['    1 10-01:00:00 /sbin/launchd', '  700 00:12:00 -zsh', '  701 00:11:58 opencode', '  702 00:11:57 opencode', '  703 00:03 vim'].join('\n') }
      }
      if (a.startsWith('lsof -a -d txt -p ')) {
        if (!txtOk) return { ok: false, stdout: '' }
        return { ok: true, stdout: ['p701', 'ftxt', `n${CELLAR}`, 'ftxt', 'n/usr/lib/dyld', 'p702', 'ftxt', `n${CELLAR}`, 'ftxt', 'n/usr/lib/libSystem.B.dylib'].join('\n') }
      }
      if (a.startsWith('ps -ww -o pid=,command= -p ')) {
        // 702 is the background service the 2.x TUI spawns for itself: plumbing, never a session.
        return { ok: true, stdout: ['  701 opencode', '  702 /opt/homebrew/Cellar/opencode/2.2.5/bin/opencode serve --service'].join('\n') }
      }
      if (a.includes('-d cwd')) return { ok: true, stdout: ['p701', 'fcwd', 'n/Users/owner/proj', 'p702', 'fcwd', 'n/Users/owner/proj'].join('\n') }
      if (a.includes('-d 0')) return { ok: true, stdout: ['p701', 'f0', 'n/dev/ttys004', 'p702', 'f0', 'n/dev/null'].join('\n') }
      return { ok: true, stdout: '' }
    }
    return { run, calls }
  }
  test('the bare `opencode` from `ps` is resolved through lsof txt to the Cellar binary and becomes ONE external TUI row', async () => {
    const { run, calls } = homebrewMac()
    const r = await scanMacProcesses(Date.now(), run)
    expect(r.procs.map(p => [p.pid, p.harness, p.cwd, p.stdinIsTty])).toEqual([[701, 'opencode', '/Users/owner/proj', true]])
    // One txt read for every bare-named candidate, and none for the rest of the table (`-zsh`, `vim`).
    const txt = calls.filter(c => c.startsWith('lsof -a -d txt'))
    expect(txt).toEqual(['lsof -a -d txt -p 701,702 -Fpn'])
  })
  test('an unreadable txt leaves the process unmatched (never guessed from the bare name)', async () => {
    const r = await scanMacProcesses(Date.now(), homebrewMac(false).run)
    expect(r.procs).toEqual([])
  })
})

describe('executableFromLsofTxt', () => {
  const fields = new Map([[9, ['/usr/lib/dyld', '/Users/o/.local/share/claude/versions/2.1.300', '/usr/lib/libc.dylib']], [5, ['/opt/homebrew/Cellar/opencode/2.2.5/bin/opencode', '/usr/lib/dyld']]])
  test('the file named like the command wins; a versioned install is found by the caller\'s layout test', async () => {
    const { executableFromLsofTxt } = await import('./macos-processes')
    expect(executableFromLsofTxt(fields, 5, 'opencode')).toBe('/opt/homebrew/Cellar/opencode/2.2.5/bin/opencode')
    expect(executableFromLsofTxt(fields, 9, 'claude', p => installedHarnessAt(p) === 'claude')).toBe('/Users/o/.local/share/claude/versions/2.1.300')
    expect(executableFromLsofTxt(fields, 9, 'claude', () => false)).toBeUndefined()
    expect(executableFromLsofTxt(fields, 77, 'opencode')).toBeUndefined()
  })
})

describe('installedHarnessAt — Homebrew Cellar', () => {
  test('Apple Silicon, Intel and Linuxbrew cellars are installations; a cellar binary of another name is not', () => {
    expect(installedHarnessAt('/opt/homebrew/Cellar/opencode/2.2.5/bin/opencode')).toBe('opencode')
    expect(installedHarnessAt('/usr/local/Cellar/opencode/2.2.5/bin/opencode')).toBe('opencode')
    expect(installedHarnessAt('/home/linuxbrew/.linuxbrew/Cellar/opencode/2.2.5/bin/opencode')).toBe('opencode')
    expect(installedHarnessAt('/opt/homebrew/Cellar/opencode/2.2.5/bin/opencode', 'claude')).toBeUndefined()
    expect(installedHarnessAt('/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg')).toBeUndefined()
  })
})

/**
 * The OWNER'S Mac, as read on it (2026-11-06, opencode 2.2.5 installed `npm i -g @opencode/cli` under Homebrew's node, so
 * `/opt/homebrew/bin/opencode` → `/opt/homebrew/lib/node_modules/@opencode/cli/bin/opencode.exe`):
 *   1287  ppid 1      `…/@opencode/cli/bin/opencode.exe serve --service`   (the 2.x background service, cwd ~)
 *   45443 ppid 10729  `opencode`                                           (the TUI the owner opened, cwd ~/upx-workspace)
 *   49659 `opencode acp` → child `opencode.exe serve --stdio --port 0`    (agentistics-managed ACP sessions)
 * Only 45443 is an external session; ps names it by the bare word while its program file ends in `.exe`.
 */
describe('scanMacProcesses — the owner\'s real Mac process table', () => {
  const EXE = '/opt/homebrew/lib/node_modules/@opencode/cli/bin/opencode.exe'
  const run: MacRun = async argv => {
    const a = argv.join(' ')
    if (a === 'ps -axwwo pid=,etime=,comm=') {
      return { ok: true, stdout: [` 1287 2-03:00:00 ${EXE}`, '10729 01:00:00 -zsh', '45443 00:40:00 opencode', '49659 00:20:00 opencode', `49660 00:20:00 ${EXE}`].join('\n') }
    }
    if (a.startsWith('lsof -a -d txt -p ')) {
      return { ok: true, stdout: ['p45443', 'ftxt', `n${EXE}`, 'ftxt', 'n/usr/lib/dyld', 'p49659', 'ftxt', `n${EXE}`, 'ftxt', 'n/usr/lib/dyld'].join('\n') }
    }
    if (a.startsWith('ps -ww -o pid=,command= -p ')) {
      return { ok: true, stdout: [` 1287 ${EXE} serve --service`, '45443 opencode', '49659 opencode acp', `49660 ${EXE} serve --stdio --port 0`].join('\n') }
    }
    if (a.includes('-d cwd')) return { ok: true, stdout: ['p1287', 'n/Users/blpsoares', 'p45443', 'n/Users/blpsoares/upx-workspace', 'p49659', 'n/Users/blpsoares/upx-workspace', 'p49660', 'n/Users/blpsoares/upx-workspace'].join('\n') }
    if (a.includes('-d 0')) return { ok: true, stdout: ['p45443', 'n/dev/ttys007', 'p49659', 'n/dev/ttys009'].join('\n') }
    return { ok: true, stdout: '' }
  }
  test('the TUI is the one external row; the service and the managed ACP pair are plumbing', async () => {
    const r = await scanMacProcesses(Date.now(), run)
    expect(r.procs.map(p => [p.pid, p.harness, p.cwd])).toEqual([[45443, 'opencode', '/Users/blpsoares/upx-workspace']])
  })
})
