import { describe, expect, test } from 'bun:test'
import { createHealthApiCache, createHealthReader, createSampleLog, hostDriveMount, isWsl, HEALTH_API_FRESH_MS, KERNEL_LOG_EVERY_MS, HOST_DRIVE_RETRY_MS, type HealthIo } from './machine-health-io'
import { emptyHealthState, evaluateHealth, SAMPLE_EVERY_MS, type FsFacts, type HealthState } from './machine-health'

const FS: FsFacts = { totalBytes: 1000 * 1024 ** 3, freeBytes: 800 * 1024 ** 3, files: 1000, freeFiles: 900 }
const PROC: Record<string, string> = {
  '/proc/version': 'Linux version 5.15.167.4-microsoft-standard-WSL2 (root@x) #1 SMP',
  '/proc/buddyinfo': 'Node 0, zone    DMA32   4241   1173    923    889    537    142      3      0      0      0      0\nNode 0, zone   Normal   2849   1911    525    377    209     47      5      0      0      0      0\n',
  '/proc/meminfo': 'MemTotal: 12252336 kB\nMemAvailable: 4600000 kB\nDirty: 100 kB\nWriteback: 0 kB\n',
  '/proc/vmstat': 'pswpin 18933090\n',
  '/proc/mounts': '/dev/sdc / ext4 rw,relatime 0 0\n',
}

function fakeIo(over: Partial<HealthIo> = {}, files: Record<string, string> = PROC) {
  const calls: string[][] = []
  let t = 1_000_000
  const io: HealthIo = {
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' },
    dataDir: '/home/u/.agentistics',
    now: () => t,
    mono: () => t,
    readText: async p => files[p] ?? null,
    statfs: async () => FS,
    run: async argv => {
      calls.push(argv)
      if (argv[0] === 'dmesg') return { code: 0, stdout: '[53990.0] x: page allocation failure: order:7, mode:0x40cc0' }
      if (argv[0] === 'powershell.exe') return { code: 0, stdout: 'Ubuntu-22.04|\\\\?\\C:\\WSL\\Ubuntu-22.04\r\nDebian|D:\\wsl\\debian\r\n' }
      return null
    },
    ...over,
  }
  return { io, calls, advance: (ms: number) => { t += ms } }
}

describe('helpers', () => {
  test('hostDriveMount: the distro BasePath drive letter → /mnt/<x>', () => {
    const out = 'Ubuntu-22.04|\\\\?\\C:\\WSL\\Ubuntu-22.04\r\nDebian|D:\\wsl\\debian\r\n'
    expect(hostDriveMount(out, 'Ubuntu-22.04')).toBe('/mnt/c')
    expect(hostDriveMount(out, 'Debian')).toBe('/mnt/d')
    expect(hostDriveMount(out, 'Arch')).toBeNull()
    expect(hostDriveMount('Only|\\\\server\\share\\x', undefined)).toBeNull()
    expect(hostDriveMount('Only|E:\\x', undefined)).toBe('/mnt/e')
  })
  test('isWsl', () => {
    expect(isWsl(PROC['/proc/version']!, {})).toBe(true)
    expect(isWsl('Linux version 6.8.0-generic', {})).toBe(false)
    expect(isWsl(null, { WSL_DISTRO_NAME: 'x' })).toBe(true)
  })
})

describe('createHealthReader', () => {
  test('linux/WSL: every source read, the Windows drive resolved once, dmesg paced', async () => {
    const { io, calls, advance } = fakeIo()
    const r = createHealthReader(io)
    const s = await r.sample()
    expect(s.wsl).toBe(true)
    expect(s.hostDrive?.path).toBe('/mnt/c')
    expect(s.kernelLog).toContain('order:7')
    advance(10_000)
    await r.sample()
    expect(calls.filter(c => c[0] === 'dmesg')).toHaveLength(1)
    expect(calls.filter(c => c[0]!.includes('powershell'))).toHaveLength(1)
    advance(KERNEL_LOG_EVERY_MS)
    await r.sample()
    expect(calls.filter(c => c[0] === 'dmesg')).toHaveLength(2)
    expect(calls.filter(c => c[0]!.includes('powershell'))).toHaveLength(1)
    // morning buddyinfo: S1 at 0, critical once it holds for 2 ticks; the order:7 line already in the buffer is history
    const one = evaluateHealth(s).state
    expect(one.values).toMatchObject({ S1: 0, S2: null })
    expect(evaluateHealth(s, one).state.level).toBe('critical')
  })
  test('powershell failing: S6 unavailable in words, tried again only after the retry interval, fallback path tried', async () => {
    const { io, calls, advance } = fakeIo({ run: async argv => { calls.push(argv); return argv[0] === 'dmesg' ? { code: 0, stdout: '' } : null } })
    const r = createHealthReader(io)
    const s = await r.sample()
    expect(s.hostDrive).toBeNull()
    expect(evaluateHealth(s).state.unavailableWhy.S6).toContain('powershell.exe')
    expect(calls.filter(c => c[0]!.includes('powershell'))).toHaveLength(2) // PATH name, then the absolute path
    advance(60_000)
    await r.sample()
    expect(calls.filter(c => c[0]!.includes('powershell'))).toHaveLength(2)
    advance(HOST_DRIVE_RETRY_MS)
    await r.sample()
    expect(calls.filter(c => c[0]!.includes('powershell'))).toHaveLength(4)
  })
  test('native Linux: S6 is the data dir filesystem, no powershell', async () => {
    const { io, calls } = fakeIo({ env: {} }, { ...PROC, '/proc/version': 'Linux version 6.8.0-generic' })
    const s = await createHealthReader(io).sample()
    expect(s.wsl).toBe(false)
    expect(s.hostDrive).toEqual({ path: '/home/u/.agentistics', fs: FS })
    expect(calls.some(c => c[0]!.includes('powershell'))).toBe(false)
  })
  test('dmesg restricted (non-zero exit) → kernelLog null → S2 unavailable', async () => {
    const { io } = fakeIo({ run: async argv => (argv[0] === 'dmesg' ? { code: 1, stdout: '' } : { code: 0, stdout: 'Ubuntu-22.04|C:\\x' }) })
    const s = await createHealthReader(io).sample()
    expect(s.kernelLog).toBeNull()
    expect(evaluateHealth(s).state.unavailable).toContain('S2')
  })
  for (const platform of ['darwin', 'win32']) {
    test(`${platform}: nothing is read, every signal unavailable`, async () => {
      const { io, calls } = fakeIo({ platform, readText: async () => { throw new Error('must not read') }, statfs: async () => { throw new Error('must not statfs') } })
      const s = await createHealthReader(io).sample()
      expect(calls).toEqual([])
      const st = evaluateHealth(s).state
      expect(st.measured).toBe(false)
      expect(st.unavailable).toHaveLength(11)
    })
  }
})

describe('createHealthReader — monotonic clock', () => {
  test('the sample carries the monotonic time; a wall-clock leap does not re-run dmesg early', async () => {
    let wall = 1_000_000
    let mono = 50_000
    const { io, calls } = fakeIo({ now: () => wall, mono: () => mono })
    const r = createHealthReader(io)
    const s = await r.sample()
    expect(s.monoMs).toBe(50_000)
    expect(s.atMs).toBe(1_000_000)
    wall += 3_600_000 // the wall clock leaps an hour
    mono += 10_000 // 10 s really passed
    await r.sample()
    expect(calls.filter(c => c[0] === 'dmesg')).toHaveLength(1)
  })
})

describe('createHealthApiCache — the route fallback when the governor tick is stale', () => {
  function counted() {
    let mono = 0
    let reads = 0
    let release: (() => void) | null = null
    let gate: Promise<void> | null = null
    const { io } = fakeIo()
    const reader = createHealthReader(io)
    return {
      cache: (freshMs?: number) => createHealthApiCache({
        sample: async () => { reads += 1; if (gate) await gate; return reader.sample() },
      }, () => mono, freshMs),
      advance: (ms: number) => { mono += ms },
      reads: () => reads,
      hold: () => { gate = new Promise(r => { release = r }) },
      release: () => { gate = null; release?.() },
    }
  }
  test('concurrent GETs share ONE read', async () => {
    const c = counted()
    const cache = c.cache()
    c.hold()
    const all = Promise.all([cache.get(), cache.get(), cache.get()])
    c.release()
    const out = await all
    expect(c.reads()).toBe(1)
    expect(out.every(o => o.state === out[0]!.state)).toBe(true)
  })
  test('a later GET within the window serves the last sample with its age; past it, one new read', async () => {
    const c = counted()
    const cache = c.cache()
    const first = await cache.get()
    expect(first.ageMs).toBe(0)
    c.advance(HEALTH_API_FRESH_MS - 1)
    const again = await cache.get()
    expect(c.reads()).toBe(1)
    expect(again.state).toBe(first.state)
    expect(again.ageMs).toBe(HEALTH_API_FRESH_MS - 1)
    c.advance(1)
    await cache.get()
    expect(c.reads()).toBe(2)
  })
  test('the single-sample state is evaluated with no history (instant)', async () => {
    const c = counted()
    const { state } = await c.cache().get()
    expect(state.level).toBe('critical') // the morning buddyinfo: S1 at 0, one tick is enough when instant
  })
})

describe('createSampleLog', () => {
  const at = (ms: number, level: HealthState['level'] = 'ok', values: HealthState['values'] = { S1: 50 }): HealthState =>
    ({ ...emptyHealthState(ms), sampledAtMs: ms, level, values })

  function fakeFs(initial: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initial }
    const writes: string[] = []
    return {
      files, writes,
      io: {
        dir: '/d/health',
        readText: async (p: string) => files[p] ?? null,
        ensureDir: async () => true,
        write: async (p: string, t: string) => { files[p] = t; writes.push(p) },
      },
    }
  }
  const DAY = Date.UTC(2026, 10, 26, 10, 0, 0)

  test('one line per minute with the worst value of the minute; a transition writes at once', async () => {
    const f = fakeFs()
    const log = createSampleLog(f.io)
    for (let i = 0; i <= 6; i++) await log.record(at(DAY + i * 10_000, 'ok', { S1: [50, 30, 12, 60, 70, 80, 90][i]! }), null)
    expect(log.lines()).toHaveLength(1)
    expect(JSON.parse(log.lines()[0]!)).toMatchObject({ level: 'ok', v: { S1: 12 } })
    expect(f.files['/d/health/samples.jsonl']).toContain('"S1":12')
    await log.record(at(DAY + 70_000, 'critical', { S1: 0 }), { from: 'ok', to: 'critical' })
    expect(JSON.parse(log.lines().at(-1)!)).toMatchObject({ level: 'critical', from: 'ok' })
    expect(f.files['/d/health/samples.jsonl']!.trim().split('\n')).toHaveLength(2)
  })
  test('a new UTC day rotates yesterday into its weekday slot (overwritten a week later, nothing deleted)', async () => {
    const f = fakeFs()
    const log = createSampleLog(f.io)
    await log.record(at(DAY), null)
    await log.record(at(DAY + SAMPLE_EVERY_MS), null)
    const tomorrow = DAY + 24 * 3600_000
    await log.record(at(tomorrow), { from: 'ok', to: 'tight' })
    expect(f.files['/d/health/samples.4.jsonl']).toContain(`"t":${DAY + SAMPLE_EVERY_MS}`) // Thursday 2026-11-26
    expect(f.files['/d/health/samples.jsonl']!.trim().split('\n')).toHaveLength(1)
  })
  test('a samples.jsonl left from an earlier day is moved to its slot on start', async () => {
    const old = `${JSON.stringify({ t: DAY - 2 * 24 * 3600_000, level: 'ok', v: {}, r: [] })}\n`
    const f = fakeFs({ '/d/health/samples.jsonl': old })
    const log = createSampleLog(f.io)
    await log.record(at(DAY), null)
    expect(f.files['/d/health/samples.2.jsonl']).toBe(old) // Tuesday
    expect(f.files['/d/health/samples.jsonl']).toBe('')
  })
  test("today's file is reloaded on start and appended to", async () => {
    const line = JSON.stringify({ t: DAY - 3600_000, level: 'ok', v: {}, r: [] })
    const f = fakeFs({ '/d/health/samples.jsonl': `${line}\n` })
    const log = createSampleLog(f.io)
    await log.record(at(DAY), { from: 'ok', to: 'tight' })
    expect(f.files['/d/health/samples.jsonl']!.trim().split('\n')).toEqual([line, expect.stringContaining('"from":"ok"')])
  })
  test('a failing write never throws into the tick', async () => {
    const f = fakeFs()
    const log = createSampleLog({ ...f.io, write: async () => { throw new Error('EROFS') } })
    await expect(log.record(at(DAY), { from: 'ok', to: 'readonly' })).resolves.toBeUndefined()
  })
})
