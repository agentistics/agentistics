import { describe, expect, test } from 'bun:test'
import {
  contiguousFreeBlocks,
  dirtyWritebackBytes,
  emptyHealthState,
  evaluateHealth,
  foldWorst,
  hostDriveRule,
  newestKernelLine,
  advanceKernelCursor,
  healthBlock,
  isAllocFailure,
  mountOf,
  parseMounts,
  psiAvg60,
  rotatedSampleName,
  rootFsRule,
  sampleFileDay,
  swapInRate,
  vmstatCounter,
  HEALTH_TICK_MS,
  SIGNAL_IDS,
  type FsFacts,
  type HealthSample,
  type HealthState,
  type Level,
} from './machine-health'

const GiB = 1024 ** 3

/** The buddyinfo measured on 2026-11-26 ~12:40Z (spec §0): zero blocks of order >= 7 in DMA32 and Normal. */
const BUDDY_MORNING = `Node 0, zone      DMA      0      0      0      0      0      0      0      0      0      1      3
Node 0, zone    DMA32   4241   1173    923    889    537    142      3      0      0      0      0
Node 0, zone   Normal   2849   1911    525    377    209     47      5      0      0      0      0
`
/** A buddyinfo whose order >= 7 sum (DMA32 + Normal) is exactly `n`. */
const buddy = (n: number) => `Node 0, zone      DMA      0      0      0      0      0      0      0      0      0      1      3
Node 0, zone    DMA32   100 100 100 100 100 100 100 ${n} 0 0 0
Node 0, zone   Normal   100 100 100 100 100 100 100 0 0 0 0
`
const meminfo = (availGiB: number, dirtyKb = 4000, wbKb = 0) => `MemTotal:       12252336 kB
MemFree:          500000 kB
MemAvailable:   ${Math.round(availGiB * 1024 * 1024)} kB
Dirty:          ${dirtyKb} kB
Writeback:      ${wbKb} kB
SwapTotal:       8388608 kB
SwapFree:        4000000 kB
`
const vmstat = (pswpin: number) => `nr_free_pages 12345\npswpin ${pswpin}\npswpout 18088684\n`
const MOUNTS_RW = `/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0
C:\\134 /mnt/c 9p rw,noatime,dirsync 0 0
`
const MOUNTS_RO = MOUNTS_RW.replace('/dev/sdc / ext4 rw,', '/dev/sdc / ext4 ro,')
const fs = (totalGiB: number, freeGiB: number, files = 1_000_000, freeFiles = 900_000): FsFacts =>
  ({ totalBytes: totalGiB * GiB, freeBytes: freeGiB * GiB, files, freeFiles })

function sample(over: Partial<HealthSample> = {}, atMs = 1_000_000): HealthSample {
  return {
    atMs,
    monoMs: atMs,
    platform: 'linux',
    wsl: true,
    buddyinfo: buddy(200),
    meminfo: meminfo(8),
    vmstat: vmstat(1000),
    psiMemory: null,
    psiIo: null,
    kernelLog: '[    1.000000] Linux version 5.15.167.4-microsoft-standard-WSL2\n',
    mounts: MOUNTS_RW,
    dataDir: '/home/u/.agentistics',
    rootFs: fs(1007, 800),
    dataFs: fs(1007, 800),
    hostDrive: { path: '/mnt/c', fs: fs(930, 130) },
    ...over,
  }
}

/** Run a sequence of samples through the evaluator, collecting levels and transitions. */
function run(samples: HealthSample[], start?: HealthState) {
  let s: HealthState | undefined = start
  const levels: Level[] = []
  const transitions: Array<{ from: Level; to: Level }> = []
  for (const x of samples) {
    const step = evaluateHealth(x, s)
    s = step.state
    levels.push(s.level)
    if (step.transition) transitions.push(step.transition)
  }
  return { levels, transitions, state: s! }
}
const ticks = (n: number, over: (i: number) => Partial<HealthSample>, t0 = 1_000_000) =>
  Array.from({ length: n }, (_, i) => sample(over(i), t0 + i * HEALTH_TICK_MS))

describe('parsers', () => {
  test('buddyinfo: this morning sums to 0 over DMA32 + Normal (DMA ignored)', () => {
    expect(contiguousFreeBlocks(BUDDY_MORNING)).toBe(0)
    expect(contiguousFreeBlocks(buddy(19))).toBe(19)
    // orders 7..10 summed, DMA's 1 + 3 never counted
    expect(contiguousFreeBlocks('Node 0, zone DMA 0 0 0 0 0 0 0 0 0 1 3\nNode 0, zone DMA32 1 1 1 1 1 1 1 72 8 0 0\nNode 0, zone Normal 1 1 1 1 1 1 0 1 0 0 0')).toBe(81)
    expect(contiguousFreeBlocks('Node 0, zone DMA 0 0 0 0 0 0 0 0 0 1 3\n')).toBeNull()
    expect(contiguousFreeBlocks('')).toBeNull()
  })
  test('meminfo / vmstat / psi', () => {
    expect(dirtyWritebackBytes(meminfo(8, 1024, 1024))).toBe(2 * 1024 * 1024)
    expect(dirtyWritebackBytes('MemTotal: 1 kB\n')).toBeNull()
    expect(vmstatCounter(vmstat(18933090), 'pswpin')).toBe(18933090)
    expect(vmstatCounter('pgfault 1\n', 'pswpin')).toBeNull()
    const psi = 'some avg10=1.00 avg60=22.50 avg300=3.00 total=1\nfull avg10=0.00 avg60=11.25 avg300=0.00 total=1\n'
    expect(psiAvg60(psi, 'some')).toBe(22.5)
    expect(psiAvg60(psi, 'full')).toBe(11.25)
  })
  test('kernel log: newest matching stamp and count; order < 4 is not a failure', () => {
    const log = '[  100.5] swapper/0: page allocation failure: order:7, mode:0x40cc0\n[  200.0] foo: page allocation failure: order:2, mode:0\n[  300.25] bar: page allocation failure: order:7, mode:0x40cc0\n'
    expect(newestKernelLine(log, isAllocFailure)).toEqual({ ts: 300.25, count: 2 })
    expect(newestKernelLine('[ 1.0] hello\n', isAllocFailure)).toEqual({ ts: null, count: 0 })
  })
  test('kernel cursor: lines present at start are history; a newer stamp is new, dated by the tick that saw it', () => {
    const old = '[44495.4] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n'
    const c0 = advanceKernelCursor(undefined, old, 1000)
    expect(c0).toMatchObject({ failTs: 44495.4, failSeenMonoMs: null, failuresInLog: 1 })
    expect(advanceKernelCursor(c0, old, 2000).failSeenMonoMs).toBeNull()
    const c1 = advanceKernelCursor(c0, `${old}[44600.0] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n`, 3000)
    expect(c1).toMatchObject({ failTs: 44600, failSeenMonoMs: 3000, failuresInLog: 2 })
    expect(advanceKernelCursor(c1, `${old}[44600.0] x: page allocation failure: order:7\n`, 9000).failSeenMonoMs).toBe(3000)
    // stamps going backwards = another buffer: re-baseline, nothing new
    expect(advanceKernelCursor(c1, '[5.0] x: page allocation failure: order:7\n', 9000).failSeenMonoMs).toBeNull()
  })
  test('mounts: longest prefix wins, octal escapes decoded', () => {
    const m = parseMounts(`/dev/a / ext4 rw 0 0\n/dev/b /home/my\\040data ext4 ro 0 0\n`)
    expect(mountOf('/home/my data/x', m)?.device).toBe('/dev/b')
    expect(mountOf('/home/my datax', m)?.device).toBe('/dev/a')
    expect(mountOf('/', m)?.device).toBe('/dev/a')
  })
  test('swap rate needs most of the window', () => {
    const h = [0, 1, 2, 3, 4, 5, 6].map(i => ({ monoMs: i * 10_000, pswpin: i * 10_000 }))
    expect(swapInRate(h, 60_000)).toBe(1000)
    expect(swapInRate(h.slice(0, 3), 60_000)).toBeNull()
  })
  test('disk rules: GB lines on a big drive, percentages under 256 GB; root = max(%, GB)', () => {
    expect(hostDriveRule(930 * GiB).tight!.enter.value).toBe(50 * GiB)
    expect(hostDriveRule(200 * GiB).tight!.enter.value).toBeCloseTo(0.2 * 200 * GiB)
    expect(rootFsRule(1007 * GiB).tight!.enter.value).toBeCloseTo(100.7 * GiB)
    expect(rootFsRule(100 * GiB).tight!.enter.value).toBe(30 * GiB)
    expect(rootFsRule(100 * GiB).critical!.exit.value).toBe(10 * GiB)
  })
})

describe('S1 contiguous memory — the signal that preceded the crash', () => {
  test("this morning's buddyinfo is critical after 2 consecutive ticks (not on the first)", () => {
    const { levels, transitions, state } = run(ticks(2, () => ({ buddyinfo: BUDDY_MORNING })))
    expect(levels).toEqual(['ok', 'critical'])
    expect(transitions).toEqual([{ from: 'ok', to: 'critical' }])
    const r = state.reasons.find(x => x.signal === 'S1')!
    expect(r).toMatchObject({ level: 'critical', value: 0, unit: 'blocks', enter: { op: '<=', value: 0 }, exit: { op: '>=', value: 40 } })
    expect(state.values.S1).toBe(0)
    // MemAvailable 8 GiB said "fine" — S3 is not among the reasons.
    expect(state.reasons.map(x => x.signal)).toEqual(['S1'])
  })
  test('a single tick at 0 is not enough (compaction can recover in seconds)', () => {
    const { transitions } = run([...ticks(1, () => ({ buddyinfo: buddy(0) })), ...ticks(5, () => ({ buddyinfo: buddy(100) }), 2_000_000)])
    expect(transitions).toEqual([])
  })
  test('hovering at 19/21 is ONE transition', () => {
    const seq = [19, 19, 21, 19, 21, 19, 21, 19, 21, 19, 21, 19, 21, 19, 21, 19]
    const { transitions, levels } = run(ticks(seq.length, i => ({ buddyinfo: buddy(seq[i]!) })))
    expect(transitions).toEqual([{ from: 'ok', to: 'tight' }])
    expect(levels.at(-1)).toBe('tight')
    // pure alternation from ok never even enters (2 consecutive ticks needed)
    expect(run(ticks(12, i => ({ buddyinfo: buddy(i % 2 ? 21 : 19) }))).transitions).toEqual([])
  })
  test('leaves only at >= 40 for 6 consecutive ticks (60 s); 5 then a dip restarts the dwell', () => {
    const enter = ticks(2, () => ({ buddyinfo: buddy(0) }))
    const s0 = run(enter).state
    expect(s0.level).toBe('critical')
    // 39 never leaves
    expect(run(ticks(20, () => ({ buddyinfo: buddy(39) }), 2_000_000), s0).levels.every(l => l === 'critical')).toBe(true)
    // 5 ticks at 45, a dip to 30, then 6 at 45
    const seq = [45, 45, 45, 45, 45, 30, 45, 45, 45, 45, 45, 45]
    const r = run(ticks(seq.length, i => ({ buddyinfo: buddy(seq[i]!) }), 2_000_000), s0)
    expect(r.levels).toEqual(['critical', 'critical', 'critical', 'critical', 'critical', 'critical', 'critical', 'critical', 'critical', 'critical', 'critical', 'ok'])
    expect(r.transitions).toEqual([{ from: 'critical', to: 'ok' }])
    expect(r.state.since).toBe(2_000_000 + 11 * HEALTH_TICK_MS)
  })
})

describe('the other signals', () => {
  test('S2: a NEW order:7 failure is critical at once and for 10 min after it was first seen; old lines are history', () => {
    const base = '[44495.4] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n'
    const first = evaluateHealth(sample({ kernelLog: base }, 1_000_000))
    expect(first.state.level).toBe('ok') // already in the buffer when the guard started
    expect(first.state.values.S2).toBeNull()
    expect(healthBlock(first.state, 'governor', 0).kernelFailuresInLog).toBe(1)
    const log = `${base}[44600.0] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n`
    const a = evaluateHealth(sample({ kernelLog: log }, 1_010_000), first.state)
    expect(a.state.level).toBe('critical')
    expect(a.state.reasons[0]).toMatchObject({ signal: 'S2', value: 0, unit: 'seconds' })
    const mid = evaluateHealth(sample({ kernelLog: log }, 1_010_000 + 599_000), a.state)
    expect(mid.state.level).toBe('critical')
    const b = evaluateHealth(sample({ kernelLog: log }, 1_010_000 + 700_000), mid.state)
    expect(b.state.level).toBe('ok')
    expect(b.state.values.S2).toBe(700)
  })
  test('S2: 10 min without a new line is not enough while S1 is critical (spec: "AND S1 not critical")', () => {
    const base = '[44495.4] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n'
    const log = `${base}[44600.0] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n`
    const first = evaluateHealth(sample({ kernelLog: base, buddyinfo: buddy(0) }, 1_000_000)).state
    const a = evaluateHealth(sample({ kernelLog: log, buddyinfo: buddy(0) }, 1_010_000), first).state
    expect(a.reasons.map(r => r.signal).sort()).toEqual(['S1', 'S2'])
    const late = evaluateHealth(sample({ kernelLog: log, buddyinfo: buddy(0) }, 1_010_000 + 700_000), a).state
    expect(late.reasons.find(r => r.signal === 'S2')).toMatchObject({ level: 'critical', value: 700 })
    // S1 recovers (6 ticks at >= 40): from then on S2 leaves on its own.
    const r = run(ticks(6, () => ({ kernelLog: log, buddyinfo: buddy(100) }), 1_010_000 + 710_000), late)
    expect(r.state.reasons).toEqual([])
    expect(r.state.level).toBe('ok')
  })
  test('S2: a forward jump of the wall clock does not age a failure (the window is monotonic)', () => {
    const base = '[44495.4] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n'
    const log = `${base}[44600.0] kworker/0:0: page allocation failure: order:7, mode:0xdc0\n`
    const first = evaluateHealth(sample({ kernelLog: base }, 1_000_000)).state
    const a = evaluateHealth(sample({ kernelLog: log }, 1_010_000), first).state
    expect(a.level).toBe('critical')
    // WSL resyncs its clock: the wall clock leaps an hour, only 10 s really passed.
    const jumped = evaluateHealth({ ...sample({ kernelLog: log }, 1_010_000 + 3_600_000), monoMs: 1_020_000 }, a).state
    expect(jumped.level).toBe('critical')
    expect(jumped.values.S2).toBe(10)
  })
  test('S5 enters AT the line (the table says >=): memory some 20 % / io full 10 %', () => {
    const at = (some: number, full: number) => `some avg10=0 avg60=${some.toFixed(2)} avg300=0 total=1\nfull avg10=0 avg60=${full.toFixed(2)} avg300=0 total=1\n`
    const s = evaluateHealth(sample({ psiMemory: at(20, 0), psiIo: at(0, 10) })).state
    expect(s.reasons.find(r => r.signal === 'S5.memory')).toMatchObject({ level: 'tight', enter: { op: '>=', value: 20 } })
    expect(s.reasons.find(r => r.signal === 'S5.io')).toMatchObject({ level: 'tight', enter: { op: '>=', value: 10 } })
    const c = evaluateHealth(sample({ psiMemory: at(50, 0), psiIo: at(0, 30) })).state
    expect(c.reasons.find(r => r.signal === 'S5.memory')?.level).toBe('critical')
    expect(c.reasons.find(r => r.signal === 'S5.io')?.level).toBe('critical')
    expect(evaluateHealth(sample({ psiMemory: at(19.99, 0), psiIo: at(0, 9.99) })).state.reasons).toEqual([])
  })
  test('S3: tight under 4 GiB, critical under 2,5 GiB, leaves critical to tight at 3 GiB', () => {
    const s = run([...ticks(1, () => ({ meminfo: meminfo(3.9) })), ...ticks(1, () => ({ meminfo: meminfo(2.4) }), 2_000_000)])
    expect(s.levels).toEqual(['tight', 'critical'])
    const back = run(ticks(3, () => ({ meminfo: meminfo(3.5) }), 3_000_000), s.state)
    expect(back.levels).toEqual(['critical', 'critical', 'tight'])
  })
  test('S4: swap-in rate over 60 s, observed; leaves under 300 pages/s over 120 s', () => {
    const up = run(ticks(8, i => ({ vmstat: vmstat(1000 + i * 15_000) })))
    expect(up.levels.slice(0, 5).every(l => l === 'ok')).toBe(true) // warming up: < 50 s of history
    expect(up.levels.at(-1)).toBe('tight')
    expect(up.state.values.S4).toBe(1500)
    const t0 = 1_000_000 + 8 * HEALTH_TICK_MS
    const last = 1000 + 7 * 15_000
    const down = run(ticks(14, i => ({ vmstat: vmstat(last + (i + 1) * 1000) }), t0), up.state)
    expect(down.levels.at(-1)).toBe('ok')
  })
  test('S5 PSI is read where it exists, unavailable where not', () => {
    const psi = 'some avg10=60 avg60=55.00 avg300=1 total=1\nfull avg10=0 avg60=0.00 avg300=0 total=1\n'
    const s = evaluateHealth(sample({ psiMemory: psi, psiIo: psi })).state
    expect(s.reasons.find(r => r.signal === 'S5.memory')?.level).toBe('critical')
    const none = evaluateHealth(sample()).state
    expect(none.unavailable).toEqual(['S5.memory', 'S5.io'])
    expect(none.unavailableWhy['S5.memory']).toContain('CONFIG_PSI')
  })
  test('S6 host drive: C: at 42 GB is tight; a small drive uses percentages', () => {
    expect(evaluateHealth(sample({ hostDrive: { path: '/mnt/c', fs: fs(930, 42) } })).state.reasons[0]).toMatchObject({ signal: 'S6', level: 'tight' })
    expect(evaluateHealth(sample({ hostDrive: { path: '/mnt/c', fs: fs(200, 30) } })).state.reasons[0]).toMatchObject({ signal: 'S6', level: 'tight' })
    const why = evaluateHealth(sample({ hostDrive: null, hostDriveWhy: 'powershell.exe could not be run' })).state
    expect(why.unavailable).toContain('S6')
    expect(why.unavailableWhy.S6).toBe('powershell.exe could not be run')
  })
  test('S7 root / S8 inodes / S10 writeback', () => {
    expect(evaluateHealth(sample({ rootFs: fs(1007, 60) })).state.reasons[0]).toMatchObject({ signal: 'S7', level: 'tight' })
    expect(evaluateHealth(sample({ dataFs: fs(100, 5) })).state.reasons[0]).toMatchObject({ signal: 'S7', level: 'critical' })
    expect(evaluateHealth(sample({ rootFs: fs(1007, 800, 1_000_000, 20_000) })).state.reasons[0]).toMatchObject({ signal: 'S8', level: 'critical' })
    expect(evaluateHealth(sample({ rootFs: fs(1007, 800, 0, 0) })).state.unavailable).toContain('S8')
    expect(evaluateHealth(sample({ meminfo: meminfo(8, 1_200_000) })).state.reasons[0]).toMatchObject({ signal: 'S10', level: 'tight' })
  })
  test('S9: a read-only root decides `readonly` on its own, above every other level', () => {
    const s = evaluateHealth(sample({ mounts: MOUNTS_RO, meminfo: meminfo(2) })).state
    expect(s.level).toBe('readonly')
    expect(s.reasons[0]).toMatchObject({ signal: 'S9', level: 'readonly' })
    expect(s.reasons[1]).toMatchObject({ signal: 'S3', level: 'critical' })
    const k0 = evaluateHealth(sample()).state
    const k = evaluateHealth(sample({ kernelLog: '[49990.0] EXT4-fs (sdc): Remounting filesystem read-only\n' }, 1_010_000), k0).state
    expect(k.level).toBe('readonly')
  })
  test('the level is the worst signal', () => {
    const s = evaluateHealth(sample({ meminfo: meminfo(3.9), hostDrive: { path: '/mnt/c', fs: fs(930, 10) } })).state
    expect(s.level).toBe('critical')
    expect(s.reasons.map(r => [r.signal, r.level])).toEqual([['S6', 'critical'], ['S3', 'tight']])
  })
  test('a healthy WSL sample is ok, measured, with only PSI unavailable', () => {
    const s = evaluateHealth(sample()).state
    expect(s).toMatchObject({ level: 'ok', measured: true, reasons: [] })
    expect(s.unavailable).toEqual(['S5.memory', 'S5.io'])
  })
})

describe('unavailable is never ok', () => {
  for (const platform of ['darwin', 'win32']) {
    test(`${platform}: every signal unavailable, said in words, measured false`, () => {
      const s = evaluateHealth({
        atMs: 1, monoMs: 1, platform, wsl: false, buddyinfo: null, meminfo: null, vmstat: null, psiMemory: null, psiIo: null, kernelLog: null,
        mounts: null, dataDir: '/x', rootFs: null, dataFs: null, hostDrive: null,
      }).state
      expect(s.unavailable).toEqual([...SIGNAL_IDS])
      expect(s.measured).toBe(false)
      expect(s.reasons).toEqual([])
      for (const id of SIGNAL_IDS) expect(s.unavailableWhy[id]).toContain(`not measured on ${platform}`)
    })
  }
  test('linux with dmesg restricted: S2 unavailable with the reason, the rest measured', () => {
    const s = evaluateHealth(sample({ kernelLog: null })).state
    expect(s.unavailable).toContain('S2')
    expect(s.unavailableWhy.S2).toContain('dmesg_restrict')
    expect(s.measured).toBe(true)
  })
  test('instant evaluation (single on-demand sample) enters on one tick', () => {
    expect(evaluateHealth(sample({ buddyinfo: BUDDY_MORNING }), emptyHealthState(0), { instant: true }).state.level).toBe('critical')
  })
})

describe('sample log helpers', () => {
  test('foldWorst keeps the min where low is bad and the max where high is bad', () => {
    const a = foldWorst({}, { S1: 50, S4: 10, S3: 8 * GiB })
    const b = foldWorst(a, { S1: 12, S4: 900, S3: 9 * GiB })
    expect(b).toEqual({ S1: 12, S4: 900, S3: 8 * GiB })
    expect(foldWorst({ S1: 5 }, { S1: null })).toEqual({ S1: 5 })
  })
  test('rotation slots by UTC weekday; file day from the first parseable line', () => {
    expect(rotatedSampleName('2026-11-26')).toBe('samples.4.jsonl') // a Thursday
    expect(sampleFileDay('garbage\n{"t":1764115200000,"level":"ok"}\n')).toBe('2025-11-26')
    expect(sampleFileDay('')).toBeNull()
  })
})
