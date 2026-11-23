import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cgroupDirOf, scopeDirOf, watchScope, foldScopeSample, parseScopeSample, readScopeSample, scopeStatsLine, type ScopeSample } from './run-scope-stats'

const MB = 1024 * 1024
const GB = 1024 * MB

describe('RUN.LENTIDAO-SUITE — what a run cost, said at its end', () => {
  test('the cgroup v2 line of /proc/<pid>/cgroup names the scope directory', () => {
    expect(cgroupDirOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentistics-throwaway-run-x.scope\n'))
      .toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/agentistics-throwaway-run-x.scope')
    expect(cgroupDirOf('12:memory:/a\n0::/b/c.scope', '/root')).toBe('/root/b/c.scope')
    // cgroup v1 only, an empty or a root path: nothing to read.
    expect(cgroupDirOf('12:memory:/a\n')).toBeNull()
    expect(cgroupDirOf('')).toBeNull()
    expect(cgroupDirOf('0::/\n')).toBeNull()
    expect(cgroupDirOf('0::/../etc\n')).toBeNull()
  })

  test('a sample reads cpu, memory, cap hits and swap; an absent file is unmeasured, never a zero', () => {
    const s = parseScopeSample({
      cpuStat: 'usage_usec 1108000000\nuser_usec 831000000\nsystem_usec 277000000\n',
      memoryCurrent: `${1900 * MB}\n`,
      memoryEvents: 'low 0\nhigh 0\nmax 3713\noom 0\noom_kill 0\n',
      swapCurrent: `${160 * MB}\n`,
    })
    expect(s).toEqual({ cpuUsec: 1108000000, memoryPeakBytes: 1900 * MB, capHits: 3713, oomKills: 0, swapPeakBytes: 160 * MB })
    expect(parseScopeSample({})).toEqual({ cpuUsec: null, memoryPeakBytes: null, capHits: null, oomKills: null, swapPeakBytes: null })
    expect(parseScopeSample({ memoryCurrent: 'junk' }).memoryPeakBytes).toBeNull()
  })

  test('folding keeps the PEAK of the gauges and the LATEST of the counters', () => {
    const a: ScopeSample = { cpuUsec: 10, memoryPeakBytes: 2 * GB, capHits: 5, oomKills: 0, swapPeakBytes: 100 }
    const b: ScopeSample = { cpuUsec: 30, memoryPeakBytes: 1 * GB, capHits: 9, oomKills: 1, swapPeakBytes: null }
    expect(foldScopeSample(a, b)).toEqual({ cpuUsec: 30, memoryPeakBytes: 2 * GB, capHits: 9, oomKills: 1, swapPeakBytes: 100 })
    // a sample taken while the scope was already gone (all null) never erases what was measured.
    const gone = parseScopeSample({})
    expect(foldScopeSample(a, gone)).toEqual(a)
    expect(foldScopeSample(null, a)).toEqual(a)
  })

  test('the closing line: cpu against wall time, the peak against the cap, and the cap hits named', () => {
    const line = scopeStatsLine({ cpuUsec: 7755_000_000, memoryPeakBytes: 1950 * MB, capHits: 3713, oomKills: 0, swapPeakBytes: 160 * MB }, 5_597_000, 2 * GB)!
    expect(line).toContain('cpu 2h09m15s over 1h33m17s wall (1.39 cores)')
    expect(line).toContain('memory peak 1.9 GB of the 2.0 GB cap')
    expect(line).toContain('cap reached 3713×')
    expect(line).toContain('swap peak 160 MB')
    expect(line.startsWith('agentop run: ')).toBe(true)
  })

  test('a quiet run says only what was measured; nothing measured says nothing', () => {
    const line = scopeStatsLine({ cpuUsec: 650_000, memoryPeakBytes: 120 * MB, capHits: 0, oomKills: 0, swapPeakBytes: 0 }, 2_000, 2 * GB)!
    expect(line).toBe('agentop run: cpu 0.7s over 2.0s wall (0.33 cores) · memory peak 120 MB of the 2.0 GB cap')
    expect(scopeStatsLine(parseScopeSample({}), 2_000, 2 * GB)).toBeNull()
    expect(scopeStatsLine(null, 2_000, 2 * GB)).toBeNull()
  })

  test('an OOM kill is said in words', () => {
    expect(scopeStatsLine({ cpuUsec: 1_000_000, memoryPeakBytes: 2 * GB, capHits: 40, oomKills: 2, swapPeakBytes: null }, 1_000, 2 * GB))
      .toContain('OOM-killed 2 process(es)')
  })

  test('readScopeSample reads a cgroup directory and tolerates missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-stats-'))
    try {
      const scope = join(dir, 'x.scope')
      mkdirSync(scope)
      writeFileSync(join(scope, 'cpu.stat'), 'usage_usec 42\n')
      writeFileSync(join(scope, 'memory.current'), '1048576\n')
      expect(readScopeSample(scope)).toEqual({ cpuUsec: 42, memoryPeakBytes: MB, capHits: null, oomKills: null, swapPeakBytes: null })
      expect(readScopeSample(join(dir, 'gone.scope'))).toEqual(parseScopeSample({}))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the scope is resolved by UNIT NAME, never from the spawned child', () => {
  test('scopeDirOf accepts only a ControlGroup that ends in the unit', () => {
    const cg = '/user.slice/user-1000.slice/user@1000.service/app.slice/u-x.scope\n'
    expect(scopeDirOf(cg, 'u-x.scope')).toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/u-x.scope')
    expect(scopeDirOf('/app.slice/agentop-server.service', 'u-x.scope')).toBeNull()
    expect(scopeDirOf('', 'u-x.scope')).toBeNull()
    expect(scopeDirOf('/a/../u-x.scope', 'u-x.scope')).toBeNull()
  })
  test('watchScope keeps asking until the unit answers, and an unreadable scope is null, not a throw', () => {
    let calls = 0
    const w = watchScope('u-x.scope', 10_000, () => (++calls < 3 ? null : '/nonexistent/dir'))
    expect(scopeStatsLine(w.stop(), 1000, 1 << 30)).toBeNull()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(watchScope('u-y.scope', 10_000, () => null).stop()).toBeNull()
  })
})
